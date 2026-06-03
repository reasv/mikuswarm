import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { estimateTokens, truncateToTokens } from "../context/tokens.js";
import { diaryHeaderRegex } from "./header.js";

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/**
 * The recent-memory window (ARCHITECTURE.md §9a) — the shared helper behind both
 * continuity inputs (the diary session's read-only context §8 and the §10a chat
 * surfacing), so sparsity is handled identically in both places.
 *
 * Lists every `memory/YYYY-MM-DD.md` whose filename date is **≤ `anchorDay`**, sorts
 * descending by date, takes the first `fileCount`, concatenates **newest-last**, then
 * applies the header-trim: split on the §4 header regex and drop earliest-in-text
 * blocks until the estimate is ≤ `ceilingTokens`.
 *
 * Walking the N most recent *existing* files (rather than the calendar
 * `[anchorDay−1, anchorDay]`) bridges arbitrary gaps: day files are sparse (written
 * only when something happened), so a calendar window silently surfaces nothing for a
 * slow room. Unbounded staleness is accepted — for a diary that is desired continuity.
 * The directory listing is cheap (`readdir` + filename filter); only the selected
 * files are read.
 *
 * Returns the trimmed concatenation (possibly empty string when no day files exist).
 */
export async function recentMemoryWindow(opts: {
  workspaceRoot: string;
  anchorDay: string;
  ceilingTokens: number;
  fileCount: number;
}): Promise<string> {
  const { workspaceRoot, anchorDay, ceilingTokens, fileCount } = opts;
  const memoryDir = path.join(workspaceRoot, "memory");

  let entries: string[];
  try {
    entries = await readdir(memoryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }

  // Filename date ≤ anchorDay; ISO dates sort lexicographically.
  const dates = entries
    .map((name) => DAY_FILE_RE.exec(name)?.[1])
    .filter((d): d is string => d != null && d <= anchorDay)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // descending

  const selected = dates.slice(0, Math.max(0, fileCount));
  if (selected.length === 0) return "";

  // Concatenate newest-last → read in ascending order.
  selected.reverse();
  const contents: string[] = [];
  for (const date of selected) {
    try {
      contents.push(await readFile(path.join(memoryDir, `${date}.md`), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // raced deletion
      throw error;
    }
  }
  if (contents.length === 0) return "";

  const joined = contents.join("\n\n");
  return trimToTokenCeiling(joined, ceilingTokens);
}

/**
 * Trim concatenated day-file text to `ceilingTokens` by splitting on the §4 header
 * pattern and dropping whole blocks from the front (earliest in text order — dates
 * don't matter for trimming) until it fits. Legacy header-less content (imported
 * OpenClaw files) has no split points, so its only droppable unit is the whole text
 * (the coarse §10a fallback). A single residual block still over budget is
 * hard-truncated to keep the layer strictly bounded.
 */
export function trimToTokenCeiling(text: string, ceilingTokens: number): string {
  if (estimateTokens(text) <= ceilingTokens) return text;

  const blocks = splitIntoHeaderBlocks(text);
  // Drop earliest-in-text blocks until it fits or one block remains.
  let start = 0;
  while (start < blocks.length - 1) {
    const candidate = blocks.slice(start).join("");
    if (estimateTokens(candidate) <= ceilingTokens) return candidate.replace(/^\s+/, "");
    start += 1;
  }
  const remainder = blocks.slice(start).join("").replace(/^\s+/, "");
  if (estimateTokens(remainder) <= ceilingTokens) return remainder;
  // Single residual block (or header-less whole) still over budget → hard-truncate.
  return truncateToTokens(remainder, ceilingTokens);
}

/**
 * Split text into header-delimited blocks. Any content before the first `## ` header
 * (e.g. a file's `# <date> Daily Memory` top line, or legacy text) is its own leading
 * block; each `## ` header starts a new block running to the next header. Header-less
 * text yields a single block (the whole thing).
 */
function splitIntoHeaderBlocks(text: string): string[] {
  const re = diaryHeaderRegex();
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    indices.push(m.index);
    if (re.lastIndex === m.index) re.lastIndex += 1; // guard against zero-width loops
  }
  if (indices.length === 0) return [text];

  const blocks: string[] = [];
  if (indices[0]! > 0) blocks.push(text.slice(0, indices[0]!));
  for (let i = 0; i < indices.length; i++) {
    const begin = indices[i]!;
    const end = i + 1 < indices.length ? indices[i + 1]! : text.length;
    blocks.push(text.slice(begin, end));
  }
  return blocks;
}
