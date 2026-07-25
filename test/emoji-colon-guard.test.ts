/**
 * B1 — Emoji double-colon blocker
 *
 * Two-layer regression guard for the B1 ruling:
 *
 * 1. Adapter layer (MatrixChannelClient.emojiList): listKnownShortcodes returns
 *    `:name:`-wrapped strings; emojiList() must strip the colons before returning
 *    EmojiEntry objects.  Without the fix, the tool renders `::name::`.
 *
 * 2. Tool layer (emoji_list): given a channelClient.emojiList that returns bare
 *    shortcodes (as the fixed adapter now guarantees), the tool output must be
 *    `:name:` — exactly one colon pair.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MatrixChannelClient } from "../src/matrix/channel-client.js";
import type { MatrixNativeClient } from "../src/matrix/native-client.js";
import { createEmojiListTool } from "../src/tools/emoji.js";
import type { ChannelClient, EmojiEntry } from "../src/types.js";

// ── Layer 1: adapter strips colons ────────────────────────────────────────────

test("MatrixChannelClient.emojiList strips leading/trailing colons from listKnownShortcodes results", async () => {
  // listKnownShortcodes returns `:name:`-wrapped strings from the native binding.
  // The adapter must strip the wrapping colons so EmojiEntry.shortcode is the
  // bare name — the tool renders `:${shortcode}:` itself.
  const stubNative = {
    listKnownShortcodes(_req: { roomId?: string; limit?: number }): string[] {
      return [":smile:", ":wave:", "plain", ":x:"];
    },
  } as unknown as MatrixNativeClient;

  const client = new MatrixChannelClient(stubNative, "!room:server");
  const entries = await client.emojiList(50);

  assert.deepStrictEqual(
    entries.map((e) => e.shortcode),
    ["smile", "wave", "plain", "x"],
    "shortcodes should be bare names — colons stripped where present",
  );
});

test("MatrixChannelClient.emojiList does not strip colons that are not a symmetric wrapping pair", async () => {
  // Only strip when s.startsWith(":") && s.endsWith(":") && s.length > 2.
  // Strings like ":" or ":a" (only one side) are left unchanged.
  const stubNative = {
    listKnownShortcodes(_req: { roomId?: string; limit?: number }): string[] {
      // ":" is length 1 — not > 2, so no strip
      // ":a" has no trailing colon — no strip
      return [":", ":a"];
    },
  } as unknown as MatrixNativeClient;

  const client = new MatrixChannelClient(stubNative, "!room:server");
  const entries = await client.emojiList(50);

  assert.deepStrictEqual(
    entries.map((e) => e.shortcode),
    [":", ":a"],
    "edge cases with unbalanced colons must be left unchanged",
  );
});

// ── Layer 2: tool renders :name: once ─────────────────────────────────────────

test("emoji_list tool output contains :name: exactly once (not ::name::)", async () => {
  // Simulate what the fixed MatrixChannelClient produces: bare shortcodes.
  // The tool wraps each in `:…:`, so the output must be :smile:, :wave: —
  // not ::smile::, ::wave:: as it would be if the adapter returned colon-wrapped.
  const stubClient: ChannelClient = {
    async emojiList(_limit?: number): Promise<EmojiEntry[]> {
      return [{ shortcode: "smile" }, { shortcode: "wave" }];
    },
    async react() {},
    async unreact() {},
    async listReactions() { return []; },
    async editMessage() {},
    async deleteMessage() {},
    async readMessages() { return { messages: [] }; },
    async readMessage() { return undefined; },
    async memberInfo() { return undefined; },
    async channelInfo() {
      return { label: "test", channelId: "!test", isDirect: false };
    },
    async pins() { return []; },
    async pinMessage() {},
    async unpinMessage() {},
  };

  const tool = createEmojiListTool({ channelClient: stubClient });
  const result = await tool.execute("call-1", {});

  assert.ok(result.content.length > 0, "tool should produce content");
  const text = result.content.find((c) => c.type === "text")?.text ?? "";

  // Must contain :smile: and :wave: exactly — no double colons.
  assert.ok(text.includes(":smile:"), `expected :smile: in output, got: ${text}`);
  assert.ok(text.includes(":wave:"), `expected :wave: in output, got: ${text}`);
  assert.ok(!text.includes("::"), `output must not contain double-colons (::), got: ${text}`);
});

test("emoji_list tool text is exactly ':smile:, :wave:' for those two shortcodes", async () => {
  const stubClient: ChannelClient = {
    async emojiList(): Promise<EmojiEntry[]> {
      return [{ shortcode: "smile" }, { shortcode: "wave" }];
    },
    async react() {},
    async unreact() {},
    async listReactions() { return []; },
    async editMessage() {},
    async deleteMessage() {},
    async readMessages() { return { messages: [] }; },
    async readMessage() { return undefined; },
    async memberInfo() { return undefined; },
    async channelInfo() {
      return { label: "test", channelId: "!test", isDirect: false };
    },
    async pins() { return []; },
    async pinMessage() {},
    async unpinMessage() {},
  };

  const tool = createEmojiListTool({ channelClient: stubClient });
  const result = await tool.execute("call-2", {});
  const text = result.content.find((c) => c.type === "text")?.text ?? "";

  assert.strictEqual(text, ":smile:, :wave:");
});
