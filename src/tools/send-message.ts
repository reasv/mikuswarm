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
import { assertPublicHttpUrl } from "./ssrf.js";
import { chunkMarkdownText } from "./chunk.js";

/** Safe content budget for body + formatted_body within Matrix's 65 536-byte event limit. */
const MATRIX_MAX_CONTENT_BYTES = 60_000;

export interface SendMessageToolContext {
  provider: ChatProvider;
  target: OutboundTarget;
  timeline: TimelineStore;
  agentSessionId: string;
  workspaceRoot?: string;
  mediaMaxBytes?: number;
}

export function createSendMessageTool(context: SendMessageToolContext): AgentTool {
  return {
    name: "send_message",
    label: "Send message",
    description: "Send a message to the current Matrix room. You must explicitly decide whether the message is a reply.",
    parameters: Type.Object({
      message: Type.String({ description: "Message text. Can be empty string if sending media only." }),
      html: Type.Optional(Type.String({ description: "Optional HTML body. If omitted and message contains :shortcode: patterns, HTML is generated automatically." })),
      is_reply: Type.Boolean({ description: "Whether this message is an explicit reply to another message. Set to false for standalone messages." }),
      reply_to_id: Type.Optional(Type.String({ description: "Matrix event ID to reply to. Required when is_reply is true." })),
      media: Type.Optional(Type.String({ description: "Path to local file (relative to workspace) or URL to send as media attachment." })),
      as_voice: Type.Optional(Type.Boolean({ description: "When true, sends the media attachment as a voice message (audio only). Requires media to be set to an audio file." })),
      final: Type.Optional(Type.Boolean({ description: "Whether this is the final message of your turn. Defaults to true. Set to false only when you intend to do more work and send additional messages after this one." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        message: string;
        html?: string;
        is_reply: boolean;
        reply_to_id?: string;
        media?: string;
        as_voice?: boolean;
        final?: boolean;
      };
      const isFinal = args.final !== false;

      if (args.is_reply && !args.reply_to_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: reply_to_id is required when is_reply is true. Provide the event ID of the message you want to reply to." }],
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
            role: "assistant",
            sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
            body,
            htmlBody,
            timestamp: receipt.deliveredAt,
            receivedAt: Date.now(),
          };
          await context.timeline.append(event);

          return {
            content: [{ type: "text", text: `sent: ${receipt.externalId ?? "local"}` }],
            details: { eventIds: receipt.externalId ? [receipt.externalId] : [] },
            terminate: isFinal,
          };
        }

        // No custom HTML — chunk the plaintext message as before.
        const chunks = chunkMarkdownText(body, 4000);
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
            role: "assistant",
            sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
            body: chunks[i],
            timestamp: receipt.deliveredAt,
            receivedAt: Date.now(),
          };
          await context.timeline.append(event);
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
  await assertPublicHttpUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await globalThis.fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "MikuAgent/1.0" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
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
