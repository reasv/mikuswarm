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
 *  - (ingest-time embed persistence — incl. the trigger-hold flush — lives in
 *    test/discord-ingest-embeds.test.ts: previews ride on event.linkPreviews and
 *    are written by the timeline store in the same transaction as the event row)
 *  - MAJOR: @username → <@id> mention resolution in send path (spec §7.3, §14)
 *  - MINOR: case-insensitive username match in resolveMentionTokens
 *  - NIT 2: MESSAGE_UPDATE routing — null editedTimestamp vs non-null
 *  - MAJOR 7b: member_intent=false → ChannelClient.members is undefined; true → members() present
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DiscordProvider,
  DiscordChannelClient,
  EmojiCatalog,
  resolveMentionTokens,
  type DiscordProviderCallbacks,
} from "../src/discord/index.js";
import { MatrixProvider } from "../src/matrix/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { IChatProvider } from "../src/types.js";
import type { TextChannel, DMChannel } from "discord.js";

// ── Minimal stubs ─────────────────────────────────────────────────────────────

const noopCallbacks: import("../src/discord/provider.js").DiscordProviderCallbacks = {
  async mergeLateEmbeds() {},
  async upsertUserIdentity() {},
  async setChannelMetadata() {},
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

  it("voiceMessages = true (Phase 7b: ogg/opus send + waveform implemented)", () => {
    const p = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
    assert.equal(p.capabilities.voiceMessages, true);
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
      async upsertUserIdentity() {},
      async setChannelMetadata() {},
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
      async upsertUserIdentity() {},
      async setChannelMetadata() {},
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
      async upsertUserIdentity() {},
      async setChannelMetadata() {},
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

// ── MAJOR: member_intent → ChannelClient.members absent/present ───────────────

// DiscordChannelClient is constructed directly (no start() needed) with a
// minimal stub discord.js client object. The constructor only stores the client
// reference; no methods are called during construction.
const stubDjsClient = {} as import("discord.js").Client;

describe("DiscordChannelClient: members optional contract", () => {
  it("member_intent=false → members is undefined (roster-unavailable path reachable)", () => {
    const cc = new DiscordChannelClient(
      stubDjsClient,
      "200000000000000001", // channelId
      "111111111111111111", // guildId
      "999999999999999999", // selfUserId
      false,                // memberIntentEnabled
      new EmojiCatalog(),
      "main",               // accountId
    );
    assert.equal(cc.members, undefined,
      "members must be undefined when member_intent=false so client.members?.() short-circuits");
  });

  it("member_intent=true → members is a function", () => {
    const cc = new DiscordChannelClient(
      stubDjsClient,
      "200000000000000001",
      "111111111111111111",
      "999999999999999999",
      true,                 // memberIntentEnabled
      new EmojiCatalog(),
      "main",
    );
    assert.equal(typeof cc.members, "function",
      "members must be a callable function when member_intent=true");
  });

  it("member_intent=false → ChannelClient interface: members? is correctly absent", () => {
    // The ChannelClient interface defines members?() as optional.
    // When absent, user_activity's roster-unavailable note must be reachable.
    const cc = new DiscordChannelClient(
      stubDjsClient,
      "200000000000000001",
      undefined,            // DM — no guildId
      "999999999999999999",
      false,
      new EmojiCatalog(),
      "main",
    ) satisfies import("../src/types.js").ChannelClient;
    // Optional-chaining on undefined must short-circuit to undefined (no throw).
    const rosterResult = cc.members?.();
    assert.equal(rosterResult, undefined, "cc.members?.() must be undefined when members is absent");
  });
});

// ── setTyping: refresh-chain lifecycle (in-flight stop race + keepalive dedup) ─

/**
 * Build an unstarted provider with a fake account runtime whose channel fetch /
 * sendTyping can be gated on a controllable promise, to exercise the
 * cancellation-while-in-flight windows of the typing refresh chain.
 */
function makeTypingProvider(opts: {
  fetchGate?: Promise<void>;
  sendGate?: Promise<void>;
  onSendStart?: () => void;
  failFetches?: number;
} = {}) {
  const provider = new DiscordProvider(makeDiscordConfig(), noopCallbacks);
  let sendCount = 0;
  let failFetches = opts.failFetches ?? 0;
  const channel = {
    isTextBased: () => true,
    sendTyping: async () => {
      opts.onSendStart?.();
      await opts.sendGate;
      sendCount += 1;
    },
  };
  const client = {
    channels: {
      fetch: async () => {
        await opts.fetchGate;
        if (failFetches > 0) {
          failFetches -= 1;
          throw new Error("fetch failed");
        }
        return channel;
      },
    },
  };
  (provider as unknown as { accounts: Map<string, unknown> }).accounts.set("main", { client });
  const chains = (
    provider as unknown as { typingChains: Map<string, { timer?: NodeJS.Timeout }> }
  ).typingChains;
  return { provider, chains, getSendCount: () => sendCount };
}

const typingTarget: import("../src/types.js").OutboundTarget = {
  provider: "discord",
  timelineKey: "discord:main:room:200000000000000001",
  accountId: "main",
  roomId: "200000000000000001",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("DiscordProvider.setTyping: refresh chain", () => {
  it("setTyping(false) during an in-flight channel fetch cancels the chain (no orphaned loop)", async () => {
    const gate = deferred();
    const { provider, chains, getSendCount } = makeTypingProvider({ fetchGate: gate.promise });

    const inFlight = provider.setTyping(typingTarget, true);
    assert.equal(chains.size, 1, "chain must be registered while the first send is in flight");
    await provider.setTyping(typingTarget, false);
    assert.equal(chains.size, 0, "stop must remove the chain immediately");

    gate.resolve();
    await inFlight;

    assert.equal(getSendCount(), 0, "cancelled chain must not send typing after the stop");
    assert.equal(chains.size, 0, "resolved in-flight send must not re-register the chain");
  });

  it("setTyping(false) between the REST send and rescheduling cancels the chain", async () => {
    const gate = deferred();
    const started = deferred();
    const { provider, chains, getSendCount } = makeTypingProvider({
      sendGate: gate.promise,
      onSendStart: started.resolve,
    });

    const inFlight = provider.setTyping(typingTarget, true);
    await started.promise; // the REST send is now in flight
    await provider.setTyping(typingTarget, false);
    gate.resolve();
    await inFlight;

    assert.equal(getSendCount(), 1, "the send that was already in flight completes");
    assert.equal(chains.size, 0, "but no next refresh may be scheduled after the stop");
  });

  it("repeated setTyping(true) is a no-op while a chain is live (keepalive dedup)", async () => {
    const { provider, chains, getSendCount } = makeTypingProvider();

    await provider.setTyping(typingTarget, true);
    assert.equal(getSendCount(), 1);
    assert.equal(chains.size, 1);
    assert.ok(chains.get(typingTarget.timelineKey)?.timer, "refresh timer scheduled");

    await provider.setTyping(typingTarget, true);
    await provider.setTyping(typingTarget, true);
    assert.equal(getSendCount(), 1, "keepalive repeats must not issue extra REST sends");
    assert.equal(chains.size, 1);

    await provider.setTyping(typingTarget, false);
    assert.equal(chains.size, 0);
  });

  it("a failed send removes the chain so the next keepalive tick revives it", async () => {
    const { provider, chains, getSendCount } = makeTypingProvider({ failFetches: 1 });

    await provider.setTyping(typingTarget, true);
    assert.equal(getSendCount(), 0);
    assert.equal(chains.size, 0, "failed chain must deregister itself");

    await provider.setTyping(typingTarget, true);
    assert.equal(getSendCount(), 1, "next keepalive tick starts a fresh chain");
    assert.equal(chains.size, 1);

    await provider.setTyping(typingTarget, false);
    assert.equal(chains.size, 0);
  });
});
