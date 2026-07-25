/**
 * Phase 3a identity rendering tests (spec DISCORD-SUPPORT-DESIGN.md §6.2).
 *
 * Covers:
 *  - Matrix-shaped senders (no `username`) are byte-identical to pre-3a output
 *    (the rendering rule degrades to `username ?? id` = `id` with no username set)
 *  - Discord-shaped senders (with `username`) render with `username` as the
 *    human-facing label, not the raw id
 *  - displayName suppression guard uses `username ?? id` as the baseline, not bare
 *    `id`, so a Discord user whose displayName === username gets it suppressed while
 *    one with a distinct nickname shows both
 *  - Reply sender identity follows the same rules
 */
import assert from "node:assert/strict";
import test from "node:test";
import { renderRichMessage, renderCompactMessage } from "../src/context/renderer.js";
import type { CanonicalChatEvent, ReplyContext } from "../src/types.js";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function matrixEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "matrix:miku:$ev",
    externalId: "$ev",
    timelineKey: "matrix:miku:room:!room:example.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "hello",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function discordEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "discord:bot:$123",
    externalId: "123",
    timelineKey: "discord:bot:channel:456",
    provider: "discord",
    role: "user",
    sender: { id: "111222333444555666", username: "alice_d", displayName: "Alice (Discord)" },
    body: "hello from discord",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §6.2 byte-identity: Matrix senders (no username field)
// ---------------------------------------------------------------------------

test("Matrix sender (no username): rich sender attr uses raw id — byte-identical to pre-3a", () => {
  // username is absent → `username ?? id` = id → sender attr is the MXID.
  const ev = matrixEvent();
  const rich = renderRichMessage(ev);
  assert.match(rich, /sender="@alice:example\.org"/, "sender attr must be the Matrix id");
  // display_name is shown because displayName ('Alice') !== handle ('@alice:example.org').
  assert.match(rich, /display_name="Alice"/, "displayName still rendered when it differs from id");
});

test("Matrix sender (no username): compact label uses raw id — byte-identical to pre-3a", () => {
  const ev = matrixEvent();
  const compact = renderCompactMessage(ev);
  // Compact: "Alice (@alice:example.org): hello"
  assert.match(compact, /Alice \(@alice:example\.org\): hello/, "compact label: displayName (handle)");
});

test("Matrix sender where displayName equals id: display_name attr suppressed (pre-3a behavior unchanged)", () => {
  // Edge case: a Matrix user whose display name happens to equal the MXID.
  // Pre-3a guard: displayName !== id. Post-3a guard: displayName !== (username ?? id) = id.
  // Both guard formulations produce the same result here — display_name is suppressed.
  const ev = matrixEvent({ sender: { id: "@alice:example.org", displayName: "@alice:example.org" } });
  const rich = renderRichMessage(ev);
  assert.match(rich, /sender="@alice:example\.org"/, "sender attr is the MXID");
  assert.doesNotMatch(rich, /display_name=/, "display_name suppressed when it equals the id");
});

// ---------------------------------------------------------------------------
// §6.2 Discord senders: username is the human-facing label
// ---------------------------------------------------------------------------

test("Discord sender (with username): rich sender attr uses username, not snowflake id", () => {
  const ev = discordEvent();
  const rich = renderRichMessage(ev);
  // sender attr must be the username handle, NOT the raw snowflake.
  assert.match(rich, /sender="alice_d"/, "sender attr must be the Discord username");
  assert.doesNotMatch(rich, /sender="111222333444555666"/, "raw snowflake must not appear in sender attr");
  // external_id still carries the raw snowflake (the declared exception, §6.2).
  assert.match(rich, /external_id="123"/, "external_id carries the raw provider id");
});

test("Discord sender: displayName != username → display_name attr shown", () => {
  // displayName 'Alice (Discord)' differs from username 'alice_d' → show both.
  const ev = discordEvent();
  const rich = renderRichMessage(ev);
  assert.match(rich, /display_name="Alice \(Discord\)"/, "distinct displayName is rendered");
});

test("Discord sender: displayName === username → display_name attr suppressed", () => {
  // When the guild nickname matches the username, it's redundant — suppress it.
  const ev = discordEvent({ sender: { id: "111222333444555666", username: "alice_d", displayName: "alice_d" } });
  const rich = renderRichMessage(ev);
  assert.match(rich, /sender="alice_d"/);
  assert.doesNotMatch(rich, /display_name=/, "display_name suppressed when it equals the username handle");
});

test("Discord sender: compact label uses username as handle", () => {
  const ev = discordEvent();
  const compact = renderCompactMessage(ev);
  // displayName "Alice (Discord)" has parens escaped → "Alice \(Discord\)" in compact.
  // The format is: <displayName_escaped> (<handle>): <body>
  // Inner parens in displayName are backslash-escaped by escapeCompactParens.
  assert.match(compact, /Alice \\?\(Discord\\?\) \(alice_d\):/, "compact label: displayName (username)");
  assert.doesNotMatch(compact, /111222333444555666/, "raw snowflake must not appear in compact label");
  assert.match(compact, /alice_d/, "username handle must appear");
});

test("Discord sender where displayName equals username: compact label shows only the handle", () => {
  const ev = discordEvent({ sender: { id: "111222333444555666", username: "alice_d", displayName: "alice_d" } });
  const compact = renderCompactMessage(ev);
  // Only the handle, no displayName parenthetical.
  assert.match(compact, /alice_d:/, "compact label is just the username");
  assert.doesNotMatch(compact, /alice_d \(alice_d\)/, "handle must not appear in the parenthetical when displayName equals username");
});

// ---------------------------------------------------------------------------
// §6.2 Reply sender identity
// ---------------------------------------------------------------------------

test("Discord reply sender: sender attr in reply_to uses username, not snowflake", () => {
  const replyTo: ReplyContext = {
    externalId: "99",
    sender: { id: "999888777666555444", username: "bob_d", displayName: "Bob" },
    body: "quoted body",
    timestamp: 1_699_999_000_000,
  };
  const ev = matrixEvent({ replyTo });
  const rich = renderRichMessage(ev);
  assert.match(rich, /<reply_to sender="bob_d"/, "reply sender attr uses username");
  assert.match(rich, /display_name="Bob"/, "distinct displayName shown in reply");
});

test("Matrix reply sender (no username): reply sender attr uses raw id — byte-identical", () => {
  const replyTo: ReplyContext = {
    externalId: "$orig",
    sender: { id: "@bob:example.org", displayName: "Bob" },
    body: "original",
    timestamp: 1_699_999_000_000,
  };
  const ev = matrixEvent({ replyTo });
  const rich = renderRichMessage(ev);
  assert.match(rich, /<reply_to sender="@bob:example\.org"/, "reply sender attr is MXID when no username");
  assert.match(rich, /display_name="Bob"/, "displayName shown in reply because it differs from id");
});

// ---------------------------------------------------------------------------
// §6.2 compactReply: sender label in the compact-tier reply block
// ---------------------------------------------------------------------------

test("compactReply: Matrix reply sender (no displayName, no username) renders 'unknown' — byte-identical", () => {
  // Matrix senders have no username; without a displayName the label must be "unknown",
  // preserving pre-3a behaviour (the raw id must NOT appear as the label).
  const replyTo: ReplyContext = {
    externalId: "$orig",
    sender: { id: "@bob:example.org" },
    body: "quoted",
    timestamp: 1_699_999_000_000,
  };
  const ev = matrixEvent({ replyTo });
  const compact = renderCompactMessage(ev);
  assert.match(compact, /From: unknown/, "label must be 'unknown' for Matrix sender with no displayName");
  assert.doesNotMatch(compact, /@bob:example\.org/, "MXID must not appear as the compact reply label");
});

test("compactReply: Discord reply sender (no displayName, has username) renders the username", () => {
  // Discord senders have username; when displayName is absent the handle (username) is shown.
  const replyTo: ReplyContext = {
    externalId: "42",
    sender: { id: "123", username: "bob" },
    body: "quoted",
    timestamp: 1_699_999_000_000,
  };
  const ev = matrixEvent({ replyTo });
  const compact = renderCompactMessage(ev);
  assert.match(compact, /From: bob/, "username used as label when displayName absent");
  assert.doesNotMatch(compact, /From: unknown/, "must not fall back to 'unknown' when username present");
});
