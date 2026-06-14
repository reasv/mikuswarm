import type { Storage, ChatSearchHit, ChatSearchResult } from "../storage/index.js";
import type { ChatSearchIndexer } from "./indexer.js";

export type SearchScope = "text" | "text+captions" | "all";

/**
 * Turn a free-text query into a safe, column-scoped FTS5 MATCH expression. Each
 * whitespace token becomes a quoted term (implicit AND); a trailing `*` is preserved
 * as a prefix query. Quoting neutralizes FTS5 operators so user text can't inject
 * syntax. `scope` selects the column set: "text" matches the message body only;
 * "text+captions" / "all" also match aux_text (captions + link-preview text).
 * Returns undefined when the query has no usable tokens (→ metadata-only search).
 */
export function sanitizeFtsMatch(query: string, scope: SearchScope): string | undefined {
  const terms = ftsQuotedTerms(query);
  if (terms.length === 0) return undefined;
  const cols = scope === "text" ? "body" : "body aux_text";
  return `{${cols}} : (${terms.join(" ")})`;
}

/**
 * Column-scoped MATCH expression over `summaries_fts`'s single `content` column, for
 * `search_messages(corpus:"summaries")` (§9e). Same tokenization/quoting as
 * `sanitizeFtsMatch` — only the column set differs. Returns undefined for a no-token
 * query (→ metadata-only summary search).
 */
export function sanitizeSummaryFtsMatch(query: string): string | undefined {
  const terms = ftsQuotedTerms(query);
  if (terms.length === 0) return undefined;
  return `{content} : (${terms.join(" ")})`;
}

/**
 * Column-scoped MATCH expression over `agent_sessions_fts`'s single `trigger_body`
 * column, for the console sessions filter's keyword search (ARCHITECTURE.md §11).
 * Same tokenization/quoting as `sanitizeFtsMatch` — only the column differs. Returns
 * undefined for a no-token query (→ the caller runs a metadata-only filter).
 */
export function sanitizeTriggerFtsMatch(query: string): string | undefined {
  const terms = ftsQuotedTerms(query);
  if (terms.length === 0) return undefined;
  return `{trigger_body} : (${terms.join(" ")})`;
}

/**
 * Tokenize free text into quoted FTS5 terms (implicit AND; trailing `*` = prefix
 * query). Quoting neutralizes FTS5 operators so user text can't inject syntax; pure
 * punctuation tokens are dropped. Shared by the message and summary match builders.
 */
function ftsQuotedTerms(query: string): string[] {
  const tokens = query.match(/\S+/g);
  if (!tokens || tokens.length === 0) return [];
  const terms: string[] = [];
  for (const raw of tokens) {
    const prefix = raw.endsWith("*") && raw.length > 1;
    const core = prefix ? raw.slice(0, -1) : raw;
    const escaped = core.replace(/"/g, '""');
    if (escaped.replace(/[^\p{L}\p{N}]/gu, "") === "") continue; // pure punctuation
    terms.push(prefix ? `"${escaped}"*` : `"${escaped}"`);
  }
  return terms;
}

const SNIPPET_RADIUS = 90;

/** Escape `<`/`>` so a snippet can't forge XML envelope tags in the rendered context. */
function escapeAngles(s: string): string {
  return s.replace(/</g, "‹").replace(/>/g, "›");
}

/**
 * Build a short snippet for a hit. With a text query, centers a ~180-char window on
 * the first matching token (in body, else aux_text); otherwise takes the head of the
 * body. Angle brackets are neutralized. Whitespace is collapsed.
 */
export function buildSnippet(hit: ChatSearchHit, terms: string[]): string {
  return buildSnippetFromTexts([hit.body, hit.auxText], terms);
}

/**
 * Snippet for a summary hit (`search_messages(corpus:"summaries")`, §9e): a window
 * around the first query match in the summary `content`, or its head when there is no
 * text query. Same windowing/escaping as message snippets — one haystack, the content.
 */
export function buildSummarySnippet(content: string, terms: string[]): string {
  return buildSnippetFromTexts([content], terms);
}

/**
 * Shared snippet builder over one or more haystacks (first non-empty wins for the
 * head fallback). With a text query, centers a ~180-char window on the first matching
 * token; otherwise takes the head of the first haystack. Angle brackets neutralized;
 * whitespace collapsed.
 */
function buildSnippetFromTexts(rawHaystacks: string[], terms: string[]): string {
  const haystacks = rawHaystacks.filter((s) => s.length > 0);
  const flat = (s: string): string => s.replace(/\s+/g, " ").trim();
  if (terms.length > 0) {
    for (const text of haystacks) {
      const lower = text.toLowerCase();
      let at = -1;
      for (const t of terms) {
        const i = lower.indexOf(t.toLowerCase());
        if (i >= 0 && (at < 0 || i < at)) at = i;
      }
      if (at >= 0) {
        const start = Math.max(0, at - SNIPPET_RADIUS);
        const end = Math.min(text.length, at + SNIPPET_RADIUS);
        const core = flat(text.slice(start, end));
        return escapeAngles((start > 0 ? "… " : "") + core + (end < text.length ? " …" : ""));
      }
    }
  }
  const head = haystacks[0] ?? "";
  const flat180 = flat(head).slice(0, 180);
  return escapeAngles(flat180 + (flat(head).length > 180 ? " …" : ""));
}

/**
 * Resolve the `rooms` parameter to a timeline_key filter. "current" → the room the
 * query came from; "all" / undefined-as-all → no filter (every room); an explicit
 * array → those keys. Returns undefined to mean "all rooms" (no WHERE on room).
 */
export function resolveRooms(
  rooms: string[] | "current" | "all" | undefined,
  currentTimelineKey: string,
): string[] | undefined {
  if (rooms === undefined || rooms === "current") return [currentTimelineKey];
  if (rooms === "all") return undefined;
  return rooms;
}

/** Decode a `"<timestamp>:<rowid>"` keyset cursor; undefined if malformed. */
export function decodeCursor(
  cursor: string | undefined,
): { timestamp: number; rowid: number } | undefined {
  if (!cursor) return undefined;
  const m = /^(\d+):(\d+)$/.exec(cursor.trim());
  if (!m) return undefined;
  return { timestamp: Number(m[1]), rowid: Number(m[2]) };
}

export function encodeCursor(hit: ChatSearchHit): string {
  return `${hit.timestamp}:${hit.rowid}`;
}

/** Lowercased query tokens (for the TS snippet highlighter). */
export function queryTerms(query: string | undefined): string[] {
  if (!query) return [];
  return (query.match(/\S+/g) ?? []).map((t) =>
    (t.endsWith("*") ? t.slice(0, -1) : t).toLowerCase(),
  );
}

export interface RunChatSearchResult extends ChatSearchResult {
  elapsedMs: number;
  scanned: number;
  roomCount: number;
}

/**
 * Lazily catch the index up to any brand-new events, then run the query, timing the
 * whole thing for the agent-facing latency trailer (§9e). `scanned` is the count of
 * indexed events the query ran against (for the "searched N events" trailer).
 */
export async function runChatSearch(
  storage: Storage,
  indexer: ChatSearchIndexer,
  query: Parameters<Storage["searchChatIndex"]>[0],
): Promise<RunChatSearchResult> {
  const startedAt = performance.now();
  await indexer.ensureFreshForQuery();
  const result = storage.searchChatIndex(query);
  const scanned = storage.countChatIndex(query.timelineKeys);
  const elapsedMs = Math.round(performance.now() - startedAt);
  return {
    ...result,
    elapsedMs,
    scanned,
    roomCount: query.timelineKeys ? query.timelineKeys.length : -1,
  };
}
