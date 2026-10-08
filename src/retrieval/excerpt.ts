/**
 * Readable memory excerpts and compact citations (ARCHITECTURE.md §9d
 * "Excerpts"). Shared by auto-retrieval and `recall_memory`.
 *
 * - A block up to the budget is shown whole; a longer one shows its own
 *   heading text plus a window around its best-matching region (the line or
 *   sentence with the highest query-term overlap, else the highest vector
 *   similarity when the caller can score units), expanded to whole units and
 *   marked `…` where cut.
 * - The diary header line is dropped (its room and date are in the citation),
 *   markdown heading markers are stripped, and a heading that only restates
 *   the time is dropped.
 * - The citation is `memory/<file>.md:<start>-<end>`, then the room when
 *   known, then the date only when the file name does not already carry it.
 */
import { estimateTokens, truncateToTokens } from "../context/tokens.js";
import { agentDateStamp } from "../time/index.js";
import { dayFromFilename } from "./chunk.js";

/** The canonical diary header line (src/diary/header.ts), anchored to one line. */
const DIARY_HEADER_LINE =
  /^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+→\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+·\s+\S.*$/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

const TIME_WORDS = new Set([
  "morning", "afternoon", "evening", "night", "midnight", "noon", "midday", "late", "early", "dawn",
  "dusk", "today", "tonight", "yesterday", "overnight", "later", "earlier",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
  "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "am", "pm", "utc", "gmt",
  // Filler that, beside a time, still only says "what happened when".
  "events", "event", "update", "updates", "entry", "entries", "log", "notes", "note", "session", "sessions",
  "recap", "summary", "around", "about", "at", "approx", "approximately", "the", "of", "and", "in", "on",
  "continued", "cont", "part", "time", "day",
]);

/**
 * True when a heading's text only restates the time ("Evening Events (~7:33 PM)",
 * "2026-05-22", "Tuesday night"): nothing is left once times, dates, time-of-day
 * words and filler are removed.
 */
export function headingOnlyRestatesTime(heading: string): boolean {
  const stripped = heading
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}/g, " ")
    .replace(/\d{1,2}(:\d{2}){1,2}/g, " ")
    .replace(/\b\d{1,2}\s*(a\.?m\.?|p\.?m\.?)/g, " ")
    .replace(/\b\d{1,4}(st|nd|rd|th)?\b/g, " ");
  const words = stripped.match(/[\p{L}]+/gu) ?? [];
  return words.every((w) => TIME_WORDS.has(w));
}

export interface CleanBlock {
  /** The block's first surviving heading text (markers stripped), if any. */
  heading: string | null;
  /** Body lines (heading lines kept as plain text), blank runs collapsed. */
  lines: string[];
}

/** Strip the diary header line, heading markers and time-only headings. */
export function cleanBlockText(text: string): CleanBlock {
  let heading: string | null = null;
  const lines: string[] = [];
  let blank = false;
  for (const raw of text.split(/\r?\n/)) {
    if (DIARY_HEADER_LINE.test(raw)) continue;
    const h = HEADING_LINE.exec(raw);
    let line = raw;
    if (h) {
      const content = (h[1] ?? "").trim();
      if (content.length === 0 || headingOnlyRestatesTime(content)) continue;
      heading ??= content;
      line = content;
    }
    if (line.trim().length === 0) {
      blank = lines.length > 0;
      continue;
    }
    if (blank) lines.push("");
    blank = false;
    lines.push(line.trimEnd());
  }
  return { heading, lines };
}

const STOP = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does", "for", "from",
  "had", "has", "have", "he", "her", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then", "there", "they",
  "this", "to", "up", "us", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your",
]);

/** Distinct lowercase content terms of some query texts (stopwords dropped). */
export function queryTerms(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (w.length >= 2 && !STOP.has(w)) out.add(w);
    }
  }
  return [...out].slice(0, 64);
}

/** Split body lines into excerpt units: a line, or a sentence of a long line. */
function units(lines: string[]): Array<{ text: string; breakBefore: boolean }> {
  const out: Array<{ text: string; breakBefore: boolean }> = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const parts = line.length > 200 ? line.split(/(?<=[.!?])\s+(?=\S)/) : [line];
    parts.forEach((p, i) => out.push({ text: p, breakBefore: i === 0 }));
  }
  return out;
}

function overlap(unit: string, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  let n = 0;
  const seen = new Set<string>();
  for (const w of unit.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (terms.has(w) && !seen.has(w)) {
      seen.add(w);
      n += 1;
    }
  }
  return n;
}

export interface ExcerptOptions {
  /** Query texts the window centres on. */
  queries: string[];
  /** Budget: tokens (auto-retrieval) or characters (`recall_memory`). */
  budget: { tokens: number } | { chars: number };
  /**
   * Optional semantic scorer for the units (higher = closer to the query), used
   * when no unit shares a term with the query. Errors fall back to the head.
   */
  scoreUnits?: (units: string[]) => Promise<number[]>;
}

function measureFor(budget: ExcerptOptions["budget"]): { size: (s: string) => number; limit: number; chars: boolean } {
  return "tokens" in budget
    ? { size: estimateTokens, limit: budget.tokens, chars: false }
    : { size: (s) => s.length, limit: budget.chars, chars: true };
}

function joinUnits(list: Array<{ text: string; breakBefore: boolean }>): string {
  let out = "";
  list.forEach((u, i) => {
    if (i === 0) out = u.text;
    else out += (u.breakBefore ? "\n" : " ") + u.text;
  });
  return out;
}

/** A whole-word window of `text` around its first query-term hit, `…` where cut. */
function clipAround(text: string, terms: Set<string>, limit: number, size: (s: string) => number): string {
  const words = text.split(/\s+/).filter(Boolean);
  let hit = words.findIndex((w) => {
    const t = w.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    return t.some((x) => terms.has(x));
  });
  if (hit < 0) hit = 0;
  let lo = hit;
  let hi = hit;
  const render = (a: number, b: number) =>
    `${a > 0 ? "… " : ""}${words.slice(a, b + 1).join(" ")}${b < words.length - 1 ? " …" : ""}`;
  for (let grew = true; grew; ) {
    grew = false;
    if (hi + 1 < words.length && size(render(lo, hi + 1)) <= limit) {
      hi += 1;
      grew = true;
    }
    if (lo - 1 >= 0 && size(render(lo - 1, hi)) <= limit) {
      lo -= 1;
      grew = true;
    }
  }
  return render(lo, hi);
}

function clip(text: string, limit: number, chars: boolean): string {
  if (chars) return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
  return estimateTokens(text) <= limit ? text : `${truncateToTokens(text, Math.max(1, limit - 1)).trimEnd()}…`;
}

/**
 * The excerpt of one block: whole when it fits the budget, else its heading
 * plus a match-centred window of whole units, `…` where cut.
 */
export async function makeExcerpt(text: string, opts: ExcerptOptions): Promise<string> {
  const clean = cleanBlockText(text);
  const { size, limit, chars } = measureFor(opts.budget);
  const whole = clean.lines.join("\n");
  if (size(whole) <= limit) return whole;

  const list = units(clean.lines);
  if (list.length === 0) return "";
  const terms = new Set(queryTerms(opts.queries));
  let scores = list.map((u) => overlap(u.text, terms));
  if (scores.every((s) => s === 0) && opts.scoreUnits) {
    try {
      const semantic = await opts.scoreUnits(list.map((u) => u.text));
      if (semantic.length === list.length) scores = semantic;
    } catch {
      // keep the lexical scores (all zero → the head)
    }
  }
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[best]!) best = i;

  // The block's own heading leads the window (unless the window contains it).
  const headingLine = clean.heading;
  const headingCost = headingLine ? size(headingLine) + 1 : 0;
  const room = limit - headingCost - (chars ? 4 : 2); // the two `…` marks
  let lo = best;
  let hi = best;
  let used = size(list[best]!.text);
  if (used > room) {
    // One unit alone overflows: a word window around its first matching term.
    const body = clipAround(list[best]!.text, terms, Math.max(1, room), size);
    return [headingLine, `${best > 0 && !body.startsWith("…") ? "… " : ""}${body}`].filter(Boolean).join("\n");
  }
  // Grow alternately after then before, whole units only.
  for (let grew = true; grew; ) {
    grew = false;
    if (hi + 1 < list.length) {
      const cost = size(list[hi + 1]!.text) + 1;
      if (used + cost <= room) {
        hi += 1;
        used += cost;
        grew = true;
      }
    }
    if (lo - 1 >= 0) {
      const cost = size(list[lo - 1]!.text) + 1;
      if (used + cost <= room) {
        lo -= 1;
        used += cost;
        grew = true;
      }
    }
  }
  const head = lo > 0 ? "… " : "";
  const tail = hi < list.length - 1 ? " …" : "";
  const windowUnits = list.slice(lo, hi + 1);
  const windowText = `${head}${joinUnits(windowUnits)}${tail}`;
  const showHeading = headingLine !== null && !windowUnits.some((u) => u.text === headingLine);
  return [showHeading ? headingLine : null, windowText].filter(Boolean).join("\n");
}

export interface CitedBlock {
  path: string;
  startLine: number;
  endLine: number;
  room: string | null;
  entryTs: number;
}

/**
 * The compact citation: path and lines, the room when known, and the date
 * only when the file name does not already carry it.
 */
export function formatCitation(block: CitedBlock): string {
  const parts = [`${block.path}:${block.startLine}-${block.endLine}`];
  if (block.room) parts.push(block.room);
  const base = block.path.split("/").pop() ?? block.path;
  if (!dayFromFilename(base)) parts.push(agentDateStamp(block.entryTs));
  return parts.join(" · ");
}

/** Neutralize angle brackets so diary text cannot forge the surrounding tags. */
export function escapeAngleBrackets(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Indent continuation lines so a multi-line excerpt stays inside its list item. */
export function indentContinuation(text: string): string {
  return text.replace(/\n/g, "\n  ");
}
