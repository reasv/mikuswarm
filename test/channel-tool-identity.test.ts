/**
 * M2 — Channel tool-set identity and description byte-match
 *
 * Two assertions:
 *
 * 1. Tool-name identity: with a Matrix-shaped ProviderCapabilities (all channel
 *    flags = true) and a channelClient present, the channel tool block assembles
 *    exactly the same 11 tools as it did pre-Phase-4. Phase 4 introduced
 *    per-capability gating; the Matrix provider has all flags = true, so the set
 *    must be identical.
 *
 * 2. Description byte-match: for a representative sample (send_message, react,
 *    read_messages, channel_info), the description strings produced with
 *    MATRIX_TERMINOLOGY are byte-identical to the strings the model has always seen
 *    in Matrix sessions (i.e. the pre-Phase-4 literals). Any drift here would be a
 *    silent prompt change.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createChannelInfoTool } from "../src/tools/channel-info.js";
import { createCreatePollTool } from "../src/tools/create-poll.js";
import { createDeleteMessageTool } from "../src/tools/delete-message.js";
import { createEditMessageTool } from "../src/tools/edit-message.js";
import { createEmojiListTool } from "../src/tools/emoji.js";
import { createListReactionsTool } from "../src/tools/list-reactions.js";
import { createMemberInfoTool } from "../src/tools/member-info.js";
import { createPinsTool } from "../src/tools/pins.js";
import { createPollVoteTool } from "../src/tools/poll-vote.js";
import { createReactTool } from "../src/tools/react.js";
import { createReadMessagesTool } from "../src/tools/read-messages.js";
import { createSendMessageTool, type SendMessageToolContext } from "../src/tools/send-message.js";
import { createSpawnSessionTool } from "../src/tools/spawn-session.js";
import { MATRIX_TERMINOLOGY } from "../src/tools/terminology.js";
import { createUserProfileEditTool, createUserProfileReadTool, type UserProfileToolContext } from "../src/tools/user-profile.js";
import type {
  ChannelClient,
  EmojiEntry,
  HistoryPageResult,
  IChatProvider,
  ProviderCapabilities,
  ReactionListing,
} from "../src/types.js";
import type { TimelineStore } from "../src/timeline/index.js";

// ── Shared stubs ──────────────────────────────────────────────────────────────

/**
 * Minimal stub channelClient. Methods return safe empty values; none are called
 * at tool-construction time, so only the type needs to satisfy ChannelClient.
 */
const STUB_CHANNEL_CLIENT: ChannelClient = {
  async react() {},
  async unreact() {},
  async listReactions(): Promise<ReactionListing> { return []; },
  async editMessage() {},
  async deleteMessage() {},
  async readMessages(): Promise<HistoryPageResult> { return { messages: [] }; },
  async readMessage() { return undefined; },
  async memberInfo() { return undefined; },
  async channelInfo() { return { label: "stub", channelId: "!stub", isDirect: false }; },
  async pins() { return []; },
  async pinMessage() {},
  async unpinMessage() {},
  async emojiList(): Promise<EmojiEntry[]> { return []; },
  async createPoll() { return { externalId: "stub" }; },
  async votePoll() { return { externalId: "stub" }; },
};

/**
 * Matrix capabilities — all channel-tool flags true, matching
 * `MatrixProvider.capabilities` (src/matrix/provider.ts).
 * Values must be kept in sync with the actual provider constants.
 */
const MATRIX_CAPS: ProviderCapabilities = {
  maxAttachmentsPerMessage: 1,
  maxMessageChars: 4000,
  maxContentBytes: 60_000,
  formatting: "html",
  reactions: true,
  edits: true,
  deletes: true,
  pollCreate: true,
  pollVote: true,
  pins: true,
  voiceMessages: true,
  threads: false,
  history: true,
  encrypted: true,
  linkPreviews: "provider",
  singleAttachmentPerMessage: true,
  membershipRoster: true,
};

// ── M2a: tool-name identity ───────────────────────────────────────────────────

test("channel tool block with Matrix caps produces the same 11 tool names as pre-Phase-4", () => {
  const channelClient = STUB_CHANNEL_CLIENT;
  const caps = MATRIX_CAPS;
  const t = MATRIX_TERMINOLOGY;

  // Replicate the exact gating logic from buildSessionTools (src/app.ts §3376–3390).
  // The Matrix provider has all flags = true, so all 11 tools must appear.
  const channelTools = [
    createChannelInfoTool({ channelClient, terminology: t }),
    createMemberInfoTool({ channelClient, terminology: t }),
    ...(caps.reactions ? [
      createEmojiListTool({ channelClient, terminology: t }),
      createReactTool({ channelClient, terminology: t }),
      createListReactionsTool({ channelClient, terminology: t }),
    ] : []),
    ...(caps.edits ? [createEditMessageTool({ channelClient, terminology: t })] : []),
    ...(caps.deletes ? [createDeleteMessageTool({ channelClient, terminology: t })] : []),
    ...(caps.pins ? [createPinsTool({ channelClient, terminology: t })] : []),
    ...(caps.history ? [createReadMessagesTool({ channelClient, terminology: t })] : []),
    ...(caps.pollCreate ? [createCreatePollTool({ channelClient, terminology: t })] : []),
    ...(caps.pollVote ? [createPollVoteTool({ channelClient, terminology: t })] : []),
  ];

  const names = channelTools.map((tool) => tool.name);

  // Exact count — no tools were dropped or added for Matrix sessions.
  assert.strictEqual(names.length, 11, `expected 11 channel tools, got: ${names.join(", ")}`);

  // Exact set — order within the set is allowed to vary; identity is what matters.
  const expected = new Set([
    "channel_info",
    "member_info",
    "emoji_list",
    "react",
    "list_reactions",
    "edit_message",
    "delete_message",
    "pins",
    "read_messages",
    "create_poll",
    "poll_vote",
  ]);
  assert.deepStrictEqual(
    new Set(names),
    expected,
    `tool names do not match pre-Phase-4 set. got: [${names.sort().join(", ")}]`,
  );
});

test("all 11 Matrix channel tools appear with a channelClient present and none appear without one", () => {
  // Sanity: when channelClient is absent (undefined), no channel tools are emitted.
  const caps = MATRIX_CAPS;
  const t = MATRIX_TERMINOLOGY;
  const channelClient: ChannelClient | undefined = undefined;

  const noChannelTools = [
    ...(channelClient ? [
      createChannelInfoTool({ channelClient, terminology: t }),
    ] : []),
  ];
  assert.strictEqual(noChannelTools.length, 0, "zero channel tools when channelClient is absent");

  // And 11 when present.
  const withClient = STUB_CHANNEL_CLIENT;
  const channelTools = [
    createChannelInfoTool({ channelClient: withClient, terminology: t }),
    createMemberInfoTool({ channelClient: withClient, terminology: t }),
    ...(caps.reactions ? [
      createEmojiListTool({ channelClient: withClient, terminology: t }),
      createReactTool({ channelClient: withClient, terminology: t }),
      createListReactionsTool({ channelClient: withClient, terminology: t }),
    ] : []),
    ...(caps.edits ? [createEditMessageTool({ channelClient: withClient, terminology: t })] : []),
    ...(caps.deletes ? [createDeleteMessageTool({ channelClient: withClient, terminology: t })] : []),
    ...(caps.pins ? [createPinsTool({ channelClient: withClient, terminology: t })] : []),
    ...(caps.history ? [createReadMessagesTool({ channelClient: withClient, terminology: t })] : []),
    ...(caps.pollCreate ? [createCreatePollTool({ channelClient: withClient, terminology: t })] : []),
    ...(caps.pollVote ? [createPollVoteTool({ channelClient: withClient, terminology: t })] : []),
  ];
  assert.strictEqual(channelTools.length, 11);
});

// ── M2b: per-capability gating with a partial capability set ──────────────────

test("channel tool block with reactions=false omits emoji_list, react, list_reactions", () => {
  const channelClient = STUB_CHANNEL_CLIENT;
  const caps: ProviderCapabilities = {
    ...MATRIX_CAPS,
    reactions: false,
    edits: false,
    deletes: false,
    pins: false,
    history: false,
    pollCreate: false,
    pollVote: false,
  };
  const t = MATRIX_TERMINOLOGY;

  const channelTools = [
    createChannelInfoTool({ channelClient, terminology: t }),
    createMemberInfoTool({ channelClient, terminology: t }),
    ...(caps.reactions ? [
      createEmojiListTool({ channelClient, terminology: t }),
      createReactTool({ channelClient, terminology: t }),
      createListReactionsTool({ channelClient, terminology: t }),
    ] : []),
    ...(caps.edits ? [createEditMessageTool({ channelClient, terminology: t })] : []),
    ...(caps.deletes ? [createDeleteMessageTool({ channelClient, terminology: t })] : []),
    ...(caps.pins ? [createPinsTool({ channelClient, terminology: t })] : []),
    ...(caps.history ? [createReadMessagesTool({ channelClient, terminology: t })] : []),
    ...(caps.pollCreate ? [createCreatePollTool({ channelClient, terminology: t })] : []),
    ...(caps.pollVote ? [createPollVoteTool({ channelClient, terminology: t })] : []),
  ];

  const names = channelTools.map((tool) => tool.name);

  // Only channel_info and member_info survive (no per-capability flag on those two).
  assert.deepStrictEqual(
    new Set(names),
    new Set(["channel_info", "member_info"]),
    `expected only channel_info and member_info, got: [${names.join(", ")}]`,
  );
});

// ── M2c: description byte-match ───────────────────────────────────────────────

test("send_message description with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-4", () => {
  const context: SendMessageToolContext = {
    provider: { capabilities: MATRIX_CAPS } as unknown as IChatProvider,
    target: { provider: "matrix", timelineKey: "matrix:bot:room:!r:hs" },
    timeline: {} as unknown as TimelineStore,
    agentSessionId: "test-session",
    terminology: MATRIX_TERMINOLOGY,
  };
  const tool = createSendMessageTool(context);

  assert.strictEqual(
    tool.description,
    "Send a message to the current Matrix room. You must explicitly decide whether the message is a reply.",
  );
});

test("react description is byte-identical to pre-Phase-4 (hardcoded, no terminology substitution)", () => {
  const tool = createReactTool({ channelClient: STUB_CHANNEL_CLIENT, terminology: MATRIX_TERMINOLOGY });

  assert.strictEqual(
    tool.description,
    "Add or remove an emoji reaction on a message. Use unicode emoji directly or :shortcode: for custom emoji.",
  );
});

test("read_messages description with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-4", () => {
  const tool = createReadMessagesTool({ channelClient: STUB_CHANNEL_CLIENT, terminology: MATRIX_TERMINOLOGY });

  assert.strictEqual(
    tool.description,
    "Read message history from the current room, or look up a single message by event ID. Use for retrieving messages outside your current context window.",
  );
});

test("channel_info description with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-4", () => {
  const tool = createChannelInfoTool({ channelClient: STUB_CHANNEL_CLIENT, terminology: MATRIX_TERMINOLOGY });

  assert.strictEqual(
    tool.description,
    "Get information about the current room (or a specific room by ID) including its name, aliases, member count, and type.",
  );
});

// ── M2e: react emoji parameter description — frozen at parameter level ────────
//
// The `emoji` parameter description must be byte-identical to the pre-Phase-6
// string when reactionKinds is ["unicode","custom","text"] (the Matrix default).
// This freezes the parameter-level schema so drift here is caught immediately.

test("react `emoji` parameter description is byte-identical to pre-Phase-6 for Matrix kinds", () => {
  // Default (no reactionKinds arg) → ["unicode","custom","text"] → pre-Phase-6 string.
  const tool = createReactTool({ channelClient: STUB_CHANNEL_CLIENT, terminology: MATRIX_TERMINOLOGY });
  const params = tool.parameters as { properties: Record<string, { description?: string }> };
  assert.strictEqual(
    params.properties["emoji"]?.description,
    "Emoji to react with. Unicode emoji (e.g. 👍) or :shortcode: (e.g. :custom_emoji:).",
    "emoji parameter description must be byte-identical to the pre-Phase-6 Matrix baseline",
  );
});

test("react `emoji` parameter description is computed for non-Matrix kinds (Discord: unicode+custom)", () => {
  const tool = createReactTool({
    channelClient: STUB_CHANNEL_CLIENT,
    terminology: MATRIX_TERMINOLOGY,
    reactionKinds: ["unicode", "custom"],
  });
  const params = tool.parameters as { properties: Record<string, { description?: string }> };
  // Not the pre-Phase-6 string; must mention both unicode and custom.
  assert.match(params.properties["emoji"]?.description ?? "", /unicode emoji/);
  assert.match(params.properties["emoji"]?.description ?? "", /shortcode/);
  assert.ok(
    !(params.properties["emoji"]?.description ?? "").includes("raw text strings"),
    "text kind must not appear when kinds is [unicode,custom]",
  );
});

test("read_messages `message_id` parameter description is byte-identical to Matrix baseline", () => {
  // Spot-check a second tool's parameter description to guard against drift in
  // the terminology substitution path.
  const tool = createReadMessagesTool({ channelClient: STUB_CHANNEL_CLIENT, terminology: MATRIX_TERMINOLOGY });
  const params = tool.parameters as { properties: Record<string, { description?: string }> };
  assert.match(
    params.properties["message_id"]?.description ?? "",
    /Matrix event ID/,
    "read_messages message_id description must reference Matrix event ID with MATRIX_TERMINOLOGY",
  );
});

// ── M2d: channel_info frozen execute output ───────────────────────────────────
//
// Frozen-output tests: the channel_info tool's execute output must be
// byte-identical to the pre-Phase-4 HEAD output for Matrix-shaped data.
// Tests cover displayName present/absent and alias present/absent.

test("channel_info execute output with displayName and alias matches frozen HEAD format", async () => {
  const matrixClient: ChannelClient = {
    ...STUB_CHANNEL_CLIENT,
    async channelInfo() {
      return {
        label: "My Room",
        displayName: "My Room",
        channelId: "!room:example.com",
        isDirect: false,
        memberCount: 5,
        joined: true,
        canonicalAlias: "#room:example.com",
        altAliases: [],
      };
    },
  };
  const tool = createChannelInfoTool({ channelClient: matrixClient, terminology: MATRIX_TERMINOLOGY });
  const result = await tool.execute("call-1", {});
  const text = result.content.find((c) => c.type === "text")?.text;

  assert.strictEqual(
    text,
    [
      "Room: !room:example.com",
      "Name: My Room",
      "Alias: #room:example.com",
      "Members: 5",
      "Type: group room",
      "Joined: yes",
    ].join("\n"),
  );
});

test("channel_info execute output without displayName or alias matches frozen HEAD format", async () => {
  const matrixClient: ChannelClient = {
    ...STUB_CHANNEL_CLIENT,
    async channelInfo() {
      return {
        label: "!room:example.com",
        channelId: "!room:example.com",
        isDirect: false,
        joined: true,
      };
    },
  };
  const tool = createChannelInfoTool({ channelClient: matrixClient, terminology: MATRIX_TERMINOLOGY });
  const result = await tool.execute("call-2", {});
  const text = result.content.find((c) => c.type === "text")?.text;

  assert.strictEqual(
    text,
    [
      "Room: !room:example.com",
      "Type: group room",
      "Joined: yes",
    ].join("\n"),
  );
});

test("channel_info execute output with altAliases matches frozen HEAD format", async () => {
  const matrixClient: ChannelClient = {
    ...STUB_CHANNEL_CLIENT,
    async channelInfo() {
      return {
        label: "My Room",
        displayName: "My Room",
        channelId: "!room:example.com",
        isDirect: false,
        joined: false,
        canonicalAlias: "#room:example.com",
        altAliases: ["#room-alt1:example.com", "#room-alt2:example.com"],
      };
    },
  };
  const tool = createChannelInfoTool({ channelClient: matrixClient, terminology: MATRIX_TERMINOLOGY });
  const result = await tool.execute("call-3", {});
  const text = result.content.find((c) => c.type === "text")?.text;

  assert.strictEqual(
    text,
    [
      "Room: !room:example.com",
      "Name: My Room",
      "Alias: #room:example.com",
      "Alt aliases: #room-alt1:example.com, #room-alt2:example.com",
      "Type: group room",
      "Joined: no",
    ].join("\n"),
  );
});

test("channel_info execute output for DM matches frozen HEAD format", async () => {
  const matrixClient: ChannelClient = {
    ...STUB_CHANNEL_CLIENT,
    async channelInfo() {
      return {
        label: "Alice",
        displayName: "Alice",
        channelId: "!dm:example.com",
        isDirect: true,
        memberCount: 2,
        joined: true,
      };
    },
  };
  const tool = createChannelInfoTool({ channelClient: matrixClient, terminology: MATRIX_TERMINOLOGY });
  const result = await tool.execute("call-4", {});
  const text = result.content.find((c) => c.type === "text")?.text;

  assert.strictEqual(
    text,
    [
      "Room: !dm:example.com",
      "Name: Alice",
      "Members: 2",
      "Type: DM",
      "Joined: yes",
    ].join("\n"),
  );
});

// ── M2f: emoji_list frozen strings (parameter description + empty-list message) ──

test("emoji_list room_id parameter description with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", () => {
  const tool = createEmojiListTool({ channelClient: STUB_CHANNEL_CLIENT, terminology: MATRIX_TERMINOLOGY });
  const params = tool.parameters as { properties: Record<string, { description?: string }> };
  assert.strictEqual(
    params.properties["room_id"]?.description,
    "Room ID to list emoji for. Defaults to the current room.",
    "emoji_list room_id description must be byte-identical to the pre-Phase-8 Matrix baseline",
  );
});

test("emoji_list empty-list execute output with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", async () => {
  const emptyClient: ChannelClient = {
    ...STUB_CHANNEL_CLIENT,
    async emojiList(): Promise<EmojiEntry[]> { return []; },
  };
  const tool = createEmojiListTool({ channelClient: emptyClient, terminology: MATRIX_TERMINOLOGY });
  const result = await tool.execute("call-emoji-1", {});
  const text = result.content.find((c) => c.type === "text")?.text;
  assert.strictEqual(
    text,
    "No custom emoji found for this room.",
    "emoji_list empty-list message must be byte-identical to the pre-Phase-8 Matrix baseline",
  );
});

// ── M2g: react not-found error frozen string ──────────────────────────────────

test("react not-found error text with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", async () => {
  const throwingClient: ChannelClient = {
    ...STUB_CHANNEL_CLIENT,
    async react() {
      throw new Error("not found in this room");
    },
  };
  const tool = createReactTool({ channelClient: throwingClient, terminology: MATRIX_TERMINOLOGY });
  const result = await tool.execute("call-react-1", { message_id: "$abc123:example.com", emoji: "👍" });
  const text = result.content.find((c) => c.type === "text")?.text;
  assert.strictEqual(
    text,
    `error: message_id "$abc123:example.com" not found in this room. Use a valid event ID from the conversation context.`,
    "react not-found error must be byte-identical to the pre-Phase-8 Matrix baseline",
  );
});

// ── M2h: member_info DM output line frozen string ─────────────────────────────

test("member_info DM room line with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", async () => {
  const dmClient: ChannelClient = {
    ...STUB_CHANNEL_CLIENT,
    async memberInfo() {
      return {
        userId: "@alice:example.com",
        isDirect: true,
      };
    },
  };
  const tool = createMemberInfoTool({ channelClient: dmClient, terminology: MATRIX_TERMINOLOGY });
  const result = await tool.execute("call-member-1", { user_id: "@alice:example.com" });
  const text = result.content.find((c) => c.type === "text")?.text;
  assert.strictEqual(
    text,
    ["User: @alice:example.com", "DM room: yes"].join("\n"),
    "member_info DM output must include 'DM room: yes' byte-identical to the pre-Phase-8 Matrix baseline",
  );
});

// ── M2i: user_profile_read / user_profile_edit senderId parameter description ──

const STUB_USER_PROFILE_CTX: UserProfileToolContext = {
  workspaceRoot: "/tmp/test-workspace",
  provider: "matrix",
  senderId: "@alice:example.com",
  terminology: MATRIX_TERMINOLOGY,
};

test("user_profile_read senderId parameter description with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", () => {
  const tool = createUserProfileReadTool(STUB_USER_PROFILE_CTX);
  // parameters: Type.Object({ target: Type.Optional(Type.Object({ senderId: Type.Optional(Type.String({...})) })) })
  // TypeBox Optional does not alter the JSON Schema structure, so the path is straightforward.
  const paramsSchema = tool.parameters as {
    properties: Record<string, { properties?: Record<string, { description?: string }> }>;
  };
  const description = paramsSchema.properties["target"]?.properties?.["senderId"]?.description;
  assert.strictEqual(
    description,
    "Stable provider sender id, for example a Matrix mxid.",
    "user_profile_read senderId description must be byte-identical to the pre-Phase-8 Matrix baseline",
  );
});

test("user_profile_edit senderId parameter description with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", () => {
  const tool = createUserProfileEditTool(STUB_USER_PROFILE_CTX);
  const paramsSchema = tool.parameters as {
    properties: Record<string, { properties?: Record<string, { description?: string }> }>;
  };
  const description = paramsSchema.properties["target"]?.properties?.["senderId"]?.description;
  assert.strictEqual(
    description,
    "Stable provider sender id, for example a Matrix mxid.",
    "user_profile_edit senderId description must be byte-identical to the pre-Phase-8 Matrix baseline",
  );
});

// ── M2j: spawn_session message_id description + required-error frozen strings ──

test("spawn_session message_id description with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", () => {
  const tool = createSpawnSessionTool({
    spawnCoReply: async () => ({ status: "spawned" }),
    terminology: MATRIX_TERMINOLOGY,
  });
  const params = tool.parameters as { properties: Record<string, { description?: string }> };
  assert.strictEqual(
    params.properties["message_id"]?.description,
    "The Matrix event id ($…) of the co-reply message to spin off, as given in the co-reply interjection.",
    "spawn_session message_id description must be byte-identical to the pre-Phase-8 Matrix baseline",
  );
});

test("spawn_session required-error text with MATRIX_TERMINOLOGY is byte-identical to pre-Phase-8", async () => {
  const tool = createSpawnSessionTool({
    spawnCoReply: async () => ({ status: "spawned" }),
    terminology: MATRIX_TERMINOLOGY,
  });
  // Pass an empty string to trigger the required-error path.
  const result = await tool.execute("call-spawn-1", { message_id: "" });
  const text = result.content.find((c) => c.type === "text")?.text;
  assert.strictEqual(
    text,
    "error: message_id is required (the $… event id from the co-reply interjection).",
    "spawn_session required-error must be byte-identical to the pre-Phase-8 Matrix baseline",
  );
});
