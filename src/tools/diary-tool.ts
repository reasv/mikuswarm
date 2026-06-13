import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { SummaryDraft } from "./summary-tool.js";
import { draftBeginsWithHeader } from "../diary/header.js";

/**
 * The diary editor (ARCHITECTURE.md §9c / design §8) — a `summary_tool` variant.
 * It edits a **fresh, empty** in-memory draft (`create`/`view`/`str_replace`/
 * `insert` + `finalize`); the worker appends that draft to the day file on success.
 * Because old entries are never in the draft, the diary session physically CANNOT
 * truncate or delete them — no whole-file guarding needed.
 *
 * Two per-edit checks, one tier (revert-on-fail; refuse to terminate even on
 * `finalize`):
 *   1. **Token budget** — draft tokens ≤ `perSessionBudget` (the new section is the
 *      whole draft, so this directly caps the increase).
 *   2. **Header-first** — the draft, whitespace-normalized, BEGINS with the exact
 *      dictated header string. The error echoes the required header so the agent can
 *      correct. We dictate the header and enforce it strictly — we do not rely on the
 *      agent matching house style.
 *
 * No separate finalize check: every failing edit is reverted, so the draft always
 * satisfies both checks and `finalize` needs no extra gating. The one special case —
 * **finalize on an empty (never-created) draft** — is the legitimate "nothing worth
 * recording" skip: it is allowed to terminate, and the worker (seeing an uncreated
 * draft) appends nothing and marks the row `done`.
 */
const DiaryToolSchema = Type.Object({
  command: Type.Union([
    Type.Literal("create"),
    Type.Literal("view"),
    Type.Literal("str_replace"),
    Type.Literal("insert"),
    Type.Literal("finalize"),
  ]),
  file_text: Type.Optional(Type.String()),
  view_range: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
  old_str: Type.Optional(Type.String()),
  new_str: Type.Optional(Type.String()),
  insert_line: Type.Optional(Type.Number({ minimum: 0 })),
  finalize: Type.Optional(Type.Boolean()),
});

type DiaryToolArgs = {
  command: "create" | "view" | "str_replace" | "insert" | "finalize";
  file_text?: string;
  view_range?: [number, number];
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  finalize?: boolean;
};

export function createDiaryTool(options: {
  draft: SummaryDraft;
  perSessionBudget: number;
  requiredHeader: string;
}): AgentTool {
  const { draft, perSessionBudget, requiredHeader } = options;

  return {
    name: "diary_tool",
    label: "Diary editor",
    description:
      "Write your new diary entry. Use `create` to start it (the very first line MUST be the exact dictated header), then `str_replace` or `insert` to revise, and `view` to inspect. To finish: either set `finalize: true` on your `create` (or final edit) call, or call `command: \"finalize\"` on its own once the entry is written — do NOT make a no-op edit just to finalize. If there is genuinely nothing worth recording, call `command: \"finalize\"` on the empty draft to finish without writing anything.",
    executionMode: "sequential",
    parameters: DiaryToolSchema,
    execute: async (_toolCallId, params) => {
      const args = params as DiaryToolArgs;
      const finalize = args.finalize === true;

      // view never mutates; report current draft and honor finalize (incl. the
      // empty-draft "nothing to record" skip — terminate with an uncreated draft).
      if (args.command === "view") {
        try {
          const [start, end] = args.view_range ?? [];
          const text = draft.isCreated()
            ? draft.view(start, end)
            : "(draft is empty — use create to start your entry, beginning with the required header line)";
          return { content: [{ type: "text", text }], details: { command: "view" }, terminate: finalize };
        } catch (err) {
          return errorResult(err);
        }
      }

      // `finalize` is a standalone terminal command (mirrors the `finalize: true`
      // parameter): commit whatever is in the draft and end, without faking a
      // no-op edit. An empty/uncreated draft is the legitimate "nothing worth
      // recording" skip → terminate, and the worker appends nothing. A created
      // draft has already passed both per-edit checks (budget + header-first), so
      // it is safe to commit as-is — same as the `finalize: true` path below.
      if (args.command === "finalize") {
        const tokens = draft.isCreated() ? draft.getTokenCount() : 0;
        const text = draft.isCreated()
          ? `Diary entry finalized (${tokens} tokens).`
          : "Diary finalized with no entry (nothing recorded).";
        return { content: [{ type: "text", text }], details: { command: "finalize", tokens }, terminate: true };
      }

      const snapshot = draft.snapshot();
      try {
        if (args.command === "create") {
          if (args.file_text === undefined) {
            return { content: [{ type: "text", text: "Error: create requires file_text." }], details: null, isError: true };
          }
          draft.create(args.file_text);
        } else if (args.command === "str_replace") {
          if (args.old_str === undefined) {
            return { content: [{ type: "text", text: "Error: str_replace requires old_str." }], details: null, isError: true };
          }
          draft.strReplace(args.old_str, args.new_str ?? "");
        } else {
          // insert
          if (args.insert_line === undefined) {
            return { content: [{ type: "text", text: "Error: insert requires insert_line." }], details: null, isError: true };
          }
          draft.insert(args.insert_line, args.new_str ?? "");
        }
      } catch (err) {
        draft.restore(snapshot);
        return errorResult(err);
      }

      // Check 1 — token budget. Reject the mutation atomically if over budget.
      const currentTokens = draft.getTokenCount();
      if (currentTokens > perSessionBudget) {
        draft.restore(snapshot);
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Diary entry would exceed token budget. ` +
                `Current: ${currentTokens} tokens, limit: ${perSessionBudget} tokens. ` +
                `Shorten the entry and try again.`,
            },
          ],
          details: { command: args.command, tokens: currentTokens, limit: perSessionBudget },
          isError: true,
          // Do NOT terminate even if finalize was true — the error needs handling.
        };
      }

      // Check 2 — header-first. The draft must begin with the exact dictated header.
      if (!draftBeginsWithHeader(draft.getContent(), requiredHeader)) {
        draft.restore(snapshot);
        return {
          content: [
            {
              type: "text",
              text:
                `Error: your diary entry must BEGIN with exactly this header line:\n` +
                `${requiredHeader}\n` +
                `Put the header as the very first line, then your diary text below it.`,
            },
          ],
          details: { command: args.command },
          isError: true,
        };
      }

      return {
        content: [
          { type: "text", text: `${args.command} applied (${currentTokens} tokens, limit ${perSessionBudget}).` },
        ],
        details: { command: args.command, tokens: currentTokens, limit: perSessionBudget },
        terminate: finalize,
      };
    },
  };
}

function errorResult(err: unknown): { content: [{ type: "text"; text: string }]; details: null; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], details: null, isError: true };
}
