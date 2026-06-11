import assert from "node:assert/strict";
import test from "node:test";
import { selectSummaries, renderSummaryLayer, type SummaryContiguityProbe } from "../src/context/index.js";
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

// Contiguity is event-existence based (issue: the old 1ms timestamp tolerance
// stalled the cursor at the first summary, since adjacent worker-produced
// summaries are separated by real inter-message intervals). In production the
// probe is `makeContiguityProbe(storage, timelineKey)`; these pure tests
// substitute explicit probes.
const contiguous: SummaryContiguityProbe = () => true;

test("single summary is selected and its latestEventId becomes the coverage cursor", () => {
  const candidates = [
    summary({ id: "solo", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev_solo" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates, contiguous);
  assert.deepEqual(summaries.map((s) => s.id), ["solo"]);
  assert.equal(coverageEndEventId, "ev_solo");
});

test("selects all non-overlapping level-1 summaries, ordered, cut at the latest", () => {
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "ev2" }),
    summary({ id: "s3", level: 1, earliestTimestamp: 300, latestTimestamp: 400, latestEventId: "ev3" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates, contiguous);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2", "s3"]);
  assert.equal(coverageEndEventId, "ev3");
});

test("prefers a higher-level summary that covers two level-1 summaries", () => {
  const candidates = [
    summary({ id: "l1a", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "evA" }),
    summary({ id: "l2", level: 2, earliestTimestamp: 100, latestTimestamp: 300, latestEventId: "evC", eventCount: 2 }),
    summary({ id: "l1b", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "evB" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates, contiguous);
  assert.deepEqual(summaries.map((s) => s.id), ["l2"]);
  assert.equal(coverageEndEventId, "evC");
});

test("ordering survives a reordered candidate list (prune covers either order)", () => {
  const candidates = [
    summary({ id: "l2", level: 2, earliestTimestamp: 100, latestTimestamp: 300, latestEventId: "evC", eventCount: 2 }),
    summary({ id: "l1a", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "evA" }),
    summary({ id: "l1b", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "evB" }),
  ];
  const { summaries } = selectSummaries(candidates, contiguous);
  assert.deepEqual(summaries.map((s) => s.id), ["l2"]);
});

test("timestamp collision: cut cursor stays event-ID based", () => {
  // Two summaries share the same latest_timestamp; the second is skipped
  // (latest <= coverageEnd) and the cut is the first one's event id, not a timestamp.
  const candidates = [
    summary({ id: "x", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev_x" }),
    summary({ id: "y", level: 1, earliestTimestamp: 150, latestTimestamp: 200, latestEventId: "ev_y" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates, contiguous);
  assert.deepEqual(summaries.map((s) => s.id), ["x"]);
  assert.equal(coverageEndEventId, "ev_x");
});

test("empty candidates yield a null cut cursor", () => {
  const { summaries, coverageEndEventId } = selectSummaries([], contiguous);
  assert.deepEqual(summaries, []);
  assert.equal(coverageEndEventId, null);
});

test("genuine gap (uncovered events between summaries): cursor stops at last contiguous summary", () => {
  // s1 covers [100,200], s2 covers [500,600], and the probe reports raw events
  // between them (e.g. summarization-skipped material). Both summaries are
  // rendered, but the cursor stops at s1 so the gap's events are queried and
  // rendered raw — advancing would silently skip them.
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 500, latestTimestamp: 600, latestEventId: "ev2" }),
  ];
  const eventsBetweenS1AndS2: SummaryContiguityProbe = (prev, next) =>
    !(prev.id === "s1" && next.id === "s2");
  const { summaries, coverageEndEventId } = selectSummaries(candidates, eventsBetweenS1AndS2);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2"]);
  // Cursor is ev1 (last contiguous), NOT ev2
  assert.equal(coverageEndEventId, "ev1");
});

test("adjacent summaries with a real inter-message interval: cursor reaches the end (issue #1)", () => {
  // s2 starts 90 seconds after s1 ends — a normal inter-message interval, with
  // no raw events between (the ranges abut by construction: each level-1 chunk
  // starts at the first event after the coverage cursor). Under the old 1ms
  // timestamp tolerance the cursor stalled at s1, double-rendering s2's range
  // and silently dropping history once compaction kicked in.
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100_000, latestTimestamp: 200_000, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 290_000, latestTimestamp: 380_000, latestEventId: "ev2" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates, contiguous);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2"]);
  assert.equal(coverageEndEventId, "ev2");
});

test("gap after contiguous prefix: cursor stops before the gap", () => {
  // s1-s2 are contiguous; uncovered raw events sit between s2 and s3.
  const candidates = [
    summary({ id: "s1", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "ev1" }),
    summary({ id: "s2", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "ev2" }),
    summary({ id: "s3", level: 1, earliestTimestamp: 500, latestTimestamp: 600, latestEventId: "ev3" }),
  ];
  const eventsBeforeS3: SummaryContiguityProbe = (_prev, next) => next.id !== "s3";
  const { summaries, coverageEndEventId } = selectSummaries(candidates, eventsBeforeS3);
  assert.deepEqual(summaries.map((s) => s.id), ["s1", "s2", "s3"]);
  // Cursor stops at s2 (last contiguous before the gap)
  assert.equal(coverageEndEventId, "ev2");
});

test("gap with higher-level summary: contiguous chain uses highest coverage", () => {
  // L2 covers [100,300], then a genuine gap, then L1 covers [500,600].
  // Cursor should stop at the L2 summary.
  const candidates = [
    summary({ id: "l1a", level: 1, earliestTimestamp: 100, latestTimestamp: 200, latestEventId: "evA" }),
    summary({ id: "l2", level: 2, earliestTimestamp: 100, latestTimestamp: 300, latestEventId: "evC", eventCount: 2 }),
    summary({ id: "l1b", level: 1, earliestTimestamp: 200, latestTimestamp: 300, latestEventId: "evB" }),
    summary({ id: "l1c", level: 1, earliestTimestamp: 500, latestTimestamp: 600, latestEventId: "evD" }),
  ];
  const eventsBeforeL1c: SummaryContiguityProbe = (_prev, next) => next.id !== "l1c";
  const { summaries, coverageEndEventId } = selectSummaries(candidates, eventsBeforeL1c);
  // l1a and l1b are pruned (covered by l2), l2 and l1c remain
  assert.deepEqual(summaries.map((s) => s.id), ["l2", "l1c"]);
  // Cursor at l2, not l1c (gap between 300 and 500)
  assert.equal(coverageEndEventId, "evC");
});

test("overlapping summaries: lower level extending further selects both, cursor reflects L1", () => {
  // L2 covers [100,300], L1 covers [250,400]. Both should be selected:
  // L2 first (adds coverage to 300), then L1 extends coverage to 400.
  // The cursor should reflect L1's latestEventId since it extends further.
  const candidates = [
    summary({ id: "l2", level: 2, earliestTimestamp: 100, latestTimestamp: 300, latestEventId: "evL2", eventCount: 2 }),
    summary({ id: "l1", level: 1, earliestTimestamp: 250, latestTimestamp: 400, latestEventId: "evL1" }),
  ];
  const { summaries, coverageEndEventId } = selectSummaries(candidates, contiguous);
  assert.deepEqual(summaries.map((s) => s.id), ["l2", "l1"]);
  assert.equal(coverageEndEventId, "evL1");
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
