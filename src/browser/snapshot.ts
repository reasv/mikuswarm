// AI accessibility snapshot (spec §5.1/§5.3). Phase-0 confirmed the public
// `locator.ariaSnapshot({ mode: 'ai' })` emits the [ref=eN]-tagged tree that
// `act` targets via the `aria-ref=eN` selector engine. Snapshots are capped at
// snapshot_max_chars so one snapshot can't blow the context window.
//
// Frames: `ariaSnapshot` does NOT descend into nested browsing contexts — each
// frame has its own accessibility tree and its own page-scoped `aria-ref`
// namespace — so anything inside an <iframe> (OAuth widgets, captchas, embedded
// checkout/booking forms) is otherwise invisible and unclickable. When
// maxFrames > 0 we walk `page.frames()` and append each child frame's snapshot
// under a `[frame fN: url]` boundary, with its refs namespaced to `fN:eN` (N is
// the index into page.frames()). `act` parses the `fN:` prefix to resolve the
// owning frame. The whole thing stays bounded by maxChars.

import type { Frame, Page } from "playwright-core";

export interface SnapshotResult {
  text: string;
  truncated: boolean;
  /**
   * Number of ref handles present in the RETURNED text (bare `eN` plus
   * frame-namespaced `fN:eN`). When the snapshot is truncated this counts only
   * the refs the model can actually see and use, not refs that were sliced off
   * past the cut — so the model is never told about refs it can't reach.
   */
  refCount: number;
  /**
   * The URL of each child frame at the moment its segment was appended, keyed by
   * its `page.frames()` index (the `N` in an `fN:eN` ref). The subsequent `act`
   * consults this to detect frame REORDERING between snapshot and act: if the
   * live `page.frames()[N].url()` no longer matches the recorded URL, index N now
   * points at a DIFFERENT frame (which may hold its own valid `eN`), so the ref
   * is stale → `ref_expired`. In-place navigation is already caught by the
   * detached-node timeout; this closes the reorder hole (see ARCHITECTURE.md
   * §11b "frame ref staleness"). Only frames actually rendered into the snapshot
   * are recorded — refs the model can't see can't be acted on.
   */
  frameUrls: Map<number, string>;
}

const TRUNCATION_MARKER = "\n[... snapshot truncated — scroll or interact to reveal more ...]";
// Don't bother opening a frame boundary if fewer than this many chars remain in
// the budget — there'd be no room for any useful child content under it.
const MIN_FRAME_BUDGET = 80;

export async function aiSnapshot(page: Page, maxChars: number, maxFrames = 0): Promise<SnapshotResult> {
  const mainRaw = await page.locator("body").ariaSnapshot({ mode: "ai" });

  // Main document alone fills (or overflows) the budget: don't descend into
  // frames (no room anyway). Overflow truncates with a marker; exactly-at-cap
  // passes through verbatim (the original boundary contract). No child frames
  // are rendered, so the frame-URL map is empty (no `fN:eN` refs to validate).
  if (mainRaw.length >= maxChars) {
    if (mainRaw.length > maxChars) {
      const text = clampWithMarker(mainRaw, maxChars);
      return { text, truncated: true, refCount: countRefs(text), frameUrls: new Map() };
    }
    return { text: mainRaw, truncated: false, refCount: countRefs(mainRaw), frameUrls: new Map() };
  }

  // page.frames() may be absent on a hand-rolled fake; with maxFrames === 0 we
  // never touch it, preserving the pre-frames contract.
  if (maxFrames <= 0 || typeof page.frames !== "function") {
    return { text: mainRaw, truncated: false, refCount: countRefs(mainRaw), frameUrls: new Map() };
  }

  let text = mainRaw;
  let truncated = false;
  const frames = page.frames();
  // index → URL captured at the moment we walk that frame, so it aligns with the
  // `N` in the `fN:eN` refs we emit and the next act reads from page.frames()[N].
  const frameUrls = new Map<number, string>();
  let appended = 0;
  // frames[0] is the main document (already captured above); child frames —
  // including nested ones, which page.frames() returns flattened — start at 1.
  for (let i = 1; i < frames.length; i++) {
    if (appended >= maxFrames) {
      truncated = true; // more frames exist than we're willing to render
      break;
    }
    const remaining = maxChars - text.length;
    if (remaining <= MIN_FRAME_BUDGET) {
      truncated = true;
      break;
    }
    const frame = frames[i]!;
    const segment = await frameSegment(frame, i);
    if (segment === undefined) {
      // Inaccessible/detached frame — note it inline if there's room, else stop.
      // No usable refs come out of it, so it's not recorded in frameUrls.
      const note = `\n\n[frame f${i}: <inaccessible>]`;
      if (note.length <= maxChars - text.length) {
        text += note;
        appended++;
        continue;
      }
      truncated = true;
      break;
    }
    if (segment.text.length > maxChars - text.length) {
      // Child doesn't fit whole: take what fits and stop (avoids slicing a later
      // frame mid-way and leaving a dangling boundary). Not recorded — its refs
      // aren't in the returned text.
      truncated = true;
      break;
    }
    text += segment.text;
    // Record the frame's snapshot-time URL only once it's actually in `text`, so
    // the map describes exactly the `fN:eN` refs the model can see and reuse.
    frameUrls.set(i, segment.url);
    appended++;
  }

  if (truncated) text = clampWithMarker(text, maxChars);
  return { text, truncated, refCount: countRefs(text), frameUrls };
}

/**
 * Capture one child frame's AI snapshot and frame it under a `[frame fN: url]`
 * boundary with its refs namespaced to `fN:eN`. Returns the rendered `text` and
 * the frame's snapshot-time `url` (the latter recorded by the caller for the
 * frame-reorder staleness check). Returns `undefined` when the frame can't be
 * snapshotted (detached/navigated mid-walk).
 */
async function frameSegment(frame: Frame, index: number): Promise<{ text: string; url: string } | undefined> {
  let url: string;
  try {
    url = frame.url() || "?";
  } catch {
    return undefined;
  }
  let child: string;
  try {
    child = await frame.locator("body").ariaSnapshot({ mode: "ai" });
  } catch {
    return undefined;
  }
  return { text: `\n\n[frame f${index}: ${url}]\n${namespaceRefs(child, index)}`, url };
}

/** Rewrite a child frame's page-scoped `[ref=eN]` handles to `[ref=fN:eN]`. */
function namespaceRefs(snapshot: string, frameIndex: number): string {
  return snapshot.replace(/\[ref=(e\d+)\]/g, `[ref=f${frameIndex}:$1]`);
}

/**
 * Clamp `s` to `maxChars`, reserving room for the truncation marker but never
 * letting (slice + marker) exceed `maxChars` even when maxChars < marker length.
 */
function clampWithMarker(s: string, maxChars: number): string {
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return (s.slice(0, budget) + TRUNCATION_MARKER).slice(0, maxChars);
}

function countRefs(snapshot: string): number {
  // Count bare `eN` and frame-namespaced `fN:eN` handles alike.
  const matches = snapshot.match(/\[ref=(?:f\d+:)?e\d+\]/g);
  return matches ? matches.length : 0;
}
