import assert from "node:assert/strict";
import test from "node:test";
import { RoomLabelCache, type RoomLabelStore } from "../src/matrix/room-label-cache.js";
import type { Logger } from "../src/observability/index.js";

const TK = "matrix:miku:room:!room:example.org";

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
};

class FakeStore implements RoomLabelStore {
  rows = new Map<string, { displayName: string; resolvedAt: number }>();
  writes = 0;

  getRoomMetadata(timelineKey: string) {
    return this.rows.get(timelineKey);
  }
  async setRoomDisplayName(timelineKey: string, displayName: string) {
    this.writes++;
    this.rows.set(timelineKey, { displayName, resolvedAt: Date.now() });
  }
  listKnownTimelineKeys() {
    return [...this.rows.keys()];
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("ensureLabel resolves and persists when no label is cached", async () => {
  const store = new FakeStore();
  const cache = new RoomLabelCache({ store, resolve: async () => "General", logger: noopLogger });

  cache.ensureLabel(TK);
  await tick();

  assert.equal(store.rows.get(TK)?.displayName, "General");
});

test("ensureLabel coalesces concurrent calls into a single resolve", async () => {
  const store = new FakeStore();
  let calls = 0;
  let release!: (label: string) => void;
  const gate = new Promise<string>((r) => {
    release = r;
  });
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      calls++;
      return gate;
    },
    logger: noopLogger,
  });

  cache.ensureLabel(TK);
  cache.ensureLabel(TK);
  cache.ensureLabel(TK);
  release("General");
  await tick();

  assert.equal(calls, 1);
  assert.equal(store.writes, 1);
});

test("ensureLabel skips a resolve when the cached label is still fresh", async () => {
  const store = new FakeStore();
  store.rows.set(TK, { displayName: "Cached", resolvedAt: Date.now() });
  let calls = 0;
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      calls++;
      return "New";
    },
    logger: noopLogger,
    ttlMs: 60_000,
  });

  cache.ensureLabel(TK);
  await tick();

  assert.equal(calls, 0);
  assert.equal(store.rows.get(TK)?.displayName, "Cached");
});

test("ensureLabel re-resolves when the cached label is stale", async () => {
  const store = new FakeStore();
  store.rows.set(TK, { displayName: "Old", resolvedAt: Date.now() - 120_000 });
  const cache = new RoomLabelCache({
    store,
    resolve: async () => "Fresh",
    logger: noopLogger,
    ttlMs: 60_000,
  });

  cache.ensureLabel(TK);
  await tick();

  assert.equal(store.rows.get(TK)?.displayName, "Fresh");
});

test("ensureLabel swallows resolver errors and leaves the prior label intact", async () => {
  const store = new FakeStore();
  store.rows.set(TK, { displayName: "Old", resolvedAt: Date.now() - 120_000 });
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      throw new Error("homeserver down");
    },
    logger: noopLogger,
    ttlMs: 60_000,
  });

  cache.ensureLabel(TK);
  await tick();

  assert.equal(store.rows.get(TK)?.displayName, "Old");
  // The key is no longer in flight, so a later attempt can retry.
  assert.equal(store.writes, 0);
});

test("ensureLabel does not re-resolve a failed key while within the failure cooldown", async () => {
  const store = new FakeStore();
  let calls = 0;
  let clock = 1_000_000;
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      calls++;
      throw new Error("homeserver down");
    },
    logger: noopLogger,
    ttlMs: 60_000,
    failureCooldownMs: 300_000,
    now: () => clock,
  });

  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 1);

  // Second inbound event well within the cooldown: must not re-resolve.
  clock += 1_000;
  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 1);

  // Still within the cooldown a moment before it elapses.
  clock += 298_000;
  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 1);
});

test("ensureLabel re-resolves a failed key once the failure cooldown elapses", async () => {
  const store = new FakeStore();
  let calls = 0;
  let clock = 1_000_000;
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      calls++;
      if (calls === 1) throw new Error("homeserver down");
      return "Recovered";
    },
    logger: noopLogger,
    ttlMs: 60_000,
    failureCooldownMs: 300_000,
    now: () => clock,
  });

  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 1);

  // Advance past the cooldown: a retry is allowed and succeeds.
  clock += 300_001;
  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 2);
  assert.equal(store.rows.get(TK)?.displayName, "Recovered");
});

test("a successful resolve clears a prior failure so the cooldown no longer applies", async () => {
  const store = new FakeStore();
  let calls = 0;
  let clock = 1_000_000;
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      calls++;
      if (calls === 1) throw new Error("homeserver down");
      return "Resolved";
    },
    logger: noopLogger,
    // No TTL window: a fresh label is never considered stale here, so a re-fire
    // would only happen if the failure entry were still suppressing/allowing.
    ttlMs: 60_000,
    failureCooldownMs: 300_000,
    now: () => clock,
  });

  // First attempt fails and records a failure timestamp.
  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 1);

  // After the cooldown, the retry succeeds and clears the failure entry.
  clock += 300_001;
  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 2);
  assert.equal(store.rows.get(TK)?.displayName, "Resolved");

  // A later inbound event finds a fresh label and does not resolve again, and no
  // stale failure entry lingers to interfere.
  clock += 1_000;
  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 2);
});

test("backfillAll skips a key still within its failure cooldown", async () => {
  const store = new FakeStore();
  store.rows.set(TK, { displayName: TK, resolvedAt: 0 });
  let calls = 0;
  let clock = 1_000_000;
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      calls++;
      throw new Error("homeserver down");
    },
    logger: noopLogger,
    ttlMs: 60_000,
    backfillSpacingMs: 0,
    failureCooldownMs: 300_000,
    now: () => clock,
  });

  // First backfill attempts the resolve and fails, recording the failure.
  await cache.backfillAll();
  assert.equal(calls, 1);

  // A second backfill within the cooldown must not re-resolve.
  clock += 1_000;
  await cache.backfillAll();
  assert.equal(calls, 1);
});

test("ensureLabel does not persist an empty/whitespace resolved label and backs off", async () => {
  const store = new FakeStore();
  let calls = 0;
  let clock = 1_000_000;
  const cache = new RoomLabelCache({
    store,
    resolve: async () => {
      calls++;
      return "   ";
    },
    logger: noopLogger,
    ttlMs: 60_000,
    failureCooldownMs: 300_000,
    now: () => clock,
  });

  cache.ensureLabel(TK);
  await tick();

  // Nothing persisted for an empty label.
  assert.equal(store.writes, 0);
  assert.equal(store.rows.has(TK), false);
  assert.equal(calls, 1);

  // An empty result engages the backoff: a second inbound event within the
  // cooldown does not re-resolve.
  clock += 1_000;
  cache.ensureLabel(TK);
  await tick();
  assert.equal(calls, 1);
});

test("backfillAll resolves every known timeline that lacks a fresh label", async () => {
  const store = new FakeStore();
  store.rows.set("matrix:miku:room:!a", { displayName: "!a", resolvedAt: 0 });
  store.rows.set("matrix:miku:room:!b", { displayName: "!b", resolvedAt: 0 });
  const cache = new RoomLabelCache({
    store,
    resolve: async (tk) => `name-for-${tk}`,
    logger: noopLogger,
    backfillSpacingMs: 0,
  });

  await cache.backfillAll();

  assert.equal(store.rows.get("matrix:miku:room:!a")?.displayName, "name-for-matrix:miku:room:!a");
  assert.equal(store.rows.get("matrix:miku:room:!b")?.displayName, "name-for-matrix:miku:room:!b");
});
