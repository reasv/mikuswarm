import assert from "node:assert/strict";
import test from "node:test";
import { computeRecencyLabel, resolveRecencyLabels } from "../src/context/index.js";
import type { Summary } from "../src/storage/index.js";

const HOUR = 1000 * 60 * 60;
const NOW = 1_000_000_000_000;

function summary(id: string, latestTimestamp: number): Summary {
  return {
    id,
    timelineKey: "matrix:test:room:!room",
    level: 1,
    content: "body",
    earliestTimestamp: latestTimestamp - HOUR,
    latestTimestamp,
    latestEventId: `ev_${id}`,
    eventCount: 1,
    tokenCount: 10,
    modelId: "model",
    status: "complete",
    backfillJobId: null,
    generatedAt: 0,
    createdAt: 0,
  };
}

test("recency buckets: sub-hour, singular hour, hours, days", () => {
  assert.equal(computeRecencyLabel(NOW - 30 * 60 * 1000, NOW), "< 1 hour ago");
  assert.equal(computeRecencyLabel(NOW - 1.5 * HOUR, NOW), "1 hour ago");
  assert.equal(computeRecencyLabel(NOW - 5 * HOUR, NOW), "5 hours ago");
  assert.equal(computeRecencyLabel(NOW - 47 * HOUR, NOW), "47 hours ago");
  assert.equal(computeRecencyLabel(NOW - 50 * HOUR, NOW), "2 days ago");
});

test("48-hour boundary: exactly 48 hours returns days format", () => {
  // At exactly 48 hours, diffHours === 48, which is NOT < 48, so the function
  // falls through to the days branch: Math.floor(48 / 24) = 2 days ago.
  assert.equal(computeRecencyLabel(NOW - 48 * HOUR, NOW), "2 days ago");
});

test("negative time diff (clock skew: now < latestTimestamp) returns '< 1 hour ago'", () => {
  // When the trigger timestamp is earlier than the summary's latest timestamp
  // (e.g. clock skew), diffHours is negative. The function treats this the same
  // as sub-hour, returning "< 1 hour ago".
  assert.equal(computeRecencyLabel(NOW + 5 * HOUR, NOW), "< 1 hour ago");
});

test("labels are stable across small time increments within a bucket", () => {
  const base = computeRecencyLabel(NOW - 5 * HOUR, NOW);
  // Advance now by a few minutes — still within the same hour bucket.
  const later = computeRecencyLabel(NOW - 5 * HOUR, NOW + 5 * 60 * 1000);
  assert.equal(base, later);
});

test("cache hit returns cached labels and signals no rewrite", () => {
  const selected = [summary("a", NOW - 5 * HOUR), summary("b", NOW - 2 * HOUR)];
  const cached = {
    labels: [
      { summaryId: "a", label: "5 hours ago", computedAt: NOW },
      { summaryId: "b", label: "2 hours ago", computedAt: NOW },
    ],
    validUntil: NOW + HOUR,
  };
  const resolved = resolveRecencyLabels(selected, cached, NOW, HOUR);
  assert.deepEqual(resolved.labels, ["5 hours ago", "2 hours ago"]);
  assert.equal(resolved.cacheToStore, null);
});

test("expired cache recomputes and produces a fresh cache to store", () => {
  const selected = [summary("a", NOW - 5 * HOUR)];
  const cached = {
    labels: [{ summaryId: "a", label: "4 hours ago", computedAt: NOW - 2 * HOUR }],
    validUntil: NOW - HOUR, // expired
  };
  const resolved = resolveRecencyLabels(selected, cached, NOW, HOUR);
  assert.deepEqual(resolved.labels, ["5 hours ago"]);
  assert.notEqual(resolved.cacheToStore, null);
  assert.equal(resolved.cacheToStore?.validUntil, NOW + HOUR);
});
