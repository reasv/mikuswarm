import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChatProvider, CanonicalChatEvent, OutboundTarget, AttachmentMeta } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface SendMessageToolContext {
  provider: ChatProvider;
  target: OutboundTarget;
  timeline: TimelineStore;
  agentSessionId: string;
  workspaceRoot?: string;
  mediaMaxBytes?: number;
  recordSentMessage?: (message: string) => void;
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
      media: Type.Optional(Type.String({ description: "Path to local file (relative to workspace) to send as media attachment." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        message: string;
        html?: string;
        is_reply: boolean;
        reply_to_id?: string;
        media?: string;
      };

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
      if (args.media?.trim()) {
        try {
          const mediaResult = await resolveMedia(args.media.trim(), context);
          attachments = [mediaResult];
        } catch (err) {
          return {
            content: [{ type: "text", text: `error: failed to resolve media "${args.media}": ${err instanceof Error ? err.message : String(err)}` }],
            details: null,
          };
        }
      }

      try {
        const receipt = await context.provider.send(effectiveTarget, {
          body,
          htmlBody,
          attachments,
          agentSessionId: context.agentSessionId,
        });
        context.recordSentMessage?.(args.message);
        const event: CanonicalChatEvent = {
          id: `assistant:${context.agentSessionId}:${receipt.externalId ?? Date.now()}`,
          externalId: receipt.externalId,
          timelineKey: context.target.timelineKey,
          provider: context.provider.id,
          agentSessionId: context.agentSessionId,
          role: "assistant",
          sender: { id: "mikuswarm", displayName: "Miku", isSelf: true },
          body: args.message,
          htmlBody,
          timestamp: receipt.deliveredAt,
          receivedAt: Date.now(),
        };
        await context.timeline.append(event);
        return {
          content: [{ type: "text", text: `sent: ${receipt.externalId ?? "local"}` }],
          details: receipt,
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
      }
    },
  };
}

async function resolveMedia(
  mediaRef: string,
  context: SendMessageToolContext,
): Promise<AttachmentMeta> {
  const maxBytes = context.mediaMaxBytes ?? 50 * 1024 * 1024;

  const localPath = resolveWorkspacePath(mediaRef, context.workspaceRoot ?? ".");
  const stats = await stat(localPath);
  if (stats.size > maxBytes) {
    throw new Error(`file exceeds size limit (${stats.size} > ${maxBytes} bytes)`);
  }

  const filename = path.basename(localPath);
  const mimeType = guessMimeType(filename);

  return {
    id: `outbound:${Date.now()}:${filename}`,
    filename,
    mimeType,
    mediaType: classifyMediaType(mimeType),
    sizeBytes: stats.size,
    localPath,
  };
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
