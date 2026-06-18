import { createHash } from "node:crypto";
import type { Tokenizer } from "../context/tokenizer/types.js";
import { getConfiguredTimezone, parseZonedWallClock } from "../time/index.js";
import { diaryHeaderRegex } from "../diary/header.js";

/**
 * One indexable unit of memory (ARCHITECTURE.md §9d / design §3). For a normal
 * header-delimited day file this is a single first-person diary block; for a
 * header-less legacy file (imported OpenClaw memory) or an oversized block it is a
 * token-window fragment. Carries everything the index row needs (§6).
 */
export interface MemoryChunk {
  /** Content identity: hash(path + text). Stable under inserts above it (§11.8). */
  id: string;
  /** Workspace-relative path, e.g. `memory/2026-06-03.md`. */
  path: string;
  /** 0-based block index within the file (mutable metadata — recomputed each scan). */
  ordinal: number;
  /** Corpus tag; always `memory` for now (future-proofing seam, §1/§6). */
  source: "memory";
  /** 1-indexed first line of the chunk in the file (for citation). */
  startLine: number;
  /** 1-indexed last line of the chunk in the file (inclusive). */
  endLine: number;
  /** Header room label, or null for legacy/unknown. */
  room: string | null;
  /** Real per-entry time for temporal decay (§8b): header end-ts, else file-date noon. */
  entryTs: number;
  /** Chunk content (includes the `## ` header line for header-delimited chunks). */
  text: string;
  tokenCount: number;
  /** hash(text) — the reconciliation/embedding-cache key (§6/§5e). */
  contentHash: string;
}

export interface ChunkOptions {
  relativePath: string;
  text: string;
  /** `YYYY-MM-DD` parsed from the filename, or null if it doesn't match. */
  fileDate: string | null;
  /** Last-resort timestamp (e.g. file mtime) when neither header nor filename dates it. */
  fallbackTimestamp: number;
  /** Header blocks larger than this are sub-split by token windows (§3). */
  maxChunkTokens: number;
  /** Token-window size for legacy/oversized fallback chunking (§3). */
  fallbackChunkTokens: number;
  /** Token-window overlap for fallback chunking (§3). */
  fallbackChunkOverlap: number;
  /**
   * The **embedder-matched** tokenizer (spec/TOKENIZER-SWAP.md §5.3), injected
   * rather than reached from the module-level chat tokenizer: chunk boundaries,
   * `tokenCount`s and content hashes must track the embedding model, so switching
   * `[tokenizer].primary` (the chat tokenizer) leaves the memory corpus untouched.
   */
  tokenizer: Tokenizer;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Parsed metadata from a diary header line (`## start → end · TZ · ROOM`). */
interface ParsedHeader {
  endTs: number | null;
  room: string;
}

const HEADER_LINE_RE =
  /^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+→\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+·\s+(\S+)\s+·\s+(.+?)\s*$/;

/**
 * Parse the first line of a header block into `{ endTs, room }`. The header embeds
 * the IANA zone it was written in, so the end timestamp is parsed against THAT zone
 * (not the current `agent.timezone`), keeping `entry_ts` correct across config
 * changes (§9d). Returns null endTs if the time can't be parsed.
 */
function parseHeaderLine(firstLine: string): ParsedHeader | null {
  const m = HEADER_LINE_RE.exec(firstLine);
  if (!m) return null;
  const [, end, tz, room] = m;
  const endTs = parseZonedWallClock(end, tz);
  return { endTs, room: room.trim() };
}

/** Build a `[lineStartOffset...]` table so char offsets map to 1-indexed lines. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

/** 1-indexed line containing character `offset` (binary search over line starts). */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Split a file's text into `[start, end)` character segments on the canonical diary
 * header (§4), mirroring `splitIntoHeaderBlocks` but retaining offsets. Any content
 * before the first `## ` header is its own leading segment.
 */
function headerSegments(text: string): Array<{ start: number; end: number; isHeader: boolean }> {
  const re = diaryHeaderRegex();
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    indices.push(m.index);
    if (re.lastIndex === m.index) re.lastIndex += 1; // guard against zero-width loops
  }
  if (indices.length === 0) return [{ start: 0, end: text.length, isHeader: false }];

  const segments: Array<{ start: number; end: number; isHeader: boolean }> = [];
  if (indices[0]! > 0) segments.push({ start: 0, end: indices[0]!, isHeader: false });
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i]!;
    const end = i + 1 < indices.length ? indices[i + 1]! : text.length;
    segments.push({ start, end, isHeader: true });
  }
  return segments;
}

/**
 * Chunk a memory file into indexable units (§3). Header-delimited files yield one
 * chunk per diary block (oversized blocks are token-window sub-split, inheriting the
 * block's metadata); header-less legacy files are token-window chunked. Pure-title /
 * whitespace leading segments (a file's `# <date> Daily Memory` line) are dropped.
 *
 * Async (spec/TOKENIZER-SWAP.md §4/§5.3): the per-block oversize check — the one
 * large encode in this background path — goes through the injected tokenizer's
 * optional `countAsync` escape hatch, which the native `glm` tokenizer runs on a
 * libuv worker thread. Everything else (the rare sub-split, per-sub-chunk counts)
 * stays synchronous. With the default `gpt-tokenizer` retrieval tokenizer
 * `countAsync` is absent, so this resolves synchronously with no thread hop.
 */
export async function chunkMemoryFile(opts: ChunkOptions): Promise<MemoryChunk[]> {
  const { relativePath, text, tokenizer } = opts;
  const lineStarts = lineStartOffsets(text);
  const fileNoonTs = opts.fileDate
    ? parseZonedWallClock(`${opts.fileDate} 12:00`, getConfiguredTimezone())
    : null;
  const baseTs = fileNoonTs ?? opts.fallbackTimestamp;

  /** Count a potentially-large block off-thread when the tokenizer supports it. */
  const countLarge = (s: string): Promise<number> =>
    tokenizer.countAsync ? tokenizer.countAsync(s) : Promise.resolve(tokenizer.count(s));

  const out: MemoryChunk[] = [];
  let ordinal = 0;

  const emit = (
    chunkText: string,
    charStart: number,
    charEnd: number,
    room: string | null,
    entryTs: number,
    knownTokenCount?: number,
  ): void => {
    if (chunkText.trim().length === 0) return; // skip whitespace-only fragments
    out.push({
      id: sha256Hex(`${relativePath}\0${chunkText}`),
      path: relativePath,
      ordinal: ordinal++,
      source: "memory",
      startLine: lineAt(lineStarts, charStart),
      endLine: lineAt(lineStarts, Math.max(charStart, charEnd - 1)),
      room,
      entryTs,
      text: chunkText,
      // Sub-chunks are bounded (≤ maxChunkTokens), so a sync count is cheap; the one
      // large encode (the whole block) is reused from the oversize check below.
      tokenCount: knownTokenCount ?? tokenizer.count(chunkText),
      contentHash: sha256Hex(chunkText),
    });
  };

  for (const seg of headerSegments(text)) {
    const segText = text.slice(seg.start, seg.end);
    if (seg.isHeader) {
      const firstLine = segText.split("\n", 1)[0] ?? segText;
      const parsed = parseHeaderLine(firstLine);
      const room = parsed?.room ?? null;
      const entryTs = parsed?.endTs ?? baseTs;
      const segTokens = await countLarge(segText);
      if (segTokens > opts.maxChunkTokens) {
        // Oversized block: sub-split, sub-chunks inherit the block's metadata (§3).
        for (const w of tokenizer.split(segText, opts.fallbackChunkTokens, opts.fallbackChunkOverlap)) {
          emit(w.text, seg.start + w.charStart, seg.start + w.charEnd, room, entryTs);
        }
      } else {
        emit(segText, seg.start, seg.end, room, entryTs, segTokens);
      }
    } else {
      // Leading / legacy segment. Drop if it is only a `# ` title line + whitespace.
      const stripped = segText.replace(/^\s*#[^\n]*\n?/, "").trim();
      if (stripped.length === 0) continue;
      for (const w of tokenizer.split(segText, opts.fallbackChunkTokens, opts.fallbackChunkOverlap)) {
        emit(w.text, seg.start + w.charStart, seg.start + w.charEnd, null, baseTs);
      }
    }
  }

  return out;
}

const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** `YYYY-MM-DD` from a `memory/<date>.md` basename, or null for other names. */
export function dayFromFilename(basename: string): string | null {
  return DAY_FILE_RE.exec(basename)?.[1] ?? null;
}
