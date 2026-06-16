import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/**
 * Outcome of spinning a coalesced co-reply off into its own session
 * (spec DUPLICATE-REPLY-MITIGATION §5.4).
 */
export type SpawnCoReplyResult =
  | { status: "spawned" }
  | { status: "queued" }
  | { status: "not_found" }
  | { status: "error"; detail: string };

export interface SpawnSessionToolContext {
  /**
   * Re-dispatch the coalesced (interjected) co-reply identified by `messageId`
   * (its Matrix external id) into its own fresh session. The closure is bound to
   * the requesting session, so only a co-reply that was coalesced INTO this
   * session can be spun off. `not_found` when the id doesn't match a pending
   * coalesced co-reply for this session (already spun off, settled, or never
   * coalesced here).
   */
  spawnCoReply: (messageId: string) => Promise<SpawnCoReplyResult>;
}

/**
 * `spawn_session` — the inverse of `delegate_to_session` (spec
 * DUPLICATE-REPLY-MITIGATION §5.4). When two users react to the same beat their
 * triggers are coalesced into ONE session (an `<interjection reason="co-reply">`).
 * If, on reading it, the session judges the co-reply warrants independent handling
 * — two genuinely different requests, or two heavy tool-using tasks that shouldn't
 * serialize — it calls this tool to push that request back out into its own fresh
 * session. Unlike `delegate_to_session`, the CALLING session does NOT terminate: it
 * spun *off* a sibling, it didn't hand over its own work.
 */
export function createSpawnSessionTool(context: SpawnSessionToolContext): AgentTool {
  return {
    name: "spawn_session",
    label: "Spawn session",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): control flow, not state — not work.
    resumeWorkExempt: true,
    description:
      "Spin a co-reply (surfaced to you in an `<interjection reason=\"co-reply\">`) off into its own " +
      "independent agent session, identified by its message_id. Use this only when the co-reply " +
      "warrants being worked separately (a genuinely different request, or a heavy task that should " +
      "not serialize behind your current one). You keep working on your own request — this does NOT " +
      "end your turn.",
    parameters: Type.Object({
      message_id: Type.String({
        description:
          "The Matrix event id ($…) of the co-reply message to spin off, as given in the co-reply interjection.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { message_id: string };
      const messageId = args.message_id?.trim();
      if (!messageId) {
        return {
          content: [{ type: "text", text: "error: message_id is required (the $… event id from the co-reply interjection)." }],
          details: null,
        };
      }
      const result = await context.spawnCoReply(messageId);
      switch (result.status) {
        case "spawned":
          return {
            content: [{ type: "text", text: `spawned a new session to handle ${messageId} independently; continue with your own request` }],
            details: { messageId, status: result.status },
            terminate: false,
          };
        case "queued":
          return {
            content: [{ type: "text", text: `queued a new session for ${messageId} (concurrency cap reached); it will start when a slot frees. Continue with your own request.` }],
            details: { messageId, status: result.status },
            terminate: false,
          };
        case "not_found":
          return {
            content: [{ type: "text", text: `error: no pending co-reply found for message_id "${messageId}". Only a message another user co-replied with (surfaced to you in a co-reply interjection) can be spun off — handle it inline instead.` }],
            details: null,
          };
        case "error":
          return {
            content: [{ type: "text", text: `error: could not spin off ${messageId}: ${result.detail}. Handle it inline instead.` }],
            details: null,
          };
      }
    },
  };
}
