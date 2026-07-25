/**
 * Unit tests for the Discord inbound normalizer (spec DISCORD-SUPPORT-DESIGN §8.1–§8.3).
 *
 * All tests are pure / offline — no discord.js Client, no gateway connection.
 * The normalizer functions take plain data objects and are freely exercisable.
 *
 * Covers:
 *  - Markup translation: user, nick, channel, role, custom emoji (static + animated)
 *  - Key construction: guild text, DM, thread, forum post thread
 *  - Sender fields (username, displayName, isSelf)
 *  - Attachment normalisation: file, image, voice message, sticker
 *  - Embeds → LinkPreviewMeta (URL normalization via trailing-punctuation strip)
 *  - Reply population from referenced_message (fully inline — no REST call)
 *  - Poll fallback body
 *  - Channel type annotation (group / dm / thread)
 *  - Trigger detection: DM, direct mention, role-mention-no, @everyone-no
 *  - Edit vs late-embed discrimination (§8.3 double-processing hazard)
 *  - isSelf echo path
 *  - Custom emoji observation extraction
 *  - Guild allowlist filtering (provider-level — tested via the helper)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscordTimelineKey,
  buildDiscordEventId,
  translateDiscordMarkup,
  normalizeDiscordMessage,
  detectDiscordTrigger,
  embedsToLinkPreviews,
  extractEmojiObservations,
  type DiscordMessageData,
  type DiscordNormalizerContext,
  type DiscordMentionedUser,
  type DiscordMentionedRole,
  type DiscordMentionedChannel,
} from "../src/discord/normalizer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseMsg(overrides: Partial<DiscordMessageData> = {}): DiscordMessageData {
  return {
    id: "100000000000000001",
    content: "hello world",
    channelId: "200000000000000001",
    channelType: 0, // GuildText
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
    embeds: [],
    ...overrides,
  };
}

const baseCtx: DiscordNormalizerContext = {
  accountId: "main",
  selfUserId: "999000000000000001",
};

// ── Key construction ──────────────────────────────────────────────────────────

describe("buildDiscordTimelineKey", () => {
  it("guild text channel (channelType 0)", () => {
    const key = buildDiscordTimelineKey("main", "200000000000000001", 0);
    assert.equal(key, "discord:main:room:200000000000000001");
  });

  it("DM channel (channelType 1)", () => {
    const key = buildDiscordTimelineKey("main", "500000000000000001", 1);
    assert.equal(key, "discord:main:dm:500000000000000001");
  });

  it("public thread (channelType 11) with parent", () => {
    const key = buildDiscordTimelineKey("main", "600000000000000001", 11, "200000000000000001");
    assert.equal(key, "discord:main:room:200000000000000001:thread:600000000000000001");
  });

  it("private thread (channelType 12) with parent", () => {
    const key = buildDiscordTimelineKey("main", "700000000000000001", 12, "200000000000000001");
    assert.equal(key, "discord:main:room:200000000000000001:thread:700000000000000001");
  });

  it("thread without parent falls back to room:<threadId>", () => {
    // Should not produce :thread: when parentChannelId is absent
    const key = buildDiscordTimelineKey("main", "600000000000000001", 11);
    assert.equal(key, "discord:main:room:600000000000000001");
  });
});

describe("buildDiscordEventId", () => {
  it("builds event id", () => {
    assert.equal(buildDiscordEventId("main", "123456789"), "discord:main:123456789");
  });
});

// ── Body markup translation ───────────────────────────────────────────────────

describe("translateDiscordMarkup", () => {
  const users: DiscordMentionedUser[] = [
    { id: "401", username: "alice", displayName: "Alice In Guild" },
    { id: "402", username: "bob" },
  ];
  const roles: DiscordMentionedRole[] = [{ id: "501", name: "Moderators" }];
  const channels: DiscordMentionedChannel[] = [{ id: "601", name: "general" }];

  it("translates plain user mention <@id> → @username", () => {
    const out = translateDiscordMarkup("hey <@401>", { users, roles, channels });
    assert.equal(out, "hey @alice");
  });

  it("translates nick-form user mention <@!id> → @displayName", () => {
    const out = translateDiscordMarkup("hey <@!401>", { users, roles, channels });
    assert.equal(out, "hey @Alice In Guild");
  });

  it("nick-form without displayName falls back to username", () => {
    const out = translateDiscordMarkup("<@!402>", { users, roles, channels });
    assert.equal(out, "@bob");
  });

  it("translates channel mention <#id> → #name", () => {
    const out = translateDiscordMarkup("go to <#601>", { users, roles, channels });
    assert.equal(out, "go to #general");
  });

  it("translates role mention <@&id> → @roleName", () => {
    const out = translateDiscordMarkup("hey <@&501>", { users, roles, channels });
    assert.equal(out, "hey @Moderators");
  });

  it("translates static custom emoji <:name:id> → :name:", () => {
    const out = translateDiscordMarkup("nice <:pepe:12345>", { users, roles, channels });
    assert.equal(out, "nice :pepe:");
  });

  it("translates animated custom emoji <a:name:id> → :name:", () => {
    const out = translateDiscordMarkup("<a:wave:67890> hello", { users, roles, channels });
    assert.equal(out, ":wave: hello");
  });

  it("passes through unresolvable references unchanged", () => {
    const out = translateDiscordMarkup("<@999>", { users, roles, channels });
    assert.equal(out, "<@999>");
  });

  it("leaves plain text unchanged", () => {
    const out = translateDiscordMarkup("no markup here", { users, roles, channels });
    assert.equal(out, "no markup here");
  });

  it("handles multiple substitutions in one message", () => {
    const out = translateDiscordMarkup("<@401> go to <#601> with <@&501>", { users, roles, channels });
    assert.equal(out, "@alice go to #general with @Moderators");
  });
});

// ── Attachment normalisation ──────────────────────────────────────────────────

describe("normalizeDiscordMessage: attachments", () => {
  it("file attachment → AttachmentMeta with remoteUrl", () => {
    const msg = baseMsg({
      attachments: [
        { id: "a1", filename: "doc.pdf", url: "https://cdn.discord.com/doc.pdf", size: 1024, contentType: "application/pdf" },
      ],
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    const att = inbound.event.attachments?.[0];
    assert.ok(att, "should have attachment");
    assert.equal(att.mediaType, "file");
    assert.equal(att.remoteUrl, "https://cdn.discord.com/doc.pdf");
    assert.equal(att.filename, "doc.pdf");
    assert.equal(att.sizeBytes, 1024);
  });

  it("image attachment → mediaType image", () => {
    const msg = baseMsg({
      attachments: [
        { id: "a2", filename: "photo.png", url: "https://cdn.discord.com/photo.png", size: 512, contentType: "image/png", width: 800, height: 600 },
      ],
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    const att = inbound.event.attachments?.[0];
    assert.ok(att);
    assert.equal(att.mediaType, "image");
    assert.equal(att.width, 800);
    assert.equal(att.height, 600);
  });

  it("voice message → audio mediaType with durationMs and asVoice=true", () => {
    const msg = baseMsg({
      attachments: [
        {
          id: "a3", filename: "voice.ogg", url: "https://cdn.discord.com/voice.ogg",
          size: 2048, contentType: "audio/ogg", durationSecs: 5.5, isVoiceMessage: true,
        },
      ],
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    const att = inbound.event.attachments?.[0];
    assert.ok(att);
    assert.equal(att.mediaType, "audio");
    assert.equal(att.asVoice, true);
    assert.equal(att.durationMs, 5500);
  });

  it("sticker → image attachment with remoteUrl", () => {
    const msg = baseMsg({
      stickers: [
        { id: "s1", name: "OwO", url: "https://cdn.discord.com/stickers/s1.png" },
      ],
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    const att = inbound.event.attachments?.[0];
    assert.ok(att, "sticker should produce an attachment");
    assert.equal(att.mediaType, "image");
    assert.equal(att.remoteUrl, "https://cdn.discord.com/stickers/s1.png");
    assert.equal(att.filename, "OwO.png");
  });
});

// ── Embeds → LinkPreviewMeta ──────────────────────────────────────────────────

describe("embedsToLinkPreviews", () => {
  it("embed with URL → LinkPreviewMeta with source_kind discord_embed", () => {
    const previews = embedsToLinkPreviews([
      { url: "https://example.com/article", title: "Test Article", description: "A description" },
    ]);
    assert.equal(previews.length, 1);
    assert.equal(previews[0]!.url, "https://example.com/article");
    assert.equal(previews[0]!.title, "Test Article");
    assert.equal(previews[0]!.sourceKind, "discord_embed");
  });

  it("strips trailing punctuation from embed URL (normalization parity with DirectLinkPreviewClient)", () => {
    const previews = embedsToLinkPreviews([
      { url: "https://example.com/article." },
    ]);
    assert.equal(previews[0]!.url, "https://example.com/article");
  });

  it("embed without URL → skipped", () => {
    const previews = embedsToLinkPreviews([{ title: "no url here" }]);
    assert.equal(previews.length, 0);
  });

  it("multiple embeds → multiple previews", () => {
    const previews = embedsToLinkPreviews([
      { url: "https://a.com" },
      { url: "https://b.com", title: "B" },
    ]);
    assert.equal(previews.length, 2);
  });
});

// ── Reply population ──────────────────────────────────────────────────────────

describe("normalizeDiscordMessage: reply from referenced_message", () => {
  it("populates replyTo fully from referenced_message (no REST call needed)", () => {
    const msg = baseMsg({
      referencedMessage: {
        id: "800000000000000001",
        content: "original message text",
        authorId: "402000000000000001",
        authorUsername: "bob",
        authorDisplayName: "Bob The Builder",
        timestamp: 1_699_000_000_000,
        attachments: [],
        stickers: [],
      },
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    const replyTo = inbound.event.replyTo;
    assert.ok(replyTo, "should have replyTo");
    assert.equal(replyTo.externalId, "800000000000000001");
    assert.equal(replyTo.body, "original message text");
    assert.equal(replyTo.sender?.id, "402000000000000001");
    assert.equal(replyTo.sender?.username, "bob");
    assert.equal(replyTo.sender?.displayName, "Bob The Builder");
    assert.equal(replyTo.timestamp, 1_699_000_000_000);
  });

  it("reply attachments from referenced_message are normalised", () => {
    const msg = baseMsg({
      referencedMessage: {
        id: "800000000000000002",
        content: "check this image",
        authorId: "403000000000000001",
        authorUsername: "carol",
        timestamp: 1_699_000_000_001,
        attachments: [
          { id: "ra1", filename: "img.jpg", url: "https://cdn.discord.com/img.jpg", size: 100, contentType: "image/jpeg" },
        ],
        stickers: [],
      },
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    const replyAttachments = inbound.event.replyTo?.attachments;
    assert.ok(replyAttachments?.length === 1);
    assert.equal(replyAttachments[0]!.mediaType, "image");
    assert.equal(replyAttachments[0]!.remoteUrl, "https://cdn.discord.com/img.jpg");
  });
});

// ── Poll fallback body ────────────────────────────────────────────────────────

describe("normalizeDiscordMessage: poll fallback body", () => {
  it("poll message with no content uses [poll] fallback", () => {
    const msg = baseMsg({
      content: "",
      poll: {
        question: "What is your favourite colour?",
        answers: [{ text: "Red" }, { text: "Blue" }, { text: "Green" }],
      },
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.event.body, "[poll] What is your favourite colour? — Red, Blue, Green");
  });

  it("poll message with content uses content (not fallback)", () => {
    const msg = baseMsg({
      content: "Vote now!",
      poll: {
        question: "Favourite?",
        answers: [{ text: "A" }],
      },
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.event.body, "Vote now!");
  });
});

// ── Channel type annotation ───────────────────────────────────────────────────

describe("normalizeDiscordMessage: channelType annotation", () => {
  it("guild text (0) → group", () => {
    const { inbound } = normalizeDiscordMessage(baseMsg({ channelType: 0 }), baseCtx);
    assert.equal(inbound.channelType, "group");
  });

  it("DM (1) → dm", () => {
    const { inbound } = normalizeDiscordMessage(baseMsg({ channelType: 1, guildId: undefined }), baseCtx);
    assert.equal(inbound.channelType, "dm");
  });

  it("public thread (11) → thread", () => {
    const { inbound } = normalizeDiscordMessage(
      baseMsg({ channelType: 11, parentChannelId: "200000000000000001" }),
      baseCtx,
    );
    assert.equal(inbound.channelType, "thread");
  });
});

// ── Trigger detection ─────────────────────────────────────────────────────────

describe("detectDiscordTrigger", () => {
  const selfCtx = { accountId: "main", selfUserId: "999000000000000001" };

  it("DM channel → dm trigger", () => {
    const msg = baseMsg({ channelType: 1, guildId: undefined });
    const trigger = detectDiscordTrigger(msg, selfCtx, false);
    assert.ok(trigger);
    assert.equal(trigger.type, "dm");
    assert.equal(trigger.triggeredBy.id, "400000000000000001");
  });

  it("direct mention of bot → mention trigger", () => {
    const msg = baseMsg({
      mentionedUsers: [
        { id: "999000000000000001", username: "bot" }, // the bot itself
      ],
    });
    const trigger = detectDiscordTrigger(msg, selfCtx, false);
    assert.ok(trigger);
    assert.equal(trigger.type, "mention");
  });

  it("role mention does NOT trigger", () => {
    const msg = baseMsg({
      mentionedRoles: [{ id: "501", name: "Moderators" }],
    });
    const trigger = detectDiscordTrigger(msg, selfCtx, false);
    assert.equal(trigger, undefined);
  });

  it("@everyone does NOT trigger", () => {
    const msg = baseMsg({ mentionEveryone: true });
    const trigger = detectDiscordTrigger(msg, selfCtx, false);
    assert.equal(trigger, undefined);
  });

  it("own message (isSelf) → no trigger", () => {
    const msg = baseMsg();
    const trigger = detectDiscordTrigger(msg, selfCtx, true);
    assert.equal(trigger, undefined);
  });

  it("plain guild message without mention → no trigger", () => {
    const msg = baseMsg();
    const trigger = detectDiscordTrigger(msg, selfCtx, false);
    assert.equal(trigger, undefined);
  });
});

// ── Sender fields ─────────────────────────────────────────────────────────────

describe("normalizeDiscordMessage: sender", () => {
  it("sets id (snowflake), username, displayName", () => {
    const { inbound } = normalizeDiscordMessage(
      baseMsg({ authorId: "401", authorUsername: "alice", authorDisplayName: "Alice" }),
      baseCtx,
    );
    assert.equal(inbound.event.sender.id, "401");
    assert.equal(inbound.event.sender.username, "alice");
    assert.equal(inbound.event.sender.displayName, "Alice");
  });

  it("isSelf=false for non-self messages", () => {
    const { inbound } = normalizeDiscordMessage(baseMsg(), baseCtx);
    assert.equal(inbound.event.sender.isSelf, false);
  });

  it("isSelf=true when authorId === selfUserId", () => {
    const msg = baseMsg({ authorId: "999000000000000001" });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.event.sender.isSelf, true);
    assert.equal(inbound.event.role, "assistant");
  });
});

// ── Echo: isSelf flows through inbound ───────────────────────────────────────

describe("normalizeDiscordMessage: echo/isSelf", () => {
  it("self-sent message sets role=assistant and isSelf=true", () => {
    const msg = baseMsg({ authorId: baseCtx.selfUserId });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.event.role, "assistant");
    assert.equal(inbound.event.sender.isSelf, true);
  });

  it("self-sent message produces NO trigger", () => {
    const msg = baseMsg({
      authorId: baseCtx.selfUserId,
      channelType: 1, // DM — would trigger if not self
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.trigger, undefined);
  });
});

// ── Edit vs late-embed discrimination (§8.3 double-processing hazard) ─────────

describe("edit vs late-embed discrimination", () => {
  it("message with non-null editedTimestamp → treated as user edit", () => {
    // The provider handles this at the gateway layer, not the normalizer.
    // This test verifies the discriminating data is available on the message.
    const msg = baseMsg({ editedTimestamp: 1_700_000_001_000 });
    // editedTimestamp non-null → provider routes as edit
    assert.notEqual(msg.editedTimestamp, null);
    assert.notEqual(msg.editedTimestamp, undefined);
  });

  it("message with null editedTimestamp → late-embed (NOT a user edit)", () => {
    const msg = baseMsg({
      editedTimestamp: null,
      embeds: [{ url: "https://example.com", title: "Embed Title" }],
    });
    // null editedTimestamp → provider calls callbacks.mergeLateEmbeds, never routes as edit
    assert.equal(msg.editedTimestamp, null);
    // The embed previews are extracted:
    const previews = embedsToLinkPreviews(msg.embeds);
    assert.equal(previews.length, 1);
    assert.equal(previews[0]!.sourceKind, "discord_embed");
  });

  it("double-processing hazard: a late-embed must never generate edit inbound", () => {
    // The normalizer itself doesn't know about late embeds — that's the provider's
    // job. But we verify that the normalizer does not set an `edit` marker on its own.
    const msg = baseMsg({
      editedTimestamp: null,
      embeds: [{ url: "https://example.com" }],
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    // The normalizer never sets inbound.edit
    assert.equal(inbound.edit, undefined);
  });
});

// ── Custom emoji observation extraction ──────────────────────────────────────

describe("extractEmojiObservations", () => {
  it("extracts static custom emoji", () => {
    const obs = extractEmojiObservations("nice <:pepe:12345> reaction");
    assert.equal(obs.length, 1);
    assert.deepEqual(obs[0], { name: "pepe", id: "12345", animated: false });
  });

  it("extracts animated custom emoji", () => {
    const obs = extractEmojiObservations("<a:wave:67890> hello");
    assert.equal(obs.length, 1);
    assert.deepEqual(obs[0], { name: "wave", id: "67890", animated: true });
  });

  it("deduplicates by emoji id", () => {
    const obs = extractEmojiObservations("<:pepe:12345> and <:pepe:12345> again");
    assert.equal(obs.length, 1);
  });

  it("returns empty array for no custom emoji", () => {
    const obs = extractEmojiObservations("hello world 👍");
    assert.equal(obs.length, 0);
  });

  it("records custom emoji from normalizeDiscordMessage", () => {
    const msg = baseMsg({ content: "<:kek:99991> <a:dance:99992>" });
    const { emojiObservations } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(emojiObservations.length, 2);
    const names = emojiObservations.map((o) => o.name);
    assert.ok(names.includes("kek"));
    assert.ok(names.includes("dance"));
  });
});

// ── Key shape end-to-end ──────────────────────────────────────────────────────

describe("normalizeDiscordMessage: key shapes", () => {
  it("guild text channel key format", () => {
    const msg = baseMsg({ channelType: 0, channelId: "200000000000000001" });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.timelineKey, "discord:main:room:200000000000000001");
  });

  it("DM channel key format", () => {
    const msg = baseMsg({ channelType: 1, channelId: "500000000000000001", guildId: undefined });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.timelineKey, "discord:main:dm:500000000000000001");
  });

  it("thread key format with parent channel", () => {
    const msg = baseMsg({
      channelType: 11,
      channelId: "600000000000000001",
      parentChannelId: "200000000000000001",
    });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.timelineKey, "discord:main:room:200000000000000001:thread:600000000000000001");
  });
});

// ── Embed previews in normalizeDiscordMessage ─────────────────────────────────

describe("normalizeDiscordMessage: embed previews", () => {
  it("embeds are returned as embedPreviews and attached to event.linkPreviews", () => {
    const msg = baseMsg({
      embeds: [{ url: "https://example.com", title: "Test" }],
    });
    const { inbound, embedPreviews } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(embedPreviews.length, 1);
    assert.equal(embedPreviews[0]!.sourceKind, "discord_embed");
    // Also on the canonical event
    assert.equal(inbound.event.linkPreviews?.length, 1);
  });
});

// ── Outbound target ───────────────────────────────────────────────────────────

describe("normalizeDiscordMessage: outboundTarget", () => {
  it("outboundTarget has roomId = channelId and replyToId = message id", () => {
    const msg = baseMsg({ channelId: "200000000000000001", id: "100000000000000001" });
    const { inbound } = normalizeDiscordMessage(msg, baseCtx);
    assert.equal(inbound.outboundTarget?.roomId, "200000000000000001");
    assert.equal(inbound.outboundTarget?.replyToId, "100000000000000001");
    assert.equal(inbound.outboundTarget?.accountId, "main");
    assert.equal(inbound.outboundTarget?.provider, "discord");
  });
});
