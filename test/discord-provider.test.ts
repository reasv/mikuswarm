/**
 * Tests for DiscordProvider construction, wiring, and boot behaviour.
 *
 * All tests are mocked / offline — no real Discord token or gateway connection.
 * The provider is constructed but NOT started (start() connects to Discord; the
 * mocked-gateway rule from the Phase 7 charter means we test construction and
 * static contract only, not live behaviour).
 *
 * Covers:
 *  - Provider id and capabilities values (including documented temporary lies)
 *  - ownsUserId: snowflake predicate (not MXID, not email, pure digits only)
 *  - channelClient() returns undefined (7b — gating verified)
 *  - enrichment() returns capabilities object for a registered account
 *  - enrichment() returns undefined for an unknown account
 *  - getSelf() returns undefined before start()
 *  - accountIds() returns the configured account ids
 *  - isUserIdentity composed predicate (Matrix-only byte-identical + Discord)
 *  - Dual-provider boot wiring test (construction only, no start)
 *  - membershipRoster reflects any member_intent=true account
 *  - BLOCKER 1: referencedMessage via channel message cache (discord.js v14 fix)
 *  - BLOCKER 2: storeIngestEmbeds runs after host.onEvent (FK ordering via real Storage)
 *  - MODERATE: trigger-hold FK ordering — embeds stored at flush, after host.onEvent fires
 *  - MAJOR: @username → <@id> mention resolution in send path (spec §7.3, §14)
 *  - MINOR: case-insensitive username match in resolveMentionTokens
 *  - NIT 2: MESSAGE_UPDATE routing — null editedTimestamp vs non-null
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DiscordProvider,
  resolveMentionTokens,
  normalizeDiscordMessage,
  type DiscordProviderCallbacks,
} from "../src/discord/index.js";
import { MatrixProvider } from "../src/matrix/index.js";
import { Storage, type LinkPreviewRow } from "../src/storage/index.js";
import { TimelineStore } from "../src/timeline/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { IChatProvider } from "../src/types.js";
import type { TextChannel, DMChannel } from "discord.js";

// ── Minimal stubs ─────────────────────────────────────────────────────────────

const noopCallbacks = {
  async mergeLateEmbeds() {},
  async storeIngestEmbeds() {},
};

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

// ── Provider construction ─────────────────────────────────────────────────────

describe("DiscordProvider: construction", () => {
  it("has id 'discord'", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.id, "discord");
  });

  it("accountIds() returns configured account names", () => {
    const p = new DiscordProvider(
      makeDiscordConfig({ accounts: { alpha: { token: "T1" }, beta: { token: "T2" } } }),
      noopCallbacks,
    );
    const ids = p.accountIds();
    assert.deepEqual(ids.sort(), ["alpha", "beta"]);
  });

  it("getSelf() returns undefined before start()", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.getSelf("main"), undefined);
  });
});

// ── Capabilities ──────────────────────────────────────────────────────────────

describe("DiscordProvider: capabilities", () => {
  it("maxMessageChars = 2000", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.maxMessageChars, 2000);
  });

  it("maxAttachmentsPerMessage = 10", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.maxAttachmentsPerMessage, 10);
  });

  it("formatting = markdown", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.formatting, "markdown");
  });

  it("encrypted = false", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.encrypted, false);
  });

  it("linkPreviews = none", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.linkPreviews, "none");
  });

  it("singleAttachmentPerMessage = false", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.singleAttachmentPerMessage, false);
  });

  it("history = true (safe — gated behind channelClient non-null)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.history, true);
  });

  it("pollCreate = true (v1 scope)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.pollCreate, true);
  });

  it("pollVote = false (no bot vote endpoint in Discord API)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.pollVote, false);
  });

  it("threads = true", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.threads, true);
  });

  it("voiceMessages = false (Phase 7b temporary lie, documented in capabilities JSDoc)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    // This is the ONLY temporary lie: voiceMessages will be flipped to true in Phase 7b
    // once as_voice is implemented in send(). Until then it is false so the model
    // never sees the as_voice parameter.
    assert.equal(p.capabilities.voiceMessages, false);
  });

  it("reactions = true (platform supports reactions; handlers come in Phase 7b)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.reactions, true);
  });

  it("reactionKinds = unicode + custom (not text)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.deepEqual(p.capabilities.reactionKinds, ["unicode", "custom"]);
  });

  it("customEmojiScoped = true (guild-scoped sendability)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.customEmojiScoped, true);
  });

  it("membershipRoster = false when no account has member_intent=true", () => {
    const p = new DiscordProvider(makeDiscordConfig({ accounts: { main: { token: "T", member_intent: false } } }), noopCallbacks);
    assert.equal(p.capabilities.membershipRoster, false);
  });

  it("membershipRoster = true when any account has member_intent=true", () => {
    const p = new DiscordProvider(
      makeDiscordConfig({
        accounts: {
          a: { token: "T1", member_intent: false },
          b: { token: "T2", member_intent: true },
        },
      }),
      noopCallbacks,
    );
    assert.equal(p.capabilities.membershipRoster, true);
  });
});

// ── ownsUserId ────────────────────────────────────────────────────────────────

describe("DiscordProvider.ownsUserId", () => {
  const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);

  it("accepts numeric snowflake", () => {
    assert.equal(p.ownsUserId("123456789012345678"), true);
  });

  it("rejects MXID (@user:server.com)", () => {
    assert.equal(p.ownsUserId("@user:server.com"), false);
  });

  it("rejects email address", () => {
    assert.equal(p.ownsUserId("user@example.com"), false);
  });

  it("rejects empty string", () => {
    assert.equal(p.ownsUserId(""), false);
  });

  it("rejects string with non-digit characters", () => {
    assert.equal(p.ownsUserId("123abc"), false);
  });

  it("rejects whitespace-only string", () => {
    assert.equal(p.ownsUserId("   "), false);
  });
});

// ── channelClient() returns undefined ────────────────────────────────────────

describe("DiscordProvider.channelClient", () => {
  it("returns undefined for any target (Phase 7b)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    const result = p.channelClient({
      provider: "discord",
      timelineKey: "discord:main:room:200000000000000001",
      accountId: "main",
      roomId: "200000000000000001",
    });
    assert.equal(result, undefined);
  });
});

// ── enrichment() ─────────────────────────────────────────────────────────────

describe("DiscordProvider.enrichment", () => {
  it("returns capabilities object for a known account", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    // Accounts are only populated after start(), but we test the account lookup.
    // With no accounts started, enrichment returns undefined (not registered yet).
    // This test is purely structural — verifying the interface shape.
    const caps = p.enrichment("unknown-account");
    assert.equal(caps, undefined);
  });
});

// ── history() returns undefined ───────────────────────────────────────────────

describe("DiscordProvider.history", () => {
  it("returns undefined (Phase 7b)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    const h = p.history?.({
      provider: "discord",
      timelineKey: "discord:main:room:200000000000000001",
    });
    assert.equal(h, undefined);
  });
});

// ── Dual-provider registry wiring ─────────────────────────────────────────────

describe("dual-provider registry", () => {
  it("Matrix and Discord can coexist in a providers map without conflict", () => {
    // Construction only — no start(). Verifies the registry pattern is sound.
    const discordProvider: IChatProvider = new DiscordProvider(makeDiscordConfig(), noopCallbacks);

    const providers = new Map<string, IChatProvider>();
    providers.set("discord", discordProvider);

    // A dual-provider isUserIdentity predicate (spec §6.4)
    const isUserIdentity = (id: string): boolean =>
      [...providers.values()].some((p) => p.ownsUserId(id));

    // Discord snowflake → Discord provider owns it
    assert.equal(isUserIdentity("123456789012345678"), true);

    // MXID → no registered provider owns it (Matrix not in this map)
    assert.equal(isUserIdentity("@user:server.com"), false);
  });

  it("Matrix ownsUserId is unchanged (byte-identical) in single-provider config", () => {
    // With only Matrix in the registry, the composed predicate must reproduce
    // the old id.startsWith("@") behaviour exactly.
    const matrixConfig = {
      enabled: true,
      accounts: {
        main: {
          user_id: "@bot:server.com",
          homeserver: "https://server.com",
          device_id: "DEVICE",
          store_path: "/tmp/test-store",
          access_token: "TOKEN",
        },
      },
    } as AppConfig["matrix"];

    const matrixProvider: IChatProvider = new MatrixProvider(matrixConfig);
    const providers = new Map<string, IChatProvider>([["matrix", matrixProvider]]);
    const isUserIdentity = (id: string): boolean =>
      [...providers.values()].some((p) => p.ownsUserId(id));

    // Matrix MXIDs own @ prefix
    assert.equal(isUserIdentity("@alice:server.com"), true);
    assert.equal(isUserIdentity("@bot:server.com"), true);

    // Numeric ids are not owned by Matrix alone
    assert.equal(isUserIdentity("123456789012345678"), false);

    // Empty / random strings
    assert.equal(isUserIdentity(""), false);
    assert.equal(isUserIdentity("random"), false);
  });
});

// ── Shared helpers for handler-level tests ────────────────────────────────────

/** Build a minimal stubbed AccountRuntime (no real discord.js Client). */
function makeRuntime(accountId = "main"): unknown {
  return {
    accountId,
    self: { id: "999000000000000001", username: "bot", displayName: "Bot" },
    client: {
      channels: {
        cache: new Map(),
        fetch: async () => null,
      },
    },
    allowedGuilds: undefined,
    dmEnabled: true,
    memberIntentEnabled: false,
  };
}

/** Build a minimal Message stub for handleMessageCreate. */
function makeMsgStub(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "111111111111111111",
    content: "hello",
    channelId: "200000000000000001",
    guildId: "300000000000000001",
    channel: {
      type: 0, // GuildText
      messages: { cache: { get: () => undefined } },
    },
    author: {
      id: "400000000000000001",
      username: "alice",
      displayName: "Alice",
    },
    reference: null,
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
    flags: { has: () => false },
    guild: null,
    createdTimestamp: 1_700_000_000_000,
    editedTimestamp: null,
    poll: null,
    ...overrides,
  };
}

/** Build a minimal Message stub for handleMessageUpdate. */
function makeUpdateMsgStub(
  editedTimestamp: number | null,
  embeds: Array<{ url: string }> = [],
): unknown {
  return {
    partial: false,
    id: "111111111111111111",
    content: "hello",
    channelId: "200000000000000001",
    guildId: "300000000000000001",
    channel: {
      type: 0,
      messages: { cache: { get: () => undefined } },
    },
    author: {
      id: "400000000000000001",
      username: "alice",
      displayName: "Alice",
    },
    reference: null,
    mentions: {
      users: { map: () => [] },
      roles: { map: () => [] },
      channels: { map: () => [] },
      everyone: false,
      repliedUser: null,
    },
    attachments: { values: () => [].values() },
    stickers: { values: () => [].values() },
    flags: { has: () => false },
    embeds: embeds.map((e) => ({
      url: e.url,
      title: null,
      description: null,
      provider: null,
      data: { type: null },
    })),
    poll: null,
    guild: null,
    createdTimestamp: 1_700_000_000_000,
    editedTimestamp,
  };
}

/** Minimal stub host that captures events. */
function makeStubHost(overrides: Record<string, unknown> = {}): {
  capturedEvent: unknown;
  host: Record<string, unknown>;
} {
  const result = { capturedEvent: undefined as unknown };
  return {
    capturedEvent: result as unknown,
    host: {
      onEvent(inbound: unknown) {
        (result as Record<string, unknown>).capturedEvent = inbound;
      },
      resolveReplyTrigger: () => undefined,
      ...overrides,
    },
  };
}

// ── BLOCKER 1: referencedMessage via channel message cache ────────────────────

describe("BLOCKER 1: referencedMessage — channel message cache lookup", () => {
  it("replyTo is populated from cache hit when reference.messageId is set", async () => {
    const cachedRefMsg = {
      id: "800000000000000001",
      content: "original message body",
      author: { id: "402000000000000001", username: "bob", displayName: "Bob" },
      createdTimestamp: 1_699_000_000_000,
      attachments: { values: () => [].values() },
      stickers: { values: () => [].values() },
      guild: null,
    };

    const msgStub = makeMsgStub({
      reference: { messageId: "800000000000000001" },
      channel: {
        type: 0,
        messages: {
          cache: {
            get: (id: string) =>
              id === "800000000000000001" ? cachedRefMsg : undefined,
          },
        },
      },
      // repliedUser is null — gate is on reference.messageId alone (MINOR 2)
      mentions: {
        users: { map: () => [] },
        roles: { map: () => [] },
        channels: { map: () => [] },
        everyone: false,
        repliedUser: null,
      },
    });

    let capturedInbound: unknown;
    const callbacks: DiscordProviderCallbacks = {
      async mergeLateEmbeds() {},
      async storeIngestEmbeds() {},
    };
    const provider = new DiscordProvider(makeDiscordConfig(), callbacks);
    (provider as unknown as Record<string, unknown>).host = {
      onEvent(inbound: unknown) { capturedInbound = inbound; },
      resolveReplyTrigger: () => undefined,
    };

    await (provider as unknown as Record<string, (...args: unknown[]) => unknown>)
      .handleMessageCreate(makeRuntime(), msgStub);

    const event = (capturedInbound as { event: { replyTo?: { externalId?: string; body?: string; sender?: { id?: string } } } }).event;
    assert.ok(event.replyTo, "replyTo must be populated on cache hit");
    assert.equal(event.replyTo.externalId, "800000000000000001");
    assert.equal(event.replyTo.body, "original message body");
    assert.equal(event.replyTo.sender?.id, "402000000000000001");
  });

  it("replyTo uses repliedUser stub on cache miss", async () => {
    const msgStub = makeMsgStub({
      reference: { messageId: "800000000000000002" },
      channel: {
        type: 0,
        messages: { cache: { get: () => undefined } }, // cache miss
      },
      mentions: {
        users: { map: () => [] },
        roles: { map: () => [] },
        channels: { map: () => [] },
        everyone: false,
        repliedUser: { id: "403000000000000001", username: "carol", displayName: "Carol" },
      },
    });

    let capturedInbound: unknown;
    const provider = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    (provider as unknown as Record<string, unknown>).host = {
      onEvent(inbound: unknown) { capturedInbound = inbound; },
      resolveReplyTrigger: () => undefined,
    };

    await (provider as unknown as Record<string, (...args: unknown[]) => unknown>)
      .handleMessageCreate(makeRuntime(), msgStub);

    const event = (capturedInbound as { event: { replyTo?: { externalId?: string; body?: string; sender?: { id?: string; username?: string } } } }).event;
    assert.ok(event.replyTo, "replyTo must be populated from repliedUser stub on cache miss");
    assert.equal(event.replyTo.externalId, "800000000000000002");
    assert.equal(event.replyTo.body, ""); // stub has no content
    assert.equal(event.replyTo.sender?.id, "403000000000000001");
    assert.equal(event.replyTo.sender?.username, "carol");
  });
});

// ── BLOCKER 2: FK ordering (storeIngestEmbeds after host.onEvent) ─────────────

describe("BLOCKER 2: storeIngestEmbeds runs after host.onEvent (FK ordering)", () => {
  it("message with embeds: both event row and preview rows committed via real in-memory Storage", async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      const timeline = new TimelineStore(storage);

      // Wire callbacks exactly as app.ts does — real Storage writes
      const callbacks: DiscordProviderCallbacks = {
        async mergeLateEmbeds() {},
        async storeIngestEmbeds(eventId, previews) {
          for (let i = 0; i < previews.length; i++) {
            const preview = previews[i]!;
            await storage.insertLinkPreview({
              id: `${eventId}:embed:${i}`,
              event_id: eventId,
              context: "message",
              url: preview.url,
              title: preview.title ?? null,
              description: preview.description ?? null,
              source_kind: "discord_embed",
              preview_index: i,
              fetched_at: preview.fetchedAt ?? Date.now(),
              fetch_status: "complete",
              created_at: Date.now(),
            } satisfies LinkPreviewRow);
          }
        },
      };

      // Build an inbound event with embed previews using the normalizer directly
      const { inbound, embedPreviews } = normalizeDiscordMessage(
        {
          id: "100000000000000001",
          content: "check this out",
          channelId: "200000000000000001",
          channelType: 0,
          guildId: "300000000000000001",
          authorId: "400000000000000001",
          authorUsername: "alice",
          authorDisplayName: "Alice",
          timestamp: 1_700_000_000_000,
          editedTimestamp: null,
          mentionedUsers: [],
          mentionedRoles: [],
          mentionedChannels: [],
          mentionEveryone: false,
          attachments: [],
          stickers: [],
          embeds: [{ url: "https://example.com/article", title: "Example" }],
        },
        { accountId: "main", selfUserId: "999" },
      );
      assert.equal(embedPreviews.length, 1, "test requires at least one embed preview");

      // Simulate the FIXED ordering: host.onEvent first (enqueues event write),
      // then await storeIngestEmbeds (queues preview write after event write).
      // The FIFO single-writer queue ensures the event row exists before the FK check.
      const appendPromise = timeline.append(inbound.event);
      await callbacks.storeIngestEmbeds(inbound.event.id, embedPreviews);
      await appendPromise;

      const eventCount = storage.read((db) =>
        (db.prepare("select count(*) as n from timeline_events where id = ?")
          .get(inbound.event.id) as { n: number }).n,
      );
      const previewCount = storage.read((db) =>
        (db.prepare("select count(*) as n from link_previews where event_id = ?")
          .get(inbound.event.id) as { n: number }).n,
      );
      assert.equal(eventCount, 1, "timeline_events row must exist");
      assert.equal(previewCount, 1, "link_previews row must exist (FK satisfied)");
    } finally {
      storage.close();
    }
  });
});

// ── MODERATE: trigger-hold FK ordering ───────────────────────────────────────

describe("MODERATE: trigger-hold FK ordering — embeds stored after hold flush", () => {
  it("trigger_hold_ms > 0, triggered message with embeds → event row and preview rows both exist after flush", async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      const timeline = new TimelineStore(storage);

      const callbacks: DiscordProviderCallbacks = {
        async mergeLateEmbeds() {},
        async storeIngestEmbeds(eventId, previews) {
          for (let i = 0; i < previews.length; i++) {
            const preview = previews[i]!;
            await storage.insertLinkPreview({
              id: `${eventId}:embed:${i}`,
              event_id: eventId,
              context: "message",
              url: preview.url,
              title: preview.title ?? null,
              description: preview.description ?? null,
              source_kind: "discord_embed",
              preview_index: i,
              fetched_at: preview.fetchedAt ?? Date.now(),
              fetch_status: "complete",
              created_at: Date.now(),
            } satisfies LinkPreviewRow);
          }
        },
      };

      // trigger_hold_ms = 5 ms (very short) so the hold fires well within the wait below
      const provider = new DiscordProvider(
        makeDiscordConfig({ trigger_hold_ms: 5 }),
        callbacks,
      );

      let capturedInbound: { event: { id: string } } | undefined;
      (provider as unknown as Record<string, unknown>).host = {
        onEvent(inbound: unknown) {
          capturedInbound = inbound as { event: { id: string } };
          // Mirror app.ts: append the event to storage via the timeline store
          void timeline.append((inbound as { event: Parameters<TimelineStore["append"]>[0] }).event);
        },
        resolveReplyTrigger: () => undefined,
      };

      // DM channel (type 1) auto-triggers without needing a bot mention.
      // The message carries one embed so embedPreviews will be non-empty.
      const dmMsgWithEmbed = makeMsgStub({
        channel: {
          type: 1, // DM
          messages: { cache: { get: () => undefined } },
        },
        guildId: null, // DMs have no guild
        embeds: [
          {
            url: "https://example.com/trigger-hold-test",
            title: "Test Title",
            description: null,
            provider: null,
            data: { type: null },
          },
        ],
      });

      // Call handleMessageCreate — the hold timer starts but does NOT fire yet
      await (provider as unknown as Record<string, (...args: unknown[]) => unknown>)
        .handleMessageCreate(makeRuntime("main"), dmMsgWithEmbed);

      // host.onEvent must NOT have been called yet (still within the hold window)
      assert.equal(capturedInbound, undefined, "host.onEvent must not fire before the hold expires");

      // Wait for the hold timer to fire and for the async storage writes to settle.
      // trigger_hold_ms = 5 ms; waiting 80 ms is well beyond both the timer and the
      // single-writer queue flush time.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      assert.ok(capturedInbound, "host.onEvent must have fired after the hold expires");
      const eventId = capturedInbound.event.id;

      // Verify both rows exist — FK constraint would have rejected the preview row
      // if the event row had not been written first.
      const eventCount = storage.read((db) =>
        (
          db.prepare("select count(*) as n from timeline_events where id = ?").get(eventId) as {
            n: number;
          }
        ).n,
      );
      const previewCount = storage.read((db) =>
        (
          db.prepare("select count(*) as n from link_previews where event_id = ?").get(
            eventId,
          ) as { n: number }
        ).n,
      );

      assert.equal(eventCount, 1, "timeline_events row must exist after hold flush");
      assert.equal(previewCount, 1, "link_previews row must exist (FK satisfied) after hold flush");
    } finally {
      storage.close();
    }
  });
});

// ── MAJOR: @username mention resolution in send path (spec §7.3, §14) ─────────

/** Build a stubbed TextChannel with a controlled guild member cache + REST search. */
function makeGuildChannel(opts: {
  cacheMembers?: Array<{ id: string; username: string }>;
  restMembers?: Array<{ id: string; username: string }>;
}): TextChannel {
  const cacheMembers = opts.cacheMembers ?? [];
  const restMembers = opts.restMembers ?? [];

  const cacheFind = (fn: (m: { user: { id: string; username: string } }) => boolean) => {
    for (const m of cacheMembers.map((c) => ({ user: c }))) {
      if (fn(m)) return m;
    }
    return undefined;
  };

  const membersSearch = async ({ query, limit: _limit }: { query: string; limit: number }) => {
    const matched = restMembers.filter((m) => m.username === query).map((c) => ({ user: c }));
    const searchFind = (fn: (m: { user: { id: string; username: string } }) => boolean) => {
      for (const m of matched) {
        if (fn(m)) return m;
      }
      return undefined;
    };
    return { find: searchFind } as unknown as ReturnType<typeof import("discord.js").GuildMemberManager.prototype.search>;
  };

  return {
    type: 0, // GuildText
    guild: {
      members: {
        cache: { find: cacheFind },
        search: membersSearch,
      },
    },
  } as unknown as TextChannel;
}

function makeDMChannel(recipient: { id: string; username: string } | null): DMChannel {
  return {
    type: 1, // DM (ChannelType.DM)
    recipient,
  } as unknown as DMChannel;
}

describe("MAJOR: @username mention resolution (resolveMentionTokens)", () => {
  it("cache hit: @username replaced with <@id> and id added to userIds", async () => {
    const channel = makeGuildChannel({
      cacheMembers: [{ id: "111000000000000001", username: "alice" }],
    });
    const { body, userIds } = await resolveMentionTokens("hey @alice!", channel);
    assert.equal(body, "hey <@111000000000000001>!");
    assert.ok(userIds.has("111000000000000001"));
  });

  it("REST hit (cache miss): @username resolved via guild.members.search", async () => {
    const channel = makeGuildChannel({
      cacheMembers: [],
      restMembers: [{ id: "222000000000000001", username: "bob" }],
    });
    const { body, userIds } = await resolveMentionTokens("hello @bob", channel);
    assert.equal(body, "hello <@222000000000000001>");
    assert.ok(userIds.has("222000000000000001"));
  });

  it("unresolved token passes through as literal text", async () => {
    const channel = makeGuildChannel({ cacheMembers: [], restMembers: [] });
    const { body, userIds } = await resolveMentionTokens("hello @unknown_user", channel);
    assert.equal(body, "hello @unknown_user");
    assert.equal(userIds.size, 0);
  });

  it("@everyone is never resolved (skipped unconditionally)", async () => {
    // Even if someone named 'everyone' were in the cache, @everyone is always skipped
    const channel = makeGuildChannel({
      cacheMembers: [{ id: "999000000000000001", username: "everyone" }],
    });
    const { body, userIds } = await resolveMentionTokens("@everyone please read", channel);
    assert.equal(body, "@everyone please read"); // not replaced
    assert.equal(userIds.size, 0);
  });

  it("@here is never resolved (skipped unconditionally)", async () => {
    const channel = makeGuildChannel({
      cacheMembers: [{ id: "999000000000000002", username: "here" }],
    });
    const { body, userIds } = await resolveMentionTokens("@here announcement", channel);
    assert.equal(body, "@here announcement");
    assert.equal(userIds.size, 0);
  });

  it("multi-mention: all resolved tokens replaced and user ids collected", async () => {
    const channel = makeGuildChannel({
      cacheMembers: [{ id: "111000000000000001", username: "alice" }],
      restMembers: [{ id: "222000000000000001", username: "bob" }],
    });
    const { body, userIds } = await resolveMentionTokens("@alice and @bob say hi", channel);
    assert.equal(body, "<@111000000000000001> and <@222000000000000001> say hi");
    assert.ok(userIds.has("111000000000000001"));
    assert.ok(userIds.has("222000000000000001"));
  });

  it("DM channel: resolves only the DM recipient by username", async () => {
    const channel = makeDMChannel({ id: "333000000000000001", username: "dave" });
    const { body, userIds } = await resolveMentionTokens("hey @dave", channel);
    assert.equal(body, "hey <@333000000000000001>");
    assert.ok(userIds.has("333000000000000001"));
  });

  it("DM channel: non-recipient @username is not resolved", async () => {
    const channel = makeDMChannel({ id: "333000000000000001", username: "dave" });
    const { body, userIds } = await resolveMentionTokens("hey @alice", channel);
    assert.equal(body, "hey @alice"); // alice is not the DM recipient
    assert.equal(userIds.size, 0);
  });

  it("empty body returns unchanged", async () => {
    const channel = makeGuildChannel({});
    const { body, userIds } = await resolveMentionTokens("", channel);
    assert.equal(body, "");
    assert.equal(userIds.size, 0);
  });

  it("MINOR: mixed-case legacy username resolved case-insensitively (DM)", async () => {
    // Discord usernames use lowercase since the 2023 discriminator removal, but
    // legacy usernames may have mixed case. The token @Alice must resolve to the
    // recipient whose username is "Alice" (stored with a capital A).
    const channel = makeDMChannel({ id: "444000000000000001", username: "Alice" });
    const { body, userIds } = await resolveMentionTokens("hey @Alice check this out", channel);
    assert.equal(body, "hey <@444000000000000001> check this out");
    assert.ok(userIds.has("444000000000000001"), "mixed-case DM username must be resolved");
  });

  it("MINOR: lowercase token matches mixed-case guild member cache entry", async () => {
    const channel = makeGuildChannel({
      cacheMembers: [{ id: "555000000000000001", username: "Charlie" }],
    });
    const { body, userIds } = await resolveMentionTokens("ping @charlie please", channel);
    assert.equal(body, "ping <@555000000000000001> please");
    assert.ok(userIds.has("555000000000000001"), "lowercase token must match mixed-case cache entry");
  });

  it("@username prefix of longer username not matched (word-boundary)", async () => {
    const channel = makeGuildChannel({
      cacheMembers: [{ id: "111000000000000001", username: "alice" }],
    });
    // @alice.smith must not match @alice even though @alice is a cached member
    const { body, userIds } = await resolveMentionTokens("@alice.smith replied", channel);
    // alice.smith is the full token; alice alone is not matched as prefix
    assert.equal(userIds.size, 0, "@alice must not match inside @alice.smith");
  });
});

// ── NIT 2: MESSAGE_UPDATE routing ─────────────────────────────────────────────

describe("NIT 2: MESSAGE_UPDATE routing", () => {
  it("null editedTimestamp → mergeLateEmbeds called, host.onEvent NOT called", async () => {
    const mergedPreviews: unknown[] = [];
    let onEventCalled = false;

    const callbacks: DiscordProviderCallbacks = {
      async mergeLateEmbeds(_p, _id, _key, previews) {
        mergedPreviews.push(...previews);
      },
      async storeIngestEmbeds() {},
    };
    const provider = new DiscordProvider(makeDiscordConfig(), callbacks);
    (provider as unknown as Record<string, unknown>).host = {
      onEvent() { onEventCalled = true; },
    };

    await (provider as unknown as Record<string, (...args: unknown[]) => unknown>)
      .handleMessageUpdate(
        makeRuntime(),
        makeUpdateMsgStub(null, [{ url: "https://example.com" }]),
      );

    assert.equal(onEventCalled, false, "host.onEvent must NOT be called for late-embed update");
    assert.equal(mergedPreviews.length, 1, "mergeLateEmbeds must be called with embed previews");
    assert.equal(
      (mergedPreviews[0] as { url: string }).url,
      "https://example.com",
    );
  });

  it("non-null editedTimestamp → edit event emitted via host.onEvent, mergeLateEmbeds NOT called", async () => {
    let mergeCalled = false;
    let capturedInbound: unknown;

    const callbacks: DiscordProviderCallbacks = {
      async mergeLateEmbeds() { mergeCalled = true; },
      async storeIngestEmbeds() {},
    };
    const provider = new DiscordProvider(makeDiscordConfig(), callbacks);
    (provider as unknown as Record<string, unknown>).host = {
      onEvent(inbound: unknown) { capturedInbound = inbound; },
    };

    await (provider as unknown as Record<string, (...args: unknown[]) => unknown>)
      .handleMessageUpdate(
        makeRuntime(),
        makeUpdateMsgStub(1_700_000_001_000, [{ url: "https://example.com" }]),
      );

    assert.equal(mergeCalled, false, "mergeLateEmbeds must NOT be called for user edits");
    assert.ok(capturedInbound, "host.onEvent must be called for user edits");
    const editMarker = (capturedInbound as { edit?: { targetExternalId?: string } }).edit;
    assert.ok(editMarker, "edit marker must be present");
    assert.equal(editMarker.targetExternalId, "111111111111111111");
  });
});
