import type { Storage } from "../storage/index.js";
import type { ChatSearchIndexer } from "./indexer.js";

/** Default "gone" gap (3h) and fallback lookback (24h); overridable via config (§9e). */
export const ABSENCE_GAP_DEFAULT_MS = 3 * 60 * 60 * 1000;
export const ABSENCE_LOOKBACK_DEFAULT_MS = 24 * 60 * 60 * 1000;
const HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

export interface AbsenceResult {
  /** Inclusive lower bound (ms) of "since you were gone". */
  startTs: number;
  /** Human explanation of how the boundary was derived (surfaced to the agent). */
  basis: string;
  /** True when no clear absence gap was found and a fallback window was used. */
  ambiguous: boolean;
}

export interface ResolveAbsenceOptions {
  senderId: string;
  timelineKeys?: string[];
  now: number;
  gapThresholdMs?: number;
  defaultLookbackMs?: number;
}

function humanGap(ms: number): string {
  const h = ms / 3_600_000;
  if (h >= 24) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

/**
 * Pure absence-gap detection over a user's message timestamps (DESCENDING). Skips the
 * user's *current* presence burst — the contiguous run of recent messages with
 * inter-message gaps below the threshold — and anchors the boundary at the last
 * message *before* that burst. This is what makes "summarize since I was gone" robust
 * to the user typing a few messages ("hey, what'd I miss?") *before* asking: those
 * recent messages are the burst and are excluded.
 *
 * Edge cases: no messages in the horizon → fall back to `now - defaultLookback`
 * (ambiguous). The basis distinguishes two empty-horizon causes via `hasOlderMessage`:
 * the user has been away *longer* than the look-back horizon (an older message exists
 * outside it — honest about the horizon limit, review #9) vs. genuinely no messages from
 * the user at all. Continuously present (no gap ≥ threshold) → earliest known message
 * (ambiguous), since there is no real absence to anchor on.
 */
export function detectAbsence(
  timestampsDesc: number[],
  opts: { now: number; gapThresholdMs: number; defaultLookbackMs: number; hasOlderMessage?: boolean },
): AbsenceResult {
  if (timestampsDesc.length === 0) {
    const lookback = humanGap(opts.defaultLookbackMs);
    return {
      startTs: opts.now - opts.defaultLookbackMs,
      basis: opts.hasOlderMessage
        ? `you've been away longer than the 30-day window I look back over — showing the last ${lookback}; ` +
          `pass an explicit \`after\`/\`last\` to widen`
        : `no recent messages from you — defaulted to the last ${lookback}`,
      ambiguous: true,
    };
  }
  // Walk newest→older through the current burst.
  let burstOldest = timestampsDesc[0];
  let i = 1;
  for (; i < timestampsDesc.length; i++) {
    if (burstOldest - timestampsDesc[i] >= opts.gapThresholdMs) break;
    burstOldest = timestampsDesc[i];
  }
  if (i >= timestampsDesc.length) {
    // No gap within the horizon — you've been around the whole time.
    return {
      startTs: timestampsDesc[timestampsDesc.length - 1],
      basis: "you've been continuously active — showing everything since your earliest message in range",
      ambiguous: true,
    };
  }
  // timestampsDesc[i] is your last message before the gap.
  const gap = burstOldest - timestampsDesc[i];
  return {
    startTs: timestampsDesc[i],
    basis: `detected a ${humanGap(gap)} absence — showing everything since your last message before it`,
    ambiguous: false,
  };
}

/**
 * Resolve the absence boundary for a user by reading their message timestamps from the
 * (freshened) chat index, then running {@link detectAbsence}.
 */
export async function resolveAbsence(
  storage: Storage,
  indexer: ChatSearchIndexer,
  opts: ResolveAbsenceOptions,
): Promise<AbsenceResult> {
  await indexer.ensureFreshForQuery();
  const timestampsDesc = storage.getChatSenderTimestamps({
    senderId: opts.senderId,
    timelineKeys: opts.timelineKeys,
    sinceTs: opts.now - HORIZON_MS,
  });
  // When nothing is in-horizon, the 24h fallback would otherwise read as "nothing
  // happened" even if the user has simply been away longer than the 30-day horizon
  // (review #9). A cheap unbounded probe (limit 1, no `sinceTs`) tells the two apart so
  // the basis can be honest about the horizon limit rather than silently collapsing.
  let hasOlderMessage = false;
  if (timestampsDesc.length === 0) {
    hasOlderMessage =
      storage.getChatSenderTimestamps({
        senderId: opts.senderId,
        timelineKeys: opts.timelineKeys,
        limit: 1,
      }).length > 0;
  }
  return detectAbsence(timestampsDesc, {
    now: opts.now,
    gapThresholdMs: opts.gapThresholdMs ?? ABSENCE_GAP_DEFAULT_MS,
    defaultLookbackMs: opts.defaultLookbackMs ?? ABSENCE_LOOKBACK_DEFAULT_MS,
    hasOlderMessage,
  });
}
