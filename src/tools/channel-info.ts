import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface ChannelInfoToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createChannelInfoTool(context: ChannelInfoToolContext): AgentTool {
  return {
    name: "channel_info",
    label: "Channel info",
    description: "Get information about the current room (or a specific room by ID) including its name, aliases, member count, and type.",
    parameters: Type.Object({
      room_id: Type.Optional(Type.String({ description: "Room ID to query. Defaults to the current room." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { room_id?: string };
      const targetRoom = args.room_id?.trim() || context.roomId;

      try {
        const info = await context.client.channelInfo({ roomId: targetRoom });

        const lines: string[] = [];
        lines.push(`Room: ${info.roomId}`);
        if (info.displayName) lines.push(`Name: ${info.displayName}`);
        if (info.canonicalAlias) lines.push(`Alias: ${info.canonicalAlias}`);
        if (info.altAliases.length > 0) lines.push(`Alt aliases: ${info.altAliases.join(", ")}`);
        if (info.memberCount != null) lines.push(`Members: ${info.memberCount}`);
        lines.push(`Type: ${info.isDirect ? "DM" : "group room"}`);
        lines.push(`Joined: ${info.joined ? "yes" : "no"}`);

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
