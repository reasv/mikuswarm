import assert from "node:assert/strict";
import test from "node:test";
import { selectSummaries, renderSummaryLayer } from "../src/context/index.js";
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

test("gap between summaries: cursor stops at last contiguous summary", () => {
  // s1 covers [100,200], s2 covers [500,600] — gap between 200 and 500.
  // Both summaries should be rendered, but the cursor should stop at s1
  // so events in the gap (201-499) are queried and rendered raw.
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 500, latestTimestamp: 600, latestEventId: "ev2" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2"]);
  // Cursor is ev1 (last contiguous), NOT ev2
  assert.equal(coverageEndEventId, "ev1");
});

test("contiguous summaries within 1ms tolerance: cursor reaches the end", () => {
  // s2.earliestTimestamp is exactly 1ms after s1.latestTimestamp — within tolerance.
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 201, latestTimestamp: 300, latestEventId: "ev2" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2"]);
  assert.equal(coverageEndEventId, "ev2");
});

test("gap after contiguous prefix: cursor stops before the gap", () => {
  // s1-s2 are contiguous, s3 has a gap after s2.
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "ev2" }),
    summary({ id: "s3", level: 1, earliestTimestamp: 500, latestTimestamp: 600, latestEventId: "ev3" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2", "s3"]);
  // Cursor stops at s2 (last contiguous before the gap)
  assert.equal(coverageEndEventId, "ev2");
});

test("gap with higher-level summary: contiguous chain uses highest coverage", () => {
  // L2 covers [100,300], then a gap, then L1 covers [500,600].
  // Cursor should stop at the L2 summary.
  const candidates = [
    summary({ id: "l1a", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "evA" }),
    summary({ id: "l2", level: 2, earliestTimestamp: 100, latestTimestamp: 300, latestEventId: "evC", eventCount: 2 }),
    summary({ id: "l1b", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "evB" }),
    summary({ id: "l1c", level: 1, earliestTimestamp: 500, latestTimestamp: 600, latestEventId: "evD" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates);
  // l1a and l1b are pruned (covered by l2), l2 and l1c remain
  assert.deepEqual(summaries.map((s) => s.id), ["l2", "l1c"]);
  // Cursor at l2, not l1c (gap between 300 and 500)
  assert.equal(coverageEndEventId, "evC");
});

test("renderSummaryLayer escapes XML special characters in summary content", () => {
  const summaries = [
    summary({
      id: "s1",
      level: 1,
      earliestTimestamp: 1000,
      latestTimestamp: 2000,
      latestEventId: "ev1",
      content: 'User said <bold>hello</bold> & "goodbye" with 3 > 2 assertion',
    }),
  ];
  const labels = ["1 hour ago"];
  const rendered = renderSummaryLayer(summaries, labels);
  // The content should have XML entities escaped
  assert.ok(rendered.includes("&lt;bold&gt;hello&lt;/bold&gt;"), "< and > should be escaped");
  assert.ok(rendered.includes("&amp;"), "& should be escaped");
  // The XML envelope tags themselves should NOT be escaped
  assert.ok(rendered.startsWith("<summary "), "envelope tag should not be escaped");
  assert.ok(rendered.endsWith("</summary>"), "closing tag should not be escaped");
});
