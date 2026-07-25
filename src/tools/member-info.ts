import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface MemberInfoToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

export function createMemberInfoTool(context: MemberInfoToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "member_info",
    label: "Member info",
    description: `Get information about a ${t.channelNoun} member including their display name, avatar, and membership state.`,
    parameters: Type.Object({
      user_id: Type.String({ description: `${t.userIdFmt}.` }),
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
        const info = await context.channelClient.memberInfo(args.user_id.trim());
        if (!info) {
          return {
            content: [{ type: "text", text: `member "${args.user_id}" not found.` }],
            details: null,
          };
        }

        const lines: string[] = [];
        lines.push(`User: ${info.userId}`);
        if (info.displayName) lines.push(`Display name: ${info.displayName}`);
        if (info.avatarUrl) lines.push(`Avatar: ${info.avatarUrl}`);
        if (info.membership) lines.push(`Membership: ${info.membership}`);
        if (info.isSelf) lines.push(`(this is you)`);
        if (info.isDirect) lines.push(`DM ${t.channelNoun}: yes`);

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
