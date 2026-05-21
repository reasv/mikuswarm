import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { CanonicalChatEvent } from "../types.js";

export interface DelegateToolContext {
  currentEvent: CanonicalChatEvent;
  steerSession: (sessionId: string, content: string) => boolean;
}

export function createDelegateToSessionTool(context: DelegateToolContext): AgentTool {
  return {
    name: "delegate_to_session",
    label: "Delegate to session",
    description: "Route the current user request into another running agent session.",
    parameters: Type.Object({
      session_id: Type.String(),
      note: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { session_id: string; note?: string };
      const content = [
        args.note ? `<delegation_note>${escapeXml(args.note)}</delegation_note>` : undefined,
        `<message sender="${escapeXml(context.currentEvent.sender.displayName ?? context.currentEvent.sender.id)}" time="${new Date(context.currentEvent.timestamp).toISOString()}">
${escapeXml(context.currentEvent.body)}
</message>`,
      ]
        .filter(Boolean)
        .join("\n");
      const ok = context.steerSession(args.session_id, content);
      return {
        content: [{ type: "text", text: ok ? "delegated" : "delegation failed: target session is not running" }],
        details: { sessionId: args.session_id, delegated: ok },
        terminate: ok,
      };
    },
  };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
