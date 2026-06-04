// AI accessibility snapshot (spec §5.1/§5.3). Phase-0 confirmed the public
// `locator.ariaSnapshot({ mode: 'ai' })` emits the [ref=eN]-tagged tree that
// `act` targets via the `aria-ref=eN` selector engine. Snapshots are capped at
// snapshot_max_chars so one snapshot can't blow the context window.

import type { Page } from "playwright-core";

export interface SnapshotResult {
  text: string;
  truncated: boolean;
  /** Number of [ref=eN] handles present in the (untruncated) snapshot. */
  refCount: number;
}

const TRUNCATION_MARKER = "\n[... snapshot truncated — scroll or interact to reveal more ...]";

export async function aiSnapshot(page: Page, maxChars: number): Promise<SnapshotResult> {
  const raw = await page.locator("body").ariaSnapshot({ mode: "ai" });
  const refCount = countRefs(raw);
  if (raw.length <= maxChars) {
    return { text: raw, truncated: false, refCount };
  }
  const budget = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return { text: raw.slice(0, budget) + TRUNCATION_MARKER, truncated: true, refCount };
}

function countRefs(snapshot: string): number {
  const matches = snapshot.match(/\[ref=e\d+\]/g);
  return matches ? matches.length : 0;
}
