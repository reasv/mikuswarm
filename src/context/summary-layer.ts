import type { Summary } from "../storage/index.js";
import { escapeAttr, escapeXml } from "./xml.js";

export interface SummarySelection {
  /** Summaries to render, ordered by earliest_timestamp ASC. */
  summaries: Summary[];
  /** Event-ID cut cursor: raw rendering starts strictly after this event. Null if no summaries. */
  coverageEndEventId: string | null;
}

/**
 * Greedy highest-level coverage selection (§4 step 2-5).
 *
 * `candidates` must already be filtered to status in (complete, truncated) and
 * ordered by earliest_timestamp ASC (the `getSummaryCandidates` query does this,
 * optionally applying the summarization `beforeTimestamp` filter).
 *
 * Selection ordering uses timestamps (not unique under Matrix collisions), but the
 * returned cut cursor is always an event ID — so a borderline selection can never
 * make an event render both inside a summary and raw.
 */
export function selectSummaries(candidates: Summary[]): SummarySelection {
  let coverageEnd = 0;
  const selected: Summary[] = [];

  for (const s of candidates) {
    if (s.latestTimestamp <= coverageEnd) continue;
    const coveredByHigher = selected.some(
      (sel) =>
        sel.earliestTimestamp <= s.earliestTimestamp &&
        sel.latestTimestamp >= s.latestTimestamp &&
        sel.level > s.level,
    );
    if (coveredByHigher) continue;
    selected.push(s);
    coverageEnd = Math.max(coverageEnd, s.latestTimestamp);
  }

  // Remove any selected summary fully covered by another selected higher-level one.
  const pruned = selected.filter(
    (s) =>
      !selected.some(
        (other) =>
          other !== s &&
          other.level > s.level &&
          other.earliestTimestamp <= s.earliestTimestamp &&
          other.latestTimestamp >= s.latestTimestamp,
      ),
  );

  pruned.sort((a, b) => a.earliestTimestamp - b.earliestTimestamp);

  // Derive the cursor from the contiguous prefix of summaries. Walk
  // chronologically; if one summary's earliestTimestamp is significantly past
  // the previous summary's latestTimestamp (more than 1ms tolerance), stop the
  // contiguous chain. Summaries after the gap are still rendered (they contain
  // useful context) but don't drive the cursor past the gap, so events in the
  // gap are queried and rendered raw.
  const GAP_TOLERANCE_MS = 1;
  let contiguousCursor: Summary | null = null;
  for (const s of pruned) {
    if (contiguousCursor === null) {
      contiguousCursor = s;
    } else if (s.earliestTimestamp <= contiguousCursor.latestTimestamp + GAP_TOLERANCE_MS) {
      // This summary follows contiguously (or overlaps) — extend the chain.
      if (s.latestTimestamp > contiguousCursor.latestTimestamp) {
        contiguousCursor = s;
      }
    } else {
      // Gap detected — stop extending the cursor. The contiguousCursor stays
      // at the last contiguous summary.
      break;
    }
  }

  return { summaries: pruned, coverageEndEventId: contiguousCursor ? contiguousCursor.latestEventId : null };
}

/** Progressive-rounding relative-time label (§5). `now` is always trigger.timestamp. */
export function computeRecencyLabel(latestTimestamp: number, now: number): string {
  const diffHours = (now - latestTimestamp) / (1000 * 60 * 60);
  if (diffHours < 1) return "< 1 hour ago";
  const wholeHours = Math.floor(diffHours);
  if (diffHours < 48) return `${wholeHours} ${wholeHours === 1 ? "hour" : "hours"} ago`;
  return `${Math.floor(diffHours / 24)} days ago`;
}

export interface SummaryLabelCache {
  labels: Array<{ summaryId: string; label: string; computedAt: number }>;
  validUntil: number;
}

export interface ResolvedLabels {
  /** Labels in render order, one per selected summary. */
  labels: string[];
  /** Cache to persist, or null when the existing cache is still valid and matches. */
  cacheToStore: SummaryLabelCache | null;
}

/**
 * Resolve recency labels for the selected summaries, using the cached labels when
 * still valid and matching the selection sequence (§5 cache algorithm). Pure: the
 * caller performs the metadata read/write.
 */
export function resolveRecencyLabels(
  selected: Summary[],
  cached: SummaryLabelCache | null,
  now: number,
  ttlMs: number,
): ResolvedLabels {
  if (
    cached &&
    cached.validUntil > now &&
    cached.labels.length === selected.length &&
    cached.labels.every((entry, i) => entry.summaryId === selected[i]!.id)
  ) {
    return { labels: cached.labels.map((entry) => entry.label), cacheToStore: null };
  }

  const labels: string[] = [];
  const entries: SummaryLabelCache["labels"] = [];
  let prefixStable = true;
  for (let i = 0; i < selected.length; i++) {
    const s = selected[i]!;
    const cachedEntry = cached?.labels[i];
    const fresh = computeRecencyLabel(s.latestTimestamp, now);
    if (prefixStable && cachedEntry && cachedEntry.summaryId === s.id && cachedEntry.label === fresh) {
      labels.push(cachedEntry.label);
      entries.push(cachedEntry);
    } else {
      prefixStable = false;
      labels.push(fresh);
      entries.push({ summaryId: s.id, label: fresh, computedAt: now });
    }
  }

  return { labels, cacheToStore: { labels: entries, validUntil: now + ttlMs } };
}

/** Render the selected summaries into the single summary-layer user message body (§4). */
export function renderSummaryLayer(selected: Summary[], labels: string[]): string {
  return selected
    .map((s, i) => {
      const attrs = [
        `level="${s.level}"`,
        `earliest="${new Date(s.earliestTimestamp).toISOString()}"`,
        `latest="${new Date(s.latestTimestamp).toISOString()}"`,
        `recency="${escapeAttr(labels[i] ?? "")}"`,
        `events="${s.eventCount}"`,
        `id="${escapeAttr(s.id)}"`,
      ];
      if (s.status === "truncated") attrs.push(`truncated="true"`);
      return `<summary ${attrs.join(" ")}>\n${escapeXml(s.content)}\n</summary>`;
    })
    .join("\n\n");
}
