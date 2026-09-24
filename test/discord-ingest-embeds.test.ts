/**
 * Discord ingest-time embeds (`discord_embed` link previews) must be persisted
 * together with the event row, on every ingest path, without depending on the
 * relative microtask timing of the provider and the inbound pipeline.
 *
 * Regression: on an ACTIVE timeline `handleInbound` awaits the activation gate
 * before it enqueues the event insert, while the provider enqueued the preview
 * insert synchronously right after `host.onEvent` returned. The preview write
 * therefore landed on the single-writer queue BEFORE the event write and failed
 * the `link_previews.event_id → timeline_events(id)` FK ("FOREIGN KEY constraint
 * failed", logged as a `messageCreate` provider_error). Messages that carry an
 * embed at MESSAGE_CREATE time — typically bot replies such as link-fixer bots,
 * which also reply to a message the pipeline may not have stored — lost their
 * previews.
 *
 * The harness drives the real activation gate (`ActivationCoordinator`), router
 * and in-memory Storage exactly as app.ts orders them, so the race is real, not
 * simulated.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DiscordProvider, type DiscordProviderCallbacks } from "../src/discord/index.js";
import { Storage } from "../src/storage/index.js";
import {
  ActivationCoordinator,
  TimelineRouter,
  TimelineStore,
  TriggerCoordinator,
} from "../src/timeline/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { InboundChatEvent } from "../src/types.js";

const SESSIONS_CONFIG: AppConfig["agent"]["sessions"] = {
  max_concurrent: 1,
  max_concurrent_dm: 1,
  max_queued_per_timeline: 10,
} as AppConfig["agent"]["sessions"];

function makeDiscordConfig(
  overrides: Partial<NonNullable<AppConfig["discord"]>> = {},
): NonNullable<AppConfig["discord"]> {
  return {
    enabled: true,
    accounts: {
      main: {
        token: "MOCK_TOKEN",
        dm_enabled: true,
        member_intent: false,
        guilds: undefined,
        application_id: undefined,
      },
    },
    ...overrides,
  };
}

function makeRuntime(accountId = "main"): unknown {
  return {
    accountId,
    self: { id: "999000000000000001", username: "bot", displayName: "Bot" },
    client: { channels: { cache: new Map(), fetch: async () => null } },
    allowedGuilds: undefined,
    dmEnabled: true,
    memberIntentEnabled: false,
    emojiCatalog: { observeEmoji() {} },
  };
}

/**
 * A bot reply that carries an embed in its MESSAGE_CREATE payload and replies
 * to a message the pipeline has never stored (cache miss → repliedUser stub).
 */
function makeBotReplyWithEmbed(): unknown {
  return {
    id: "111111111111111111",
    content: "",
    channelId: "200000000000000001",
    guildId: "300000000000000001",
    guild: { id: "300000000000000001", name: "Guild", members: { cache: new Map() } },
    channel: {
      type: 0, // GuildText
      name: "general",
      messages: { cache: { get: () => undefined } }, // reply target not cached
    },
    author: { id: "400000000000000001", username: "fixer", displayName: "Fixer", bot: true },
    reference: { messageId: "800000000000000001" },
    mentions: {
      users: { map: () => [] },
      roles: { map: () => [] },
      channels: { map: () => [] },
      everyone: false,
      repliedUser: { id: "403000000000000001", username: "carol", displayName: "Carol" },
    },
    attachments: { values: () => [].values() },
    stickers: { values: () => [].values() },
    embeds: [
      {
        url: "https://example.com/fixed/status/1",
        title: "Fixed link",
        description: "an embed delivered with the message",
        provider: { name: "example" },
        data: { type: "rich" },
      },
    ],
    createdTimestamp: 1_700_000_000_000,
    editedTimestamp: null,
  };
}

interface Pipeline {
  storage: Storage;
  timeline: TimelineStore;
  coordinator: ActivationCoordinator;
  router: TimelineRouter;
  /** Rejections surfaced by the pipeline's own `handleInbound` analogue. */
  pipelineErrors: unknown[];
}

/**
 * Real in-memory Storage + real activation gate. `host.onEvent` mirrors app.ts
 * `handleInbound`: fire-and-forget, `await gateInbound(...)` first, then
 * `router.route(...)` — the yield that puts the event insert one microtask behind
 * anything the provider enqueues right after `onEvent` returns.
 */
async function makePipeline(timelineState: "active" | "inactive"): Promise<Pipeline> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  const timeline = new TimelineStore(storage);
  const router = new TimelineRouter(timeline);
  const coordinator = new ActivationCoordinator({
    storage,
    router,
    triggerCoordinator: new TriggerCoordinator(SESSIONS_CONFIG),
    setEnrichmentStatus: (eventId, status) => timeline.setEnrichmentStatus(eventId, status),
    notifyEnrichment: () => {},
    notifyCaptions: () => {},
    runInitialBackfill: async () => {},
    resolveTriggerGroup: async () => {},
    awaitTriggerReadiness: async () => {},
    addClaim: () => {},
    releaseClaim: () => {},
    launchSession: async () => {},
    dispatch: () => {},
    isDraining: () => false,
    logger: { info() {}, warn() {}, error() {} },
  });
  const timelineKey = "discord:main:room:200000000000000001";
  if (timelineState === "active") await storage.setTimelineState(timelineKey, "active");
  return { storage, timeline, coordinator, router, pipelineErrors: [] };
}

function attachHost(provider: DiscordProvider, p: Pipeline): void {
  (provider as unknown as Record<string, unknown>).host = {
    onEvent(inbound: InboundChatEvent) {
      void (async () => {
        if ((await p.coordinator.gateInbound(inbound)) === "handled") return;
        await p.router.route(inbound, "pending");
      })().catch((error) => p.pipelineErrors.push(error));
    },
    resolveReplyTrigger: () => undefined,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

function counts(storage: Storage, eventId: string): { events: number; previews: number } {
  return storage.read((db) => ({
    events: (db.prepare("select count(*) as n from timeline_events where id = ?").get(eventId) as { n: number }).n,
    previews: (db.prepare("select count(*) as n from link_previews where event_id = ?").get(eventId) as { n: number }).n,
  }));
}

const callbacks: DiscordProviderCallbacks = {
  async mergeLateEmbeds() {},
  async upsertUserIdentity() {},
  async setChannelMetadata() {},
};

describe("Discord ingest embeds ride with the event row", () => {
  for (const state of ["active", "inactive"] as const) {
    it(`bot reply with a create-time embed to an unstored target, ${state} timeline: message and preview stored, no FK error`, async () => {
      const p = await makePipeline(state);
      try {
        const provider = new DiscordProvider(makeDiscordConfig(), callbacks);
        attachHost(provider, p);

        await (provider as unknown as Record<string, (...args: unknown[]) => Promise<void>>)
          .handleMessageCreate(makeRuntime(), makeBotReplyWithEmbed());
        await settle();

        assert.deepEqual(p.pipelineErrors, [], "pipeline must not reject");
        const eventId = "discord:main:111111111111111111";
        assert.deepEqual(counts(p.storage, eventId), { events: 1, previews: 1 });

        // The reply reference survives untouched: it is data on the event row,
        // never an FK, so an unstored target can't reject the message.
        const stored = p.storage.getTimelineEventById(eventId);
        assert.equal(stored?.replyTo?.externalId, "800000000000000001");
        assert.equal(stored?.replyTo?.sender?.id, "403000000000000001");

        const row = p.storage.read((db) =>
          db.prepare("select id, source_kind, url, fetch_status from link_previews where event_id = ?").get(eventId) as {
            id: string; source_kind: string; url: string; fetch_status: string;
          },
        );
        assert.equal(row.id, `${eventId}:embed:0`);
        assert.equal(row.source_kind, "discord_embed");
        assert.equal(row.url, "https://example.com/fixed/status/1");
        assert.equal(row.fetch_status, "complete");
      } finally {
        p.storage.close();
      }
    });
  }

  it("trigger hold flush on an active timeline: previews stored with the held event", async () => {
    const p = await makePipeline("active");
    try {
      const provider = new DiscordProvider(makeDiscordConfig({ trigger_hold_ms: 5 }), callbacks);
      attachHost(provider, p);

      // A DM auto-triggers, so the message takes the hold path and is emitted at flush.
      const dm = {
        ...(makeBotReplyWithEmbed() as Record<string, unknown>),
        guildId: null,
        guild: null,
        channel: { type: 1, messages: { cache: { get: () => undefined } } },
        reference: null,
      };
      await (provider as unknown as Record<string, (...args: unknown[]) => Promise<void>>)
        .handleMessageCreate(makeRuntime(), dm);
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      assert.deepEqual(p.pipelineErrors, [], "pipeline must not reject");
      assert.deepEqual(counts(p.storage, "discord:main:111111111111111111"), { events: 1, previews: 1 });
    } finally {
      p.storage.close();
    }
  });

  it("duplicate delivery of the same message does not duplicate or lose the previews", async () => {
    const p = await makePipeline("active");
    try {
      const provider = new DiscordProvider(makeDiscordConfig(), callbacks);
      attachHost(provider, p);
      const handle = (provider as unknown as Record<string, (...args: unknown[]) => Promise<void>>).handleMessageCreate.bind(provider);

      await handle(makeRuntime(), makeBotReplyWithEmbed());
      await settle();
      await handle(makeRuntime(), makeBotReplyWithEmbed());
      await settle();

      assert.deepEqual(p.pipelineErrors, []);
      assert.deepEqual(counts(p.storage, "discord:main:111111111111111111"), { events: 1, previews: 1 });
    } finally {
      p.storage.close();
    }
  });
});
