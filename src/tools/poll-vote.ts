import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface PollVoteToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createPollVoteTool(context: PollVoteToolContext): AgentTool {
  return {
    name: "poll_vote",
    label: "Vote in poll",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: "Vote in an existing poll by selecting one or more answer IDs.",
    parameters: Type.Object({
      poll_event_id: Type.String({ description: "Matrix event ID of the poll to vote in." }),
      answers: Type.Array(Type.String({ description: "Answer ID to vote for (e.g. 'opt1')." }), { minItems: 1, description: "Answer IDs to select." }),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { poll_event_id: string; answers: string[] };

      if (!args.poll_event_id?.trim()) {
        return {
          content: [{ type: "text", text: "error: poll_event_id is required." }],
          details: null,
        };
      }
      if (!args.answers || args.answers.length === 0) {
        return {
          content: [{ type: "text", text: "error: at least one answer is required." }],
          details: null,
        };
      }

      try {
        const result = await context.client.pollVote({
          roomId: context.roomId,
          pollEventId: args.poll_event_id.trim(),
          answerIds: args.answers,
        });

        return {
          content: [{ type: "text", text: `vote submitted: ${result.eventId}` }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: poll vote failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
