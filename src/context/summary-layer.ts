import type { Summary } from "../storage/index.js";
import { escapeAttr, escapeXml } from "./xml.js";
import { estimateTokens } from "./tokens.js";
import { formatAgentTimestamp } from "../time/index.js";

export interface SummarySelection {
  /** Summaries to render, ordered by earliest_timestamp ASC. */
  summaries: Summary[];
  /** Event-ID cut cursor: raw rendering starts strictly after this event. Null if no summaries. */
  coverageEndEventId: string | null;
}

/**
 * Contiguity test for the coverage-cursor chain walk: does `next` follow `prev`
 * with no un-covered raw events between them? "Between" means strictly after
 * `prev`'s last covered event and strictly before `next`'s first covered event —
 * an *event-existence* question, never a timestamp-interval one (adjacent
 * worker-produced summaries are separated by real inter-message intervals, and
 * genuinely disjoint summaries over retention-deleted ranges have nothing left
 * to render between them).
 */
export type SummaryContiguityProbe = (prev: Summary, next: Summary) => boolean;

/** The storage capability {@link makeContiguityProbe} needs (implemented by `Storage`). */
export interface SummaryAdjacencyStore {
  hasEventsBetweenSummaries(timelineKey: string, prev: Summary, next: Summary): boolean;
}

/**
 * The production {@link SummaryContiguityProbe}: two summaries are contiguous
 * exactly when no raw timeline event exists strictly between their coverage
 * (level-1 job ranges abut by construction — each chunk starts at the first
 * event after the coverage cursor — and a retention-deleted gap is equally
 * contiguous: nothing un-covered would be skipped by advancing the cursor).
 */
export function makeContiguityProbe(
  storage: SummaryAdjacencyStore,
  timelineKey: string,
): SummaryContiguityProbe {
  return (prev, next) => !storage.hasEventsBetweenSummaries(timelineKey, prev, next);
}

/**
 * The storage surface {@link selectSummaryCoverage} needs (implemented by
 * `Storage`); structural so the pure selection logic stays storage-agnostic.
 */
export interface SummaryCoverageStore extends SummaryAdjacencyStore {
  getSummaryCandidates(timelineKey: string, beforeTimestamp?: number): Summary[];
  getFailedSummarizationJobs(
    timelineKey: string,
    level: number,
  ): Array<{ id: string; level: number; inputStartId: string; inputEndId: string; updatedAt: number }>;
  getEventCursor(
    timelineKey: string,
    eventId: string,
  ): { timestamp: number; receivedAt: number; id: string } | undefined;
  getTimelineEventsBetween(
    timelineKey: string,
    start: { timestamp: number; receivedAt: number; id: string },
    end: { timestamp: number; receivedAt: number; id: string },
  ): Array<{ id: string; timestamp: number }>;
}

/** Body of a synthesized failure-placeholder summary (spec §7.2). */
export const FAILURE_PLACEHOLDER_CONTENT =
  "[Summary for this range could not be generated — summarization failed after retries; " +
  "the underlying messages are omitted from context.]";

/**
 * Failure placeholders (spec §7.2): one synthetic summary per terminally
 * `failed` level-1 job, occupying the slot the real summary would have — usual
 * envelope (time range, level, event count), body replaced by an explicit
 * "could not be generated" marker. Never persisted; re-synthesized
 * deterministically while the job stays failed (stable id `sumfail_<jobId>`,
 * stable timestamps from the job row, so recency-label caching holds).
 *
 * These participate in coverage selection as first-class candidates: the
 * coverage cursor advances THROUGH a failed range (its placeholder links the
 * contiguity chain), which is what makes `failed` terminal for the range —
 * builds omit the raw events and render the marker, and the eager indexer
 * never re-counts or re-enqueues the range. There is deliberately NO automatic
 * retry; the manual override is deleting the failed job row, after which the
 * next reconcile re-enqueues the range.
 *
 * Ranges that no longer resolve (boundary events retention-deleted) are
 * skipped — there is nothing left to stand in for.
 */
export function synthesizeFailurePlaceholders(
  storage: SummaryCoverageStore,
  timelineKey: string,
  beforeTimestamp?: number,
): Summary[] {
  const placeholders: Summary[] = [];
  for (const job of storage.getFailedSummarizationJobs(timelineKey, 1)) {
    const start = storage.getEventCursor(timelineKey, job.inputStartId);
    const end = storage.getEventCursor(timelineKey, job.inputEndId);
    if (!start || !end) continue;
    const covered = storage.getTimelineEventsBetween(timelineKey, start, end);
    if (covered.length === 0) continue;
    const first = covered[0]!;
    const last = covered[covered.length - 1]!;
    // Mirror getSummaryCandidates' inclusive `latest_timestamp <= beforeTimestamp`.
    if (beforeTimestamp != null && last.timestamp > beforeTimestamp) continue;
    placeholders.push({
      id: `sumfail_${job.id}`,
      timelineKey,
      level: job.level,
      content: FAILURE_PLACEHOLDER_CONTENT,
      earliestTimestamp: first.timestamp,
      latestTimestamp: last.timestamp,
      earliestEventId: first.id,
      latestEventId: last.id,
      eventCount: covered.length,
      tokenCount: estimateTokens(FAILURE_PLACEHOLDER_CONTENT),
      modelId: null,
      status: "complete",
      backfillJobId: null,
      generatedAt: job.updatedAt,
      createdAt: job.updatedAt,
    });
  }
  return placeholders;
}

/**
 * Explicit candidate exclusion for the diary-range build mode (spec
 * DIARY-CONTEXT-PARITY §3): drop any summary whose coverage extends INTO the
 * work range — belt-and-suspenders against millisecond-collision edges where
 * the inclusive `beforeTimestamp` bound alone would admit the range's own
 * summary (e.g. a single-event range whose earliest == latest equals the
 * bound). `summaryId` (the range's own summary) is also excluded by id
 * explicitly. A prior chunk's summary that merely SHARES a millisecond
 * boundary with the range start (its `latestTimestamp` equals
 * `earliestTimestamp` while it begins before the range) is deliberately
 * KEPT — the same inclusive semantics the cutoff path uses to prevent a
 * coverage gap on Matrix batch-send timestamp collisions.
 */
export interface SummaryRangeExclusion {
  earliestTimestamp: number;
  latestTimestamp: number;
  summaryId?: string;
}

/**
 * The production coverage selection (§9b): persisted summary candidates plus
 * synthesized failure placeholders, chained with the event-existence
 * contiguity probe. The single entry point shared by the context builder and
 * the eager `SummarizationIndexer`, so both always agree on what is covered.
 */
export function selectSummaryCoverage(
  storage: SummaryCoverageStore,
  timelineKey: string,
  beforeTimestamp?: number,
  excludeRange?: SummaryRangeExclusion,
): SummarySelection {
  const candidates = storage.getSummaryCandidates(timelineKey, beforeTimestamp);
  const placeholders = synthesizeFailurePlaceholders(storage, timelineKey, beforeTimestamp);
  let merged =
    placeholders.length === 0
      ? candidates
      : [...candidates, ...placeholders].sort((a, b) => a.earliestTimestamp - b.earliestTimestamp);
  if (excludeRange) {
    const { earliestTimestamp: rangeStart, latestTimestamp: rangeEnd } = excludeRange;
    merged = merged.filter((s) => {
      if (s.id === excludeRange.summaryId) return false;
      // Begins inside the range → the range's own coverage (never a prior
      // chunk's), including the single-event edge where earliest == latest ==
      // rangeStart, which the inclusive beforeTimestamp bound alone admits.
      const beginsWithin = s.earliestTimestamp >= rangeStart && s.earliestTimestamp <= rangeEnd;
      // Extends strictly past the range start into the range. STRICT at the
      // start boundary: a prior chunk whose latestTimestamp == rangeStart
      // (millisecond collision) must stay selected.
      const extendsInto = s.latestTimestamp > rangeStart && s.earliestTimestamp <= rangeEnd;
      return !beginsWithin && !extendsInto;
    });
  }
  return selectSummaries(merged, makeContiguityProbe(storage, timelineKey));
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
 * make an event render both inside a summary and raw. The cursor chain is walked
 * with `isContiguous` (event-existence based, see {@link SummaryContiguityProbe}).
 */
export function selectSummaries(
  candidates: Summary[],
  isContiguous: SummaryContiguityProbe,
): SummarySelection {
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
  // chronologically, consulting the contiguity probe: the chain extends across
  // a summary only when no un-covered raw events sit between it and the current
  // coverage end (event-existence, NOT timestamp distance — adjacent chunk
  // summaries are separated by real inter-message intervals and must still
  // advance the cursor, or a freshly waited-on summary would double-render and
  // the build would silently drop history). Summaries after a genuine gap are
  // still rendered (they contain useful context) but don't drive the cursor
  // past the gap, so the gap's events are queried and rendered raw.
  let contiguousCursor: Summary | null = null;
  for (const s of pruned) {
    if (contiguousCursor === null) {
      contiguousCursor = s;
    } else if (isContiguous(contiguousCursor, s)) {
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
        `earliest="${formatAgentTimestamp(s.earliestTimestamp)}"`,
        `latest="${formatAgentTimestamp(s.latestTimestamp)}"`,
        `recency="${escapeAttr(labels[i] ?? "")}"`,
        `events="${s.eventCount}"`,
        `id="${escapeAttr(s.id)}"`,
      ];
      if (s.status === "truncated") attrs.push(`truncated="true"`);
      return `<summary ${attrs.join(" ")}>\n${escapeXml(s.content)}\n</summary>`;
    })
    .join("\n\n");
}
