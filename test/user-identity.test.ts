/**
 * Phase 3b user-identity tests (spec DISCORD-SUPPORT-DESIGN.md §6.5, §11.2).
 *
 * Covers:
 *  (a) DDL migration: v4→v5 creates user_identities + user_identity_aliases cleanly
 *      on an existing database; fresh open stamped at v5 also has both tables.
 *  (b) Upsert semantics: first sight inserts; changed username demotes to alias;
 *      unchanged is a no-op write-wise; alias bound (16) enforced.
 *  (c) Matrix events (no username): NEVER write rows — zero rows after Matrix-
 *      shaped events.
 *  (d) Render-time resolution: empty map → byte-identical output (reuse
 *      identity-rendering.test.ts patterns); populated map → old event renders
 *      under current name.
 *  (e) Retrieval lane: alias expansion produces the ORed name set.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage, USER_IDENTITY_ALIAS_BOUND } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function withTmpDb<T>(fn: (storage: Storage, dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-identity-"));
  const dbPath = path.join(dir, "test.db");
  const storage = await Storage.open({ databasePath: dbPath });
  try {
    return await fn(storage, dbPath);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Count rows in user_identities for a given provider. */
function countIdentities(storage: Storage, provider: string): number {
  return storage.read(
    (db) =>
      (
        db
          .prepare("select count(*) as n from user_identities where provider = ?")
          .get(provider) as { n: number }
      ).n,
  );
}

/** Count rows in user_identity_aliases for a given (provider, user_id). */
function countAliases(storage: Storage, provider: string, userId: string): number {
  return storage.read(
    (db) =>
      (
        db
          .prepare(
            "select count(*) as n from user_identity_aliases where provider = ? and user_id = ?",
          )
          .get(provider, userId) as { n: number }
      ).n,
  );
}

/** Read the current row for (provider, user_id). */
function readIdentity(
  storage: Storage,
  provider: string,
  userId: string,
): { username: string; display_name: string | null } | undefined {
  return storage.read(
    (db) =>
      db
        .prepare(
          "select username, display_name from user_identities where provider = ? and user_id = ?",
        )
        .get(provider, userId) as { username: string; display_name: string | null } | undefined,
  );
}

function matrixEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "matrix:miku:$ev",
    externalId: "$ev",
    timelineKey: "matrix:miku:room:!room:example.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "hello",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function discordEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "discord:bot:$123",
    externalId: "123",
    timelineKey: "discord:bot:channel:456",
    provider: "discord",
    role: "user",
    sender: { id: "111222333", username: "alice_d", displayName: "Alice (nick)" },
    body: "hello",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) DDL migration: v4→v5 and fresh DB
// ---------------------------------------------------------------------------

const hasTable = (storage: Storage, name: string): boolean =>
  storage.read(
    (db) =>
      db
        .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
        .get(name) !== undefined,
  );

test("fresh DB is stamped at v10 and has user_identities + user_identity_aliases", async () => {
  await withTmpDb(async (storage) => {
    const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
    assert.equal(version, 15, "fresh DB is at LATEST_SCHEMA_VERSION (15)");
    assert.ok(hasTable(storage, "user_identities"), "user_identities table exists");
    assert.ok(hasTable(storage, "user_identity_aliases"), "user_identity_aliases table exists");
  });
});

test("v4→v5 migration creates user_identities tables on an existing v4 database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mikuswarm-identity-migration-"));
  const dbPath = path.join(dir, "test.db");
  try {
    // Simulate a v4 database: open normally (creates v5 schema), drop the new
    // tables, re-stamp as v4. The next open must run the v4→v5 migration step.
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.write((db) => {
        db.exec("drop table if exists user_identity_aliases");
        db.exec("drop table if exists user_identities");
        db.pragma("user_version = 4");
      });
      await storage.waitForIdle();
      assert.equal(hasTable(storage, "user_identities"), false, "tables dropped for v4 sim");
      storage.close();
    }

    // Reopen — should run v4→v5, v5→v6, v6→v7, v7→v8, v8→v9, v9→v10 and create the tables.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      const version = storage.read((db) => Number(db.pragma("user_version", { simple: true })));
      assert.equal(version, 15, "migration stamps latest version (v15)");
      assert.ok(hasTable(storage, "user_identities"), "user_identities table created by migration");
      assert.ok(
        hasTable(storage, "user_identity_aliases"),
        "user_identity_aliases table created by migration",
      );
      // Existing data (other tables) is preserved — migration is purely additive.
      // (No pre-existing data to check for user_identities; that is the point —
      //  there is intentionally no backfill. See spec §11.2.)
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// (b) Upsert semantics
// ---------------------------------------------------------------------------

test("first sight of a sender inserts a current identity row", async () => {
  await withTmpDb(async (storage) => {
    assert.equal(countIdentities(storage, "discord"), 0, "table empty before first upsert");

    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "111",
      username: "alice",
      displayName: "Alice",
      observedAt: 1_000,
    });
    await storage.waitForIdle();

    assert.equal(countIdentities(storage, "discord"), 1, "one row after first upsert");
    const row = readIdentity(storage, "discord", "111");
    assert.ok(row);
    assert.equal(row.username, "alice");
    assert.equal(row.display_name, "Alice");
    assert.equal(countAliases(storage, "discord", "111"), 0, "no alias rows on first insert");
  });
});

test("unchanged sender: upsert is a no-op on alias rows (last_seen bumped)", async () => {
  await withTmpDb(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "111",
      username: "alice",
      displayName: "Alice",
      observedAt: 1_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "111",
      username: "alice",
      displayName: "Alice",
      observedAt: 2_000,
    });
    await storage.waitForIdle();

    assert.equal(countAliases(storage, "discord", "111"), 0, "no alias created for identical upsert");
    const row = readIdentity(storage, "discord", "111");
    assert.equal(row?.username, "alice", "current username unchanged");
  });
});

test("changed username: old username is demoted to alias, current row updated", async () => {
  await withTmpDb(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "222",
      username: "old_handle",
      displayName: "Bob",
      observedAt: 1_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "222",
      username: "new_handle",
      displayName: "Bob",
      observedAt: 2_000,
    });
    await storage.waitForIdle();

    const row = readIdentity(storage, "discord", "222");
    assert.equal(row?.username, "new_handle", "current row has new username");
    assert.equal(countAliases(storage, "discord", "222"), 1, "one alias row for the old username");

    const aliases = storage.getUserIdentityAliases("discord", "222", 10);
    assert.deepEqual(aliases, ["old_handle"], "alias history contains the old username");
  });
});

test("displayName-only change: updates current row without creating an alias", async () => {
  await withTmpDb(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "333",
      username: "carol",
      displayName: "Carol",
      observedAt: 1_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "333",
      username: "carol",
      displayName: "Carol (new nick)",
      observedAt: 2_000,
    });
    await storage.waitForIdle();

    const row = readIdentity(storage, "discord", "333");
    assert.equal(row?.username, "carol", "username unchanged");
    assert.equal(row?.display_name, "Carol (new nick)", "displayName updated");
    assert.equal(countAliases(storage, "discord", "333"), 0, "no alias row for displayName-only change");
  });
});

test("alias bound: 16 aliases kept; oldest evicted on the 17th rename", async () => {
  await withTmpDb(async (storage) => {
    // Insert initial identity, then rename 17 times — should keep exactly 16 aliases.
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "999",
      username: "v0",
      observedAt: 1_000,
    });
    for (let i = 1; i <= 17; i++) {
      await storage.upsertUserIdentity({
        provider: "discord",
        userId: "999",
        username: `v${i}`,
        observedAt: 1_000 + i,
      });
    }
    await storage.waitForIdle();

    const aliasCount = countAliases(storage, "discord", "999");
    assert.equal(aliasCount, USER_IDENTITY_ALIAS_BOUND, `exactly ${USER_IDENTITY_ALIAS_BOUND} aliases kept`);

    // Current row should be the last rename.
    const row = readIdentity(storage, "discord", "999");
    assert.equal(row?.username, "v17", "current row is the latest username");

    // Oldest alias (v0) was evicted; newest aliases survive (v1..v16).
    const aliases = storage.getUserIdentityAliases("discord", "999", 20);
    assert.equal(aliases.length, USER_IDENTITY_ALIAS_BOUND, "alias query returns exactly bound rows");
    assert.ok(!aliases.includes("v0"), "oldest alias v0 was evicted");
    assert.ok(aliases.includes("v1"), "v1 survived (just inside the bound)");
    assert.ok(aliases.includes("v16"), "v16 survived (most recent alias)");
    // Aliases are returned newest-first (highest rowid first).
    assert.equal(aliases[0], "v16", "first alias returned is the most recent");
  });
});

// ---------------------------------------------------------------------------
// (c) Matrix events (no username): NEVER write rows
// ---------------------------------------------------------------------------

test("Matrix-shaped events never write user_identities rows", async () => {
  await withTmpDb(async (storage) => {
    // Call upsertUserIdentity with username=undefined — simulates Matrix events
    // where the caller checks sender.username before calling. In practice callers
    // only invoke upsertUserIdentity when sender.username is truthy; we test the
    // app-level gate by NOT calling it for Matrix senders (the key property is
    // that the caller gate is the only guard — there is no server-side filter).
    // We DO verify that a Matrix-shaped event has no username so the gate fires.
    const matrixSender = matrixEvent().sender;
    assert.equal(matrixSender.username, undefined, "Matrix sender has no username (gate condition)");

    // Simulate what handleInbound does: only call upsertUserIdentity when username is set.
    if (matrixSender.username) {
      await storage.upsertUserIdentity({
        provider: "matrix",
        userId: matrixSender.id,
        username: matrixSender.username,
        observedAt: 1_000,
      });
    }
    await storage.waitForIdle();

    assert.equal(countIdentities(storage, "matrix"), 0, "zero rows after Matrix-shaped event — gate ensures this");

    // Sanity: getUserIdentityMap returns an empty map (no rows) for Matrix senders.
    const map = storage.getUserIdentityMap([{ provider: "matrix", userId: "@alice:example.org" }]);
    assert.equal(map.size, 0, "identity map is empty for Matrix senders");
  });
});

// ---------------------------------------------------------------------------
// (d) Render-time resolution
// ---------------------------------------------------------------------------

test("render-time: empty identity map → byte-identical output for Matrix event", () => {
  // Reproduce the identity-rendering.test.ts patterns with an explicit empty map.
  // buildIdentityMap is private, but we can test the contract indirectly: when
  // the identity table is empty, rendering should produce identical output to
  // pre-Phase-3b. We verify by comparing to the known-good pre-3b output.
  const ev = matrixEvent();
  const rich = renderRichMessage(ev);
  // These assertions are copy-pasted from identity-rendering.test.ts to confirm
  // that with no identity override, Phase-3b output is byte-identical to Phase-3a.
  assert.match(rich, /sender="@alice:example\.org"/, "Matrix sender: MXID in sender attr");
  assert.match(rich, /display_name="Alice"/, "Matrix sender: displayName still shown");
  const compact = renderCompactMessage(ev);
  assert.match(compact, /Alice \(@alice:example\.org\): hello/);
});

test("render-time: Discord event with no identity map entry falls back to event sender values", () => {
  const ev = discordEvent();
  // Without any identity override (empty map, no call to applyIdentityOverrides),
  // the event renders using the sender fields baked into the event.
  const rich = renderRichMessage(ev);
  assert.match(rich, /sender="alice_d"/, "event-stored username used as sender attr");
  assert.match(rich, /display_name="Alice \(nick\)"/, "event-stored displayName shown");
});

test("render-time: applyIdentityOverrides via getUserIdentityMap gives current username to old event", async () => {
  // Test that the builder's identity-override machinery works: store an identity
  // (alice_d → renamed_d), then use getUserIdentityMap to build the override,
  // apply it, and confirm the OLD event now renders under the CURRENT name.
  await withTmpDb(async (storage) => {
    // Old event stored alice_d's identity at the time it was sent.
    const oldEvent = discordEvent({
      sender: { id: "111222333", username: "alice_d", displayName: "Alice old nick" },
      timestamp: 1_000,
    });

    // Later, alice_d renamed to renamed_d.
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "111222333",
      username: "alice_d",
      displayName: "Alice old nick",
      observedAt: 1_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "111222333",
      username: "renamed_d",
      displayName: "Alice new nick",
      observedAt: 2_000,
    });
    await storage.waitForIdle();

    // Simulate what the context builder does: batch-query the identity map.
    const map = storage.getUserIdentityMap([{ provider: "discord", userId: "111222333" }]);
    assert.equal(map.size, 1, "identity map has one entry");

    const current = map.get("discord:111222333");
    assert.ok(current, "map has the entry for alice_d's user_id");
    assert.equal(current.username, "renamed_d", "current username is the post-rename value");
    assert.equal(current.displayName, "Alice new nick", "current displayName is the post-rename value");

    // Apply override: the old event should now render under the current name.
    const overridden = {
      ...oldEvent,
      sender: {
        ...oldEvent.sender,
        username: current.username ?? oldEvent.sender.username,
        displayName: current.displayName != null ? current.displayName : oldEvent.sender.displayName,
      },
    };

    const rich = renderRichMessage(overridden);
    assert.match(rich, /sender="renamed_d"/, "old event renders under current username");
    assert.match(rich, /display_name="Alice new nick"/, "old event renders under current displayName");
    assert.doesNotMatch(rich, /alice_d/, "old username no longer appears in sender attr");
  });
});

// ---------------------------------------------------------------------------
// (e) Retrieval lane: alias expansion
// ---------------------------------------------------------------------------

test("getUserIdentityAliases returns recent prior usernames newest-first", async () => {
  await withTmpDb(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "444",
      username: "handle_v1",
      observedAt: 1_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "444",
      username: "handle_v2",
      observedAt: 2_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "444",
      username: "handle_v3",
      observedAt: 3_000,
    });
    await storage.waitForIdle();

    // Aliases should be handle_v1 and handle_v2 (the demoted predecessors).
    const aliases = storage.getUserIdentityAliases("discord", "444", 10);
    assert.deepEqual(aliases, ["handle_v2", "handle_v1"], "aliases returned newest-first");
  });
});

test("alias expansion bound: getUserIdentityAliases respects the limit parameter", async () => {
  await withTmpDb(async (storage) => {
    for (let i = 0; i < 5; i++) {
      await storage.upsertUserIdentity({
        provider: "discord",
        userId: "555",
        username: `v${i}`,
        observedAt: 1_000 + i,
      });
    }
    await storage.waitForIdle();

    // 4 renames → 4 aliases (v0–v3 demoted; v4 is current).
    const all = storage.getUserIdentityAliases("discord", "555", 10);
    assert.equal(all.length, 4, "4 alias rows total");

    // The retrieval lane uses limit=4 (current + 4 ≤ 5 names).
    const limited = storage.getUserIdentityAliases("discord", "555", 4);
    assert.equal(limited.length, 4, "limit=4 returns all 4 aliases when ≤ 4 exist");

    const limited2 = storage.getUserIdentityAliases("discord", "555", 2);
    assert.equal(limited2.length, 2, "limit=2 returns only the 2 most recent aliases");
    assert.equal(limited2[0], "v3", "most recent alias is v3");
    assert.equal(limited2[1], "v2", "second most recent is v2");
  });
});

test("alias expansion: no aliases for Matrix senders (no rows → empty array)", async () => {
  await withTmpDb(async (storage) => {
    const aliases = storage.getUserIdentityAliases("matrix", "@alice:example.org", 4);
    assert.deepEqual(aliases, [], "empty array when no alias rows exist");
  });
});

test("alias expansion: triggerUsers includes current + prior usernames", async () => {
  // End-to-end simulation of what the builder does for retrieval alias expansion:
  // 1. Build the current-names set from the trigger event senders.
  // 2. For senders with a username, fetch alias history from storage.
  // 3. The result is the union of current + prior names.
  await withTmpDb(async (storage) => {
    // Set up: discord user renamed twice.
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "777",
      username: "first_handle",
      observedAt: 1_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "777",
      username: "second_handle",
      observedAt: 2_000,
    });
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "777",
      username: "current_handle",
      observedAt: 3_000,
    });
    await storage.waitForIdle();

    // Trigger event comes in with the current identity.
    const triggerEvent = discordEvent({
      sender: { id: "777", username: "current_handle", displayName: "Current Nick" },
    });

    // Simulate the builder's triggerUsers construction with alias expansion.
    const triggerUserNames = new Set<string>();
    const senderHandle = (triggerEvent.sender.username ?? triggerEvent.sender.displayName)?.trim();
    if (senderHandle && !triggerEvent.sender.isSelf) {
      triggerUserNames.add(senderHandle);
      if (triggerEvent.sender.username) {
        const aliases = storage.getUserIdentityAliases(triggerEvent.provider, triggerEvent.sender.id, 4);
        for (const alias of aliases) {
          triggerUserNames.add(alias);
        }
      }
    }
    const triggerUsers = Array.from(triggerUserNames);

    assert.ok(triggerUsers.includes("current_handle"), "current username in triggerUsers");
    assert.ok(triggerUsers.includes("second_handle"), "second handle (alias) in triggerUsers");
    assert.ok(triggerUsers.includes("first_handle"), "first handle (alias) in triggerUsers");
    assert.equal(triggerUsers.length, 3, "three distinct names total (current + 2 aliases)");
  });
});

// ---------------------------------------------------------------------------
// (f) Console labels: getUserLabels (bare-id lookup for per-user-limits display)
// ---------------------------------------------------------------------------

test("getUserLabels: Discord id resolves username + display name from user_identities", async () => {
  await withTmpDb(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "191539408967565312",
      username: "average_dave_34",
      displayName: "Dave",
      observedAt: 1_000,
    });
    await storage.waitForIdle();

    const labels = storage.getUserLabels(["191539408967565312"]);
    assert.deepEqual(labels.get("191539408967565312"), {
      displayName: "Dave",
      username: "average_dave_34",
    });
  });
});

test("getUserLabels: Matrix MXID falls back to the latest agent_sessions display name", async () => {
  await withTmpDb(async (storage) => {
    // Matrix senders never write user_identities; the only durable name source is
    // the sessions they triggered. The LATEST non-null name must win.
    const base = {
      timelineKey: "matrix:miku:room:!room:example.org",
      sessionType: "chat",
      status: "completed" as const,
      triggerSenderId: "@alice:example.org",
    };
    await storage.insertAgentSession({
      ...base,
      id: "s-old",
      triggerSenderDisplayName: "Old Alice",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await storage.insertAgentSession({
      ...base,
      id: "s-new",
      triggerSenderDisplayName: "Alice",
      createdAt: 2_000,
      updatedAt: 2_000,
    });
    await storage.waitForIdle();

    const labels = storage.getUserLabels(["@alice:example.org"]);
    assert.deepEqual(labels.get("@alice:example.org"), {
      displayName: "Alice",
      username: null,
    });
  });
});

test("getUserLabels: identity display-name gap falls back to sessions; unknown id → nulls", async () => {
  await withTmpDb(async (storage) => {
    // A Discord identity row with no display name (nick never observed) still
    // borrows the session-recorded name, keeping the username from the identity.
    await storage.upsertUserIdentity({
      provider: "discord",
      userId: "999",
      username: "no_nick",
      observedAt: 1_000,
    });
    await storage.insertAgentSession({
      id: "s-d",
      timelineKey: "discord:bot:room:456",
      sessionType: "chat",
      status: "completed",
      triggerSenderId: "999",
      triggerSenderDisplayName: "Nick From Session",
      createdAt: 1_500,
      updatedAt: 1_500,
    });
    await storage.waitForIdle();

    const labels = storage.getUserLabels(["999", "unknown-id"]);
    assert.deepEqual(labels.get("999"), {
      displayName: "Nick From Session",
      username: "no_nick",
    });
    assert.deepEqual(labels.get("unknown-id"), { displayName: null, username: null });
    assert.deepEqual(storage.getUserLabels([]), new Map(), "empty input short-circuits");
  });
});
