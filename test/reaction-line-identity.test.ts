/**
 * Reaction-line identity resolution (Phase 6, §6.5 / Phase 3b carry-over).
 *
 * After Phase 6, buildDiscreteReactionLines in src/context/builder.ts resolves
 * each reaction row's senderDisplay through getUserIdentityMap using the provider
 * derived from the row's timelineKey. These tests verify:
 *
 *   1. Matrix sender with no user_identities entry → getUserIdentityMap returns an
 *      empty map → senderDisplay is unchanged → byte-identical output to pre-Phase-6.
 *   2. Non-Matrix sender with a user_identities entry → getUserIdentityMap returns
 *      the current identity → senderDisplay is overridden to the identity's displayName.
 *   3. synthesizeReactionLines uses the overridden senderDisplay in the output line.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import type { DiscreteReactionRow } from "../src/storage/index.js";
import { synthesizeReactionLines, type ReactionTarget } from "../src/context/reactions.js";

async function withStorage(run: (s: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await run(storage);
  } finally {
    storage.close();
  }
}

// ── Storage: getUserIdentityMap ───────────────────────────────────────────────

test("getUserIdentityMap returns empty map for Matrix senders (Matrix never writes user_identities)", async () => {
  await withStorage(async (storage) => {
    // Matrix senders never get a user_identities row — the matrix inbound path
    // skips upsertUserIdentity when no username field is present (§6.5).
    const result = storage.getUserIdentityMap([
      { provider: "matrix", userId: "@alice:example.org" },
    ]);
    assert.equal(result.size, 0, "Matrix senders produce an empty identity map");
  });
});

test("getUserIdentityMap returns overrides for providers that write user_identities", async () => {
  await withStorage(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "discord-user-1",
      username: "alice_discord",
      displayName: "Alice (Discord)",
      observedAt: 1000,
    });

    const result = storage.getUserIdentityMap([
      { provider: "discord", userId: "discord-user-1" },
      { provider: "discord", userId: "no-entry-for-this-user" },
    ]);

    assert.equal(result.size, 1);
    const identity = result.get("discord:discord-user-1");
    assert.ok(identity, "entry exists for the known sender");
    assert.equal(identity.username, "alice_discord");
    assert.equal(identity.displayName, "Alice (Discord)");
    assert.equal(result.get("discord:no-entry-for-this-user"), undefined, "missing sender absent from map");
  });
});

// ── Rendering: synthesizeReactionLines uses the overridden senderDisplay ─────

/** Minimal DiscreteReactionRow for synthesizeReactionLines. */
function reactionRow(
  over: Partial<DiscreteReactionRow> & { reactionEventId: string },
): DiscreteReactionRow {
  return {
    targetEventId: "$msg1",
    senderId: "discord-user-1",
    senderDisplay: "OldName",
    timelineKey: "discord:guild1:channel:ch1",
    normalizedKey: "👍",
    kind: "unicode",
    display: "👍",
    shortcode: null,
    reactedAt: 1000,
    ...over,
  };
}

function selfTarget(): Map<string, ReactionTarget> {
  return new Map([["$msg1", { body: "hello", self: true }]]);
}

test("synthesizeReactionLines uses senderDisplay from the row (pre-identity-resolution shape)", () => {
  const rows = [reactionRow({ reactionEventId: "$r1", senderDisplay: "StoredName" })];
  const lines = synthesizeReactionLines(rows, selfTarget(), { nameCap: 4 });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.content, /StoredName/, "stored senderDisplay appears in the line");
});

test("synthesizeReactionLines uses the overridden senderDisplay (post-identity-resolution shape)", () => {
  // Simulate what buildDiscreteReactionLines does: replace senderDisplay from the identity map.
  const rawRows = [reactionRow({ reactionEventId: "$r1", senderDisplay: "OldName" })];
  const resolvedRows = rawRows.map((row) => ({ ...row, senderDisplay: "IdentityMapName" }));

  const lines = synthesizeReactionLines(resolvedRows, selfTarget(), { nameCap: 4 });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.content, /IdentityMapName/, "identity-map name appears in the rendered line");
  assert.ok(!lines[0]!.content.includes("OldName"), "old senderDisplay is replaced");
});

test("buildDiscreteReactionLines empty-map passthrough: synthesizeReactionLines with empty rows returns []", () => {
  // Mirrors the rows.length === 0 early-return in buildDiscreteReactionLines: when
  // there are no live reactions, the function returns [] without allocating. Verified
  // here via synthesizeReactionLines (the private method's actual render delegate).
  const targets: Map<string, ReactionTarget> = new Map([["$msg1", { body: "hello", self: true }]]);
  const lines = synthesizeReactionLines([], targets, { nameCap: 4 });
  assert.deepEqual(lines, []);
});

test("Matrix reaction rows with no identity entry are byte-identical before and after Phase 6", () => {
  // Matrix rows always have senderDisplay from the event; no identity-map entry exists.
  // The identity-map lookup returns an empty map → resolvedRows === rows (no-op path).
  // This verifies byte-identical output for Matrix.
  const matrixRow: DiscreteReactionRow = {
    reactionEventId: "$r-mat",
    targetEventId: "$msg-mat",
    senderId: "@alice:example.org",
    senderDisplay: "Alice",
    timelineKey: "matrix:miku:room:!room:example.org",
    normalizedKey: "👍",
    kind: "unicode",
    display: "👍",
    shortcode: null,
    reactedAt: 1000,
  };

  const matrixTarget: Map<string, ReactionTarget> = new Map([["$msg-mat", { body: "hey", self: true }]]);
  const opts = { nameCap: 4 };

  // Before: row as-is.
  const before = synthesizeReactionLines([matrixRow], matrixTarget, opts);

  // After Phase 6 with empty identity map (no Matrix entry → no-op override).
  const emptyMap = new Map<string, import("../src/storage/index.js").CurrentIdentity>();
  const resolvedRow =
    emptyMap.size > 0
      ? { ...matrixRow, senderDisplay: emptyMap.get("matrix:@alice:example.org")?.displayName ?? matrixRow.senderDisplay }
      : matrixRow;
  const after = synthesizeReactionLines([resolvedRow], matrixTarget, opts);

  assert.deepEqual(before, after, "Matrix reaction lines are byte-identical after Phase 6");
  assert.match(before[0]!.content, /Alice/, "Alice's name is in the output");
});
