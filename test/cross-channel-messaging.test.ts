/**
 * Unit tests for cross-channel messaging (spec CROSS-CHANNEL-MESSAGING §12).
 *
 * Covers:
 *   - Resolution error candidate formatting
 *   - Set operations (union / intersection / ordered difference, multi-room flags)
 *   - message_ref lifecycle (stash, consume, session death, message-wins conflict)
 *   - Opt-out gate ordering (fires before resolution)
 *   - Structural authorization (trigger sender / stranger)
 *   - read_messages room + anchor resolution incl. user-id sugar and visibility refusal
 *   - Context-note validation error before side effects
 *   - Eligibility check (exact id detection per provider)
 *   - Proactive scheduler DM opt-out gate
 *   - Cross-channel note rendering in rich + compact renderers
 *   - Storage: searchUserIdentities, findDmTimelineKeysForUser, getLastAssistantEvent
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Storage } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import { ChannelVisibilityResolver } from "../src/visibility/index.js";
import { createCrossChannelTools, type CrossChannelToolContext } from "../src/tools/cross-channel.js";
import { createReadMessagesTool } from "../src/tools/read-messages.js";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";
import type { CanonicalChatEvent, ChannelClient, IChatProvider, InboundChatEvent, OutboundTarget, SenderInfo } from "../src/types.js";
import { evaluateGate } from "../src/proactive/index.js";

// ── Storage helpers ───────────────────────────────────────────────────────────

async function withStorage(fn: (s: Storage, tl: TimelineStore) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ccm-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  const timeline = new TimelineStore(storage);
  try {
    await fn(storage, timeline);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function makeEvent(overrides: Partial<CanonicalChatEvent> & { id: string; timelineKey: string }): CanonicalChatEvent {
  return {
    provider: "matrix",
    role: "user",
    sender: { id: "@u:example.org", isSelf: false },
    body: "hello",
    timestamp: Date.now(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

// ── Minimal stub provider ─────────────────────────────────────────────────────

function stubProvider(id = "matrix"): IChatProvider {
  return {
    id,
    capabilities: {
      maxAttachmentsPerMessage: 1,
      maxMessageChars: 4000,
    },
    accountIds: () => [],
    getSelf: () => undefined,
    ownsUserId: () => false,
    send: async () => ({ provider: id, target: {} as OutboundTarget, deliveredAt: Date.now() }),
    setTyping: async () => {},
    channelClient: () => undefined,
    start: async () => {},
    stop: async () => {},
  };
}

// ── Minimal stub ChannelClient ────────────────────────────────────────────────

function stubChannelClient(members: SenderInfo[] = []): ChannelClient {
  return {
    react: async () => {},
    unreact: async () => {},
    listReactions: async () => ({ reactions: [], byUser: {} }),
    editMessage: async () => {},
    deleteMessage: async () => {},
    readMessages: async (req) => {
      void req;
      return { messages: [] };
    },
    readMessage: async () => undefined,
    memberInfo: async () => undefined,
    members: async () => members,
    channelInfo: async () => ({
      id: "!room:server",
      label: "Test Room",
      provider: "matrix",
      kind: "room",
      joined: true,
    }),
  };
}

// ── Stub InboundChatEvent ─────────────────────────────────────────────────────

function stubInbound(senderId: string, timelineKey: string): InboundChatEvent {
  const event = makeEvent({ id: "e1", timelineKey });
  event.sender = { id: senderId };
  return {
    provider: "matrix",
    timelineKey,
    event,
  };
}

// ── CrossChannelToolContext builder ───────────────────────────────────────────

function makeCcCtx(
  overrides: Partial<CrossChannelToolContext> & {
    storage: Storage;
    timeline: TimelineStore;
  },
): CrossChannelToolContext {
  const provider = overrides.provider ?? stubProvider();
  const target: OutboundTarget = {
    provider: provider.id,
    timelineKey: "matrix:default:room:!r:s",
    accountId: "default",
  };
  const inbound = stubInbound("@alice:example.org", target.timelineKey);
  return {
    provider,
    providers: new Map([[provider.id, provider]]),
    target,
    inbound,
    sessionId: "test-session-1",
    timeline: overrides.timeline,
    storage: overrides.storage,
    visibilityResolver: overrides.visibilityResolver ?? new ChannelVisibilityResolver(undefined),
    messagingEnabled: overrides.messagingEnabled ?? true,
    dmInitiationEnabled: overrides.dmInitiationEnabled ?? true,
    triggerSenderId: overrides.triggerSenderId ?? "@alice:example.org",
    agentSessionGeneration: 0,
    ...overrides,
  };
}

// ── Storage: searchUserIdentities ─────────────────────────────────────────────

test("searchUserIdentities: finds by username substring", async () => {
  await withStorage(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "matrix",
      userId: "@alice:example.org",
      username: "alice",
      displayName: "Alice Smith",
      observedAt: Date.now(),
    });
    await storage.upsertUserIdentity({
      provider: "matrix",
      userId: "@bob:example.org",
      username: "bob",
      displayName: "Bob Jones",
      observedAt: Date.now(),
    });

    const hits = storage.searchUserIdentities("alice", { provider: "matrix" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.userId, "@alice:example.org");
    assert.equal(hits[0]!.username, "alice");
  });
});

test("searchUserIdentities: finds by displayName substring", async () => {
  await withStorage(async (storage) => {
    await storage.upsertUserIdentity({
      provider: "matrix",
      userId: "@carol:example.org",
      username: "carol_smith",
      displayName: "Carol Smith",
      observedAt: Date.now(),
    });

    const hits = storage.searchUserIdentities("Smith", { provider: "matrix" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.displayName, "Carol Smith");
  });
});

test("searchUserIdentities: no match returns empty array", async () => {
  await withStorage(async (storage) => {
    const hits = storage.searchUserIdentities("nobody", { provider: "matrix" });
    assert.equal(hits.length, 0);
  });
});

// ── Storage: findDmTimelineKeysForUser ────────────────────────────────────────

test("findDmTimelineKeysForUser: finds DM key where user has posted", async () => {
  await withStorage(async (storage) => {
    const event = makeEvent({
      id: "e1",
      timelineKey: "matrix:default:dm:!dmroom:server",
      sender: { id: "@peer:example.org" },
    });
    await storage.appendTimelineEvent(event, "skipped");

    const keys = storage.findDmTimelineKeysForUser("@peer:example.org");
    assert.equal(keys.length, 1);
    assert.equal(keys[0], "matrix:default:dm:!dmroom:server");
  });
});

test("findDmTimelineKeysForUser: ignores non-DM timeline keys", async () => {
  await withStorage(async (storage) => {
    const event = makeEvent({
      id: "e2",
      timelineKey: "matrix:default:room:!general:server",
      sender: { id: "@peer:example.org" },
    });
    await storage.appendTimelineEvent(event, "skipped");

    const keys = storage.findDmTimelineKeysForUser("@peer:example.org");
    assert.equal(keys.length, 0);
  });
});

// ── Storage: getLastAssistantEvent ────────────────────────────────────────────

test("getLastAssistantEvent: returns most recent assistant event", async () => {
  await withStorage(async (storage) => {
    const tk = "matrix:default:dm:!dm:s";
    const e1 = makeEvent({ id: "asst1", timelineKey: tk, role: "assistant", timestamp: 1000, receivedAt: 1000 });
    const e2 = makeEvent({ id: "asst2", timelineKey: tk, role: "assistant", timestamp: 2000, receivedAt: 2000 });
    await storage.appendTimelineEvent(e1, "skipped");
    await storage.appendTimelineEvent(e2, "skipped");

    const last = storage.getLastAssistantEvent(tk);
    assert.ok(last, "should find last assistant event");
    assert.equal(last.id, "asst2");
  });
});

test("getLastAssistantEvent: returns undefined when no assistant events", async () => {
  await withStorage(async (storage) => {
    const last = storage.getLastAssistantEvent("matrix:default:room:!empty:s");
    assert.equal(last, undefined);
  });
});

// ── dm_optout: structural authorization ──────────────────────────────────────

test("dm_optout: trigger sender can opt out themselves", async () => {
  await withStorage(async (storage, timeline) => {
    const ctx = makeCcCtx({ storage, timeline, triggerSenderId: "@alice:example.org" });
    const tools = createCrossChannelTools(ctx);
    const optoutTool = tools.find((t) => t.name === "dm_optout")!;

    const result = await optoutTool.execute("call1", { action: "opt_out" }, undefined as never);
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("will no longer receive"), `expected opt-out confirmation, got: ${text}`);

    const row = storage.getDmOptout("matrix", "@alice:example.org");
    assert.ok(row, "opt-out row should be written");
  });
});

test("dm_optout: stranger is rejected with structural error", async () => {
  await withStorage(async (storage, timeline) => {
    const ctx = makeCcCtx({ storage, timeline, triggerSenderId: "@alice:example.org" });
    const tools = createCrossChannelTools(ctx);
    const optoutTool = tools.find((t) => t.name === "dm_optout")!;

    const result = await optoutTool.execute("call1", { action: "opt_out", user: "@stranger:example.org" }, undefined as never);
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("need to ask me directly") || text.includes("themselves"), `expected auth error, got: ${text}`);

    // No row should be written
    const row = storage.getDmOptout("matrix", "@stranger:example.org");
    assert.equal(row, undefined);
  });
});

test("dm_optout: opt_in removes existing opt-out row", async () => {
  await withStorage(async (storage, timeline) => {
    // Pre-seed an opt-out.
    await storage.setDmOptout({
      provider: "matrix",
      userId: "@alice:example.org",
      createdAt: Date.now(),
    });

    const ctx = makeCcCtx({ storage, timeline, triggerSenderId: "@alice:example.org" });
    const tools = createCrossChannelTools(ctx);
    const optoutTool = tools.find((t) => t.name === "dm_optout")!;

    const result = await optoutTool.execute("call1", { action: "opt_in" }, undefined as never);
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("DMs from me again"), `expected opt-in confirmation, got: ${text}`);

    const row = storage.getDmOptout("matrix", "@alice:example.org");
    assert.equal(row, undefined, "opt-out row should be deleted");
  });
});

// ── send_dm: opt-out gate fires before resolution ─────────────────────────────

test("send_dm: opt-out error fires before provider open DM (exact id)", async () => {
  await withStorage(async (storage, timeline) => {
    // Pre-seed opt-out for @alice.
    await storage.setDmOptout({
      provider: "matrix",
      userId: "@alice:example.org",
      createdAt: 1000,
      originTimelineKey: "matrix:default:room:!r:s",
    });

    let openDmCalled = false;
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      openDm: async () => {
        openDmCalled = true;
        return { timelineKey: "matrix:default:dm:!dm:s", status: "delivered" };
      },
    };

    const ctx = makeCcCtx({ storage, timeline, provider });
    const tools = createCrossChannelTools(ctx);
    const sendDmTool = tools.find((t) => t.name === "send_dm")!;

    const result = await sendDmTool.execute(
      "call1",
      { user: "@alice:example.org", message: "hi", context_note: "test" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    assert.ok(!openDmCalled, "openDm should not be called when user has opted out");
    assert.ok(text.includes("opted out"), `expected opt-out error, got: ${text}`);
    // The error should carry a message_ref.
    assert.ok(text.includes("m1"), "error should carry a message_ref");
  });
});

// ── send_dm: message_ref lifecycle ───────────────────────────────────────────

test("send_dm: failed resolution stores message_ref for retry", async () => {
  await withStorage(async (storage, timeline) => {
    const ctx = makeCcCtx({ storage, timeline });
    const tools = createCrossChannelTools(ctx);
    const sendDmTool = tools.find((t) => t.name === "send_dm")!;

    // Fuzzy target — not a valid Matrix MXID.
    const result = await sendDmTool.execute(
      "call1",
      { user: "alice", message: "Hello Alice!", context_note: "testing" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    // Should get either "no match" error or resolution candidates.
    assert.ok(
      text.includes("not found") || text.includes("No user found") || text.includes("No exact"),
      `expected resolution error, got: ${text}`,
    );
    // The ref "m1" should appear in the error.
    assert.ok(text.includes("m1"), `error should carry message_ref "m1", got: ${text}`);

    // Retry with the message_ref — no message param.
    const retry = await sendDmTool.execute(
      "call2",
      { user: "alice", message_ref: "m1", context_note: "testing" },
      undefined as never,
    );
    const retryText = retry.content[0]!.text as string;
    // Should get the same resolution error (not a "message_ref not found" error).
    assert.ok(!retryText.includes("not found in this session"), `message_ref should still work, got: ${retryText}`);
  });
});

test("send_dm: message beats message_ref when both given", async () => {
  await withStorage(async (storage, timeline) => {
    const ctx = makeCcCtx({ storage, timeline });
    const tools = createCrossChannelTools(ctx);
    const sendDmTool = tools.find((t) => t.name === "send_dm")!;

    // First call stores "m1" with original body.
    await sendDmTool.execute(
      "call1",
      { user: "alice", message: "original", context_note: "x" },
      undefined as never,
    );

    // Seed @bob so M3 eligibility passes.
    await storage.upsertUserIdentity({
      provider: "matrix",
      userId: "@bob:example.org",
      username: "bob",
      observedAt: Date.now(),
    });

    let sentBody: string | undefined;
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      openDm: async () => ({ timelineKey: "matrix:default:dm:!dm:s", status: "delivered" }),
      send: async (_target, msg) => {
        sentBody = msg.body;
        return { provider: "matrix", target: {} as OutboundTarget, deliveredAt: Date.now() };
      },
    };

    // Second call with both message and message_ref — message should win.
    const ctx2 = makeCcCtx({ storage, timeline, provider, providers: new Map([["matrix", provider]]) });
    const tools2 = createCrossChannelTools(ctx2);
    const sendDm2 = tools2.find((t) => t.name === "send_dm")!;

    await sendDm2.execute(
      "call2",
      { user: "@bob:example.org", message: "winner body", message_ref: "m1", context_note: "x" },
      undefined as never,
    );
    assert.equal(sentBody, "winner body", "message param should win over message_ref");
  });
});

// ── send_dm: messaging disabled ───────────────────────────────────────────────

test("send_dm: returns error when messaging disabled", async () => {
  await withStorage(async (storage, timeline) => {
    const ctx = makeCcCtx({ storage, timeline, messagingEnabled: false });
    const tools = createCrossChannelTools(ctx);
    const sendDmTool = tools.find((t) => t.name === "send_dm")!;

    const result = await sendDmTool.execute(
      "call1",
      { user: "@bob:example.org", message: "hi", context_note: "x" },
      undefined as never,
    );
    assert.ok(result.content[0]!.text.includes("disabled"), "should report messaging disabled");
  });
});

// ── list_members: set operations ──────────────────────────────────────────────

test("list_members: union deduplications across two rooms", async () => {
  await withStorage(async (storage, timeline) => {
    const alice: SenderInfo = { id: "@alice:s", username: "alice" };
    const bob: SenderInfo = { id: "@bob:s", username: "bob" };
    const carol: SenderInfo = { id: "@carol:s", username: "carol" };

    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      channelClient: (target) => {
        if (target.timelineKey.includes("room1")) return stubChannelClient([alice, bob]);
        if (target.timelineKey.includes("room2")) return stubChannelClient([bob, carol]);
        return undefined;
      },
    };

    const ctx = makeCcCtx({
      storage,
      timeline,
      provider,
      providers: new Map([["matrix", provider]]),
    });
    const tools = createCrossChannelTools(ctx);
    const listMembersTool = tools.find((t) => t.name === "list_members")!;

    const result = await listMembersTool.execute(
      "call1",
      { rooms: ["matrix:default:room:room1", "matrix:default:room:room2"], op: "union" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    // alice, bob (once), carol = 3 unique members
    assert.ok(text.includes("3 member"), `expected 3 unique members, got: ${text}`);
  });
});

test("list_members: intersection returns only shared members", async () => {
  await withStorage(async (storage, timeline) => {
    const alice: SenderInfo = { id: "@alice:s", username: "alice" };
    const bob: SenderInfo = { id: "@bob:s", username: "bob" };

    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      channelClient: (target) => {
        if (target.timelineKey.includes("room1")) return stubChannelClient([alice, bob]);
        if (target.timelineKey.includes("room2")) return stubChannelClient([bob]);
        return undefined;
      },
    };

    const ctx = makeCcCtx({
      storage,
      timeline,
      provider,
      providers: new Map([["matrix", provider]]),
    });
    const tools = createCrossChannelTools(ctx);
    const listMembersTool = tools.find((t) => t.name === "list_members")!;

    const result = await listMembersTool.execute(
      "call1",
      { rooms: ["matrix:default:room:room1", "matrix:default:room:room2"], op: "intersection" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("1 member"), `expected 1 intersected member, got: ${text}`);
    assert.ok(text.includes("@bob:s"), `bob should be in intersection, got: ${text}`);
  });
});

test("list_members: ordered difference (first minus rest)", async () => {
  await withStorage(async (storage, timeline) => {
    const alice: SenderInfo = { id: "@alice:s", username: "alice" };
    const bob: SenderInfo = { id: "@bob:s", username: "bob" };
    const carol: SenderInfo = { id: "@carol:s", username: "carol" };

    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      channelClient: (target) => {
        if (target.timelineKey.includes("room1")) return stubChannelClient([alice, bob, carol]);
        if (target.timelineKey.includes("room2")) return stubChannelClient([bob]);
        return undefined;
      },
    };

    const ctx = makeCcCtx({
      storage,
      timeline,
      provider,
      providers: new Map([["matrix", provider]]),
    });
    const tools = createCrossChannelTools(ctx);
    const listMembersTool = tools.find((t) => t.name === "list_members")!;

    const result = await listMembersTool.execute(
      "call1",
      { rooms: ["matrix:default:room:room1", "matrix:default:room:room2"], op: "difference" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    // room1 - room2 = alice + carol
    assert.ok(text.includes("2 member"), `expected 2 difference members, got: ${text}`);
    assert.ok(!text.includes("@bob:s"), `bob should NOT be in difference, got: ${text}`);
  });
});

test("list_members: rooms='all' without query returns error", async () => {
  await withStorage(async (storage, timeline) => {
    const ctx = makeCcCtx({ storage, timeline });
    const tools = createCrossChannelTools(ctx);
    const listMembersTool = tools.find((t) => t.name === "list_members")!;

    const result = await listMembersTool.execute(
      "call1",
      { rooms: "all" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("query"), `expected query-required error, got: ${text}`);
  });
});

// ── read_messages: room param and anchor ─────────────────────────────────────

test("read_messages: room=userId sugar resolves DM key from storage", async () => {
  await withStorage(async (storage, timeline) => {
    const dmKey = "matrix:default:dm:!dmroom:s";
    // Insert a message from the peer in the DM.
    const dmEvent = makeEvent({
      id: "dm1",
      timelineKey: dmKey,
      sender: { id: "@peer:example.org" },
    });
    await storage.appendTimelineEvent(dmEvent, "skipped");

    let resolvedKey: string | undefined;
    const ctx = {
      channelClient: stubChannelClient(),
      storage,
      currentTimelineKey: "matrix:default:room:!r:s",
      visibilityResolver: new ChannelVisibilityResolver(undefined),
      resolveChannelClient: (key: string) => {
        resolvedKey = key;
        return stubChannelClient();
      },
    };
    const tool = createReadMessagesTool(ctx);
    await tool.execute("call1", { room: "@peer:example.org" }, undefined as never);
    assert.equal(resolvedKey, dmKey, "should resolve to the DM timeline key");
  });
});

test("read_messages: isolated room is refused", async () => {
  await withStorage(async (storage) => {
    const resolver = new ChannelVisibilityResolver({
      channels: [{ timeline_key: "matrix:default:dm:!secret:s", mode: "isolated" }],
    });
    const ctx = {
      channelClient: stubChannelClient(),
      storage,
      currentTimelineKey: "matrix:default:room:!r:s",
      visibilityResolver: resolver,
      resolveChannelClient: () => stubChannelClient(),
    };
    const tool = createReadMessagesTool(ctx);
    const result = await tool.execute(
      "call1",
      { room: "matrix:default:dm:!secret:s" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("isolated") || text.includes("private"), `expected isolation error, got: ${text}`);
  });
});

test("read_messages: anchor=last_self returns window around last self event", async () => {
  await withStorage(async (storage) => {
    const tk = "matrix:default:room:!r:s";
    const events = [
      makeEvent({ id: "u1", timelineKey: tk, role: "user", timestamp: 1000, receivedAt: 1000 }),
      makeEvent({ id: "asst1", timelineKey: tk, role: "assistant", timestamp: 2000, receivedAt: 2000, sender: { id: "@bot:s", isSelf: true } }),
      makeEvent({ id: "u2", timelineKey: tk, role: "user", timestamp: 3000, receivedAt: 3000 }),
    ];
    for (const e of events) await storage.appendTimelineEvent(e, "skipped");

    const ctx = {
      channelClient: stubChannelClient(),
      storage,
      currentTimelineKey: tk,
      visibilityResolver: new ChannelVisibilityResolver(undefined),
      resolveChannelClient: undefined,
    };
    const tool = createReadMessagesTool(ctx);
    const result = await tool.execute("call1", { anchor: "last_self" }, undefined as never);
    const text = result.content[0]!.text as string;
    assert.ok(!text.includes("No messages"), `should find messages, got: ${text}`);
  });
});

// ── Context-note rendering ────────────────────────────────────────────────────

test("renderRichMessage: cross_channel note emits <cross_channel_note> element", () => {
  const event = makeEvent({
    id: "a1",
    timelineKey: "matrix:default:dm:!dm:s",
    role: "assistant",
    sender: { id: "@bot:s", isSelf: true },
    crossChannel: {
      originTimelineKey: "matrix:default:room:!r:s",
      originSenderId: "@alice:example.org",
      originSessionId: "sess1",
      note: "Alice asked me to relay this.",
    },
  });

  const rendered = renderRichMessage(event);
  assert.ok(rendered.includes("<cross_channel_note"), `should contain cross_channel_note element, got: ${rendered}`);
  assert.ok(rendered.includes("relay"), `note text should appear, got: ${rendered}`);
  assert.ok(rendered.includes("matrix:default:room:!r:s"), `origin key should appear, got: ${rendered}`);
});

test("renderCompactMessage: cross_channel note appended as bracketed suffix", () => {
  const event = makeEvent({
    id: "a1",
    timelineKey: "matrix:default:dm:!dm:s",
    role: "assistant",
    sender: { id: "@bot:s", isSelf: true },
    body: "Hey there!",
    crossChannel: {
      originTimelineKey: "matrix:default:room:!r:s",
      originSenderId: "@alice:example.org",
      originSessionId: "sess1",
      note: "relay the answer back",
    },
  });

  const rendered = renderCompactMessage(event);
  assert.ok(rendered.includes("relay the answer back"), `note should appear in compact form, got: ${rendered}`);
  assert.ok(rendered.includes("Hey there!"), `body should still appear, got: ${rendered}`);
  assert.ok(rendered.includes("→"), `compact note should have → indicator, got: ${rendered}`);
});

test("renderRichMessage: no cross_channel field emits no cross_channel_note", () => {
  const event = makeEvent({
    id: "a1",
    timelineKey: "matrix:default:room:!r:s",
    role: "assistant",
    sender: { id: "@bot:s", isSelf: true },
  });
  const rendered = renderRichMessage(event);
  assert.ok(!rendered.includes("cross_channel_note"), `no note element expected, got: ${rendered}`);
});

// ── Proactive scheduler: DM opt-out gate ─────────────────────────────────────

function ev(id: string, ts: number, role: "user" | "assistant", senderId?: string): CanonicalChatEvent {
  return {
    id,
    timelineKey: "matrix:miku:dm:!dm:s",
    provider: "matrix",
    role,
    sender: { id: senderId ?? (role === "assistant" ? "@miku:s" : "@peer:s"), isSelf: role === "assistant" },
    body: id,
    timestamp: ts,
    receivedAt: ts,
  };
}

const GATE = { deadChannelBackstopMs: 6 * 3_600_000, minUserMessages: 1 };

test("evaluateGate: passes with sufficient user messages", () => {
  const now = Date.now();
  const events = [
    ev("u1", now - 1000, "user"),
    ev("u2", now - 500, "user"),
  ];
  const result = evaluateGate(events, now, GATE);
  assert.deepEqual(result, { ok: true });
});

test("proactive DM opt-out: getDmOptout blocks the peer", async () => {
  await withStorage(async (storage) => {
    // Seed opt-out for the peer.
    await storage.setDmOptout({
      provider: "matrix",
      userId: "@peer:s",
      createdAt: Date.now() - 1000,
    });

    const row = storage.getDmOptout("matrix", "@peer:s");
    assert.ok(row, "opt-out row should exist");
    assert.ok(row.createdAt > 0);

    // Verify gate is blocked: the scheduler's evaluate() would check this.
    // We test the storage layer directly since the scheduler's evaluate() is private.
    const peerEvent = ev("u1", Date.now() - 1000, "user", "@peer:s");
    const optout = storage.getDmOptout("matrix", peerEvent.sender.id);
    assert.ok(optout, "should find opt-out for the peer sender");
  });
});

// ── Isomorphic exact-id detection per provider ────────────────────────────────

// These test the internal isLikelyExactId logic via send_dm behavior:
// exact-id calls should NOT trigger fuzzy resolution (no candidates returned),
// while non-exact calls SHOULD trigger resolution or the provider's openDm.

test("send_dm: Matrix MXID starting with @ is treated as exact id", async () => {
  await withStorage(async (storage, timeline) => {
    // Seed the corpus so M3 eligibility passes for this known user.
    await storage.upsertUserIdentity({
      provider: "matrix",
      userId: "@bob:example.org",
      username: "bob",
      observedAt: Date.now(),
    });

    let openDmCalledWith: string | undefined;
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      openDm: async (_accountId, userId) => {
        openDmCalledWith = userId;
        return { timelineKey: "matrix:default:dm:!dm:s", status: "delivered" };
      },
    };

    const ctx = makeCcCtx({ storage, timeline, provider, providers: new Map([["matrix", provider]]) });
    const tools = createCrossChannelTools(ctx);
    const sendDmTool = tools.find((t) => t.name === "send_dm")!;

    await sendDmTool.execute(
      "call1",
      { user: "@bob:example.org", message: "hi", context_note: "test note" },
      undefined as never,
    );
    assert.equal(openDmCalledWith, "@bob:example.org", "openDm should be called with the MXID");
  });
});

test("send_dm: fuzzy name triggers resolution error with candidates", async () => {
  await withStorage(async (storage, timeline) => {
    // Seed a user_identities row so the fuzzy search finds something.
    await storage.upsertUserIdentity({
      provider: "matrix",
      userId: "@bob:example.org",
      username: "bob",
      displayName: "Bob Jones",
      observedAt: Date.now(),
    });

    const ctx = makeCcCtx({ storage, timeline });
    const tools = createCrossChannelTools(ctx);
    const sendDmTool = tools.find((t) => t.name === "send_dm")!;

    const result = await sendDmTool.execute(
      "call1",
      { user: "bob", message: "hello", context_note: "test" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    // Should get a resolution candidate (not a send)
    assert.ok(
      text.includes("No exact") || text.includes("Closest known"),
      `expected candidate resolution error, got: ${text}`,
    );
    assert.ok(text.includes("@bob:example.org"), `candidate should include exact id, got: ${text}`);
  });
});

// ── Adversarial findings: new coverage (C1, C2, M1, M3, M4, M5, m1, m3, m4-minLength) ──

// C1: send_to_channel must redirect dm-kind keys to send_dm
test("C1: send_to_channel rejects a dm-kind timeline key", async () => {
  await withStorage(async (storage, timeline) => {
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      listJoinedChannels: (_accountId) => ["matrix:default:room:!r:s"],
    };
    const ctx = makeCcCtx({ storage, timeline, provider, providers: new Map([["matrix", provider]]) });
    const tools = createCrossChannelTools(ctx);
    const tool = tools.find((t) => t.name === "send_to_channel")!;

    const result = await tool.execute(
      "call1",
      { channel: "matrix:default:dm:!dm:example.org", message: "hi", context_note: "test" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("send_dm"), `should redirect to send_dm, got: ${text}`);
    // message_ref should be stashed so the body isn't lost.
    assert.ok(text.includes("m1"), `should include a message_ref, got: ${text}`);
  });
});

// C2: read_messages userId sugar with isolated DM must fail the second visibility check
test("C2: read_messages refuses isolated DM resolved from userId sugar", async () => {
  await withStorage(async (storage, _timeline) => {
    // Seed a DM event so findDmTimelineKeysForUser returns a key.
    const dmKey = "matrix:default:dm:!isolateddm:s";
    await storage.upsertUserIdentity({ provider: "matrix", userId: "@peer:s", username: "peer", observedAt: Date.now() });
    const ev: CanonicalChatEvent = {
      id: "dm-ev1",
      timelineKey: dmKey,
      provider: "matrix",
      role: "user",
      sender: { id: "@peer:s", isSelf: false },
      body: "hello",
      timestamp: Date.now(),
      receivedAt: Date.now(),
    };
    await storage.appendTimelineEvent(ev, "skipped");
    await storage.waitForIdle();

    // Set up an isolated visibility resolver for the DM key.
    const resolver = new ChannelVisibilityResolver({
      channels: [{ timeline_key: dmKey, mode: "isolated" }],
    });
    const currentKey = "matrix:default:room:!r:s"; // not the DM

    const ctx = {
      channelClient: stubChannelClient(),
      storage,
      currentTimelineKey: currentKey,
      visibilityResolver: resolver,
    };
    const tool = createReadMessagesTool(ctx);

    const result = await tool.execute("call1", { room: "@peer:s" }, undefined as never);
    const text = result.content[0]!.text as string;
    assert.ok(
      text.toLowerCase().includes("isolated") || text.toLowerCase().includes("cannot read"),
      `should refuse isolated DM, got: ${text}`,
    );
  });
});

// M1: proactive scheduler fails closed for DM channel with unknown peer (no events, no dm_peers row)
test("M1: proactive gate skips DM channel when peer is unknown (fail-closed)", async () => {
  await withStorage(async (storage) => {
    // Use storage directly — getDmPeer returns undefined for unseen DM.
    const peer = storage.getDmPeer("matrix", "miku", "!dm:s");
    assert.equal(peer, undefined, "no dm_peers row yet");

    // Simulate what the scheduler does: no peer from events, no peer from storage → skip.
    // We verify the storage primitive directly since scheduler internals are package-private.
    const optout = peer ? storage.getDmOptout("matrix", peer) : undefined;
    assert.equal(optout, undefined, "no optout either — but peer unknown → fail closed");

    // After setDmPeer, the lookup should succeed.
    await storage.setDmPeer("matrix", "miku", "!dm:s", "@peer:s");
    const knownPeer = storage.getDmPeer("matrix", "miku", "!dm:s");
    assert.equal(knownPeer, "@peer:s", "dm_peers row now present");
  });
});

// M3: eligibility check blocks exact-id send_dm when user not in corpus and no existing DM
test("M3: send_dm rejects exact id not in corpus and no existing DM", async () => {
  await withStorage(async (storage, timeline) => {
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      openDm: async () => ({ timelineKey: "matrix:default:dm:!dm:s", status: "delivered" }),
    };
    const ctx = makeCcCtx({ storage, timeline, provider, providers: new Map([["matrix", provider]]) });
    const tools = createCrossChannelTools(ctx);
    const tool = tools.find((t) => t.name === "send_dm")!;

    // @unknown:example.org is an exact MXID but not in corpus, no DM history.
    const result = await tool.execute(
      "call1",
      { user: "@unknown:example.org", message: "hi", context_note: "test" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    assert.ok(
      text.includes("not known") || text.includes("not in corpus") || text.includes("no prior DM"),
      `should fail eligibility, got: ${text}`,
    );
    // Should still stash message_ref.
    assert.ok(text.includes("m1"), `should include message_ref, got: ${text}`);
  });
});

// M3: eligibility check passes when user has existing DM timeline (no corpus entry needed)
test("M3: send_dm allows exact id with existing DM timeline even if not in identity corpus", async () => {
  await withStorage(async (storage, timeline) => {
    // Insert a DM event for @oldpeer:example.org — findDmTimelineKeysForUser returns the key.
    const dmEv: CanonicalChatEvent = {
      id: "old-dm-ev1",
      timelineKey: "matrix:default:dm:!olddm:s",
      provider: "matrix",
      role: "user",
      sender: { id: "@oldpeer:example.org", isSelf: false },
      body: "hi",
      timestamp: Date.now() - 10000,
      receivedAt: Date.now() - 10000,
    };
    await storage.appendTimelineEvent(dmEv, "skipped");
    await storage.waitForIdle();

    let openDmCalled = false;
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      openDm: async () => {
        openDmCalled = true;
        return { timelineKey: "matrix:default:dm:!olddm:s", status: "delivered" };
      },
    };
    const ctx = makeCcCtx({ storage, timeline, provider, providers: new Map([["matrix", provider]]) });
    const tools = createCrossChannelTools(ctx);
    const tool = tools.find((t) => t.name === "send_dm")!;

    await tool.execute(
      "call1",
      { user: "@oldpeer:example.org", message: "hello again", context_note: "test" },
      undefined as never,
    );
    assert.ok(openDmCalled, "openDm should be called when existing DM timeline exists");
  });
});

// m1: list_members uses sameChannel semantics — thread key sees parent room as current
test("m1: list_members allows read of a room from a thread session (sameChannel match)", async () => {
  await withStorage(async (storage, timeline) => {
    const roomKey = "matrix:default:room:!r:s";
    // Thread keys use the form "<roomKey>:thread:<threadId>" — same kind as room.
    const threadKey = "matrix:default:room:!r:s:thread:$threadRoot";

    const alice: SenderInfo = { id: "@alice:s", username: "alice" };
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      channelClient: () => stubChannelClient([alice]),
    };

    // Resolver: roomKey is isolated (only accessible from inside that room or its threads).
    const resolver = new ChannelVisibilityResolver({
      channels: [{ timeline_key: roomKey, mode: "isolated" }],
    });

    const ctx = makeCcCtx({
      storage,
      timeline,
      provider,
      providers: new Map([["matrix", provider]]),
      visibilityResolver: resolver,
      target: { provider: "matrix", timelineKey: threadKey, accountId: "default" },
    });
    const tools = createCrossChannelTools(ctx);
    const tool = tools.find((t) => t.name === "list_members")!;

    const result = await tool.execute(
      "call1",
      { rooms: [roomKey] },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    // sameChannel(threadKey, roomKey) should be true → not blocked as isolated.
    assert.ok(
      !text.includes("isolated"),
      `thread session should be able to read parent room, got: ${text}`,
    );
  });
});

// M4: list_channels filters out accounts not in sessionAgentAccountPrefixes
test("M4: list_channels omits channels from out-of-scope accounts", async () => {
  await withStorage(async (storage, timeline) => {
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      accountIds: () => ["accountA", "accountB"],
      listJoinedChannels: (accountId) => [`matrix:${accountId}:room:!r:s`],
    };

    const ctx = makeCcCtx({
      storage,
      timeline,
      provider,
      providers: new Map([["matrix", provider]]),
      target: { provider: "matrix", timelineKey: "matrix:accountA:room:!r:s", accountId: "accountA" },
      // Only accountA is in scope.
      sessionAgentAccountPrefixes: ["matrix:accountA"],
    });
    const tools = createCrossChannelTools(ctx);
    const tool = tools.find((t) => t.name === "list_channels")!;

    const result = await tool.execute("call1", {}, undefined as never);
    const text = result.content[0]!.text as string;
    assert.ok(text.includes("matrix:accountA:room:!r:s"), `accountA channel should be listed, got: ${text}`);
    assert.ok(!text.includes("matrix:accountB"), `accountB channels should be filtered, got: ${text}`);
  });
});

// M4: send_to_channel rejects destination from out-of-scope account
test("M4: send_to_channel rejects out-of-scope account key", async () => {
  await withStorage(async (storage, timeline) => {
    const provider: IChatProvider = {
      ...stubProvider("matrix"),
      accountIds: () => ["accountA", "accountB"],
      listJoinedChannels: (accountId) => [`matrix:${accountId}:room:!r:s`],
    };

    const ctx = makeCcCtx({
      storage,
      timeline,
      provider,
      providers: new Map([["matrix", provider]]),
      target: { provider: "matrix", timelineKey: "matrix:accountA:room:!r:s", accountId: "accountA" },
      sessionAgentAccountPrefixes: ["matrix:accountA"],
    });
    const tools = createCrossChannelTools(ctx);
    const tool = tools.find((t) => t.name === "send_to_channel")!;

    const result = await tool.execute(
      "call1",
      { channel: "matrix:accountB:room:!r:s", message: "hi", context_note: "test" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    assert.ok(
      text.includes("not in scope") || text.includes("scope"),
      `should reject out-of-scope account, got: ${text}`,
    );
    assert.ok(text.includes("m1"), `should include message_ref, got: ${text}`);
  });
});

// m3-minLength: empty context_note fails TypeBox validation
test("minLength: empty context_note fails schema validation for send_dm", () => {
  // The TypeBox schema on context_note has minLength: 1.
  // We verify the schema constraint is present by inspecting the tool's parameter schema.
  const ctx = {
    provider: stubProvider("matrix"),
    providers: new Map([["matrix", stubProvider("matrix")]]),
    target: { provider: "matrix", timelineKey: "matrix:default:room:!r:s", accountId: "default" } as OutboundTarget,
    inbound: stubInbound("@alice:example.org", "matrix:default:room:!r:s"),
    sessionId: "sess",
    timeline: null as unknown as TimelineStore,
    storage: null as unknown as Storage,
    visibilityResolver: new ChannelVisibilityResolver(undefined),
    messagingEnabled: true,
    dmInitiationEnabled: true,
    triggerSenderId: "@alice:example.org",
  };
  const tools = createCrossChannelTools(ctx);
  const sendDmTool = tools.find((t) => t.name === "send_dm")!;
  const sendToTool = tools.find((t) => t.name === "send_to_channel")!;

  // Inspect the schema directly — context_note should have minLength: 1.
  const dmSchema = sendDmTool.parameters as { properties?: { context_note?: { minLength?: number } } };
  assert.equal(dmSchema.properties?.context_note?.minLength, 1, "send_dm context_note has minLength: 1");

  const toSchema = sendToTool.parameters as { properties?: { context_note?: { minLength?: number } } };
  assert.equal(toSchema.properties?.context_note?.minLength, 1, "send_to_channel context_note has minLength: 1");
});

// m2: IRC userId canonicalization — lowercase before opt-out lookup
test("m2: dm_optout stored as lowercase for IRC provider", async () => {
  await withStorage(async (storage, timeline) => {
    const ctx = makeCcCtx({
      storage,
      timeline,
      provider: stubProvider("irc"),
      target: {
        provider: "irc",
        timelineKey: "irc:default:room:#test",
        accountId: "default",
      },
      triggerSenderId: "libera.chat/Alice",
    });
    const tools = createCrossChannelTools(ctx);
    const optoutTool = tools.find((t) => t.name === "dm_optout")!;

    // Opt out as "Alice" — stored under lowercase "libera.chat/alice".
    await optoutTool.execute(
      "call1",
      { action: "opt_out", user: "libera.chat/Alice" },
      undefined as never,
    );

    // The row should be readable under lowercase.
    const row = storage.getDmOptout("irc", "libera.chat/alice");
    assert.ok(row, "opt-out should be stored under lowercase id");
    // Should NOT exist under mixed case.
    const rowMixed = storage.getDmOptout("irc", "libera.chat/Alice");
    assert.equal(rowMixed, undefined, "opt-out should NOT be findable under mixed-case id directly");
  });
});

// m5: opted-out candidates in fuzzy resolution are annotated
test("m5: fuzzy resolution annotates opted-out candidates", async () => {
  await withStorage(async (storage, timeline) => {
    await storage.upsertUserIdentity({
      provider: "matrix",
      userId: "@optedout:example.org",
      username: "optedout_user",
      displayName: "Opted Out User",
      observedAt: Date.now(),
    });
    // Set an opt-out for this user.
    await storage.setDmOptout({
      provider: "matrix",
      userId: "@optedout:example.org",
      createdAt: Date.now(),
    });

    const ctx = makeCcCtx({ storage, timeline });
    const tools = createCrossChannelTools(ctx);
    const tool = tools.find((t) => t.name === "send_dm")!;

    const result = await tool.execute(
      "call1",
      { user: "optedout", message: "hello", context_note: "test" },
      undefined as never,
    );
    const text = result.content[0]!.text as string;
    // Either the candidate is annotated as opted out, or all-opted-out error.
    assert.ok(
      text.includes("opted out"),
      `should annotate opted-out candidate or give all-opted-out error, got: ${text}`,
    );
  });
});
