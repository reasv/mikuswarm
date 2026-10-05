/**
 * Spec SESSION-RECORDS §5 premise: "Bot messages render agent_session_id, so
 * the [read_session_record] argument is always in sight". Besides the message
 * itself, that covers the <reply_to> quote of a bot message (the usual entry:
 * a user replies to it) and read_messages output.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { hydrateEvents } from "../src/context/hydrate.js";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";
import { createReadMessagesTool } from "../src/tools/read-messages.js";
import type { CanonicalChatEvent, ChannelClient, HistorySummary } from "../src/types.js";

const ROOM_TK = "matrix:miku:room:!r:example.org";
const ROOM_TK_B = "matrix:chen:room:!r:example.org";

function ev(overrides: Partial<CanonicalChatEvent>): CanonicalChatEvent {
  return {
    id: "matrix:miku:$x",
    externalId: "$x",
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "hi",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function withStores(run: (store: TimelineStore, storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await run(new TimelineStore(storage), storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

const BOT = { id: "@miku:example.org", displayName: "Miku", isSelf: true };

async function seedReply(store: TimelineStore, storage: Storage, quotedExternalId: string, timelineKey = ROOM_TK) {
  const account = timelineKey.split(":")[1];
  const reply = ev({ id: `matrix:${account}:$reply`, externalId: "$reply", timelineKey, body: "post the second one" });
  await store.append(reply, "skipped");
  await storage.insertReplyContext({
    event_id: reply.id,
    reply_external_id: quotedExternalId,
    sender_id: BOT.id,
    body: "Here are three links.",
    created_at: 1_700_000_001_000,
  });
  await storage.waitForIdle();
  return reply;
}

test("<reply_to> quoting a bot message carries its agent_session_id", async () => {
  await withStores(async (store, storage) => {
    await store.append(
      ev({ id: "matrix:miku:$bot", externalId: "$bot", role: "assistant", sender: BOT, agentSessionId: "s-bot1", body: "Here are three links." }),
      "skipped",
    );
    const reply = await seedReply(store, storage, "$bot");
    const [hydrated] = hydrateEvents(storage, [reply]);
    assert.equal(hydrated.replyTo?.agentSessionId, "s-bot1");
    const rich = renderRichMessage(hydrated);
    assert.match(rich, /<reply_to sender="@miku:example\.org"[^>]* external_id="\$bot" agent_session_id="s-bot1">/);
    // The compact tier stays as it was (no per-message id cost there).
    assert.doesNotMatch(renderCompactMessage(hydrated), /s-bot1/);
  });
});

test("<reply_to> quoting a human message, or another account's bot row, has no session id", async () => {
  await withStores(async (store, storage) => {
    await store.append(ev({ id: "matrix:miku:$human", externalId: "$human" }), "skipped");
    // Account B's row of the same event carries a session id; account A's quote must not borrow it.
    await store.append(
      ev({ id: "matrix:chen:$shared", externalId: "$shared", timelineKey: ROOM_TK_B, role: "assistant", sender: BOT, agentSessionId: "s-chen" }),
      "skipped",
    );
    const humanReply = await seedReply(store, storage, "$human");
    const [h] = hydrateEvents(storage, [humanReply]);
    assert.equal(h.replyTo?.agentSessionId, undefined);
    assert.doesNotMatch(renderRichMessage(h), /agent_session_id/);

    await storage.write((db) => db.prepare("delete from reply_contexts").run());
    const crossReply = await seedReply(store, storage, "$shared");
    const [c] = hydrateEvents(storage, [crossReply]);
    assert.equal(c.replyTo?.agentSessionId, undefined, "scoped to the quoting account's room");
  });
});

test("<reply_to> in a thread finds the bot message in its room", async () => {
  await withStores(async (store, storage) => {
    await store.append(
      ev({ id: "matrix:miku:$bot", externalId: "$bot", role: "assistant", sender: BOT, agentSessionId: "s-bot2" }),
      "skipped",
    );
    const reply = await seedReply(store, storage, "$bot", `${ROOM_TK}:thread:$root`);
    const [hydrated] = hydrateEvents(storage, [reply]);
    assert.equal(hydrated.replyTo?.agentSessionId, "s-bot2");
  });
});

function channelClient(messages: HistorySummary[]): ChannelClient {
  return {
    react: async () => {},
    unreact: async () => {},
    listReactions: async () => ({ reactions: [], byUser: {} }),
    editMessage: async () => {},
    deleteMessage: async () => {},
    readMessages: async () => ({ messages }),
    readMessage: async (id: string) => messages.find((m) => m.externalId === id),
    memberInfo: async () => undefined,
    members: async () => [],
    channelInfo: async () => ({ id: "!r:example.org", label: "r", provider: "matrix", kind: "room", joined: true }),
  } as ChannelClient;
}

test("read_messages shows agent_session_id beside bot messages (history and by-id)", async () => {
  await withStores(async (store, storage) => {
    await store.append(
      ev({ id: "matrix:miku:$bot", externalId: "$bot", role: "assistant", sender: BOT, agentSessionId: "s-bot3" }),
      "skipped",
    );
    await storage.waitForIdle();
    const history: HistorySummary[] = [
      { externalId: "$u", sender: { id: "@alice:example.org", displayName: "Alice" }, timestamp: 1_700_000_000_000, body: "find it" },
      { externalId: "$bot", sender: BOT, timestamp: 1_700_000_000_500, body: "found it" },
    ];
    const tool = createReadMessagesTool({ channelClient: channelClient(history), storage, currentTimelineKey: ROOM_TK });
    const res = await tool.execute("t", {});
    const text = (res.content[0] as { text: string }).text;
    assert.match(text, /Miku \[agent_session_id: s-bot3\]: found it/);
    assert.match(text, /Alice: find it/);

    const one = await tool.execute("t", { message_id: "$bot" });
    assert.match((one.content[0] as { text: string }).text, /Miku \[agent_session_id: s-bot3\]: found it/);
  });
});
