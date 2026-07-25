import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderCapabilities, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface EmojiToolContext {
  channelClient: ChannelClient;
  /** Provider terminology — used to adapt the room_id description and empty-list message. */
  terminology?: ProviderTerminology;
  /**
   * When true, custom emoji are scoped to the server/guild rather than global
   * (e.g. Discord). When false or absent (Matrix), emoji are platform-wide.
   * Used to adjust the tool description; the provider enforces the actual scope.
   */
  customEmojiScoped?: ProviderCapabilities["customEmojiScoped"];
  /**
   * Optional resolver for a specific channel by id (M4/M5). When room_id is
   * supplied and this resolver is present, the tool fetches emoji for that
   * channel; when absent or returning undefined it falls back to the session
   * channelClient. Implemented by buildSessionTools via IChatProvider.channelClient
   * with a rebuilt target for the given channelId.
   */
  channelClientFor?: (channelId: string) => ChannelClient | undefined;
}

export function createEmojiListTool(context: EmojiToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  const ChannelNoun = t.channelNoun.charAt(0).toUpperCase() + t.channelNoun.slice(1);
  const scopeSuffix = context.customEmojiScoped
    ? " These are custom emoji available on this server and can be used in messages as :shortcode: and in reactions."
    : " These can be used in messages as :shortcode: and in reactions.";
  return {
    name: "emoji_list",
    label: "List custom emoji",
    description: `List available custom emoji shortcodes.${scopeSuffix}`,
    parameters: Type.Object({
      room_id: Type.Optional(Type.String({ description: `${ChannelNoun} ID to list emoji for. Defaults to the current ${t.channelNoun}.` })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "Max number of shortcodes to return. Default 50." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { room_id?: string; limit?: number };
      const effectiveChannelId = args.room_id?.trim() || undefined;
      const client = effectiveChannelId
        ? (context.channelClientFor?.(effectiveChannelId) ?? context.channelClient)
        : context.channelClient;
      const entries = await client.emojiList(args.limit ?? 50);
      if (entries.length === 0) {
        return {
          content: [{ type: "text", text: `No custom emoji found for this ${t.channelNoun}.` }],
          details: null,
        };
      }
      const shortcodes = entries.map((e) => (e.animated ? `:${e.shortcode}: (animated)` : `:${e.shortcode}:`));
      return {
        content: [{ type: "text", text: shortcodes.join(", ") }],
        details: { count: entries.length },
      };
    },
  };
}
