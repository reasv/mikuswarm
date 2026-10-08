/**
 * Discord deletions and the trigger hold (ARCHITECTURE.md §6 "Message edits",
 * §6c "Deletes", "Trigger hold"): the hold emits every message at once,
 * untriggered (stored as it arrives), and delivers the trigger once at its end,
 * grouping the sender's held messages, one hold per timeline and sender (the
 * Matrix provider's semantics). A deleted held message leaves the held group;
 * the first remaining part becomes the root; a hold left empty starts nothing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DiscordProvider, type DiscordProviderCallbacks } from "../src/discord/index.js";
import { Storage } from "../src/storage/index.js";
import { TimelineRouter, TimelineStore } from "../src/timeline/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { InboundChatEvent } from "../src/types.js";

const CHANNEL = "200000000000000001";

function makeDiscordConfig(overrides: Partial<NonNullable<AppConfig["discord"]>> = {}): NonNullable<AppConfig["discord"]> {
  return {
    enabled: true,
    accounts: {
      main: { token: "MOCK_TOKEN", dm_enabled: true, member_intent: false, guilds: undefined, application_id: undefined },
    },
    ...overrides,
  };
}

function makeRuntime(): unknown {
  return {
    accountId: "main",
    self: { id: "999000000000000001", username: "bot", displayName: "Bot" },
    // The DM channel is cached, so the delete resolves the same timeline key as the create.
    client: { channels: { cache: new Map([[CHANNEL, { type: 1 }]]), fetch: async () => null } },
    allowedGuilds: undefined,
    dmEnabled: true,
    memberIntentEnabled: false,
    emojiCatalog: { observeEmoji() {} },
  };
}

/** A DM (auto-triggers, so it takes the trigger hold). */
function makeDm(id: string, content = "please answer this", authorId = "400000000000000001"): unknown {
  return {
    id,
    content,
    channelId: CHANNEL,
    guildId: null,
    guild: null,
    channel: { type: 1, messages: { cache: { get: () => undefined } } },
    reference: null,
    author: { id: authorId, username: "alice", displayName: "Alice", bot: false },
    mentions: {
      users: { map: () => [] },
      roles: { map: () => [] },
      channels: { map: () => [] },
      everyone: false,
      repliedUser: null,
    },
    attachments: { values: () => [].values() },
    stickers: { values: () => [].values() },
    embeds: [],
    createdTimestamp: 1_700_000_000_000,
    editedTimestamp: null,
  };
}

const callbacks: DiscordProviderCallbacks = {
  async mergeLateEmbeds() {},
  async upsertUserIdentity() {},
  async setChannelMetadata() {},
};

type Handlers = Record<string, (...args: unknown[]) => Promise<void>>;

describe("Discord trigger hold", () => {
  const holdHarness = async (holdMs: number) => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    const timeline = new TimelineStore(storage);
    const router = new TimelineRouter(timeline);
    const provider = new DiscordProvider(makeDiscordConfig({ trigger_hold_ms: holdMs }), callbacks);
    const emitted: InboundChatEvent[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onEvent(inbound: InboundChatEvent) {
        emitted.push(inbound);
        if (inbound.edit?.deleted) void timeline.markDeleted("discord", inbound.edit.targetExternalId, inbound.timelineKey, { at: inbound.event.timestamp });
        else if (!inbound.edit) void router.route(inbound, "skipped");
      },
      resolveReplyTrigger: () => undefined,
    };
    const handlers = provider as unknown as Handlers;
    const triggers = () => emitted.filter((i) => !i.edit && i.trigger);
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    return { storage, provider, emitted, handlers, triggers, wait };
  };

  it("stores every held message as it arrives and delivers one trigger grouping the sender's messages", async () => {
    const t = await holdHarness(150);
    try {
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111101", "first part"));
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111102", "second part"));
      assert.equal(t.triggers().length, 0, "the trigger is held");
      assert.deepEqual(t.emitted.map((i) => [i.event.externalId, i.trigger]), [["111111111111111101", undefined], ["111111111111111102", undefined]]);
      await t.wait(300);
      assert.equal(t.triggers().length, 1, "one grouped trigger");
      const [held] = t.triggers();
      assert.equal(held!.event.externalId, "111111111111111101", "rooted on the first message");
      assert.deepEqual(held!.trigger!.groupedEventIds, ["discord:main:111111111111111101", "discord:main:111111111111111102"]);
      assert.equal(held!.event.trigger, held!.trigger);
      // Both held messages are stored, not only the last one.
      assert.equal(t.storage.getTimelineEventById("discord:main:111111111111111101")?.body, "first part");
      assert.equal(t.storage.getTimelineEventById("discord:main:111111111111111102")?.body, "second part");
    } finally {
      t.storage.close();
    }
  });

  it("holds each sender separately: another sender's trigger never replaces a held one", async () => {
    const t = await holdHarness(150);
    try {
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111111", "alice asks", "400000000000000001"));
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111112", "bob asks", "400000000000000002"));
      await t.wait(300);
      assert.deepEqual(t.triggers().map((i) => i.event.externalId).sort(), ["111111111111111111", "111111111111111112"]);
      assert.ok(t.triggers().every((i) => i.trigger!.groupedEventIds!.length === 1));
    } finally {
      t.storage.close();
    }
  });

  it("a deleted held root re-roots the trigger on the next held part; a deleted later part leaves the group", async () => {
    const t = await holdHarness(150);
    try {
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111121", "typo"));
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111122", "corrected"));
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111123", "an afterthought"));
      await t.handlers.handleMessageDelete!(makeRuntime(), { id: "111111111111111121", channelId: CHANNEL });
      await t.handlers.handleMessageDelete!(makeRuntime(), { id: "111111111111111123", channelId: CHANNEL });
      await t.wait(300);
      assert.equal(t.triggers().length, 1);
      const [held] = t.triggers();
      assert.equal(held!.event.externalId, "111111111111111122");
      assert.equal(held!.event.body, "corrected");
      assert.deepEqual(held!.trigger!.groupedEventIds, ["discord:main:111111111111111122"]);
      // Every deleted held message is stored, marked, with its content.
      for (const id of ["111111111111111121", "111111111111111123"]) {
        const stored = t.storage.getTimelineEventById(`discord:main:${id}`);
        assert.ok(stored?.deleted, `${id} marked`);
      }
      assert.equal(t.storage.getTimelineEventById("discord:main:111111111111111121")?.body, "typo", "content kept");
      assert.equal(t.storage.getTimelineEventById("discord:main:111111111111111122")?.deleted, undefined);
    } finally {
      t.storage.close();
    }
  });

  it("every held part deleted: the trigger is never delivered", async () => {
    const t = await holdHarness(150);
    try {
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111131"));
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111132", "more"));
      await t.handlers.handleMessageDelete!(makeRuntime(), { id: "111111111111111132", channelId: CHANNEL });
      await t.handlers.handleMessageDelete!(makeRuntime(), { id: "111111111111111131", channelId: CHANNEL });
      await t.wait(300);
      assert.equal(t.triggers().length, 0, "no trigger for a withdrawn hold");
      assert.equal(t.emitted.filter((i) => i.edit?.deleted === true).length, 2);
      assert.ok(t.storage.getTimelineEventById("discord:main:111111111111111131")?.deleted);
      assert.equal(t.storage.getTimelineEventById("discord:main:111111111111111131")?.body, "please answer this", "content kept");
    } finally {
      t.storage.close();
    }
  });

  it("a deletion of another message leaves the held trigger alone", async () => {
    const t = await holdHarness(100);
    try {
      await t.handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111141"));
      await t.handlers.handleMessageDelete!(makeRuntime(), { id: "111111111111111999", channelId: CHANNEL });
      await t.wait(250);
      assert.equal(t.triggers().length, 1);
      assert.deepEqual(t.triggers()[0]!.trigger!.groupedEventIds, ["discord:main:111111111111111141"]);
    } finally {
      t.storage.close();
    }
  });
});

describe("Discord bulk deletion (a purge)", () => {
  it("messageDeleteBulk emits one deletion per message, deleter unknown, through the single-delete path", async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      const timeline = new TimelineStore(storage);
      const router = new TimelineRouter(timeline);
      const provider = new DiscordProvider(makeDiscordConfig(), callbacks);
      const emitted: InboundChatEvent[] = [];
      (provider as unknown as Record<string, unknown>).host = {
        onEvent: (inbound: InboundChatEvent) => emitted.push(inbound),
        onError: (error: unknown) => assert.fail(String(error)),
        resolveReplyTrigger: () => undefined,
      };
      // Store the purged messages first, so the deletions find them.
      for (const id of ["111111111111111121", "111111111111111122"]) {
        await router.route(
          {
            provider: "discord",
            timelineKey: `discord:main:dm:${CHANNEL}`,
            event: {
              id: `discord:main:${id}`,
              externalId: id,
              timelineKey: `discord:main:dm:${CHANNEL}`,
              provider: "discord",
              role: "user",
              sender: { id: "400000000000000001" },
              body: `purged ${id}`,
              timestamp: 1,
              receivedAt: 1,
            },
          },
          "skipped",
        );
      }
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const runtime = makeRuntime() as { client: Record<string, unknown> };
      runtime.client.on = (name: string, fn: (...args: unknown[]) => void) => listeners.set(name, fn);
      runtime.client.rest = { on() {} };
      (provider as unknown as { attachListeners(r: unknown): void }).attachListeners(runtime);
      const bulk = listeners.get("messageDeleteBulk");
      assert.ok(bulk, "messageDeleteBulk is handled");
      const purged = new Map([
        ["111111111111111121", { id: "111111111111111121", channelId: CHANNEL, guildId: null }],
        ["111111111111111122", { id: "111111111111111122", channelId: CHANNEL, guildId: null }],
      ]);
      bulk(purged, { id: CHANNEL });
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      const deletions = emitted.filter((i) => i.edit?.deleted === true);
      assert.deepEqual(deletions.map((i) => i.edit!.targetExternalId), ["111111111111111121", "111111111111111122"]);
      assert.ok(deletions.every((i) => i.edit!.deletedBy === undefined && i.timelineKey === `discord:main:dm:${CHANNEL}`));
    } finally {
      storage.close();
    }
  });

  it("skips messages the account does not handle (DMs disabled)", async () => {
    const provider = new DiscordProvider(makeDiscordConfig(), callbacks);
    const emitted: InboundChatEvent[] = [];
    (provider as unknown as Record<string, unknown>).host = { onEvent: (inbound: InboundChatEvent) => emitted.push(inbound) };
    const runtime = { ...(makeRuntime() as Record<string, unknown>), dmEnabled: false };
    await (provider as unknown as Handlers).handleMessageDeleteBulk!(runtime, [{ id: "1", channelId: CHANNEL, guildId: null }]);
    assert.equal(emitted.length, 0);
  });
});
