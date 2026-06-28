import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import {
  ChatSearchIndexer,
  sanitizeFtsMatch,
  resolveRooms,
  projectChatEvent,
  resolveAbsence,
} from "../src/search/index.js";
import { createSearchMessagesTool, createUserActivityTool } from "../src/tools/index.js";
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

function toolText(res: { content: Array<{ type: string }> }): string {
  return (res.content[0] as { type: "text"; text: string }).text;
}

test("user_activity with a lone `before` keeps the lower bound open (does not invert the window) (#8)", async () => {
  // SEED timestamps are tiny epoch-ms (1_000..4_000) — far older than 30 days before
  // any real `now`. The pre-fix code injected a default `last:"30d"` for a lone `before`,
  // producing afterTs = now-30d > beforeTs, inverting the window → flat "No activity".
  await withIndexed(SEED, async (storage, indexer) => {
    const tool = createUserActivityTool({
      storage,
      indexer,
      currentTimelineKey: ROOM_A,
      now: () => 1_000_000_000_000, // far in the future relative to the seed
    });
    // Upper bound after the newest seed event, with NO last/after → open lower bound.
    const res = await tool.execute("t1", { before: "2001-09-09", rooms: "all" });
    const text = toolText(res);
    assert.doesNotMatch(text, /No activity/);
    assert.match(text, /Activity roster/);
    // All four seed events fall in the open-ended window: @alice (3) + @bob (1).
    const details = res.details as { window: { after: number | null }; senderCount: number };
    assert.equal(details.window.after, null); // lower bound is genuinely open
    assert.equal(details.senderCount, 2);
  });
});

test("user_activity roster is bounded to top-N by GLOBAL total with per-room detail (#6)", async () => {
  // @alice: 2 in room A + 1 in room B = 3 (global top). @bob: 1 in room A. @carol: 1.
  // limit:1 must return @alice (global #1) with BOTH her rooms — not a single (sender,room)
  // row — and the "(+N more)" line must report the true sender count (3).
  const events: CanonicalChatEvent[] = [
    ...SEED,
    ev({ id: "c1", senderId: "@carol", body: "hi there", timestamp: 5_000 }),
  ];
  await withIndexed(events, async (storage, indexer) => {
    const tool = createUserActivityTool({
      storage,
      indexer,
      currentTimelineKey: ROOM_A,
      now: () => 1_000_000_000_000,
    });
    const res = await tool.execute("t1", { rooms: "all", last: "100000d", limit: 1 });
    const text = toolText(res);
    const details = res.details as {
      senderCount: number;
      senders: Array<{ senderId: string; total: number; perRoom: Array<{ room: string }> }>;
    };
    // Top-1 by global total is @alice with total 3 across BOTH her rooms.
    assert.equal(details.senders.length, 1);
    assert.equal(details.senders[0].senderId, "@alice");
    assert.equal(details.senders[0].total, 3);
    assert.equal(details.senders[0].perRoom.length, 2); // room A + room B, not cut mid-sender
    // Overflow line reports the true total sender count (3), not the page size.
    assert.equal(details.senderCount, 3);
    assert.match(text, /\(\+2 more\)/);
  });
});

test("user_activity single-user path is unchanged by the roster bounding (#6)", async () => {
  await withIndexed(SEED, async (storage, indexer) => {
    const tool = createUserActivityTool({
      storage,
      indexer,
      currentTimelineKey: ROOM_A,
      now: () => 1_000_000_000_000,
    });
    const res = await tool.execute("t1", { user: "@alice", rooms: "all", last: "100000d" });
    const text = toolText(res);
    // @alice posts 3 of the 4 seed messages → 75% of total; share now shown inline.
    assert.match(text, /@alice: 3 message\(s\) \(75%\) across 2 room\(s\)/);
  });
});

// ── user_activity message-type filters (§9e) ─────────────────────────────────
const UA_NOW = 1_000_000_000_000;
const UA_DAY = 24 * 60 * 60 * 1000;

/** Seed timeline_events (FK) + chat_index rows with explicit type flags, then run the
 *  user_activity tool over them with a NON-reconciling stub indexer — a live reconcile
 *  would re-project the seeded events and reset the hand-set attachment/link/reply flags
 *  (the events have no backing media), so the stub is what keeps the fixture intact. */
async function withTypedActivity(
  rows: Array<Partial<ChatIndexUpsert> & { eventId: string; senderId: string; timestamp: number }>,
  run: (tool: ReturnType<typeof createUserActivityTool>) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ua-filter-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await seedEvents(storage, rows.map((r) => ({ id: r.eventId, room: r.timelineKey, timestamp: r.timestamp })));
    await storage.upsertChatIndexRows(rows.map(idxRow));
    const indexer = { ensureFreshForQuery: async () => {} } as unknown as ChatSearchIndexer;
    const tool = createUserActivityTool({ storage, indexer, currentTimelineKey: ROOM_A, now: () => UA_NOW });
    await run(tool);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// @img: 2 images + 1 text; @txt: 3 text; @vid: 1 video. 7 total (4 text, 3 attachments).
const TYPED: Array<Partial<ChatIndexUpsert> & { eventId: string; senderId: string; timestamp: number }> = [
  { eventId: "i1", senderId: "@img", timestamp: UA_NOW - 1 * UA_DAY, hasAttachment: 1, attachmentTypes: "image" },
  { eventId: "i2", senderId: "@img", timestamp: UA_NOW - 2 * UA_DAY, hasAttachment: 1, attachmentTypes: "image" },
  { eventId: "ix", senderId: "@img", timestamp: UA_NOW - 1 * UA_DAY, body: "look at this" },
  { eventId: "t1", senderId: "@txt", timestamp: UA_NOW - 1 * UA_DAY, body: "hello" },
  { eventId: "t2", senderId: "@txt", timestamp: UA_NOW - 2 * UA_DAY, body: "world" },
  { eventId: "t3", senderId: "@txt", timestamp: UA_NOW - 3 * UA_DAY, body: "again" },
  { eventId: "v1", senderId: "@vid", timestamp: UA_NOW - 1 * UA_DAY, hasAttachment: 1, attachmentTypes: "video" },
];

test("user_activity attachment_type:['image'] counts only image posts and labels the filter", async () => {
  await withTypedActivity(TYPED, async (tool) => {
    const res = await tool.execute("uf1", { rooms: [ROOM_A], attachment_type: ["image"] });
    const text = toolText(res);
    assert.match(text, /Activity roster — image attachments/);
    // Only @img matched; 2 of 2 image messages → 100%; @txt/@vid absent.
    assert.match(text, /@img — 2 msg\(s\) \(100%\)/);
    assert.doesNotMatch(text, /@txt/);
    assert.doesNotMatch(text, /@vid/);
    assert.match(text, /These 1 sender\(s\) account for 2 of 2 message\(s\) \(100%\)/);
    const d = res.details as { scope: { totalMessages: number }; filter: { attachmentTypes?: string[] } | null };
    assert.equal(d.scope.totalMessages, 2); // denominator is the filtered subset
    assert.deepEqual(d.filter?.attachmentTypes, ["image"]);
  });
});

test("user_activity has_attachment:false counts only text posts", async () => {
  await withTypedActivity(TYPED, async (tool) => {
    const res = await tool.execute("uf2", { rooms: [ROOM_A], has_attachment: false });
    const text = toolText(res);
    assert.match(text, /text only \(no attachment\)/);
    // 4 text messages total: @txt 3 (75%), @img 1 (25%); @vid (video only) absent.
    assert.match(text, /@txt — 3 msg\(s\) \(75%\)/);
    assert.match(text, /@img — 1 msg\(s\) \(25%\)/);
    assert.doesNotMatch(text, /@vid/);
    const d = res.details as { scope: { totalMessages: number } };
    assert.equal(d.scope.totalMessages, 4);
  });
});

test("user_activity single-user honours a type filter", async () => {
  await withTypedActivity(TYPED, async (tool) => {
    const res = await tool.execute("uf3", { user: "@img", rooms: [ROOM_A], attachment_type: ["image"] });
    assert.match(toolText(res), /@img: 2 message\(s\) \(100%\)/);
  });
});

test("coverage footnote stays a CORPUS property — a type filter doesn't false-trigger it", async () => {
  // Corpus reaches back ~29d (an old text post); images exist only in the last day. The
  // default 30d window IS covered by the corpus, so filtering to images must NOT warn even
  // though the image span is recent. (If coverage keyed off the filtered span it would.)
  const rows = [
    { eventId: "old", senderId: "@txt", timestamp: UA_NOW - 29 * UA_DAY, body: "ancient history" },
    { eventId: "img", senderId: "@img", timestamp: UA_NOW - 1 * UA_DAY, hasAttachment: 1, attachmentTypes: "image" },
  ];
  await withTypedActivity(rows, async (tool) => {
    const res = await tool.execute("uf4", { rooms: [ROOM_A], attachment_type: ["image"] });
    const text = toolText(res);
    assert.doesNotMatch(text, /⚠ Coverage/);
    assert.match(text, /@img — 1 msg\(s\)/);
  });
});

test("include_silent is declined (with a note) when a type filter is active", async () => {
  await withTypedActivity(TYPED, async (tool) => {
    const res = await tool.execute("uf5", { rooms: [ROOM_A], include_silent: true, attachment_type: ["image"] });
    assert.match(toolText(res), /never-posted members aren't listed alongside a message-type filter/);
  });
});

test("resolveAbsence is honest when the user has been away longer than the horizon (#9)", async () => {
  const NOW = 1_000_000_000_000;
  const HORIZON = 30 * 24 * 60 * 60 * 1000;
  // One message ~40 days ago (older than the 30-day horizon), none within it.
  const events: CanonicalChatEvent[] = [
    ev({ id: "old1", senderId: "@dora", body: "long ago", timestamp: NOW - 40 * 24 * 60 * 60 * 1000 }),
  ];
  await withIndexed(events, async (storage, indexer) => {
    const absent = await resolveAbsence(storage, indexer, { senderId: "@dora", now: NOW });
    assert.equal(absent.ambiguous, true);
    assert.match(absent.basis, /away longer than the 30-day window/);

    // A brand-new user with no messages at all keeps the genuine "no messages" basis.
    const fresh = await resolveAbsence(storage, indexer, { senderId: "@nobody", now: NOW });
    assert.match(fresh.basis, /no recent messages from you/);
    assert.doesNotMatch(fresh.basis, /away longer than/);
    // Sanity: the old message truly is outside the horizon.
    assert.ok(NOW - 40 * 24 * 60 * 60 * 1000 < NOW - HORIZON);
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
