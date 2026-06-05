import type { Summary } from "../storage/index.js";

/** 1ms contiguity tolerance — matches the in-context summary layer (§9b). */
const TOL = 1;

export interface DigestSelection {
  /** Chosen summaries, earliest-first. */
  summaries: Summary[];
  /** How many finer summaries were folded into coarser parents for budget. */
  coarsened: number;
  /** How many summaries were dropped entirely (budget could not be met by coarsening). */
  trimmed: number;
  coveredFrom: number | null;
  coveredTo: number | null;
}

function tokens(arr: Summary[]): number {
  return arr.reduce((sum, s) => sum + s.tokenCount, 0);
}

/**
 * Greedy *lowest*-level coverage of [start, end] (the inverse of the in-context
 * layer's greedy *highest*-level selection, §9b): at each step pick the finest summary
 * that covers the current cursor and extends furthest, so the result is as detailed as
 * the available summaries allow. Where level-1 is missing for a sub-range (e.g. just
 * behind the live edge, or very old), it falls back to the lowest level present.
 */
export function selectFineCover(overlap: Summary[], start: number, end: number): Summary[] {
  const result: Summary[] = [];
  const used = new Set<string>();
  let cursor = start;
  // Bound the loop defensively: at most one pick per summary.
  for (let guard = 0; guard <= overlap.length && cursor <= end; guard++) {
    let best: Summary | null = null;
    for (const s of overlap) {
      if (used.has(s.id)) continue;
      if (s.earliestTimestamp <= cursor + TOL && s.latestTimestamp >= cursor) {
        if (
          best === null ||
          s.level < best.level ||
          (s.level === best.level && s.latestTimestamp > best.latestTimestamp)
        ) {
          best = s;
        }
      }
    }
    if (best === null) {
      // Gap before any remaining summary — jump the cursor to the next start.
      let next: number | null = null;
      for (const s of overlap) {
        if (used.has(s.id)) continue;
        if (s.earliestTimestamp > cursor && (next === null || s.earliestTimestamp < next)) {
          next = s.earliestTimestamp;
        }
      }
      if (next === null) break;
      cursor = next;
      continue;
    }
    result.push(best);
    used.add(best.id);
    cursor = best.latestTimestamp + 1;
  }
  return result.sort((a, b) => a.earliestTimestamp - b.earliestTimestamp);
}

/**
 * Find the gentlest (lowest-level, tightest) higher-level summary that fully covers
 * `s` while staying **strictly interior** — its span must not reach the two protected
 * ends (`[, ]`). Keeping parents off the ends is what preserves boundary precision and
 * recency: coarsening only ever folds the middle, never the start-straddling or
 * most-recent summary. Returns null if no such parent exists.
 */
function eligibleInteriorParent(
  overlap: Summary[],
  s: Summary,
  interiorStart: number,
  interiorEnd: number,
): Summary | null {
  let best: Summary | null = null;
  for (const c of overlap) {
    if (c.level <= s.level) continue;
    if (c.earliestTimestamp < interiorStart || c.latestTimestamp > interiorEnd) continue;
    if (c.earliestTimestamp <= s.earliestTimestamp && c.latestTimestamp >= s.latestTimestamp) {
      const span = c.latestTimestamp - c.earliestTimestamp;
      const bestSpan = best ? best.latestTimestamp - best.earliestTimestamp : Infinity;
      if (best === null || c.level < best.level || (c.level === best.level && span < bestSpan)) {
        best = c;
      }
    }
  }
  return best;
}

/**
 * Select the finest summary coverage of [start, end] that fits `budgetTokens`,
 * honoring the resolved policy (decision §9.3): keep the **boundary-straddling** and
 * **most-recent** summaries at their finest level, and coarsen the **oldest interior**
 * runs to higher-level parents first. If coarsening alone can't meet the budget (no
 * coarser parent exists), drop the oldest interior summaries and report it.
 */
export function selectDigest(
  overlap: Summary[],
  start: number,
  end: number,
  budgetTokens: number,
): DigestSelection {
  const inWindow = overlap.filter(
    (s) => s.latestTimestamp >= start && s.earliestTimestamp <= end,
  );
  let selected = selectFineCover(inWindow, start, end);
  if (selected.length === 0) {
    return { summaries: [], coarsened: 0, trimmed: 0, coveredFrom: null, coveredTo: null };
  }

  let coarsened = 0;
  let trimmed = 0;
  const maxIterations = inWindow.length * 4 + 8;
  for (let iter = 0; iter < maxIterations && tokens(selected) > budgetTokens; iter++) {
    if (selected.length <= 2) break; // only the two protected ends remain — accept overage
    const first = selected[0];
    const last = selected[selected.length - 1];
    // Interior span lies strictly between the two ends' inner edges.
    const interiorStart = first.latestTimestamp;
    const interiorEnd = last.earliestTimestamp;
    const endIds = new Set<string>([first.id, last.id]);

    // Oldest-first: find an interior summary with a beneficial interior parent.
    let applied = false;
    for (const victim of selected) {
      if (endIds.has(victim.id)) continue;
      const parent = eligibleInteriorParent(inWindow, victim, interiorStart, interiorEnd);
      if (!parent) continue;
      const folded = selected.filter(
        (s) =>
          !endIds.has(s.id) &&
          parent.earliestTimestamp <= s.earliestTimestamp &&
          parent.latestTimestamp >= s.latestTimestamp,
      );
      // Only coarsen when it actually saves tokens (a lone item under a big parent can
      // cost more than it saves — trim that instead, below).
      if (tokens(folded) - parent.tokenCount <= 0) continue;
      selected = selected.filter((s) => !folded.some((f) => f.id === s.id));
      if (!selected.some((s) => s.id === parent.id)) selected.push(parent);
      selected.sort((a, b) => a.earliestTimestamp - b.earliestTimestamp);
      coarsened += folded.length;
      applied = true;
      break;
    }
    if (applied) continue;

    // No beneficial coarsening: drop the oldest interior summary outright.
    const victim = selected.find((s) => !endIds.has(s.id));
    if (!victim) break;
    selected = selected.filter((s) => s.id !== victim.id);
    trimmed += 1;
  }

  return {
    summaries: selected,
    coarsened,
    trimmed,
    coveredFrom: selected.length > 0 ? selected[0].earliestTimestamp : null,
    coveredTo: selected.length > 0 ? selected[selected.length - 1].latestTimestamp : null,
  };
}
