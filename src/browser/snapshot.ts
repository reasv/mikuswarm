// AI accessibility snapshot (spec §5.1/§5.3). Phase-0 confirmed the public
// `locator.ariaSnapshot({ mode: 'ai' })` emits the [ref=eN]-tagged tree that
// `act` targets via the `aria-ref=eN` selector engine. Snapshots are capped at
// snapshot_max_chars so one snapshot can't blow the context window.

import type { Page } from "playwright-core";

export interface SnapshotResult {
  text: string;
  truncated: boolean;
  /**
   * Number of [ref=eN] handles present in the RETURNED text. When the snapshot
   * is truncated this counts only the refs the model can actually see and use,
   * not refs that were sliced off past the cut — so the model is never told
   * about refs it can't reach.
   */
  refCount: number;
}

const TRUNCATION_MARKER = "\n[... snapshot truncated — scroll or interact to reveal more ...]";

export async function aiSnapshot(page: Page, maxChars: number): Promise<SnapshotResult> {
  const raw = await page.locator("body").ariaSnapshot({ mode: "ai" });
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false, refCount: countRefs(raw) };
  }
  // Reserve room for the marker, but never let (slice + marker) exceed maxChars
  // even when maxChars < TRUNCATION_MARKER.length: clamp the final string to the
  // cap so the total returned text is always ≤ maxChars.
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  const text = (raw.slice(0, budget) + TRUNCATION_MARKER).slice(0, maxChars);
  // Count refs on the truncated output, not the raw, so refCount reflects only
  // the refs actually present in what we return.
  return { text, truncated: true, refCount: countRefs(text) };
}

function countRefs(snapshot: string): number {
  const matches = snapshot.match(/\[ref=e\d+\]/g);
  return matches ? matches.length : 0;
}
