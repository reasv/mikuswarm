import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
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

test("scope controls whether aux_text (captions) is searched", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-chat-scope-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
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
