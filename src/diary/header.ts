import { compactAgentTimestamp, getConfiguredTimezone } from "../time/index.js";

/**
 * The canonical diary entry header (ARCHITECTURE.md §9c / design §4), uniform for
 * all ranges:
 *
 *   `## <YYYY-MM-DD HH:MM> → <YYYY-MM-DD HH:MM> · <TZ> · <ROOM>`
 *   `## 2026-06-03 14:05 → 2026-06-03 15:30 · America/Los_Angeles · Project Hammer (Earendil)`
 *
 * - start/end = earliest/latest range timestamp rendered `YYYY-MM-DD HH:MM` in the
 *   canonical zone via {@link compactAgentTimestamp} — so header and body agree by
 *   construction. Always BOTH full dates (cross-midnight ranges stay unambiguous).
 * - ` → ` = space + U+2192 + space (deliberately an arrow, not en-dash/hyphen, so
 *   the split-regex can't false-match prose or legacy headings).
 * - ` · ` = U+00B7 middle-dot separators around the TZ.
 * - `<TZ>` = the IANA zone name straight from `agent.timezone` (NOT an abbreviation
 *   — the codebase has no abbreviation renderer; the IANA name is unambiguous and
 *   DST-stable).
 * - `<ROOM>` = the channel label, free-form trailing text to end-of-line.
 */
export function buildDiaryHeader(opts: {
  earliestTimestamp: number;
  latestTimestamp: number;
  room: string;
  /** Override the canonical zone (defaults to the configured agent timezone). */
  timezone?: string;
}): string {
  const tz = opts.timezone ?? getConfiguredTimezone();
  const start = compactAgentTimestamp(opts.earliestTimestamp);
  const end = compactAgentTimestamp(opts.latestTimestamp);
  return `## ${start} → ${end} · ${tz} · ${opts.room}`;
}

/**
 * Splits/trims on the canonical header (§4/§10a), multiline. Anchors entirely on
 * the machine part; `<ROOM>` is the trailing `\S.*`, so any room name is safe.
 * Legacy header-less files (imported OpenClaw memory) yield zero matches, so the
 * whole file is the only droppable unit (the §10a fallback). The `g`+`m` flags let
 * callers find every block boundary. NOTE: a regex with the `g` flag is stateful
 * (`lastIndex`); construct a fresh one per scan via {@link diaryHeaderRegex}.
 */
export function diaryHeaderRegex(): RegExp {
  return /^##\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+→\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+·\s+\S.*$/gm;
}

/**
 * The header-first check the diary tool enforces on every edit (§8): the draft,
 * with leading/trailing whitespace normalized, must BEGIN with the exact dictated
 * header string. Normalization trims only ASCII/Unicode whitespace — never the
 * `·`/`→` tokens (they are not whitespace), so the structural separators survive.
 */
export function draftBeginsWithHeader(draft: string, header: string): boolean {
  return draft.trim().startsWith(header.trim());
}
