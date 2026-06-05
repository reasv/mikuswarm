import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { LATEST_SCHEMA_VERSION, Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ChatSearchIndexer, sanitizeFtsMatch, resolveRooms, projectChatEvent } from "../src/search/index.js";
import { createSearchMessagesTool } from "../src/tools/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { ChatProjectionInput, ChatIndexUpsert } from "../src/storage/index.js";

const ROOM_A = "matrix:miku:room:!a";
const ROOM_B = "matrix:miku:room:!b";

function ev(o: {
  id: string;
  room?: string;
  senderId: string;
  body: string;
  timestamp: number;
  mentions?: string[];
}): CanonicalChatEvent {
  return {
    id: o.id,
    timelineKey: o.room ?? ROOM_A,
    provider: "matrix",
    role: "user",
    sender: { id: o.senderId, displayName: o.senderId, isSelf: false },
    body: o.body,
    timestamp: o.timestamp,
    receivedAt: o.timestamp,
    mentions: o.mentions ? { mentionedUserIds: o.mentions } : undefined,
  };
}

async function withIndexed(
  events: CanonicalChatEvent[],
  run: (storage: Storage, indexer: ChatSearchIndexer) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-chat-search-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const timeline = new TimelineStore(storage);
    for (const e of events) await timeline.append(e);
    const indexer = new ChatSearchIndexer({ storage });
    await indexer.reconcileAll();
    await run(storage, indexer);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const SEED: CanonicalChatEvent[] = [
  ev({ id: "a1", senderId: "@alice", body: "hello world", timestamp: 1_000 }),
  ev({ id: "a2", senderId: "@bob", body: "goodbye world", timestamp: 2_000 }),
  ev({ id: "a3", senderId: "@alice", body: "hello again everyone", timestamp: 3_000, mentions: ["@carol"] }),
  ev({ id: "b1", room: ROOM_B, senderId: "@alice", body: "hello from room b", timestamp: 4_000 }),
];

test("sanitizeFtsMatch builds column-scoped quoted terms", () => {
  assert.equal(sanitizeFtsMatch("hello world", "text"), '{body} : ("hello" "world")');
  assert.equal(sanitizeFtsMatch("conf*", "text+captions"), '{body aux_text} : ("conf"*)');
  assert.equal(sanitizeFtsMatch("   ", "text"), undefined);
  // Quotes are neutralized (no FTS injection).
  assert.equal(sanitizeFtsMatch('a"b', "text"), '{body} : ("a""b")');
});

test("resolveRooms maps current/all/explicit", () => {
  assert.deepEqual(resolveRooms("current", ROOM_A), [ROOM_A]);
  assert.deepEqual(resolveRooms(undefined, ROOM_A), [ROOM_A]);
  assert.equal(resolveRooms("all", ROOM_A), undefined);
  assert.deepEqual(resolveRooms([ROOM_A, ROOM_B], ROOM_A), [ROOM_A, ROOM_B]);
});

test("full-text body search is scoped to the current room", async () => {
  await withIndexed(SEED, async (storage) => {
    const res = storage.searchChatIndex({
      match: sanitizeFtsMatch("hello", "text"),
      timelineKeys: [ROOM_A],
      limit: 10,
      order: "newest",
    });
    assert.equal(res.total, 2);
    assert.deepEqual(
      res.hits.map((h) => h.eventId),
      ["a3", "a1"], // newest-first
    );
  });
});

test("all-rooms search spans timelines", async () => {
  await withIndexed(SEED, async (storage) => {
    const res = storage.searchChatIndex({
      match: sanitizeFtsMatch("hello", "text"),
      timelineKeys: undefined,
      limit: 10,
      order: "oldest",
    });
    assert.deepEqual(
      res.hits.map((h) => h.eventId),
      ["a1", "a3", "b1"],
    );
  });
});

test("sender and mention filters work without a text query", async () => {
  await withIndexed(SEED, async (storage) => {
    const byBob = storage.searchChatIndex({
      fromSenders: ["@bob"],
      timelineKeys: [ROOM_A],
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(byBob.hits.map((h) => h.eventId), ["a2"]);

    const mentioningCarol = storage.searchChatIndex({
      mentions: ["@carol"],
      timelineKeys: undefined,
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(mentioningCarol.hits.map((h) => h.eventId), ["a3"]);
  });
});

test("time window bounds are applied (after inclusive, before exclusive)", async () => {
  await withIndexed(SEED, async (storage) => {
    const res = storage.searchChatIndex({
      timelineKeys: [ROOM_A],
      afterTs: 2_000,
      beforeTs: 3_000,
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(res.hits.map((h) => h.eventId), ["a2"]);
  });
});

test("keyset pagination returns total and pages by cursor", async () => {
  await withIndexed(SEED, async (storage) => {
    const first = storage.searchChatIndex({
      match: sanitizeFtsMatch("hello", "text"),
      timelineKeys: [ROOM_A],
      limit: 1,
      order: "newest",
    });
    assert.equal(first.total, 2);
    assert.equal(first.hits.length, 1);
    assert.equal(first.hits[0].eventId, "a3");
    const cursor = { timestamp: first.hits[0].timestamp, rowid: first.hits[0].rowid };
    const second = storage.searchChatIndex({
      match: sanitizeFtsMatch("hello", "text"),
      timelineKeys: [ROOM_A],
      limit: 1,
      order: "newest",
      cursor,
    });
    assert.equal(second.hits[0].eventId, "a1");
  });
});

function projInput(o: Partial<ChatProjectionInput> & { eventId: string; body: string }): ChatProjectionInput {
  return {
    srcRowid: 1,
    eventId: o.eventId,
    timelineKey: o.timelineKey ?? ROOM_A,
    senderId: o.senderId ?? "@alice",
    senderDisplayName: o.senderDisplayName ?? null,
    role: o.role ?? "user",
    body: o.body,
    timestamp: o.timestamp ?? 1_000,
    updatedAt: o.updatedAt ?? 1_000,
    eventJson: o.eventJson ?? "{}",
    attachmentTypes: o.attachmentTypes ?? null,
    attachCount: o.attachCount ?? 0,
    captions: o.captions ?? null,
    linkCount: o.linkCount ?? 0,
    linkText: o.linkText ?? null,
    quotedSenderId: o.quotedSenderId ?? null,
    replyCount: o.replyCount ?? 0,
  };
}

test("projectChatEvent flattens captions/links/flags and parses mentions", () => {
  const p = projectChatEvent(
    projInput({
      eventId: "x1",
      body: "look at this",
      captions: "a golden retriever puppy",
      attachmentTypes: "image",
      attachCount: 1,
      linkText: "Example Title An example site",
      linkCount: 1,
      quotedSenderId: "@bob",
      replyCount: 1,
      eventJson: JSON.stringify({ mentions: { mentionedUserIds: ["@carol", "@carol", "@dave"] } }),
    }),
  );
  assert.equal(p.hasAttachment, 1);
  assert.equal(p.attachmentTypes, "image");
  assert.equal(p.hasLink, 1);
  assert.equal(p.isReply, 1);
  assert.equal(p.quotedSenderId, "@bob");
  assert.match(p.auxText, /golden retriever puppy/);
  assert.match(p.auxText, /Example Title/);
  assert.deepEqual(p.mentions, ["@carol", "@dave"]); // deduped + sorted
});

test("projectChatEvent content_sig changes with body but is stable across unrelated touches", () => {
  const a = projectChatEvent(projInput({ eventId: "x", body: "hello", updatedAt: 1 }));
  const b = projectChatEvent(projInput({ eventId: "x", body: "hello", updatedAt: 999 }));
  const c = projectChatEvent(projInput({ eventId: "x", body: "changed", updatedAt: 1 }));
  assert.equal(a.contentSig, b.contentSig); // updatedAt isn't part of the projection
  assert.notEqual(a.contentSig, c.contentSig);
});

function idxRow(o: Partial<ChatIndexUpsert> & { eventId: string }): ChatIndexUpsert {
  return {
    eventId: o.eventId,
    timelineKey: o.timelineKey ?? ROOM_A,
    senderId: o.senderId ?? "@alice",
    senderDisplayName: o.senderDisplayName ?? null,
    role: o.role ?? "user",
    timestamp: o.timestamp ?? 1_000,
    body: o.body ?? "",
    auxText: o.auxText ?? "",
    hasAttachment: o.hasAttachment ?? 0,
    attachmentTypes: o.attachmentTypes ?? "",
    hasLink: o.hasLink ?? 0,
    isReply: o.isReply ?? 0,
    quotedSenderId: o.quotedSenderId ?? null,
    mentions: o.mentions ?? [],
    contentSig: o.contentSig ?? `sig-${o.eventId}`,
  };
}

// Seed minimal backing timeline_events rows for the given ids so a direct
// upsertChatIndexRows (used to isolate the search SQL) satisfies the
// chat_index -> timeline_events cascade FK (review #4). Tests that go through
// `withIndexed` already create real events via timeline.append.
async function seedEvents(
  storage: Storage,
  rows: Array<{ id: string; room?: string; timestamp?: number }>,
): Promise<void> {
  await storage.readAndWrite((db) => {
    const stmt = db.prepare(
      `insert into timeline_events
         (id, timeline_key, provider, role, sender_id, body, timestamp,
          received_at, event_json, enrichment_status, created_at, updated_at)
       values (?, ?, 'matrix', 'user', '@alice', '', ?, ?, '{}', 'complete', ?, ?)`,
    );
    for (const r of rows) {
      const ts = r.timestamp ?? 1_000;
      stmt.run(r.id, r.room ?? ROOM_A, ts, ts, ts, ts);
    }
  });
}

test("scope controls whether aux_text (captions) is searched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-chat-scope-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await seedEvents(storage, [{ id: "img", timestamp: 1 }, { id: "txt", timestamp: 2 }]);
    await storage.upsertChatIndexRows([
      idxRow({ eventId: "img", body: "look", auxText: "a golden retriever", hasAttachment: 1, attachmentTypes: "image", timestamp: 1 }),
      idxRow({ eventId: "txt", body: "retriever in text", timestamp: 2 }),
    ]);
    const textOnly = storage.searchChatIndex({
      match: sanitizeFtsMatch("retriever", "text"),
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(textOnly.hits.map((h) => h.eventId), ["txt"]);

    const withCaptions = storage.searchChatIndex({
      match: sanitizeFtsMatch("retriever", "all"),
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(withCaptions.hits.map((h) => h.eventId).sort(), ["img", "txt"]);

    const images = storage.searchChatIndex({
      attachmentTypes: ["image"],
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(images.hits.map((h) => h.eventId), ["img"]);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("format:compact returns the full message body + id reference; snippet truncates", async () => {
  const longTail = "y".repeat(300);
  const body = `alpha needle ${longTail}`;
  const seed = [ev({ id: "long1", senderId: "@alice", body, timestamp: 5_000 })];
  await withIndexed(seed, async (storage, indexer) => {
    const tool = createSearchMessagesTool({ storage, indexer, currentTimelineKey: ROOM_A });

    const compact = await tool.execute("t1", { query: "needle", format: "compact" });
    const compactText = (compact.content[0] as { type: "text"; text: string }).text;
    assert.ok(compactText.includes(longTail), "compact includes the full body");
    assert.match(compactText, /↳ id: long1/);

    const snippet = await tool.execute("t2", { query: "needle", format: "snippet" });
    const snippetText = (snippet.content[0] as { type: "text"; text: string }).text;
    assert.ok(snippetText.includes("needle"));
    assert.ok(!snippetText.includes(longTail), "snippet truncates the long tail");
    assert.match(snippetText, /↳ id: long1/);
  });
});

test("a corrupt event_json degrades that hit to a snippet without aborting the render (#5)", async () => {
  // Two matches; make getTimelineEventById throw for one row, mirroring an unguarded
  // JSON.parse failure on a corrupt event_json (the generated `is_undecryptable`
  // column means a literally-malformed row can't be written here, so we inject the
  // throw at the accessor — the exact failure the tool-level guard must absorb). The
  // render must still complete: the good hit renders in full and the corrupt one
  // falls back to its snippet line.
  const seed = [
    ev({ id: "good1", senderId: "@alice", body: "needle in the good one", timestamp: 6_000 }),
    ev({ id: "bad1", senderId: "@bob", body: "needle in the corrupt one", timestamp: 7_000 }),
  ];
  await withIndexed(seed, async (storage, indexer) => {
    const realGet = storage.getTimelineEventById.bind(storage);
    storage.getTimelineEventById = (id: string) => {
      if (id === "bad1") throw new SyntaxError("Unexpected token in JSON (corrupt event_json)");
      return realGet(id);
    };
    const tool = createSearchMessagesTool({ storage, indexer, currentTimelineKey: ROOM_A });

    // Must not throw even though one of the two hits has corrupt event_json.
    const res = await tool.execute("t1", { query: "needle", format: "rich", order: "oldest" });
    const text = (res.content[0] as { type: "text"; text: string }).text;

    // Good hit rendered as the full rich envelope; corrupt hit degraded to a snippet
    // line (the `[time] sender: …` form), and both ids are still referenced.
    assert.match(text, /<message[^>]*sender="@alice"/);
    assert.match(text, /↳ id: good1/);
    assert.match(text, /↳ id: bad1/);
    assert.match(text, /@bob: .*needle/); // snippet fallback for the corrupt row
    assert.equal((res.details as { total: number }).total, 2);
  });
});

test("rich aggregate output cap degrades overflow hits to snippets with a note (#3)", async () => {
  // Many large bodies in rich mode would otherwise blow the context window. The
  // aggregate cap must stop emitting full envelopes partway and surface a note.
  const big = "z".repeat(20_000); // ~20k chars each; ~RICH_AGGREGATE_MAX/20k ≈ 10 fit
  const seed = Array.from({ length: 40 }, (_, i) =>
    ev({ id: `r${i}`, senderId: "@alice", body: `needle ${i} ${big}`, timestamp: 1_000 + i }),
  );
  await withIndexed(seed, async (storage, indexer) => {
    const tool = createSearchMessagesTool({ storage, indexer, currentTimelineKey: ROOM_A });
    const res = await tool.execute("t1", { query: "needle", format: "rich", limit: 40, order: "oldest" });
    const text = (res.content[0] as { type: "text"; text: string }).text;
    const details = res.details as { aggregateTruncated: boolean };

    assert.equal(details.aggregateTruncated, true);
    assert.match(text, /Output cap reached/);
    // At least one full <message> envelope was emitted, but not all 40 (some degraded
    // to snippet lines), so total output stays well under 40 * 20k.
    assert.ok(text.includes("<message"), "at least one full envelope rendered");
    assert.ok(text.length < 40 * 20_000, "aggregate output is bounded");
    // All 40 are still accounted for as hits.
    assert.equal((res.details as { returned: number }).returned, 40);
  });
});

test("rich per-message body is capped (#3)", async () => {
  const huge = "q".repeat(20_000);
  const seed = [ev({ id: "huge1", senderId: "@alice", body: `needle ${huge}`, timestamp: 5_000 })];
  await withIndexed(seed, async (storage, indexer) => {
    const tool = createSearchMessagesTool({ storage, indexer, currentTimelineKey: ROOM_A });
    const res = await tool.execute("t1", { query: "needle", format: "rich" });
    const text = (res.content[0] as { type: "text"; text: string }).text;
    // The 20k-char body is truncated to the 6000-char cap (+ envelope), so the full
    // 20k run never appears verbatim.
    assert.ok(!text.includes(huge), "rich body is truncated to the cap, not emitted verbatim");
    assert.match(text, /needle/);
    assert.match(text, /\.\.\./); // truncation ellipsis present
  });
});

test("trailer reports scanned as in-scope corpus, not filtered coverage (#10)", async () => {
  // SEED has 3 events in ROOM_A. A filtered query (sender @bob) matches 1, but the
  // trailer's scanned count is the room corpus size, labelled as such so it can't be
  // misread as "events examined under your filters".
  await withIndexed(SEED, async (storage, indexer) => {
    const tool = createSearchMessagesTool({ storage, indexer, currentTimelineKey: ROOM_A });
    const res = await tool.execute("t1", { from: ["@bob"], format: "snippet" });
    const text = (res.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /3 indexed events in scope/);
    assert.match(text, /1 match\(es\)/);
    assert.equal((res.details as { scanned: number }).scanned, 3);
  });
});

test("aggregateChatActivity counts per sender and room", async () => {
  await withIndexed(SEED, async (storage) => {
    const rows = storage.aggregateChatActivity({});
    const alice = rows.filter((r) => r.senderId === "@alice");
    const total = alice.reduce((n, r) => n + r.count, 0);
    assert.equal(total, 3); // a1, a3 (room A) + b1 (room B)
    const roomA = alice.find((r) => r.timelineKey === ROOM_A);
    assert.equal(roomA?.count, 2);
    const scoped = storage.aggregateChatActivity({ senderId: "@bob" });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].count, 1);
  });
});

test("re-indexing an edited body is reflected and the old term no longer matches", async () => {
  await withIndexed(SEED, async (storage, indexer) => {
    const timeline = new TimelineStore(storage);
    await timeline.enrich("a1", (event) => ({ ...event, body: "salutations world" }));
    await indexer.enqueueReconcileEvent("a1");
    // give the FIFO tail a tick to drain
    await new Promise((r) => setTimeout(r, 10));

    const stale = storage.searchChatIndex({
      match: sanitizeFtsMatch("hello", "text"),
      timelineKeys: [ROOM_A],
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(stale.hits.map((h) => h.eventId), ["a3"]); // a1 no longer matches "hello"

    const fresh = storage.searchChatIndex({
      match: sanitizeFtsMatch("salutations", "text"),
      timelineKeys: [ROOM_A],
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(fresh.hits.map((h) => h.eventId), ["a1"]);
  });
});

// --- Review #4: deleted/pruned events must not keep surfacing in search ---

test("deleting a timeline_events row cascades to chat_index, chat_index_fts and chat_mentions", async () => {
  await withIndexed(SEED, async (storage) => {
    // a3 carries a @carol mention, so it exercises the chat_mentions path too.
    // Sanity: it is indexed and matchable before the delete.
    const before = storage.searchChatIndex({
      match: sanitizeFtsMatch("everyone", "text"),
      timelineKeys: [ROOM_A],
      limit: 10,
      order: "newest",
    });
    assert.deepEqual(before.hits.map((h) => h.eventId), ["a3"]);

    // Delete the source event directly (mirrors pruneInactiveTimelineEvents /
    // deleteUndecryptedEvent, neither of which touches chat_index explicitly).
    await storage.readAndWrite((db) => {
      db.prepare(`delete from timeline_events where id = ?`).run("a3");
    });

    storage.read((db) => {
      // chat_index row gone via the cascade FK.
      const idx = db
        .prepare(`select count(*) as n from chat_index where event_id = ?`)
        .get("a3") as { n: number };
      assert.equal(idx.n, 0, "chat_index row removed by cascade");

      // chat_mentions row gone via the chat_index_ad AFTER DELETE trigger.
      const men = db
        .prepare(`select count(*) as n from chat_mentions where event_id = ?`)
        .get("a3") as { n: number };
      assert.equal(men.n, 0, "chat_mentions removed by the ad trigger");
    });

    // FTS entry gone: the term is no longer matchable.
    const after = storage.searchChatIndex({
      match: sanitizeFtsMatch("everyone", "text"),
      timelineKeys: [ROOM_A],
      limit: 10,
      order: "newest",
    });
    assert.equal(after.hits.length, 0, "FTS entry removed by the ad trigger");
  });
});

test("a freshly-opened DB has the chat_index -> timeline_events cascade FK active", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-chat-search-fk-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    const fk = storage.read(
      (db) =>
        db.pragma(`foreign_key_list(chat_index)`) as Array<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>,
    );
    const ref = fk.find((f) => f.table === "timeline_events");
    assert.ok(ref, "chat_index declares an FK to timeline_events");
    assert.equal(ref.from, "event_id");
    assert.equal(ref.to, "id");
    assert.equal(ref.on_delete.toUpperCase(), "CASCADE");
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// The v12 chat-search DDL as it shipped — `chat_index.event_id` has NO cascade FK.
// Used to build a legacy fixture so the v12 -> v13 migration can be exercised on a
// real old database.
const V12_TIMELINE_EVENTS = `
create table timeline_events (
  id text primary key,
  external_id text,
  timeline_key text not null,
  provider text not null,
  role text not null check(role in ('user', 'assistant')),
  sender_id text not null,
  sender_display_name text,
  body text not null,
  timestamp integer not null,
  received_at integer not null,
  agent_session_id text,
  event_json text not null,
  enrichment_status text not null default 'pending',
  enrichment_retries integer not null default 0,
  last_edit_timestamp integer,
  redecrypt_attempts integer not null default 0,
  trigger_group_id text,
  created_at integer not null,
  updated_at integer not null,
  is_undecryptable integer generated always as
    (case when json_extract(event_json, '$.undecryptable') is not null then 1 else 0 end) virtual
);
`;

const V12_CHAT_SEARCH = `
create table chat_index (
  rowid               integer primary key autoincrement,
  event_id            text not null unique,
  timeline_key        text not null,
  sender_id           text not null,
  sender_display_name text,
  role                text not null,
  timestamp           integer not null,
  body                text not null default '',
  aux_text            text not null default '',
  has_attachment      integer not null default 0,
  attachment_types    text not null default '',
  has_link            integer not null default 0,
  is_reply            integer not null default 0,
  quoted_sender_id    text,
  content_sig         text not null,
  indexed_at          integer not null
);
create index idx_chat_index_room_time on chat_index(timeline_key, timestamp);
create index idx_chat_index_sender_time on chat_index(sender_id, timestamp);
create index idx_chat_index_quoted on chat_index(quoted_sender_id, timestamp)
  where quoted_sender_id is not null;
create table chat_mentions (
  event_id text not null,
  user_id  text not null,
  primary key (event_id, user_id)
);
create index idx_chat_mentions_user on chat_mentions(user_id);
create virtual table chat_index_fts using fts5(
  body, aux_text, content='chat_index', content_rowid='rowid'
);
create trigger chat_index_ai after insert on chat_index begin
  insert into chat_index_fts(rowid, body, aux_text) values (new.rowid, new.body, new.aux_text);
end;
create trigger chat_index_ad after delete on chat_index begin
  insert into chat_index_fts(chat_index_fts, rowid, body, aux_text)
    values ('delete', old.rowid, old.body, old.aux_text);
  delete from chat_mentions where event_id = old.event_id;
end;
create trigger chat_index_au after update on chat_index
  when new.body is not old.body or new.aux_text is not old.aux_text
begin
  insert into chat_index_fts(chat_index_fts, rowid, body, aux_text)
    values ('delete', old.rowid, old.body, old.aux_text);
  insert into chat_index_fts(rowid, body, aux_text) values (new.rowid, new.body, new.aux_text);
end;
`;

test("v12 -> v13 migration adds the cascade FK, preserves rows, and keeps FTS consistent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-chat-search-v13-"));
  const dbPath = path.join(dir, "legacy.db");
  try {
    // Build a v12 fixture: a timeline_events row + its (FK-less) chat_index row +
    // a matching FTS entry + a mention. Plus a deliberately ORPHANED chat_index
    // row (its timeline_events was "pruned" while the FK was absent) to prove the
    // migration purges orphans rather than aborting on the deferred FK check.
    const legacy = new Database(dbPath);
    legacy.exec(V12_TIMELINE_EVENTS);
    legacy.exec(V12_CHAT_SEARCH);
    const now = Date.now();
    legacy
      .prepare(
        `insert into timeline_events
           (id, timeline_key, provider, role, sender_id, body, timestamp,
            received_at, event_json, enrichment_status, created_at, updated_at)
         values
           ('keep', ?, 'matrix', 'user', '@alice', 'durable haystack token',
            ?, ?, '{}', 'complete', ?, ?)`,
      )
      .run(ROOM_A, now, now, now, now);
    legacy
      .prepare(
        `insert into chat_index
           (event_id, timeline_key, sender_id, role, timestamp, body, content_sig, indexed_at)
         values ('keep', ?, '@alice', 'user', ?, 'durable haystack token', 'sig-keep', ?)`,
      )
      .run(ROOM_A, now, now);
    legacy
      .prepare(`insert into chat_mentions (event_id, user_id) values ('keep', '@carol')`)
      .run();
    // Orphan: chat_index row with no backing timeline_events row.
    legacy
      .prepare(
        `insert into chat_index
           (event_id, timeline_key, sender_id, role, timestamp, body, content_sig, indexed_at)
         values ('orphan', ?, '@bob', 'user', ?, 'orphan token', 'sig-orphan', ?)`,
      )
      .run(ROOM_A, now, now);
    // Keep the external-content FTS in sync with what we just inserted.
    legacy.exec(`insert into chat_index_fts(chat_index_fts) values ('rebuild');`);
    legacy.pragma("user_version = 12");

    // Sanity: the v12 chat_index has NO FK yet.
    const fkBefore = legacy.pragma(`foreign_key_list(chat_index)`) as Array<unknown>;
    assert.equal(fkBefore.length, 0, "fixture must start without the FK");
    legacy.close();

    // Open through Storage: runs the v12 -> v13 step.
    const storage = await Storage.open({ databasePath: dbPath });
    try {
      assert.equal(
        storage.read((db) => db.pragma("user_version", { simple: true }) as number),
        LATEST_SCHEMA_VERSION,
      );

      storage.read((db) => {
        // FK is now present and CASCADE.
        const fk = db.pragma(`foreign_key_list(chat_index)`) as Array<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>;
        const ref = fk.find((f) => f.table === "timeline_events");
        assert.ok(ref, "FK to timeline_events added by the migration");
        assert.equal(ref.from, "event_id");
        assert.equal(ref.to, "id");
        assert.equal(ref.on_delete.toUpperCase(), "CASCADE");

        // The valid row survived (with its rowid/mention); the orphan was purged.
        const keep = db
          .prepare(`select count(*) as n from chat_index where event_id = 'keep'`)
          .get() as { n: number };
        assert.equal(keep.n, 1, "valid chat_index row preserved");
        const men = db
          .prepare(`select count(*) as n from chat_mentions where event_id = 'keep'`)
          .get() as { n: number };
        assert.equal(men.n, 1, "mention preserved");
        const orphan = db
          .prepare(`select count(*) as n from chat_index where event_id = 'orphan'`)
          .get() as { n: number };
        assert.equal(orphan.n, 0, "orphaned chat_index row purged by the migration");

        // foreign_keys enforcement itself was restored to ON after the rebuild.
        assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
      });

      // FTS stays consistent post-rebuild: the preserved row is matchable, the
      // orphan's tokens are gone.
      const found = storage.searchChatIndex({
        match: sanitizeFtsMatch("haystack", "text"),
        timelineKeys: [ROOM_A],
        limit: 10,
        order: "newest",
      });
      assert.deepEqual(found.hits.map((h) => h.eventId), ["keep"]);
      const gone = storage.searchChatIndex({
        match: sanitizeFtsMatch("orphan", "text"),
        timelineKeys: [ROOM_A],
        limit: 10,
        order: "newest",
      });
      assert.equal(gone.hits.length, 0, "purged orphan no longer in FTS");

      // And the new FK actually cascades on a subsequent delete.
      await storage.readAndWrite((db) => {
        db.prepare(`delete from timeline_events where id = 'keep'`).run();
      });
      const afterDelete = storage.read(
        (db) =>
          (db.prepare(`select count(*) as n from chat_index where event_id = 'keep'`).get() as {
            n: number;
          }).n,
      );
      assert.equal(afterDelete, 0, "cascade removes the migrated row on delete");
    } finally {
      storage.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
