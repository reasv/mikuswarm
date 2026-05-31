import assert from "node:assert/strict";
import test from "node:test";
import { decideRetentionSweep, runRetentionSweep } from "../src/app.js";

const noopLogger = { info() {}, error() {} };

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

test("#6: a sweep does NOT start when draining flips true between the decision and the prune", async () => {
  // The race the fix closes: decideRetentionSweep sees draining=false (so it does
  // not skip), but stop() sets draining=true before the awaited prune. The
  // re-check must bail so no prune is started.
  let draining = false;
  let pruneCalls = 0;
  await runRetentionSweep({
    retentionDays: 30,
    // First read (inside decideRetentionSweep) sees false; flip true for the
    // re-check just before the prune, mimicking stop() racing the callback.
    isDraining: () => {
      const value = draining;
      draining = true; // next read (the re-check) observes drain has begun
      return value;
    },
    now: () => NOW,
    prune: async () => {
      pruneCalls++;
      return 0;
    },
    logger: noopLogger,
  });
  assert.equal(pruneCalls, 0, "the prune must not start once draining flips true before it");
});

test("#6: a sweep runs the prune when not draining at either check", async () => {
  let pruneCalls = 0;
  let prunedCutoff: number | undefined;
  await runRetentionSweep({
    retentionDays: 30,
    isDraining: () => false,
    now: () => NOW,
    prune: async (cutoff) => {
      pruneCalls++;
      prunedCutoff = cutoff;
      return 3;
    },
    logger: noopLogger,
  });
  assert.equal(pruneCalls, 1, "the prune runs when not draining");
  assert.equal(prunedCutoff, NOW - 30 * MILLIS_PER_DAY);
});
