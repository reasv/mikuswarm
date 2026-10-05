import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { estimateTokens } from "../context/tokens.js";

/** Thrown by draft mutations on a semantic failure (surfaced to the model, not fatal). */
class SummaryDraftError extends Error {}

/**
 * The error an editor tool (`summary_tool`, `diary_tool`) throws from `execute()`.
 * pi-agent-core marks a tool result as an error only when `execute()` throws, so
 * every failure path throws this rather than returning a result. The `Error:`
 * prefix keeps the failure legible on transports with no tool-error flag (OpenAI
 * Chat Completions / Responses); the message itself names the fix.
 */
export function draftToolError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`Error: ${message}`);
}

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

  /** Back to empty and not created (a discarded attempt is written again). */
  reset(): void {
    this.content = "";
    this.created = false;
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
        let text: string;
        try {
          const [start, end] = args.view_range ?? [];
          text = draft.isCreated() ? draft.view(start, end) : "(draft is empty — use create first)";
        } catch (err) {
          throw draftToolError(err);
        }
        return { content: [{ type: "text", text }], details: { command: "view" }, terminate: finalize };
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
          throw draftToolError("nothing to finalize — use `create` to write the summary first.");
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
          if (args.file_text === undefined) throw new SummaryDraftError("create requires file_text.");
          draft.create(args.file_text);
        } else if (args.command === "str_replace") {
          if (args.old_str === undefined) throw new SummaryDraftError("str_replace requires old_str.");
          draft.strReplace(args.old_str, args.new_str ?? "");
        } else {
          // insert
          if (args.insert_line === undefined) throw new SummaryDraftError("insert requires insert_line.");
          draft.insert(args.insert_line, args.new_str ?? "");
        }
      } catch (err) {
        draft.restore(snapshot);
        throw draftToolError(err);
      }

      // Token-limit enforcement: reject the mutation atomically if over budget.
      const currentTokens = draft.getTokenCount();
      if (currentTokens > limit) {
        draft.restore(snapshot);
        // Thrown, so a `finalize: true` on this call never terminates — the error needs handling.
        throw draftToolError(
          `Summary would exceed token limit. ` +
            `Current: ${currentTokens} tokens, limit: ${limit} tokens (target: ${targetTokenCount}). ` +
            `Shorten the summary and try again.`,
        );
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
