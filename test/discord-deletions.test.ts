/**
 * Discord deletions before the message is stored (ARCHITECTURE.md §6 "Message
 * edits", §6c "Deletes"): a trigger deleted during the provider's trigger hold
 * is flushed at once, without its trigger and already marked deleted, so it is
 * stored marked and starts no session.
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
function makeDm(id: string): unknown {
  return {
    id,
    content: "please answer this",
    channelId: CHANNEL,
    guildId: null,
    guild: null,
    channel: { type: 1, messages: { cache: { get: () => undefined } } },
    reference: null,
    author: { id: "400000000000000001", username: "alice", displayName: "Alice", bot: false },
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

describe("Discord deletion of a held trigger", () => {
  it("flushes the held message at once, untriggered and marked deleted; the trigger never fires", async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      const timeline = new TimelineStore(storage);
      const router = new TimelineRouter(timeline);
      const provider = new DiscordProvider(makeDiscordConfig({ trigger_hold_ms: 150 }), callbacks);
      const emitted: InboundChatEvent[] = [];
      (provider as unknown as Record<string, unknown>).host = {
        onEvent(inbound: InboundChatEvent) {
          emitted.push(inbound);
          if (!inbound.edit) void router.route(inbound, "skipped");
        },
        resolveReplyTrigger: () => undefined,
      };
      const handlers = provider as unknown as Handlers;
      await handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111111"));
      assert.equal(emitted.length, 0, "held, not emitted yet");
      await handlers.handleMessageDelete!(makeRuntime(), { id: "111111111111111111", channelId: CHANNEL });
      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      const flushed = emitted.filter((i) => !i.edit);
      assert.equal(flushed.length, 1, "the held message is flushed once, never again at the hold's end");
      assert.equal(flushed[0]!.trigger, undefined);
      assert.equal(flushed[0]!.event.trigger, undefined);
      assert.ok(flushed[0]!.event.deleted, "flushed already marked deleted");
      const deletions = emitted.filter((i) => i.edit?.deleted === true);
      assert.equal(deletions.length, 1);
      assert.equal(deletions[0]!.edit!.targetExternalId, "111111111111111111");

      const stored = storage.getTimelineEventById("discord:main:111111111111111111");
      assert.ok(stored?.deleted, "stored marked");
      assert.equal(stored?.body, "please answer this", "content kept");
    } finally {
      storage.close();
    }
  });

  it("a deletion of another message leaves the held trigger alone", async () => {
    const provider = new DiscordProvider(makeDiscordConfig({ trigger_hold_ms: 100 }), callbacks);
    const emitted: InboundChatEvent[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onEvent: (inbound: InboundChatEvent) => emitted.push(inbound),
      resolveReplyTrigger: () => undefined,
    };
    const handlers = provider as unknown as Handlers;
    await handlers.handleMessageCreate!(makeRuntime(), makeDm("111111111111111112"));
    await handlers.handleMessageDelete!(makeRuntime(), { id: "111111111111111999", channelId: CHANNEL });
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    const flushed = emitted.filter((i) => !i.edit);
    assert.equal(flushed.length, 1);
    assert.ok(flushed[0]!.trigger, "still a trigger");
    assert.equal(flushed[0]!.event.deleted, undefined);
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
