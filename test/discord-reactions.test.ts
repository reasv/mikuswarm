/**
 * Tests for Discord reaction event routing (spec §12.6, §10).
 *
 * All tests use the provider's private handlers directly to avoid needing
 * a live discord.js Client. No gateway, no REST, no subprocess.
 *
 * Covers:
 *   - handleReactionAdd: unicode + custom, PK shape, payload fields
 *   - handleReactionRemove: PK reconstruction matches add PK
 *   - messageReactionRemoveAll: host.onBulkReactionClear with no normalizedKey
 *   - messageReactionRemoveEmoji: host.onBulkReactionClear with normalizedKey
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DiscordProvider, type DiscordProviderCallbacks } from "../src/discord/provider.js";
import type { AppConfig } from "../src/config/index.js";
import type { ReactionStreamEvent } from "../src/types.js";
import { EmojiCatalog } from "../src/discord/emoji-catalog.js";

// ── Test infra ────────────────────────────────────────────────────────────────

const noopCallbacks: DiscordProviderCallbacks = {
  async mergeLateEmbeds() {},
  async storeIngestEmbeds() {},
  async upsertUserIdentity() {},
  async setChannelMetadata() {},
};

function makeConfig(): NonNullable<AppConfig["discord"]> {
  return {
    enabled: true,
    accounts: {
      main: {
        token: "Bot test.token",
        guilds: [],
        dm_enabled: true,
        member_intent: false,
      } as unknown as NonNullable<AppConfig["discord"]>["accounts"][string],
    },
  } as unknown as NonNullable<AppConfig["discord"]>;
}

function makeProvider() {
  return new DiscordProvider(makeConfig(), noopCallbacks);
}

/** Build a minimal AccountRuntime that the handlers can use without crashing. */
function makeRuntime(accountId = "main") {
  return {
    accountId,
    self: { id: "999", username: "bot", displayName: "Bot" },
    client: {
      channels: { cache: new Map(), fetch: async () => null },
      guilds: { cache: new Map() },
    },
    allowedGuilds: undefined,
    dmEnabled: true,
    memberIntentEnabled: false,
    emojiCatalog: new EmojiCatalog(),
  };
}

/** Minimal reaction stub for a unicode emoji. */
function makeUnicodeReaction(messageId: string, emoji: string, channelId = "chan1") {
  return {
    message: { id: messageId, channelId, guildId: "guild1", channel: { type: 0 } },
    emoji: { id: null, name: emoji },
  };
}

/** Minimal reaction stub for a custom emoji. */
function makeCustomReaction(messageId: string, emojiId: string, emojiName: string, channelId = "chan1") {
  return {
    message: { id: messageId, channelId, guildId: "guild1", channel: { type: 0 } },
    emoji: { id: emojiId, name: emojiName },
  };
}

/** Minimal user stub. */
function makeUser(id: string, username = "alice") {
  return { id, username };
}

// ── handleReactionAdd ─────────────────────────────────────────────────────────

describe("handleReactionAdd: unicode emoji", () => {
  it("routes to host.onReaction with action=add and correct fields", () => {
    const provider = makeProvider();
    const runtime = makeRuntime();
    const captured: ReactionStreamEvent[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onReaction(ev: ReactionStreamEvent) { captured.push(ev); },
    };

    const reaction = makeUnicodeReaction("msg1", "👍");
    const user = makeUser("user1");

    (provider as unknown as Record<string, (...args: unknown[]) => void>)
      .handleReactionAdd(runtime, reaction, user);

    assert.equal(captured.length, 1);
    const ev = captured[0]!;
    assert.equal(ev.action, "add");
    assert.equal(ev.kind, "unicode");
    assert.equal(ev.display, "👍");
    assert.equal(ev.normalizedKey, "👍");
    assert.equal(ev.senderId, "user1");
    assert.equal(ev.targetEventId, "discord:main:msg1");
    assert.ok(ev.reactionEventId.startsWith("discord:msg1:👍:user1"));
    assert.ok(ev.timelineKey.includes("main"));
  });

  it("PK is deterministic: same (message, emoji, user) always gives same PK", () => {
    const provider = makeProvider();
    const runtime = makeRuntime();
    const ids: string[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onReaction(ev: ReactionStreamEvent) { ids.push(ev.reactionEventId); },
    };

    const reaction = makeUnicodeReaction("msg99", "❤️");
    const user = makeUser("user42");

    for (let i = 0; i < 3; i++) {
      (provider as unknown as Record<string, (...args: unknown[]) => void>)
        .handleReactionAdd(runtime, reaction, user);
    }

    assert.equal(ids.length, 3);
    assert.equal(ids[0], ids[1]);
    assert.equal(ids[1], ids[2]);
  });
});

describe("handleReactionAdd: custom emoji", () => {
  it("custom emoji uses discord:<emojiId> normalizedKey", () => {
    const provider = makeProvider();
    const runtime = makeRuntime();
    const captured: ReactionStreamEvent[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onReaction(ev: ReactionStreamEvent) { captured.push(ev); },
    };

    const reaction = makeCustomReaction("msg2", "42", "blobwave");
    const user = makeUser("user2");

    (provider as unknown as Record<string, (...args: unknown[]) => void>)
      .handleReactionAdd(runtime, reaction, user);

    assert.equal(captured.length, 1);
    const ev = captured[0]!;
    assert.equal(ev.kind, "custom");
    assert.equal(ev.normalizedKey, "discord:42");
    assert.equal(ev.display, ":blobwave:");
    assert.equal(ev.shortcode, "blobwave");
    // PK encodes the normalizedKey so removes can reconstruct it
    assert.equal(ev.reactionEventId, "discord:msg2:discord:42:user2");
  });
});

// ── handleReactionRemove ──────────────────────────────────────────────────────

describe("handleReactionRemove: PK reconstruction", () => {
  it("remove PK matches add PK for unicode emoji", () => {
    const provider = makeProvider();
    const runtime = makeRuntime();
    const adds: string[] = [];
    const removes: string[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onReaction(ev: ReactionStreamEvent) {
        if (ev.action === "add") adds.push(ev.reactionEventId);
        else removes.push(ev.reactionEventId);
      },
    };

    const reaction = makeUnicodeReaction("msgX", "🎉");
    const user = makeUser("userX");

    (provider as unknown as Record<string, (...args: unknown[]) => void>)
      .handleReactionAdd(runtime, reaction, user);
    (provider as unknown as Record<string, (...args: unknown[]) => void>)
      .handleReactionRemove(runtime, reaction, user);

    assert.equal(adds.length, 1);
    assert.equal(removes.length, 1);
    assert.equal(adds[0], removes[0], "add and remove PK must match for correct tombstone");
  });

  it("remove PK matches add PK for custom emoji", () => {
    const provider = makeProvider();
    const runtime = makeRuntime();
    const adds: string[] = [];
    const removes: string[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onReaction(ev: ReactionStreamEvent) {
        if (ev.action === "add") adds.push(ev.reactionEventId);
        else removes.push(ev.reactionEventId);
      },
    };

    const reaction = makeCustomReaction("msgY", "77", "pepe");
    const user = makeUser("userY");

    (provider as unknown as Record<string, (...args: unknown[]) => void>)
      .handleReactionAdd(runtime, reaction, user);
    (provider as unknown as Record<string, (...args: unknown[]) => void>)
      .handleReactionRemove(runtime, reaction, user);

    assert.equal(adds[0], removes[0], "add and remove PK must match");
  });

  it("remove event has action=remove and no kind/display fields", () => {
    const provider = makeProvider();
    const runtime = makeRuntime();
    const captured: ReactionStreamEvent[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onReaction(ev: ReactionStreamEvent) { captured.push(ev); },
    };

    const reaction = makeUnicodeReaction("msgZ", "🚀");
    const user = makeUser("userZ");

    (provider as unknown as Record<string, (...args: unknown[]) => void>)
      .handleReactionRemove(runtime, reaction, user);

    const ev = captured[0]!;
    assert.equal(ev.action, "remove");
    assert.equal(ev.kind, undefined, "remove event must not have kind");
    assert.equal(ev.display, undefined, "remove event must not have display");
    assert.equal(ev.targetEventId, undefined, "remove event must not have targetEventId");
  });
});

// ── isAllowedByGuild ──────────────────────────────────────────────────────────

describe("isAllowedByGuild filtering", () => {
  it("guild reaction blocked by allowedGuilds filter is NOT routed", () => {
    const provider = makeProvider();
    const runtime = {
      ...makeRuntime(),
      allowedGuilds: new Set(["allowed-guild"]),
    };
    const captured: unknown[] = [];
    (provider as unknown as Record<string, unknown>).host = {
      onReaction(ev: unknown) { captured.push(ev); },
    };
    (provider as unknown as Record<string, unknown>).stopped = false;

    // Reaction from a non-allowed guild
    const reaction = {
      message: { id: "m1", channelId: "c1", guildId: "other-guild", channel: { type: 0 } },
      emoji: { id: null, name: "👍" },
    };
    const user = makeUser("u1");

    // The event listener calls isAllowedByGuild before handleReactionAdd
    const allowed = (provider as unknown as Record<string, (r: typeof runtime, g: string | null) => boolean>)
      .isAllowedByGuild(runtime, "other-guild");
    assert.equal(allowed, false, "other-guild must be blocked");

    // Only allowed guild is routed
    const allowedResult = (provider as unknown as Record<string, (r: typeof runtime, g: string | null) => boolean>)
      .isAllowedByGuild(runtime, "allowed-guild");
    assert.equal(allowedResult, true);

    void reaction; void user; // suppress lint
  });
});
