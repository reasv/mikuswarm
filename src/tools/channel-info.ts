import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface ChannelInfoToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
  /**
   * Optional resolver for a specific channel by id (M4/M5). When room_id is
   * supplied and this resolver is present, the tool queries that channel's info;
   * when absent or returning undefined it falls back to the session channelClient.
   * Implemented by buildSessionTools via IChatProvider.channelClient with a
   * rebuilt target for the given channelId.
   */
  channelClientFor?: (channelId: string) => ChannelClient | undefined;
}

export function createChannelInfoTool(context: ChannelInfoToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  // Capitalized channel noun for the room_id description (e.g. "Room" vs "Channel")
  const ChannelNoun = t.channelNoun.charAt(0).toUpperCase() + t.channelNoun.slice(1);
  return {
    name: "channel_info",
    label: "Channel info",
    description: `Get information about the current ${t.channelNoun} (or a specific ${t.channelNoun} by ID) including its name, aliases, member count, and type.`,
    parameters: Type.Object({
      room_id: Type.Optional(Type.String({ description: `${ChannelNoun} ID to query. Defaults to the current ${t.channelNoun}.` })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { room_id?: string };
      const effectiveChannelId = args.room_id?.trim() || undefined;
      const client = effectiveChannelId
        ? (context.channelClientFor?.(effectiveChannelId) ?? context.channelClient)
        : context.channelClient;
      try {
        const info = await client.channelInfo();

        const lines: string[] = [];
        lines.push(`${ChannelNoun}: ${info.channelId}`);
        if (info.displayName) lines.push(`Name: ${info.displayName}`);
        if (info.canonicalAlias) lines.push(`Alias: ${info.canonicalAlias}`);
        if (info.altAliases && info.altAliases.length > 0) lines.push(`Alt aliases: ${info.altAliases.join(", ")}`);
        if (info.memberCount != null) lines.push(`Members: ${info.memberCount}`);
        lines.push(`Type: ${info.isDirect ? "DM" : `group ${t.channelNoun}`}`);
        if (info.joined != null) lines.push(`Joined: ${info.joined ? "yes" : "no"}`);
        if (info.serverName) lines.push(`Server: ${info.serverName}`);
        if (info.topic) lines.push(`Topic: ${info.topic}`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: info,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: channel info failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
