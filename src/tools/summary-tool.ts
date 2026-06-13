import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { estimateTokens } from "../context/tokens.js";

/** Thrown by draft mutations on a semantic failure (surfaced to the model, not fatal). */
class SummaryDraftError extends Error {}

interface DraftSnapshot {
  content: string;
  created: boolean;
}

/** An in-memory mutable summary document with token estimation. */
export class SummaryDraft {
  private content = "";
  private created = false;

  isCreated(): boolean {
    return this.created;
  }

  getContent(): string {
    return this.content;
  }

  getTokenCount(): number {
    return estimateTokens(this.content);
  }

  create(content: string): void {
    if (this.created) {
      throw new SummaryDraftError("Draft already created. Use str_replace or insert to modify.");
    }
    if (!content.trim()) {
      throw new SummaryDraftError("file_text must not be empty.");
    }
    this.content = content;
    this.created = true;
  }

  /** Line-numbered view, same format as str_replace_based_edit_tool. */
  view(startLine?: number, endLine?: number): string {
    const lines = this.content.split(/\r?\n/);
    const start = startLine ?? 1;
    if (start < 1) throw new SummaryDraftError("view_range start must be >= 1");
    if (this.content.length > 0 && start > lines.length) {
      throw new SummaryDraftError(`view_range.start (${start}) is past end of draft (${lines.length} lines)`);
    }
    const end = endLine === undefined || endLine === -1 ? lines.length : endLine;
    if (end < start) throw new SummaryDraftError("view_range end must be >= start or -1");
    const selected = lines.slice(start - 1, end);
    return selected.map((line, index) => `${start + index}: ${line}`).join("\n");
  }

  strReplace(oldStr: string, newStr: string): void {
    if (!this.created) throw new SummaryDraftError("Draft not created yet. Use create first.");
    if (oldStr === "") throw new SummaryDraftError("old_str must not be empty");
    const first = this.content.indexOf(oldStr);
    if (first < 0) {
      throw new SummaryDraftError(
        `old_str was not found in the draft.\nCurrent draft contents:\n${this.content}`,
      );
    }
    const second = this.content.indexOf(oldStr, first + oldStr.length);
    if (second >= 0) {
      throw new SummaryDraftError(
        `old_str matched more than once in the draft.\nCurrent draft contents:\n${this.content}`,
      );
    }
    this.content = `${this.content.slice(0, first)}${newStr}${this.content.slice(first + oldStr.length)}`;
  }

  insert(lineNumber: number, text: string): void {
    if (!this.created) throw new SummaryDraftError("Draft not created yet. Use create first.");
    const lines = this.content.split(/\r?\n/);
    if (lineNumber < 0) throw new SummaryDraftError("insert_line must be >= 0");
    if (lineNumber > lines.length) {
      throw new SummaryDraftError(`insert_line ${lineNumber} is past end of draft (${lines.length} lines)`);
    }
    const insertLines = text.split(/\r?\n/);
    const next = [...lines.slice(0, lineNumber), ...insertLines, ...lines.slice(lineNumber)];
    this.content = next.join("\n");
  }

  snapshot(): DraftSnapshot {
    return { content: this.content, created: this.created };
  }

  restore(snapshot: DraftSnapshot): void {
    this.content = snapshot.content;
    this.created = snapshot.created;
  }
}

const SummaryToolSchema = Type.Object({
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

type SummaryToolArgs = {
  command: "create" | "view" | "str_replace" | "insert" | "finalize";
  file_text?: string;
  view_range?: [number, number];
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  finalize?: boolean;
};

export function createSummaryTool(options: {
  draft: SummaryDraft;
  targetTokenCount: number;
  maxOverageFactor: number;
}): AgentTool {
  const { draft, targetTokenCount, maxOverageFactor } = options;
  const limit = Math.floor(targetTokenCount * maxOverageFactor);

  return {
    name: "summary_tool",
    label: "Summary editor",
    description:
      "Write and revise the summary document. Use `create` to start the summary, then `str_replace` or `insert` to revise it, and `view` to inspect it. To finish: either set `finalize: true` on your `create` (or final edit) call to commit it in the same step, or — if the draft is already written — call `command: \"finalize\"` on its own. `finalize` is a parameter or a standalone command; do NOT make a no-op edit (e.g. replacing text with itself) or re-view the draft just to finalize.",
    executionMode: "sequential",
    parameters: SummaryToolSchema,
    execute: async (_toolCallId, params) => {
      const args = params as SummaryToolArgs;
      const finalize = args.finalize === true;

      // view never mutates; report current draft and honor finalize.
      if (args.command === "view") {
        try {
          const [start, end] = args.view_range ?? [];
          const text = draft.isCreated() ? draft.view(start, end) : "(draft is empty — use create first)";
          return { content: [{ type: "text", text }], details: { command: "view" }, terminate: finalize };
        } catch (err) {
          return errorResult(err);
        }
      }

      // `finalize` is a standalone terminal command: commit the current draft and
      // end the session in a single call, without faking a no-op edit. The model
      // consistently reaches for `command: "finalize"` on its own (it reads the
      // instruction's "finalize" as a verb), so accepting it — alongside the
      // `finalize: true` parameter — removes a wasted validation-error round trip
      // and the identity `str_replace` it used to invent. A summary must have
      // content, so finalizing an empty/uncreated draft is an error, not a skip.
      if (args.command === "finalize") {
        if (!draft.isCreated() || draft.getContent().trim().length === 0) {
          return {
            content: [
              { type: "text", text: "Error: nothing to finalize — use `create` to write the summary first." },
            ],
            details: { command: "finalize" },
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Summary finalized (${draft.getTokenCount()} tokens).` }],
          details: { command: "finalize", tokens: draft.getTokenCount() },
          terminate: true,
        };
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

      // Token-limit enforcement: reject the mutation atomically if over budget.
      const currentTokens = draft.getTokenCount();
      if (currentTokens > limit) {
        draft.restore(snapshot);
        return {
          content: [
            {
              type: "text",
              text:
                `Error: Summary would exceed token limit. ` +
                `Current: ${currentTokens} tokens, limit: ${limit} tokens (target: ${targetTokenCount}). ` +
                `Shorten the summary and try again.`,
            },
          ],
          details: { command: args.command, tokens: currentTokens, limit },
          isError: true,
          // Do NOT terminate even if finalize was true — the error needs handling.
        };
      }

      return {
        content: [
          { type: "text", text: `${args.command} applied (${currentTokens} tokens, limit ${limit}).` },
        ],
        details: { command: args.command, tokens: currentTokens, limit },
        terminate: finalize,
      };
    },
  };
}

function errorResult(err: unknown): { content: [{ type: "text"; text: string }]; details: null; isError: true } {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], details: null, isError: true };
}
