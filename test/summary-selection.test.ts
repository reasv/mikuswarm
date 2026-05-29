import assert from "node:assert/strict";
import test from "node:test";
import { selectSummaries } from "../src/context/index.js";
import type { Summary } from "../src/storage/index.js";

function summary(overrides: Partial<Summary> & Pick<Summary, "id" | "level" | "earliestTimestamp" | "latestTimestamp" | "latestEventId">): Summary {
  return {
    timelineKey: "matrix:test:room:!room",
    content: "summary body",
    eventCount: 1,
    tokenCount: 10,
    modelId: "model",
    status: "complete",
    backfillJobId: null,
    generatedAt: 0,
    createdAt: 0,
    ...overrides,
  };
}

test("selects all non-overlapping level-1 summaries, ordered, cut at the latest", () => {
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "ev2" }),
    summary({ id: "s3", level: 1, earliestTimestamp: 300, latestTimestamp: 400, latestEventId: "ev3" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2", "s3"]);
  assert.equal(coverageEndEventId, "ev3");
});

test("prefers a higher-level summary that covers two level-1 summaries", () => {
  const candidates = [
    summary({ id: "l1a", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "evA" }),
    summary({ id: "l2", level: 2, earliestTimestamp: 100, latestTimestamp: 300, latestEventId: "evC", eventCount: 2 }),
    summary({ id: "l1b", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "evB" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates);
  assert.deepEqual(summaries.map((s) => s.id), ["l2"]);
  assert.equal(coverageEndEventId, "evC");
});

test("ordering survives a reordered candidate list (prune covers either order)", () => {
  const candidates = [
    summary({ id: "l2", level: 2, earliestTimestamp: 100, latestTimestamp: 300, latestEventId: "evC", eventCount: 2 }),
    summary({ id: "l1a", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "evA" }),
    summary({ id: "l1b", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "evB" }),
  ];
  const { summaries } = selectSummaries(candidates);
  assert.deepEqual(summaries.map((s) => s.id), ["l2"]);
});

test("timestamp collision: cut cursor stays event-ID based", () => {
  // Two summaries share the same latest_timestamp; the second is skipped
  // (latest <= coverageEnd) and the cut is the first one's event id, not a timestamp.
  const candidates = [
    summary({ id: "x", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev_x" }),
    summary({ id: "y", level: 1, earliestTimestamp: 150, latestTimestamp: 200, latestEventId: "ev_y" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates);
  assert.deepEqual(summaries.map((s) => s.id), ["x"]);
  assert.equal(coverageEndEventId, "ev_x");
});

test("empty candidates yield a null cut cursor", () => {
  const { summaries, coverageEndEventId } = selectSummaries([]);
  assert.deepEqual(summaries, []);
  assert.equal(coverageEndEventId, null);
});
