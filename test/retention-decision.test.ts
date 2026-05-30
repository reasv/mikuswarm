import assert from "node:assert/strict";
import test from "node:test";
import { decideRetentionSweep } from "../src/app.js";

const MILLIS_PER_DAY = 86_400_000;
const NOW = 1_700_000_000_000;

test("retention sweep is skipped when retention is disabled (days = 0)", () => {
  const decision = decideRetentionSweep({ retentionDays: 0, draining: false, now: NOW });
  assert.deepEqual(decision, { skip: true });
});

test("retention sweep is skipped when retentionDays is negative", () => {
  const decision = decideRetentionSweep({ retentionDays: -5, draining: false, now: NOW });
  assert.deepEqual(decision, { skip: true });
});

test("retention sweep is skipped while draining, even with a positive retention window", () => {
  const decision = decideRetentionSweep({ retentionDays: 30, draining: true, now: NOW });
  assert.deepEqual(decision, { skip: true });
});

test("retention sweep runs with cutoff = now − days·86_400_000 when enabled and not draining", () => {
  const decision = decideRetentionSweep({ retentionDays: 30, draining: false, now: NOW });
  assert.deepEqual(decision, { skip: false, cutoff: NOW - 30 * MILLIS_PER_DAY });
});

test("retention cutoff scales linearly with the day count", () => {
  const oneDay = decideRetentionSweep({ retentionDays: 1, draining: false, now: NOW });
  assert.deepEqual(oneDay, { skip: false, cutoff: NOW - MILLIS_PER_DAY });
});
