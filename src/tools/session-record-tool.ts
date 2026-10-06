import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { SummaryDraft } from "./summary-tool.js";

export { SummaryDraft };

/**
 * `session_record_tool` (spec SESSION-RECORDS §3.2, CONTRACT §1/§2):
 * a `summary_tool` / `diary_tool` variant that writes a session record into an
 * in-memory draft. The harness uses it at the end of a work-gated session.
 *
 * Behaviour:
 *   - Per-edit token budget: a mutation that would exceed `maxTokens` is atomically
 *     reverted and the error states the overage (current − limit).
 *   - Every failure THROWS (pi-agent-core marks a tool result `isError` only on
 *     a throw); a failed edit never terminates, even with `finalize: true`.
 *   - `finalize` on an empty draft is the "nothing worth recording" skip —
 *     terminates with no row written (caller inspects draft.isCreated()).
 *   - `finalize` on a non-empty draft terminates with terminate: true.
 *   - Outside the record turn the tool is blocked by the RecordTurnGate wrapper
 *     (wrapToolsWithRecordTurnGate in record-turn.ts); inside the record turn every
 *     other tool is blocked.
 *
 * Flags:
 *   `harnessOnly: true` — never surfaced in the deferred-tools index, never found
 *   by tool_search, never claimed by a skill pattern.
 *   `resumeWorkExempt: true` — calling it does not count as resumable work
 *   (spec SESSION-RECORDS CONTRACT §4).
 */

const SessionRecordToolSchema = Type.Object({
  command: Type.Union([
    Type.Literal("create"),
    Type.Literal("view"),
    Type.Literal("str_replace"),
    Type.Literal("insert"),
    Type.Literal("finalize"),
  ]),
  file_text: Type.Optional(Type.String({ description: "Required for command=create: the complete session record text." })),
  view_range: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
  old_str: Type.Optional(Type.String()),
  new_str: Type.Optional(Type.String()),
  insert_line: Type.Optional(Type.Number({ minimum: 0 })),
  finalize: Type.Optional(Type.Boolean()),
});

type SessionRecordToolArgs = {
  command: "create" | "view" | "str_replace" | "insert" | "finalize";
  file_text?: string;
  view_range?: [number, number];
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  finalize?: boolean;
};

export function createSessionRecordTool(options: {
  draft: SummaryDraft;
  maxTokens: number;
}): AgentTool {
  const { draft, maxTokens } = options;

  const tool: AgentTool = {
    name: "session_record_tool",
    label: "Session record editor",
    description:
      "Write the session record: a compact account of what was done this session " +
      "so a later session can answer questions about it and continue it. " +
      "Use `create` with `file_text` containing the record and `finalize: true` to write and finish in one call. " +
      "Use `str_replace` or `insert` to revise, and `view` to inspect. " +
      "To finish: set `finalize: true` on the final edit, or call `command: \"finalize\"` once done. " +
      "If there is nothing worth recording (the session did only conversation), " +
      "call `command: \"finalize\"` on the empty draft — this skips writing a record.",
    executionMode: "sequential",
    parameters: SessionRecordToolSchema,
    execute: async (_toolCallId, params) => {
      const args = params as SessionRecordToolArgs;
      const finalize = args.finalize === true;

      // view: never mutates; report current draft and honor finalize.
      if (args.command === "view") {
        try {
          const [start, end] = args.view_range ?? [];
          const text = draft.isCreated()
            ? draft.view(start, end)
            : "(draft is empty — use create first)";
          return { content: [{ type: "text", text }], details: { command: "view" }, terminate: finalize };
        } catch (err) {
          throw toolError(err);
        }
      }

      // `finalize` as a standalone command: commit whatever is in the draft and end.
      // An empty/uncreated draft is the "nothing worth recording" skip — still terminates.
      if (args.command === "finalize") {
        const tokens = draft.isCreated() ? draft.getTokenCount() : 0;
        const text = draft.isCreated()
          ? `Session record finalized (${tokens} tokens).`
          : "Session record finalized with no entry (nothing recorded).";
        return { content: [{ type: "text", text }], details: { command: "finalize", tokens }, terminate: true };
      }

      const snapshot = draft.snapshot();
      try {
        if (args.command === "create") {
          if (args.file_text === undefined) {
            throw new Error("create requires file_text: session_record_tool(command: \"create\", file_text: \"...\").");
          }
          draft.create(args.file_text);
        } else if (args.command === "str_replace") {
          if (args.old_str === undefined) {
            throw new Error("str_replace requires old_str (and new_str); command \"view\" shows the draft.");
          }
          draft.strReplace(args.old_str, args.new_str ?? "");
        } else {
          // insert
          if (args.insert_line === undefined) {
            throw new Error("insert requires insert_line (0 = before the first line) and new_str.");
          }
          draft.insert(args.insert_line, args.new_str ?? "");
        }
      } catch (err) {
        draft.restore(snapshot);
        throw toolError(err);
      }

      // Token budget enforcement: revert atomically if over budget. Thrown, so
      // the call is an error on the wire and a `finalize: true` on it does not
      // terminate.
      const currentTokens = draft.getTokenCount();
      if (currentTokens > maxTokens) {
        draft.restore(snapshot);
        const overage = currentTokens - maxTokens;
        throw new Error(
          `the session record would exceed its token budget: ${currentTokens} tokens, ` +
            `limit ${maxTokens} (${overage} over). The edit was reverted; shorten it and try again.`,
        );
      }

      return {
        content: [
          { type: "text", text: `${args.command} applied (${currentTokens} tokens, limit ${maxTokens}).` },
        ],
        details: { command: args.command, tokens: currentTokens, limit: maxTokens },
        terminate: finalize,
      };
    },
  };

  // Assign the classification flags. Using Object.assign instead of the literal
  // so TypeScript sees the module-augmented interface fields without a cast.
  (tool as AgentTool & { harnessOnly: boolean; resumeWorkExempt: boolean }).harnessOnly = true;
  (tool as AgentTool & { resumeWorkExempt: boolean }).resumeWorkExempt = true;
  return tool;
}

/** A draft failure as a thrown tool error (pi marks `isError` only on a throw). */
function toolError(err: unknown): Error {
  return new Error(err instanceof Error ? err.message : String(err));
}
