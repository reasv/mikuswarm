import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface EmojiToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createEmojiListTool(context: EmojiToolContext): AgentTool {
  return {
    name: "emoji_list",
    label: "List custom emoji",
    description: "List available custom emoji shortcodes. These can be used in messages as :shortcode: and in reactions.",
    parameters: Type.Object({
      room_id: Type.Optional(Type.String({ description: "Room ID to list emoji for. Defaults to the current room." })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, description: "Max number of shortcodes to return. Default 50." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { room_id?: string; limit?: number };
      const shortcodes = context.client.listKnownShortcodes({
        roomId: args.room_id ?? context.roomId,
        limit: args.limit ?? 50,
      });
      if (shortcodes.length === 0) {
        return {
          content: [{ type: "text", text: "No custom emoji found for this room." }],
          details: null,
        };
      }
      return {
        content: [{ type: "text", text: shortcodes.join(", ") }],
        details: { count: shortcodes.length },
      };
    },
  };
}
