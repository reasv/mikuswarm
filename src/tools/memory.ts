import { mkdir } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { runRipgrep, type TextEditorArgs } from "./file.js";
import { resolveWorkspacePath } from "./workspace.js";
import { agentDateStamp } from "../time/index.js";
import type { MemoryFileWriter } from "../storage/memory-writer.js";
import type { MemorySearch, RetrievalResult } from "../retrieval/index.js";

export interface MemoryToolContext {
  workspaceRoot: string;
  now?: Date;
}

export interface RecallMemoryToolContext {
  /** Shared hybrid/lexical search engine over `memory/*.md` (ARCHITECTURE.md §9d). */
  search: MemorySearch;
  /** Defaults for the optional params (resolved from `[retrieval.query]`). */
  defaults: { maxResults: number; minScore: number };
}

export interface WriteMemoryToolContext extends MemoryToolContext {
  /**
   * Single-writer FIFO for memory-file mutations (ARCHITECTURE.md §9b). All
   * `write_memory` edits route through it so they serialize with diary appends.
   */
  memoryWriter: MemoryFileWriter;
}

export function createSearchMemoryTool(context: MemoryToolContext): AgentTool {
  return {
    name: "search_memory",
    label: "Search memory",
    description: "Search workspace daily memory markdown files with ripgrep.",
    parameters: Type.Object({
      pattern: Type.String(),
      glob: Type.Optional(Type.Array(Type.String())),
      case_sensitive: Type.Optional(Type.Boolean()),
      context_lines: Type.Optional(Type.Number({ minimum: 0, maximum: 10 })),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        pattern: string;
        glob?: string[];
        case_sensitive?: boolean;
        context_lines?: number;
        max_results?: number;
      };
      await ensureMemoryDirectory(context.workspaceRoot);
      const result = await runRipgrep(context.workspaceRoot, {
        pattern: args.pattern,
        path: "memory",
        glob: args.glob ?? ["*.md"],
        case_sensitive: args.case_sensitive,
        context_lines: args.context_lines,
        max_results: args.max_results,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  };
}

export function createRecallMemoryTool(context: RecallMemoryToolContext): AgentTool {
  return {
    name: "recall_memory",
    label: "Recall memory",
    description:
      "Semantically recall your own past diary entries from memory — ranked by relevance " +
      "(meaning, not just exact words) with temporal recency factored in. Use this to answer " +
      'questions about past conversations, decisions, people, or running bits ("what did we ' +
      'decide about X", "have I talked to Y before"). Each result cites its source as ' +
      "memory/<file>.md:<startLine>-<endLine>; open that range with the text editor or bash to " +
      "read the full entry. For an exact string/regex match (a URL, an exact phrase) use " +
      "search_memory (ripgrep) instead.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1 }),
      max_results: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      min_score: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: 1,
          description:
            "Absolute relevance floor in [0,1]; results scoring below it are dropped. " +
            "It is an absolute quality cut, not a within-results rank cut — a weak lone " +
            "match scores low and may return nothing. Default ~0.35. Lower to widen, raise to tighten.",
        }),
      ),
      room: Type.Optional(Type.String()),
      after: Type.Optional(Type.String({ description: "YYYY-MM-DD inclusive lower bound" })),
      before: Type.Optional(Type.String({ description: "YYYY-MM-DD inclusive upper bound" })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        query: string;
        max_results?: number;
        min_score?: number;
        room?: string;
        after?: string;
        before?: string;
      };
      const outcome = await context.search.search({
        query: args.query,
        maxResults: args.max_results ?? context.defaults.maxResults,
        minScore: args.min_score ?? context.defaults.minScore,
        room: args.room,
        after: args.after,
        before: args.before,
        snippetMaxChars: 700,
      });
      return {
        content: [{ type: "text", text: renderRecallResults(outcome.results, outcome) }],
        details: {
          mode: outcome.mode,
          degraded: outcome.degraded,
          ignoredDateBounds: outcome.ignoredDateBounds,
          contradictoryDateBounds: outcome.contradictoryDateBounds,
          count: outcome.results.length,
          results: outcome.results,
        },
      };
    },
  };
}

function renderRecallResults(
  results: RetrievalResult[],
  outcome: {
    mode: string;
    degraded: boolean;
    ignoredDateBounds: string[];
    contradictoryDateBounds: boolean;
  },
): string {
  const note = outcome.degraded ? " (semantic search unavailable — lexical only)" : "";
  // Surface ignored date filters so the agent doesn't believe it constrained the range
  // when an unparseable after/before was silently dropped (review issue #4b). Mirrors
  // the "lexical only" degradation-note style.
  const dateNote =
    outcome.ignoredDateBounds.length > 0
      ? ` (ignored unparseable ${outcome.ignoredDateBounds.join(" and ")} date ` +
        `filter${outcome.ignoredDateBounds.length > 1 ? "s" : ""} — use YYYY-MM-DD)`
      : "";
  // Both bounds parsed but the window is empty (`after` later than `before`). Distinct
  // from an unparseable bound — the agent should know the range was the problem, not the
  // absence of a matching memory (review issue #12). Mirrors the dateNote style.
  const rangeNote = outcome.contradictoryDateBounds
    ? " (the after/before range is empty — `after` is later than `before`)"
    : "";
  if (results.length === 0) {
    return `No matching memories found (${outcome.mode}${note})${dateNote}${rangeNote}.`;
  }
  const lines = results.map((r, i) => {
    const room = r.room ? ` · ${r.room}` : "";
    return (
      `${i + 1}. ${r.path}:${r.startLine}-${r.endLine}${room} · ${r.date} ` +
      `(${r.score.toFixed(2)})\n   ${r.snippet}`
    );
  });
  return (
    `Recalled ${results.length} memor${results.length === 1 ? "y" : "ies"} ` +
    `(${outcome.mode}${note})${dateNote}. Open a cited path:lines with the text editor or bash ` +
    `for the full entry.\n\n${lines.join("\n")}`
  );
}

export function createWriteMemoryTool(context: WriteMemoryToolContext): AgentTool {
  return {
    name: "write_memory",
    label: "Daily memory editor",
    description: "View and edit today's daily memory markdown file in the workspace memory folder.",
    parameters: Type.Object({
      command: Type.Union([
        Type.Literal("view"),
        Type.Literal("str_replace"),
        Type.Literal("insert"),
      ]),
      view_range: Type.Optional(Type.Tuple([Type.Number(), Type.Number()])),
      old_str: Type.Optional(Type.String()),
      new_str: Type.Optional(Type.String()),
      insert_line: Type.Optional(Type.Number({ minimum: 0 })),
      insert_text: Type.Optional(Type.String()),
      max_characters: Type.Optional(Type.Number({ minimum: 1, maximum: 500_000 })),
    }),
    execute: async (_toolCallId, params) => {
      const date = agentDateStamp(context.now ?? new Date());
      // `ensureDailyFile` and `editorCommand` are two separate FIFO ops, not a
      // single critical section. A diary `appendEntry` for the same day may
      // interleave between them — this is design-accepted concurrency: each op is
      // atomic, and the editor re-reads the file under `str_replace`/`insert`, so a
      // stale `old_str` simply errors back to the caller rather than corrupting.
      // View-then-edit atomicity (if ever needed) would require a single combined
      // op enqueued on the writer; we intentionally don't do that here.
      const memoryPath = await context.memoryWriter.ensureDailyFile(date);
      const relativePath = context.memoryWriter.relative(memoryPath);
      const args = params as {
        command: "view" | "str_replace" | "insert";
        view_range?: [number, number];
        old_str?: string;
        new_str?: string;
        insert_line?: number;
        insert_text?: string;
        max_characters?: number;
      };
      const result = await context.memoryWriter.editorCommand(memoryEditorArgs(relativePath, args));
      return {
        content: [{ type: "text", text: result.text }],
        details: { ...result.details, memoryPath: relativePath },
      };
    },
  };
}

function memoryEditorArgs(
  relativePath: string,
  args: {
    command: "view" | "str_replace" | "insert";
    view_range?: [number, number];
    old_str?: string;
    new_str?: string;
    insert_line?: number;
    insert_text?: string;
    max_characters?: number;
  },
): TextEditorArgs {
  if (args.command === "view") {
    return {
      command: "view",
      path: relativePath,
      view_range: args.view_range,
      max_characters: args.max_characters,
    };
  }
  if (args.command === "str_replace") {
    return {
      command: "str_replace",
      path: relativePath,
      old_str: args.old_str,
      new_str: args.new_str,
    };
  }
  return {
    command: "insert",
    path: relativePath,
    insert_line: args.insert_line,
    insert_text: args.insert_text,
  };
}

async function ensureMemoryDirectory(workspaceRoot: string): Promise<string> {
  const memoryDir = resolveWorkspacePath(workspaceRoot, "memory");
  await mkdir(memoryDir, { recursive: true });
  return memoryDir;
}
