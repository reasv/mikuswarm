import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ChannelClient, ProviderTerminology } from "../types.js";
import { MATRIX_TERMINOLOGY } from "./terminology.js";

export interface CreatePollToolContext {
  channelClient: ChannelClient;
  terminology?: ProviderTerminology;
}

export function createCreatePollTool(context: CreatePollToolContext): AgentTool {
  const t = context.terminology ?? MATRIX_TERMINOLOGY;
  return {
    name: "create_poll",
    label: "Create poll",
    // Resume work gate (spec RESUMABLE-SESSIONS §7a): chat-surface — not work.
    resumeWorkExempt: true,
    description: `Create a poll in the current ${t.channelNoun}. Provide a question and 2-20 answer options.`,
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

      if (!context.channelClient.createPoll) {
        return {
          content: [{ type: "text", text: "error: poll creation is not supported on this channel." }],
          details: null,
        };
      }

      try {
        const result = await context.channelClient.createPoll!({
          question: args.question.trim(),
          options: args.options.map((text, i) => ({ id: `opt${i + 1}`, text: text.trim() })),
          maxSelections: args.max_selections,
        });

        return {
          content: [{ type: "text", text: `poll created: ${result.externalId}` }],
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
