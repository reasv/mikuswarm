import { mkdir } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { runRipgrep, type TextEditorArgs } from "./file.js";
import { resolveWorkspacePath } from "./workspace.js";
import { agentDateStamp } from "../time/index.js";
import type { MemoryFileWriter } from "../storage/memory-writer.js";
import type { MemorySearch, RetrievalResult } from "../retrieval/index.js";
import type { FilterBlock } from "../retrieval/filters/service.js";
import { formatCitation } from "../retrieval/excerpt.js";
import { splitFileBlocks } from "../retrieval/filters/blocks.js";
import type { UserScope } from "../retrieval/user-scope.js";
import type { LexicalHit } from "../storage/index.js";
import { dayFromFilename } from "../retrieval/chunk.js";
import { parseDiaryHeaderLine } from "../retrieval/participants.js";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface MemoryToolContext {
  workspaceRoot: string;
  now?: Date;
}

/**
 * Operator memory filters and follow-up tracking for the memory search tools
 * (ARCHITECTURE.md §9c "Memory filters", §9d "Observability").
 */
export interface MemoryToolHooks {
  /** Content hashes (of the given blocks) hidden by the agent's filters. */
  hiddenBlocks?: (blocks: FilterBlock[]) => Promise<Set<string>>;
  /** The session searched its memory (the follow-up-rate metric). */
  onFollowUp?: (kind: "recall_memory" | "search_memory") => void;
}

export interface SearchMemoryToolContext extends MemoryToolContext, MemoryToolHooks {}

export interface RecallMemoryToolContext {
  /** Shared hybrid/lexical search engine over `memory/*.md` (ARCHITECTURE.md §9d). */
  search: MemorySearch;
  /** Defaults for the optional params (resolved from `[retrieval.query]`). */
  defaults: { maxResults: number; minScore: number };
  /**
   * In agents mode: the owning agent's name so retrieval is scoped to its corpus
   * (spec MULTI-AGENT-SUPPORT §7.1). Null/absent = legacy mode (no filter).
   */
  agentName?: string | null;
  /** Excerpt length in characters (`[retrieval.query].excerpt_max_chars`, default 600). */
  excerptMaxChars?: number;
  /** Resolves the optional `user` argument to the chunks in scope. */
  userScope?: (user: string) => UserScope;
  /** Chunk rows by content hash (for the filters). */
  chunksByHash?: (hashes: string[]) => LexicalHit[];
  hooks?: MemoryToolHooks;
}

export interface WriteMemoryToolContext extends MemoryToolContext {
  /**
   * Single-writer FIFO for memory-file mutations (ARCHITECTURE.md §9b). All
   * `write_memory` edits route through it so they serialize with diary appends.
   */
  memoryWriter: MemoryFileWriter;
}

/** Internal ripgrep line cap before filtering (the user's max_results applies after). */
const SEARCH_MEMORY_RAW_CAP = 5000;

/** A ripgrep output line's file and line number (`path:12:text` or `path-12-text`). */
function rgLineRef(line: string): { file: string; line: number } | null {
  // ripgrep prints the path as given or absolute: key on its `memory/<file>.md` tail.
  const m = /^(?:.*\/)?(memory\/[^:\n/]+\.md)[:-](\d+)[:-]/.exec(line);
  return m ? { file: m[1]!, line: Number(m[2]) } : null;
}

/**
 * Drop ripgrep lines that fall inside blocks hidden by the operator's filters
 * (ARCHITECTURE.md §9c): each file with hits is split into its diary blocks
 * (the index's boundaries) and the hidden blocks' line ranges are removed.
 */
async function filterRipgrepLines(
  workspaceRoot: string,
  lines: string[],
  hiddenBlocks: NonNullable<MemoryToolHooks["hiddenBlocks"]>,
): Promise<string[]> {
  const files = new Set<string>();
  for (const l of lines) {
    const ref = rgLineRef(l);
    if (ref) files.add(ref.file);
  }
  const hiddenRanges = new Map<string, Array<[number, number]>>();
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(path.join(workspaceRoot, file), "utf8");
    } catch {
      continue;
    }
    const blocks = splitFileBlocks(file, text);
    const hidden = await hiddenBlocks(blocks);
    const ranges = blocks.filter((b) => hidden.has(b.contentHash)).map((b) => [b.startLine, b.endLine] as [number, number]);
    if (ranges.length > 0) hiddenRanges.set(file, ranges);
  }
  if (hiddenRanges.size === 0) return lines;
  const out: string[] = [];
  for (const l of lines) {
    const ref = rgLineRef(l);
    const ranges = ref ? hiddenRanges.get(ref.file) : undefined;
    if (ranges && ranges.some(([a, b]) => ref!.line >= a && ref!.line <= b)) continue;
    out.push(l);
  }
  // Collapse separator runs left by dropped context groups.
  return out.filter((l, i) => !(l === "--" && (i === 0 || out[i - 1] === "--" || i === out.length - 1)));
}

export function createSearchMemoryTool(context: SearchMemoryToolContext): AgentTool {
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
      context.onFollowUp?.("search_memory");
      if (!context.hiddenBlocks) {
        const result = await runRipgrep(context.workspaceRoot, {
          pattern: args.pattern,
          path: "memory",
          glob: args.glob ?? ["*.md"],
          case_sensitive: args.case_sensitive,
          context_lines: args.context_lines,
          max_results: args.max_results,
        });
        return { content: [{ type: "text", text: result.text }], details: result.details };
      }
      // Filters (§9c): fetch generously, drop lines inside hidden blocks, then cap.
      const raw = await runRipgrep(context.workspaceRoot, {
        pattern: args.pattern,
        path: "memory",
        glob: args.glob ?? ["*.md"],
        case_sensitive: args.case_sensitive,
        context_lines: args.context_lines,
        max_results: SEARCH_MEMORY_RAW_CAP,
      });
      const rawLines = raw.text === "No matches." ? [] : raw.text.split("\n").filter(Boolean);
      const kept = await filterRipgrepLines(context.workspaceRoot, rawLines, context.hiddenBlocks);
      const maxResults = args.max_results ?? 100;
      const selected = kept.slice(0, maxResults);
      return {
        content: [{ type: "text", text: selected.join("\n") || "No matches." }],
        details: {
          ...raw.details,
          count: kept.length,
          truncated: kept.length > selected.length || raw.details.truncated,
        },
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
      'decide about X", "have I talked to Y before"; pass `user` to keep only conversations that person took part in). ' +
      "Each result cites its source as " +
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
      user: Type.Optional(
        Type.String({
          description:
            "Only memories of conversations this person took part in (a sender id as shown in context, or a display name); " +
            "entries that name them count too.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as {
        query: string;
        max_results?: number;
        min_score?: number;
        room?: string;
        after?: string;
        before?: string;
        user?: string;
      };
      context.hooks?.onFollowUp?.("recall_memory");
      let scope: UserScope | undefined;
      if (args.user && args.user.trim().length > 0 && context.userScope) {
        scope = context.userScope(args.user);
        if (scope.rowids.length === 0) {
          return {
            content: [
              {
                type: "text",
                text:
                  `No memories found with "${args.user}" (no tagged conversation with that person and no entry naming them). ` +
                  "Check the name or sender id as shown in context, or call recall_memory without user.",
              },
            ],
            details: { count: 0, user: args.user, results: [] },
          };
        }
      }
      const maxResults = args.max_results ?? context.defaults.maxResults;
      const filtering = context.hooks?.hiddenBlocks !== undefined && context.chunksByHash !== undefined;
      // No `now` passed: the tool intentionally anchors temporal decay on wall-clock
      // `Date.now()` (search.ts default). It is a live, one-shot agent action that
      // reasons in the present — unlike the cache-stable auto-retrieval/diary layers,
      // which anchor on trigger time for determinism (review issue #15).
      const outcome = await context.search.search({
        query: args.query,
        // Over-fetch a little so filter-hidden results do not shrink the answer.
        maxResults: filtering ? maxResults + 5 : maxResults,
        minScore: args.min_score ?? context.defaults.minScore,
        room: args.room,
        after: args.after,
        before: args.before,
        snippetMaxChars: context.excerptMaxChars ?? 600,
        agentName: context.agentName,
        ...(scope ? { rowidScope: scope.rowids } : {}),
      });
      if (filtering && outcome.results.length > 0) {
        const rows = context.chunksByHash!(outcome.results.map((r) => r.contentHash));
        const blocks: FilterBlock[] = rows.map((r) => ({
          contentHash: r.contentHash,
          text: r.text,
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          room: r.room,
          entryTs: parseDiaryHeaderLine(r.text) || dayFromFilename(r.path.split("/").pop() ?? "") ? r.entryTs : null,
        }));
        const hidden = await context.hooks!.hiddenBlocks!(blocks);
        outcome.results = outcome.results.filter((r) => !hidden.has(r.contentHash));
      }
      outcome.results = outcome.results.slice(0, maxResults);
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
  const lines = results.map(
    (r, i) => `${i + 1}. [${formatCitation(r)}] (${r.score.toFixed(2)})\n   ${r.snippet.replace(/\n/g, "\n   ")}`,
  );
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
      view_range: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
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
