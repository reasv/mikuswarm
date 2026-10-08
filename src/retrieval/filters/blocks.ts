/**
 * File-level block splitting for the filter surfaces that read diary files
 * directly (recency layer, diary writer window, `search_memory`). Splits on the
 * canonical diary header exactly like the indexer (src/retrieval/chunk.ts), so
 * a header block's `contentHash` equals its index chunk's: the verdict cache
 * is shared across surfaces. (An oversized block that the indexer sub-splits
 * is judged here as one unit.)
 */
import { createHash } from "node:crypto";
import { diaryHeaderRegex } from "../../diary/header.js";
import { getConfiguredTimezone, parseZonedWallClock } from "../../time/index.js";
import { dayFromFilename } from "../chunk.js";
import { parseDiaryHeaderLine } from "../participants.js";
import type { FilterBlock } from "./service.js";

export interface FileBlock extends FilterBlock {
  /** Character offsets of the block in the file. */
  start: number;
  end: number;
}

function lineAt(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Split a memory file into its blocks (leading title-only text is not a block). */
export function splitFileBlocks(relPath: string, text: string): FileBlock[] {
  const re = diaryHeaderRegex();
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    starts.push(m.index);
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  const base = relPath.split("/").pop() ?? relPath;
  const fileDay = dayFromFilename(base);
  const fileNoon = fileDay ? parseZonedWallClock(`${fileDay} 12:00`, getConfiguredTimezone()) : null;
  const segments: Array<[number, number, boolean]> = [];
  if (starts.length === 0) segments.push([0, text.length, false]);
  else {
    if (starts[0]! > 0) segments.push([0, starts[0]!, false]);
    starts.forEach((s, i) => segments.push([s, i + 1 < starts.length ? starts[i + 1]! : text.length, true]));
  }
  const out: FileBlock[] = [];
  for (const [start, end, isHeader] of segments) {
    const seg = text.slice(start, end);
    if (!isHeader && seg.replace(/^\s*#[^\n]*\n?/, "").trim().length === 0) continue;
    if (seg.trim().length === 0) continue;
    const header = isHeader ? parseDiaryHeaderLine(seg) : null;
    out.push({
      contentHash: createHash("sha256").update(seg).digest("hex"),
      text: seg,
      path: relPath,
      startLine: lineAt(text, start),
      endLine: lineAt(text, Math.max(start, end - 1)),
      room: header?.room ?? null,
      entryTs: header?.endTs ?? fileNoon ?? null,
      start,
      end,
    });
  }
  return out;
}

/** The file text with the given blocks removed. */
export function removeBlocks(text: string, hidden: FileBlock[]): string {
  if (hidden.length === 0) return text;
  const sorted = [...hidden].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const b of sorted) {
    out += text.slice(at, b.start);
    at = b.end;
  }
  return out + text.slice(at);
}
