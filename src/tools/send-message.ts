import { stat, unlink, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChatProvider, CanonicalChatEvent, OutboundTarget, AttachmentMeta } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import { resolveWorkspacePath } from "./workspace.js";
import { guardedFetch } from "./ssrf.js";
import { chunkMarkdownText } from "./chunk.js";

/** Safe content budget for body + formatted_body within Matrix's 65 536-byte event limit. */
const MATRIX_MAX_CONTENT_BYTES = 60_000;

export interface SendMessageToolContext {
  provider: ChatProvider;
  target: OutboundTarget;
  timeline: TimelineStore;
  agentSessionId: string;
  /**
   * The owning session's `resume_generation` at run start (spec
   * RESUMABLE-SESSIONS §6). Tagged onto every outbound event so a later reply to
   * this message can tell whether it targets the session's live generation
   * (continue) or a superseded one (fresh). 0 for a fresh session; the bumped
   * value for a resumed run. Absent in tests = untagged (read as generation 0).
   */
  agentSessionGeneration?: number;
  workspaceRoot?: string;
  mediaMaxBytes?: number;
  /**
   * Live reply guard (spec DUPLICATE-REPLY-MITIGATION §6). Given a `reply_to_id`
   * (`$…` event id), returns a marker for the *other* session currently handling
   * that message, or undefined. `sessionId` is set when the owning session is known,
   * or undefined for an un-attributed (queued / pre-launch) claim — still a "hands
   * off", just not yet nameable (review #4). Queried at SEND time (not build time),
   * so it catches the case the frozen `<handled_by_session>` marker structurally
   * cannot: a sibling that started after this session's context was built. When it
   * returns a marker, the tool refuses the reply with a non-terminating redirect
   * (another turn), not a wall. Self is already excluded by the closure. Absent = no
   * guard (tests).
   */
  isClaimedByOther?: (externalId: string) => { sessionId?: string } | undefined;
}

export function createSendMessageTool(context: SendMessageToolContext): AgentTool {
  return {
    name: "send_message",
    label: "Send message",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — the effect IS
    // the chat message, so it leaves no rollout state worth continuing.
    resumeWorkExempt: true,
    description: "Send a message to the current Matrix room. You must explicitly decide whether the message is a reply.",
    parameters: Type.Object({
      message: Type.String({ description: "Message text. Can be empty string if sending media only. An exact Matrix user ID like @name:server in the text is turned into a real mention automatically (pill + notification) — no special markup needed." }),
      html: Type.Optional(Type.String({ description: "Optional HTML body. If omitted, HTML is generated automatically when the message contains :shortcode: emoji or @user:server mentions." })),
      is_reply: Type.Boolean({ description: "Whether this message is an explicit reply to another message. Set to false for standalone messages." }),
      reply_to_id: Type.Optional(Type.String({ description: "Matrix event ID to reply to. Required when is_reply is true." })),
      media: Type.Optional(Type.String({ description: "Path to local file (relative to workspace) or URL to send as media attachment." })),
      as_voice: Type.Optional(Type.Boolean({ description: "When true, sends the media attachment as a voice message (audio only). Requires media to be set to an audio file." })),
      final: Type.Boolean({ description: "Whether this is the final message of your turn. Set true if you are done — sending the message ends your turn. Set false ONLY when you will keep working and send more this turn (e.g. a progress update before a multi-step tool sequence); your turn stays open. There is no default — you must decide every time, just like is_reply." }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        message: string;
        html?: string;
        is_reply: boolean;
        reply_to_id?: string;
        media?: string;
        as_voice?: boolean;
        final: boolean;
      };
      const isFinal = args.final;

      if (args.is_reply && !args.reply_to_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: reply_to_id is required when is_reply is true. Provide the event ID of the message you want to reply to." }],
          details: null,
        };
      }

      // Live reply guard (spec DUPLICATE-REPLY-MITIGATION §6): refuse to REPLY to a
      // message another session is currently handling. Scoped to exactly this one
      // mechanical signal (`reply_to_id`) so false positives are near-zero — inline
      // addressing without a reply marker stays the marker/coordination line's job
      // (§4). The error is a redirect (names the alternatives), not a refusal, and
      // does NOT terminate — the agent gets another turn.
      if (args.is_reply && args.reply_to_id?.trim() && context.isClaimedByOther) {
        const claim = context.isClaimedByOther(args.reply_to_id.trim());
        if (claim) {
          // The owning session may not be attributed yet (a queued / just-accepted
          // claim — review #4); name it when known, else describe it generically.
          const who = claim.sessionId ? `another session (${claim.sessionId})` : "a session that's starting up";
          return {
            content: [{
              type: "text",
              text: `error: ${args.reply_to_id.trim()} is currently being handled by ${who}. Don't reply to it — that session has it. If you only meant to surface or quote it, send without is_reply. If it needs independent handling, that's already covered.`,
            }],
            details: null,
          };
        }
      }

      // A send with no text, no HTML, and no media has nothing to deliver — it would
      // produce an empty Matrix event (or, historically, silently send nothing). If you
      // have nothing to say, terminate the turn by outputting exactly NO_REPLY instead.
      if (!args.message.trim() && !args.html?.trim() && !args.media?.trim()) {
        return {
          content: [{ type: "text", text: "error: nothing to send — provide message text, html, or media. If you have nothing to say, output exactly NO_REPLY to end your turn silently." }],
          details: null,
        };
      }

      const effectiveTarget: OutboundTarget = { ...context.target };
      if (args.is_reply) {
        effectiveTarget.replyToId = args.reply_to_id!.trim();
      } else {
        delete effectiveTarget.replyToId;
      }

      const body = args.message;
      const htmlBody = args.html;

      let attachments: AttachmentMeta[] | undefined;
      let tempPath: string | undefined;
      if (args.media?.trim()) {
        try {
          const mediaResult = await resolveMedia(args.media.trim(), context);
          if (args.as_voice) {
            mediaResult.attachment.asVoice = true;
          }
          attachments = [mediaResult.attachment];
          tempPath = mediaResult.tempPath;
        } catch (err) {
          return {
            content: [{ type: "text", text: `error: failed to resolve media "${args.media}": ${err instanceof Error ? err.message : String(err)}` }],
            details: null,
          };
        }
      }

      try {
        // When custom HTML is provided, skip chunking — send as a single message.
        if (htmlBody) {
          const combinedBytes =
            Buffer.byteLength(body, "utf8") + Buffer.byteLength(htmlBody, "utf8");
          if (combinedBytes > MATRIX_MAX_CONTENT_BYTES) {
            return {
              content: [{
                type: "text",
                text: `error: message with custom HTML is too large to send as a single event (${combinedBytes} bytes exceeds ${MATRIX_MAX_CONTENT_BYTES}-byte limit). To fix this, shorten the message, remove the html parameter to allow automatic chunking, or split into multiple send_message calls manually.`,
              }],
              details: null,
            };
          }

          const receipt = await context.provider.send(effectiveTarget, {
            body,
            htmlBody,
            attachments,
            agentSessionId: context.agentSessionId,
          });

          const event: CanonicalChatEvent = {
            id: `assistant:${context.agentSessionId}:${receipt.externalId ?? Date.now()}:0`,
            externalId: receipt.externalId,
            timelineKey: context.target.timelineKey,
            provider: context.provider.id,
            agentSessionId: context.agentSessionId,
            agentSessionGeneration: context.agentSessionGeneration,
            role: "assistant",
            sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
            body,
            htmlBody,
            timestamp: receipt.deliveredAt,
            receivedAt: Date.now(),
          };
          // Merge-aware append: the sync echo can land its own row for this event
          // before this write (the echo race) — ingestAssistantSend folds the send
          // into that row instead of storing the message twice.
          await context.timeline.ingestAssistantSend(event);

          return {
            content: [{ type: "text", text: `sent: ${receipt.externalId ?? "local"}` }],
            details: { eventIds: receipt.externalId ? [receipt.externalId] : [] },
            terminate: isFinal,
          };
        }

        // No custom HTML — chunk the plaintext message as before.
        const chunks = chunkMarkdownText(body, 4000);
        // Media-only send: an empty body chunks to zero entries, so the send loop
        // below would never run and the attachment would be silently dropped.
        // Emit a single empty-body event to carry the attachment.
        if (chunks.length === 0 && attachments) {
          chunks.push("");
        }
        const eventIds: string[] = [];

        for (let i = 0; i < chunks.length; i++) {
          const chunkTarget: OutboundTarget = { ...effectiveTarget };
          if (i > 0) {
            delete chunkTarget.replyToId;
          }

          const receipt = await context.provider.send(chunkTarget, {
            body: chunks[i],
            attachments: i === 0 ? attachments : undefined,
            agentSessionId: context.agentSessionId,
          });

          const event: CanonicalChatEvent = {
            id: `assistant:${context.agentSessionId}:${receipt.externalId ?? Date.now()}:${i}`,
            externalId: receipt.externalId,
            timelineKey: context.target.timelineKey,
            provider: context.provider.id,
            agentSessionId: context.agentSessionId,
            agentSessionGeneration: context.agentSessionGeneration,
            role: "assistant",
            sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
            body: chunks[i],
            timestamp: receipt.deliveredAt,
            receivedAt: Date.now(),
          };
          // Merge-aware append — same echo-race handling as the html branch above.
          await context.timeline.ingestAssistantSend(event);
          eventIds.push(receipt.externalId ?? "local");
        }

        const summary = eventIds.length === 1
          ? `sent: ${eventIds[0]}`
          : `sent ${eventIds.length} chunks: ${eventIds.join(", ")}`;
        return {
          content: [{ type: "text", text: summary }],
          details: { eventIds },
          terminate: isFinal,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (args.is_reply && message.includes("not found")) {
          return {
            content: [{ type: "text", text: `error: reply_to_id "${args.reply_to_id}" not found in this room. Use a valid event ID from the conversation context, or set is_reply to false.` }],
            details: null,
          };
        }
        throw err;
      } finally {
        if (tempPath) await unlink(tempPath).catch(() => {});
      }
    },
  };
}

async function resolveMedia(
  mediaRef: string,
  context: SendMessageToolContext,
): Promise<{ attachment: AttachmentMeta; tempPath?: string }> {
  const maxBytes = context.mediaMaxBytes ?? 50 * 1024 * 1024;

  if (/^https?:\/\//i.test(mediaRef)) {
    return downloadMediaUrl(mediaRef, maxBytes);
  }

  const localPath = resolveWorkspacePath(context.workspaceRoot ?? ".", mediaRef);
  const stats = await stat(localPath);
  if (stats.size > maxBytes) {
    throw new Error(`file exceeds size limit (${stats.size} > ${maxBytes} bytes)`);
  }

  const filename = path.basename(localPath);
  const mimeType = guessMimeType(filename);

  return {
    attachment: {
      id: `outbound:${Date.now()}:${filename}`,
      filename,
      mimeType,
      mediaType: classifyMediaType(mimeType),
      sizeBytes: stats.size,
      localPath,
    },
  };
}

async function downloadMediaUrl(
  url: string,
  maxBytes: number,
): Promise<{ attachment: AttachmentMeta; tempPath: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    // guardedFetch blocks private/metadata hosts (incl. every redirect hop) when
    // the egress guard is enabled, and degrades to a plain follow-fetch when the
    // network firewall is the boundary instead.
    const response = await guardedFetch(url, { signal: controller.signal });
    if (!response.ok) {
      // Settle the unread body so the per-host limiter slot is freed promptly.
      await response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`declared content-length ${declaredLength} exceeds size limit (${maxBytes} bytes)`);
    }

    const contentType = response.headers.get("content-type") ?? undefined;
    const urlPath = new URL(response.url).pathname;
    const filename = path.basename(urlPath) || "download";

    const tempPath = path.join(tmpdir(), `miku-media-${randomBytes(8).toString("hex")}-${filename}`);

    if (!response.body) {
      await writeFile(tempPath, Buffer.alloc(0));
      const mimeType = contentType?.split(";")[0]?.trim() ?? guessMimeType(filename);
      return {
        attachment: {
          id: `outbound:${Date.now()}:${filename}`,
          filename,
          mimeType,
          mediaType: classifyMediaType(mimeType),
          sizeBytes: 0,
          localPath: tempPath,
        },
        tempPath,
      };
    }

    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    let totalBytes = 0;
    const sizeGuard = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          controller.abort();
          callback(new Error(`download exceeds size limit (${maxBytes} bytes)`));
        } else {
          callback(null, chunk);
        }
      },
    });

    try {
      await pipeline(nodeStream, sizeGuard, createWriteStream(tempPath));
    } catch (err) {
      await unlink(tempPath).catch(() => {});
      throw err;
    }

    const mimeType = contentType?.split(";")[0]?.trim() ?? guessMimeType(filename);
    return {
      attachment: {
        id: `outbound:${Date.now()}:${filename}`,
        filename,
        mimeType,
        mediaType: classifyMediaType(mimeType),
        sizeBytes: totalBytes,
        localPath: tempPath,
      },
      tempPath,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
    ".opus": "audio/opus",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".json": "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

function classifyMediaType(mimeType: string): "image" | "video" | "audio" | "file" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}
