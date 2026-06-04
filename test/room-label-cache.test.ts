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
