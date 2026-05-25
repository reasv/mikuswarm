import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface MemberInfoToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createMemberInfoTool(context: MemberInfoToolContext): AgentTool {
  return {
    name: "member_info",
    label: "Member info",
    description: "Get information about a room member including their display name, avatar, and membership state.",
    parameters: Type.Object({
      user_id: Type.String({ description: "Matrix user ID (e.g. @user:server.com)." }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { user_id: string };

      if (!args.user_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: user_id is required." }],
          details: null,
        };
      }

      try {
        const info = await context.client.memberInfo({
          roomId: context.roomId,
          userId: args.user_id.trim(),
        });

        const lines: string[] = [];
        lines.push(`User: ${info.userId}`);
        if (info.displayName) lines.push(`Display name: ${info.displayName}`);
        if (info.avatarUrl) lines.push(`Avatar: ${info.avatarUrl}`);
        if (info.membership) lines.push(`Membership: ${info.membership}`);
        if (info.isSelf) lines.push(`(this is you)`);
        if (info.isDirect) lines.push(`DM room: yes`);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: info,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: member info failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
