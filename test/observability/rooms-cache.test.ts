/**
 * Unit tests for the /api/rooms TTL cache (createCachedRoomsHandler).
 * Validates: first-call DB read, within-TTL cache hit (stale data), TTL expiry
 * triggers re-read, and that direct Storage.listConsoleRooms() is always exact.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Storage } from "../../src/storage/index.js";
import { createCachedRoomsHandler } from "../../src/observability/server/handlers.js";
import type { CanonicalChatEvent } from "../../src/types.js";
import type { RequestContext } from "../../src/observability/server/types.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function event(id: string, timelineKey: string, timestamp = 1_000): CanonicalChatEvent {
  return {
    id,
    timelineKey,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: `body ${id}`,
    timestamp,
    receivedAt: timestamp,
  };
}

/**
 * Minimal ServerResponse stub that captures the JSON body written by sendJson.
 * sendJson calls res.writeHead() then res.end(jsonString).
 */
function mockResponse(): { res: ServerResponse; body: () => unknown } {
  let captured: string | undefined;
  const res = {
    headersSent: false,
    writeHead(_status: number, _headers?: unknown) {},
    end(data: string) {
      captured = data;
    },
  } as unknown as ServerResponse;
  return {
    res,
    body: () => (captured !== undefined ? (JSON.parse(captured) as unknown) : undefined),
  };
}

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

/** Call the handler with a mock req and the given res, discarding ctx (unused by the rooms handler). */
function callHandler(
  handler: ReturnType<typeof createCachedRoomsHandler>,
  res: ServerResponse,
): void {
  handler(
    {} as unknown as IncomingMessage,
    res,
    {} as unknown as RequestContext,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("rooms cache: first call hits DB and returns current data", async () => {
  await withStorage(async (storage) => {
    const TK1 = "matrix:acc:room:!r1:example.org";
    await storage.appendTimelineEvent(event("e1", TK1));

    const handler = createCachedRoomsHandler(storage, 5_000);
    const { res, body } = mockResponse();
    callHandler(handler, res);
    const result = body() as { rooms: { timelineKey: string }[] };
    assert.equal(result.rooms.length, 1);
    assert.equal(result.rooms[0]!.timelineKey, TK1);
  });
});

test("rooms cache: second call within TTL returns cached (stale) data", async () => {
  await withStorage(async (storage) => {
    const TK1 = "matrix:acc:room:!r1:example.org";
    const TK2 = "matrix:acc:room:!r2:example.org";
    await storage.appendTimelineEvent(event("e1", TK1));

    // Long TTL so it never expires during this test.
    const handler = createCachedRoomsHandler(storage, 60_000);

    // First call: fills cache with 1 room.
    const { res: res1, body: body1 } = mockResponse();
    callHandler(handler, res1);
    assert.equal((body1() as { rooms: unknown[] }).rooms.length, 1, "initial read: 1 room");

    // Insert a second room AFTER the first call.
    await storage.appendTimelineEvent(event("e2", TK2));

    // Second call within TTL: should return the stale cached result (1 room).
    const { res: res2, body: body2 } = mockResponse();
    callHandler(handler, res2);
    assert.equal(
      (body2() as { rooms: unknown[] }).rooms.length,
      1,
      "cache hit must return stale data (new room not yet visible)",
    );
  });
});

test("rooms cache: after TTL expiry next call returns fresh data", async () => {
  await withStorage(async (storage) => {
    const TK1 = "matrix:acc:room:!r1:example.org";
    const TK2 = "matrix:acc:room:!r2:example.org";
    await storage.appendTimelineEvent(event("e1", TK1));

    // Very short TTL (50 ms) so we can trigger expiry with a small sleep.
    const handler = createCachedRoomsHandler(storage, 50);

    // First call: fills cache.
    const { res: res1, body: body1 } = mockResponse();
    callHandler(handler, res1);
    assert.equal((body1() as { rooms: unknown[] }).rooms.length, 1, "initial read: 1 room");

    // Insert second room.
    await storage.appendTimelineEvent(event("e2", TK2));

    // Immediate second call: still cached (stale).
    const { res: res2, body: body2 } = mockResponse();
    callHandler(handler, res2);
    assert.equal(
      (body2() as { rooms: unknown[] }).rooms.length,
      1,
      "within-TTL call still sees stale data",
    );

    // Wait for TTL to expire.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    // Third call after expiry: cache miss → fresh read returns 2 rooms.
    const { res: res3, body: body3 } = mockResponse();
    callHandler(handler, res3);
    assert.equal(
      (body3() as { rooms: unknown[] }).rooms.length,
      2,
      "after TTL expiry the cache refills and returns fresh data",
    );
  });
});

test("rooms cache: direct Storage.listConsoleRooms() always returns current data", async () => {
  await withStorage(async (storage) => {
    const TK1 = "matrix:acc:room:!r1:example.org";
    const TK2 = "matrix:acc:room:!r2:example.org";
    await storage.appendTimelineEvent(event("e1", TK1));

    // Very long TTL — cache stays warm throughout.
    const handler = createCachedRoomsHandler(storage, 60_000);

    // Warm the cache with 1 room.
    const { res: res1 } = mockResponse();
    callHandler(handler, res1);

    // Insert second room after cache is warm.
    await storage.appendTimelineEvent(event("e2", TK2));

    // Handler still sees stale cache (1 room).
    const { res: res2, body: body2 } = mockResponse();
    callHandler(handler, res2);
    assert.equal(
      (body2() as { rooms: unknown[] }).rooms.length,
      1,
      "cached handler sees stale data",
    );

    // Direct Storage call is always exact — unaffected by the handler cache.
    const rows = storage.listConsoleRooms();
    assert.equal(rows.length, 2, "direct Storage.listConsoleRooms() always returns current data");
  });
});
