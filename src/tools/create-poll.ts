import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MatrixNativeClient } from "../matrix/native-client.js";

export interface CreatePollToolContext {
  client: MatrixNativeClient;
  roomId: string;
}

export function createCreatePollTool(context: CreatePollToolContext): AgentTool {
  return {
    name: "create_poll",
    label: "Create poll",
    description: "Create a poll in the current room. Provide a question and 2-20 answer options.",
    parameters: Type.Object({
      question: Type.String({ description: "The poll question." }),
      options: Type.Array(Type.String({ description: "An answer option." }), { minItems: 2, maxItems: 20, description: "List of answer choices." }),
      max_selections: Type.Optional(Type.Number({ minimum: 1, description: "Maximum number of options a user can select. Default 1." })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { question: string; options: string[]; max_selections?: number };

      if (!args.question?.trim()) {
        return {
          content: [{ type: "text", text: "error: question is required." }],
          details: null,
        };
      }
      if (!args.options || args.options.length < 2) {
        return {
          content: [{ type: "text", text: "error: at least 2 options are required." }],
          details: null,
        };
      }

      try {
        const answers = args.options.map((text, i) => ({
          id: `opt${i + 1}`,
          text: text.trim(),
        }));

        const result = await context.client.createPoll({
          roomId: context.roomId,
          question: args.question.trim(),
          answers,
          maxSelections: args.max_selections,
        });

        return {
          content: [{ type: "text", text: `poll created: ${result.eventId}` }],
          details: result,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `error: create poll failed: ${message}` }],
          details: null,
        };
      }
    },
  };
}
