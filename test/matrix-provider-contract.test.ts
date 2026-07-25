/**
 * Contract-shape tests for MatrixProvider implementing IChatProvider (Phase 2a).
 *
 * - Type-level: TypeScript checks that MatrixProvider satisfies IChatProvider at
 *   compile time via the assignability assertion below.
 * - Runtime smoke: accountIds / getSelf / ownsUserId against a configured-but-
 *   not-started provider; enrichment() returns undefined before start.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MatrixProvider } from "../src/matrix/provider.js";
import type { IChatProvider } from "../src/types.js";
import type { AppConfig } from "../src/config/index.js";

// ── Type-level check ─────────────────────────────────────────────────────────

// If MatrixProvider does NOT satisfy IChatProvider this assignment will be a
// compile-time error (caught by `tsc --noEmit`), not a runtime failure.
const _typeCheck: IChatProvider = null as unknown as MatrixProvider;
void _typeCheck;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProvider(opts: Partial<AppConfig["matrix"]> = {}): MatrixProvider {
  return new MatrixProvider(
    {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {},
      ...opts,
    } as AppConfig["matrix"],
  );
}

// ── Runtime smoke: before start() ────────────────────────────────────────────

test("MatrixProvider.id is 'matrix'", () => {
  const p = makeProvider();
  assert.equal(p.id, "matrix");
});

test("MatrixProvider.capabilities has all required Phase-2a fields", () => {
  const p = makeProvider();
  const c = p.capabilities;
  assert.equal(c.maxAttachmentsPerMessage, 1);
  assert.equal(c.maxMessageChars, 4000);
  assert.equal(c.formatting, "html");
  assert.equal(c.edits, true);
  assert.equal(c.deletes, true);
  assert.equal(c.pollCreate, true);
  assert.equal(c.pollVote, true);
  assert.equal(c.pins, true);
  assert.equal(c.voiceMessages, true);
  assert.equal(c.threads, true);
  assert.equal(c.history, true);
  assert.equal(c.encrypted, true);
  assert.equal(c.linkPreviews, "provider");
  assert.equal(c.singleAttachmentPerMessage, true);
  assert.equal(c.membershipRoster, true);
  assert.deepEqual(c.reactionKinds, ["unicode", "custom", "text"]);
});

test("accountIds() returns empty array before start()", () => {
  const p = makeProvider();
  assert.deepEqual(p.accountIds(), []);
});

test("getSelf() returns undefined for unknown account before start()", () => {
  const p = makeProvider();
  assert.equal(p.getSelf("any-account"), undefined);
});

test("ownsUserId() accepts '@' prefix", () => {
  const p = makeProvider();
  assert.equal(p.ownsUserId("@bot:example.org"), true);
});

test("ownsUserId() rejects non-'@' id", () => {
  const p = makeProvider();
  assert.equal(p.ownsUserId("123456789012345678"), false);
});

test("enrichment() returns undefined before start()", () => {
  const p = makeProvider();
  assert.equal(p.enrichment("main"), undefined);
});

// ── start() with enabled:false sets host but populates no accounts ────────────

test("accountIds() remains empty when enabled:false after start()", async () => {
  const p = makeProvider({ enabled: false });
  await p.start({
    onEvent: () => {},
    onError: () => {},
    onReaction: () => {},
  });
  assert.deepEqual(p.accountIds(), []);
});

test("getSelf() returns undefined when enabled:false after start()", async () => {
  const p = makeProvider({ enabled: false });
  await p.start({
    onEvent: () => {},
    onError: () => {},
    onReaction: () => {},
  });
  assert.equal(p.getSelf("any"), undefined);
});

test("onEvent is called for delivered events when provider is started with host", async () => {
  const p = makeProvider({ enabled: false, trigger_hold_ms: 0 });
  const received: unknown[] = [];
  await p.start({
    onEvent: (e) => received.push(e),
    onError: () => {},
    onReaction: () => {},
  });
  // Drive emitWithTriggerHold directly (the private method used in poll).
  const emitFn = (p as unknown as {
    emitWithTriggerHold(e: object): void;
  }).emitWithTriggerHold.bind(p);
  const fakeEvent = {
    provider: "matrix",
    timelineKey: "matrix:bot:room:!r:h",
    event: {
      id: "e1", externalId: "e1", timelineKey: "matrix:bot:room:!r:h",
      provider: "matrix", role: "user",
      sender: { id: "@alice:h" }, body: "hi",
      timestamp: 0, receivedAt: 0,
    },
  };
  emitFn(fakeEvent);
  // The non-triggered message is emitted immediately (trigger stripped, trigger hold not buffered).
  assert.equal(received.length, 1);
});
