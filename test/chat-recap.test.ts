import assert from "node:assert/strict";
import test from "node:test";
import { detectAbsence } from "../src/search/absence.js";
import { selectFineCover, selectDigest } from "../src/search/coverage.js";
import type { Summary } from "../src/storage/index.js";

const HOUR = 3_600_000;
const NOW = 1_000_000_000_000;
const GAP = 3 * HOUR;
const LOOKBACK = 24 * HOUR;

function absenceOpts() {
  return { now: NOW, gapThresholdMs: GAP, defaultLookbackMs: LOOKBACK };
}

test("detectAbsence anchors before the gap, skipping the current burst (talk-then-ask)", () => {
  // Burst: now, -1m, -2m (the "hey what'd I miss" cluster). Then a ~5h absence.
  const desc = [NOW, NOW - 60_000, NOW - 120_000, NOW - 5 * HOUR, NOW - 5 * HOUR - 60_000];
  const r = detectAbsence(desc, absenceOpts());
  assert.equal(r.ambiguous, false);
  assert.equal(r.startTs, NOW - 5 * HOUR); // last message BEFORE the gap
});

test("detectAbsence with no messages falls back to the lookback window", () => {
  const r = detectAbsence([], absenceOpts());
  assert.equal(r.ambiguous, true);
  assert.equal(r.startTs, NOW - LOOKBACK);
});

test("detectAbsence treats continuous presence as ambiguous (earliest known)", () => {
  // All gaps under threshold → no real absence.
  const desc = [NOW, NOW - HOUR, NOW - 2 * HOUR, NOW - 2.5 * HOUR];
  const r = detectAbsence(desc, absenceOpts());
  assert.equal(r.ambiguous, true);
  assert.equal(r.startTs, NOW - 2.5 * HOUR);
});

function sum(o: {
  id: string;
  level: number;
  e: number;
  l: number;
  tok: number;
}): Summary {
  return {
    id: o.id,
    timelineKey: "matrix:miku:room:!a",
    level: o.level,
    content: `summary ${o.id}`,
    earliestTimestamp: o.e,
    latestTimestamp: o.l,
    latestEventId: `${o.id}-ev`,
    eventCount: 5,
    tokenCount: o.tok,
    modelId: null,
    status: "complete",
    backfillJobId: null,
    generatedAt: o.l,
    createdAt: o.l,
  };
}

test("selectFineCover prefers level-1 chain over a covering level-2", () => {
  const overlap = [
    sum({ id: "l1a", level: 1, e: 0, l: 100, tok: 100 }),
    sum({ id: "l1b", level: 1, e: 101, l: 200, tok: 100 }),
    sum({ id: "l1c", level: 1, e: 201, l: 300, tok: 100 }),
    sum({ id: "l2", level: 2, e: 0, l: 300, tok: 120 }),
  ];
  const cover = selectFineCover(overlap, 0, 300);
  assert.deepEqual(cover.map((s) => s.id), ["l1a", "l1b", "l1c"]);
});

test("selectDigest returns the fine cover when it fits the budget", () => {
  const overlap = [
    sum({ id: "l1a", level: 1, e: 0, l: 100, tok: 100 }),
    sum({ id: "l1b", level: 1, e: 101, l: 200, tok: 100 }),
    sum({ id: "l1c", level: 1, e: 201, l: 300, tok: 100 }),
  ];
  const d = selectDigest(overlap, 0, 300, 1000);
  assert.equal(d.coarsened, 0);
  assert.equal(d.trimmed, 0);
  assert.deepEqual(d.summaries.map((s) => s.id), ["l1a", "l1b", "l1c"]);
});

test("selectDigest folds a strictly-interior parent, keeping both ends fine", () => {
  const overlap = [
    sum({ id: "l1a", level: 1, e: 0, l: 100, tok: 100 }),
    sum({ id: "l1b", level: 1, e: 101, l: 200, tok: 100 }),
    sum({ id: "l1c", level: 1, e: 201, l: 300, tok: 100 }),
    sum({ id: "l1d", level: 1, e: 301, l: 400, tok: 100 }),
    sum({ id: "l1e", level: 1, e: 401, l: 500, tok: 100 }),
    // Interior parent covering the middle three (not the ends).
    sum({ id: "l2mid", level: 2, e: 101, l: 400, tok: 150 }),
  ];
  const d = selectDigest(overlap, 0, 500, 380);
  // Ends (l1a, l1e) stay at level 1; the middle is condensed to l2mid.
  assert.deepEqual(d.summaries.map((s) => s.id), ["l1a", "l2mid", "l1e"]);
  assert.equal(d.coarsened, 3);
  assert.equal(d.trimmed, 0);
});

test("selectDigest trims the oldest interior when no beneficial parent exists", () => {
  const overlap = [
    sum({ id: "l1a", level: 1, e: 0, l: 100, tok: 100 }),
    sum({ id: "l1b", level: 1, e: 101, l: 200, tok: 100 }),
    sum({ id: "l1c", level: 1, e: 201, l: 300, tok: 100 }),
    // Only a window-spanning L2 exists — it overlaps the ends, so it's ineligible.
    sum({ id: "l2all", level: 2, e: 0, l: 300, tok: 120 }),
  ];
  const d = selectDigest(overlap, 0, 300, 250);
  assert.deepEqual(d.summaries.map((s) => s.id), ["l1a", "l1c"]);
  assert.equal(d.trimmed, 1);
  assert.equal(d.coarsened, 0);
});
