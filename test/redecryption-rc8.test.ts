/**
 * RC8 gating for the re-decryption sweeper (Phase 6, ARCHITECTURE.md §9f end).
 *
 * The re-decryption sweeper is Matrix-only: megolm key recovery is not a
 * concept for other providers. When #probe encounters an event whose
 * `provider` field is not "matrix" it must return early with a log and
 * NEVER call retireUndecrypted.
 *
 * These tests use a stub store so they do not require the native NAPI module.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { RedecryptionSweeper } from "../src/redecryption/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { TimelineStore } from "../src/timeline/index.js";

const MATRIX_ACCOUNT = "miku";
const MATRIX_ROOM = "!room:example.org";
const MATRIX_TK = `matrix:${MATRIX_ACCOUNT}:room:${MATRIX_ROOM}`;
const DISCORD_TK = "discord:guild123:channel:456";

function makeEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "matrix:miku:$utd1",
    externalId: "$utd1",
    timelineKey: MATRIX_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org" },
    body: "",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    undecryptable: { sessionId: "s-abc" },
    ...overrides,
  };
}

/** Build a stub TimelineStore that delegates only the methods the sweeper uses. */
function makeStore(
  events: CanonicalChatEvent[],
  retired: string[],
): TimelineStore {
  return {
    getUndecrypted: (limit?: number) =>
      events.slice(0, limit).map((event) => ({ event, attempts: 0 })),
    retireUndecrypted: async (id: string) => {
      retired.push(id);
      return undefined as unknown as ReturnType<TimelineStore["retireUndecrypted"]>;
    },
    deleteUndecrypted: async (_id: string) => false,
    replaceUndecrypted: async () => undefined,
    recordRedecryptFailure: async (_id: string, _at: number) => {},
  } as unknown as TimelineStore;
}

// ── RC8: non-Matrix provider → early return, no retireUndecrypted ─────────────

test("probe skips a Discord-provider event and never calls retireUndecrypted", async () => {
  const retired: string[] = [];
  const retryCalled: string[] = [];

  const discordEvent = makeEvent({
    id: "discord:guild123:channel:456:msg1",
    timelineKey: DISCORD_TK,
    provider: "discord",
    externalId: "msg1",
  });

  const sweeper = new RedecryptionSweeper({
    store: makeStore([discordEvent], retired),
    retry: async ({ roomId, eventId }) => {
      retryCalled.push(`${roomId}:${eventId}`);
      return null;
    },
    notifyEnrichment: () => {},
    notifyCaptions: () => {},
    notifyChatIndex: () => {},
    intervalMs: 1000,
    batchSize: 10,
    isDraining: () => false,
  });

  await sweeper.tick();

  assert.deepEqual(retired, [], "retireUndecrypted must NOT be called for non-Matrix events");
  assert.deepEqual(retryCalled, [], "retry (native fetch) must NOT be called for non-Matrix events");
});

test("probe skips any non-matrix provider, not just discord", async () => {
  const retired: string[] = [];

  const slackEvent = makeEvent({
    id: "slack:workspace:channel:C123:msg1",
    timelineKey: "slack:workspace:channel:C123",
    provider: "slack",
    externalId: "msg1",
  });

  const sweeper = new RedecryptionSweeper({
    store: makeStore([slackEvent], retired),
    retry: async () => { assert.fail("retry must not be called"); return null; },
    notifyEnrichment: () => {},
    notifyCaptions: () => {},
    notifyChatIndex: () => {},
    intervalMs: 1000,
    batchSize: 10,
    isDraining: () => false,
  });

  await sweeper.tick();

  assert.deepEqual(retired, [], "retireUndecrypted not called for non-matrix providers");
});

// ── Matrix events still processed normally ────────────────────────────────────

test("probe processes a Matrix UTD event normally (calls retry, not retireUndecrypted)", async () => {
  const retired: string[] = [];
  const retryCalled: string[] = [];

  const matrixEvent = makeEvent(); // provider: "matrix", timelineKey: MATRIX_TK

  const sweeper = new RedecryptionSweeper({
    store: makeStore([matrixEvent], retired),
    retry: async ({ roomId, eventId }) => {
      retryCalled.push(`${roomId}:${eventId}`);
      // Simulate keys still not arrived → still undecryptable.
      return {
        eventId,
        sender: "@alice:example.org",
        body: "",
        timestamp: new Date(1_700_000_000_000).toISOString(),
        undecryptable: true,
        sessionId: "s-abc",
      } as unknown as import("../src/matrix/native-types.js").MatrixMessageSummary;
    },
    notifyEnrichment: () => {},
    notifyCaptions: () => {},
    notifyChatIndex: () => {},
    intervalMs: 1000,
    batchSize: 10,
    isDraining: () => false,
  });

  await sweeper.tick();

  assert.deepEqual(retired, [], "still-UTD Matrix event is not retired");
  assert.deepEqual(retryCalled, [`${MATRIX_ROOM}:$utd1`], "retry was invoked with the Matrix room+eventId");
});

// ── Matrix event with malformed timelineKey → retire (original behaviour) ─────

test("Matrix event missing roomId (malformed key) still calls retireUndecrypted", async () => {
  const retired: string[] = [];

  // provider is "matrix" but the key doesn't parse to a room id
  const brokenEvent = makeEvent({
    id: "matrix:miku:$broken",
    externalId: "$broken",
    timelineKey: "matrix:miku:not-a-valid-kind:room",
    provider: "matrix",
  });

  const sweeper = new RedecryptionSweeper({
    store: makeStore([brokenEvent], retired),
    retry: async () => { assert.fail("retry must not be called for missing roomId"); return null; },
    notifyEnrichment: () => {},
    notifyCaptions: () => {},
    notifyChatIndex: () => {},
    intervalMs: 1000,
    batchSize: 10,
    isDraining: () => false,
  });

  await sweeper.tick();

  // RC8 gate doesn't fire (provider === "matrix"), but !roomId fires → retire.
  assert.deepEqual(retired, ["matrix:miku:$broken"], "malformed Matrix key → retire as before");
});
