import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderCapabilities, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface ReactToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
  /**
   * Allowed reaction kinds for the provider (§10.2). When absent, all kinds are
   * assumed supported. Matrix: ["unicode","custom","text"]. Discord: ["unicode","custom"].
   * Used only to tailor the tool description; the provider enforces its own limits.
   */
  reactionKinds?: ProviderCapabilities["reactionKinds"];
}

function buildEmojiDescription(reactionKinds: ProviderCapabilities["reactionKinds"]): string {
  const kinds = reactionKinds ?? ["unicode", "custom", "text"];
  // When all three Matrix kinds are present, return the pre-Phase-6 string verbatim
  // so Matrix tool descriptions remain byte-identical to the pre-Phase-6 baseline.
  if (kinds.includes("unicode") && kinds.includes("custom") && kinds.includes("text")) {
    return "Emoji to react with. Unicode emoji (e.g. 👍) or :shortcode: (e.g. :custom_emoji:).";
  }
  const supportsUnicode = kinds.includes("unicode");
  const supportsCustom = kinds.includes("custom");
  const supportsText = kinds.includes("text");
  const parts: string[] = [];
  if (supportsUnicode) parts.push("unicode emoji (e.g. 👍)");
  if (supportsCustom) parts.push(":shortcode: for custom emoji (e.g. :custom_emoji:)");
  if (supportsText) parts.push("raw text strings");
  if (parts.length === 0) return "Emoji or reaction string.";
  if (parts.length === 1) return `Reaction to use: ${parts[0]}.`;
  const last = parts.pop()!;
  return `Reaction to use: ${parts.join(", ")} or ${last}.`;
}

export function createReactTool(context: ReactToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  const emojiDescription = buildEmojiDescription(context.reactionKinds);
  return {
    name: "react",
    label: "React to message",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: "Add or remove an emoji reaction on a message. Use unicode emoji directly or :shortcode: for custom emoji.",
    parameters: Type.Object({
      message_id: Type.String({ description: `${t.messageIdFmt} of the message to react to.` }),
      emoji: Type.String({ description: emojiDescription }),
      remove: Type.Optional(Type.Boolean({ description: "Set to true to remove the reaction instead of adding it." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id: string; emoji: string; remove?: boolean };

      if (!args.message_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: message_id is required." }],
          details: null,
        };
      }
      if (!args.emoji?.trim()) {
        return {
          content: [{ type: "text", text: "error: emoji is required." }],
          details: null,
        };
      }

      try {
        const messageId = args.message_id.trim();
        const emoji = args.emoji.trim();
        if (args.remove) {
          const removeResult = await context.channelClient.unreact(messageId, emoji);
          const count = (removeResult as { removed?: number } | void)?.removed;
          return {
            content: [{ type: "text", text: count != null ? `removed ${count} reaction(s)` : `removed reaction` }],
            details: null,
          };
        }
        const result = await context.channelClient.react(messageId, emoji);
        const display = (result as { display?: string } | null | void)?.display ?? emoji;
        return {
          content: [{ type: "text", text: `reacted with ${display}` }],
          details: null,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("not found") || message.includes("unknown event")) {
          return {
            content: [{ type: "text", text: `error: message_id "${args.message_id}" not found in this room. Use a valid event ID from the conversation context.` }],
            details: null,
          };
        }
        return {
          content: [{ type: "text", text: `error: reaction failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
