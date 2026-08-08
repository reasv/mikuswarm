/**
 * Tests for src/irc/normalizer.ts — pure functions only, no live socket.
 *
 * Coverage:
 *   - stripControlCodes: mIRC color, hex color, and formatting control chars
 *   - casefold: rfc1459, strict-rfc1459, ascii, fallback
 *   - detectMention: addressing prefix, bare nick, word boundary, case-folded
 *   - detectIrcTrigger: dm, mention, notice (never triggers)
 *   - buildIrcChannelKey / buildIrcDmKey
 *   - computeByteBudget
 *   - chunkIrcMessage: no split, boundary split, whitespace preference, UTF-8 multi-byte
 *   - syntheticMsgId: format, uniqueness within account, cross-account independence
 *   - normalizeIrcMessage: privmsg, action, channel notice (no trigger), DM trigger
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  stripControlCodes,
  casefold,
  detectMention,
  detectIrcTrigger,
  buildIrcChannelKey,
  buildIrcDmKey,
  computeByteBudget,
  chunkIrcMessage,
  syntheticMsgId,
  normalizeIrcMessage,
  STATIC_MAX_CHARS,
  _resetCounters,
} from "../src/irc/normalizer.js";

// ── stripControlCodes ────────────────────────────────────────────────────────

test("stripControlCodes: removes bold (\\x02)", () => {
  assert.equal(stripControlCodes("\x02hello\x02"), "hello");
});

test("stripControlCodes: removes mIRC color code bare (\\x03)", () => {
  assert.equal(stripControlCodes("\x03hello"), "hello");
});

test("stripControlCodes: removes mIRC color code with fg (\\x0304)", () => {
  assert.equal(stripControlCodes("\x034red\x03"), "red");
});

test("stripControlCodes: removes mIRC color code with fg,bg (\\x034,12)", () => {
  assert.equal(stripControlCodes("\x034,12red\x03"), "red");
});

test("stripControlCodes: removes hex color code (\\x04RRGGBB)", () => {
  assert.equal(stripControlCodes("\x04FF0000red"), "red");
});

test("stripControlCodes: removes reset (\\x0F)", () => {
  assert.equal(stripControlCodes("bold\x0Fnormal"), "boldnormal");
});

test("stripControlCodes: removes italic (\\x1D)", () => {
  assert.equal(stripControlCodes("\x1Ditalic\x1D"), "italic");
});

test("stripControlCodes: removes underline (\\x1F)", () => {
  assert.equal(stripControlCodes("\x1Funder\x1F"), "under");
});

test("stripControlCodes: removes strikethrough (\\x1E)", () => {
  assert.equal(stripControlCodes("\x1Estrike\x1E"), "strike");
});

test("stripControlCodes: removes monospace (\\x11)", () => {
  assert.equal(stripControlCodes("\x11mono\x11"), "mono");
});

test("stripControlCodes: removes reverse (\\x16)", () => {
  assert.equal(stripControlCodes("\x16reverse\x16"), "reverse");
});

test("stripControlCodes: passes through plain ASCII text unchanged", () => {
  const text = "Hello, world! No control codes here.";
  assert.equal(stripControlCodes(text), text);
});

test("stripControlCodes: handles multiple mixed control codes in one string", () => {
  const input = "\x02bold\x02 and \x034red\x03 and \x1Ditalic\x1D";
  assert.equal(stripControlCodes(input), "bold and red and italic");
});

test("stripControlCodes: handles empty string", () => {
  assert.equal(stripControlCodes(""), "");
});

// ── casefold ────────────────────────────────────────────────────────────────

test("casefold: ascii → standard toLowerCase only", () => {
  assert.equal(casefold("Hello", "ascii"), "hello");
  assert.equal(casefold("WORLD", "ascii"), "world");
  // IRC special chars NOT mapped in ascii mode
  assert.equal(casefold("[", "ascii"), "[");
  assert.equal(casefold("]", "ascii"), "]");
  assert.equal(casefold("~", "ascii"), "~");
});

test("casefold: rfc1459 → lowercase + special char mapping", () => {
  assert.equal(casefold("[Hello]", "rfc1459"), "{hello}");
  assert.equal(casefold("A\\B~C", "rfc1459"), "a|b^c");
  assert.equal(casefold("UPPER", "rfc1459"), "upper");
});

test("casefold: strict-rfc1459 → lowercase + []\\ but NOT ~→^", () => {
  assert.equal(casefold("[Hello]", "strict-rfc1459"), "{hello}");
  assert.equal(casefold("A\\B", "strict-rfc1459"), "a|b");
  // ~ is NOT mapped in strict-rfc1459
  assert.equal(casefold("~tilde", "strict-rfc1459"), "~tilde");
});

test("casefold: unknown casemapping falls back to toLowerCase", () => {
  assert.equal(casefold("HELLO", "precis"), "hello");
  assert.equal(casefold("HELLO", ""), "hello");
});

test("casefold: empty string", () => {
  assert.equal(casefold("", "rfc1459"), "");
});

// ── detectMention ────────────────────────────────────────────────────────────

test("detectMention: addressing prefix form 'nick:'", () => {
  assert.ok(detectMention("miku: hello there", "miku", "ascii"));
});

test("detectMention: addressing prefix form 'nick,' (comma)", () => {
  assert.ok(detectMention("miku, can you help?", "miku", "ascii"));
});

test("detectMention: case-insensitive nick match in prefix", () => {
  assert.ok(detectMention("MIKU: hello", "miku", "ascii"));
  assert.ok(detectMention("Miku: hello", "MIKU", "ascii"));
});

test("detectMention: bare nick word-boundary match", () => {
  assert.ok(detectMention("hey miku how are you", "miku", "ascii"));
});

test("detectMention: bare nick at start of message (no colon)", () => {
  assert.ok(detectMention("miku what time is it?", "miku", "ascii"));
});

test("detectMention: bare nick at end of message", () => {
  assert.ok(detectMention("that was great, miku", "miku", "ascii"));
});

test("detectMention: nick not mentioned — no match", () => {
  assert.ok(!detectMention("hello everyone", "miku", "ascii"));
});

test("detectMention: partial nick not a match (word boundary)", () => {
  // 'mikus' should not match nick 'miku' (nick char after)
  assert.ok(!detectMention("mikus is an interesting word", "miku", "ascii"));
});

test("detectMention: rfc1459 casemapping applied correctly", () => {
  // Nick [Miku] → {miku} in rfc1459
  assert.ok(detectMention("{miku}: hello", "[Miku]", "rfc1459"));
});

test("detectMention: empty nick returns false", () => {
  assert.ok(!detectMention("hello everyone", "", "ascii"));
});

// ── detectIrcTrigger ─────────────────────────────────────────────────────────

test("detectIrcTrigger: DM always triggers (type='dm')", () => {
  const trigger = detectIrcTrigger(
    "hello bot",
    "alice",
    "miku",
    "miku",
    "dm",
    "ascii",
    false,
  );
  assert.ok(trigger, "DM should trigger");
  assert.equal(trigger.type, "dm");
  assert.equal(trigger.triggeredBy.id, "alice");
});

test("detectIrcTrigger: channel mention triggers (type='mention')", () => {
  const trigger = detectIrcTrigger(
    "miku: can you help?",
    "bob",
    "#general",
    "miku",
    "group",
    "ascii",
    false,
  );
  assert.ok(trigger, "Channel mention should trigger");
  assert.equal(trigger.type, "mention");
  assert.equal(trigger.triggeredBy.id, "bob");
});

test("detectIrcTrigger: channel message without mention → undefined", () => {
  const trigger = detectIrcTrigger(
    "hello everyone",
    "carol",
    "#general",
    "miku",
    "group",
    "ascii",
    false,
  );
  assert.equal(trigger, undefined, "Non-mention channel message should not trigger");
});

test("detectIrcTrigger: NOTICE in channel → no trigger (spec §7.5)", () => {
  const trigger = detectIrcTrigger(
    "miku: this is a notice",
    "serv",
    "#general",
    "miku",
    "group",
    "ascii",
    true, // isNotice
  );
  assert.equal(trigger, undefined, "Channel NOTICE must never trigger");
});

test("detectIrcTrigger: NOTICE in DM → no trigger (spec §7.5)", () => {
  const trigger = detectIrcTrigger(
    "hello",
    "alice",
    "miku",
    "miku",
    "dm",
    "ascii",
    true, // isNotice
  );
  assert.equal(trigger, undefined, "DM NOTICE must never trigger");
});

// ── buildIrcChannelKey / buildIrcDmKey ────────────────────────────────────────

test("buildIrcChannelKey: produces irc:<accountId>:room:<channel> key", () => {
  const key = buildIrcChannelKey("myaccount", "#general", "ascii");
  assert.equal(key, "irc:myaccount:room:#general");
});

test("buildIrcChannelKey: lowercases channel per casemapping", () => {
  const key = buildIrcChannelKey("acc", "#GENERAL", "ascii");
  assert.equal(key, "irc:acc:room:#general");
});

test("buildIrcChannelKey: rfc1459 casefolds special chars in channel name", () => {
  // Channel [foo] → {foo} in rfc1459
  const key = buildIrcChannelKey("acc", "#[foo]", "rfc1459");
  assert.equal(key, "irc:acc:room:#{foo}");
});

test("buildIrcDmKey: produces irc:<accountId>:dm:<identity> key", () => {
  const key = buildIrcDmKey("myaccount", "alice");
  assert.equal(key, "irc:myaccount:dm:alice");
});

// ── computeByteBudget ────────────────────────────────────────────────────────

test("computeByteBudget: typical case gives expected value", () => {
  // Wire format: :nick!user@host PRIVMSG #chan :body\r\n
  // 498 - len("miku!miku@example.com") - len("#general")
  // = 498 - 21 - 8 = 469
  const budget = computeByteBudget("miku", "miku", "example.com", "#general");
  assert.equal(budget, 498 - "miku!miku@example.com".length - "#general".length);
});

test("computeByteBudget: minimum floor of 50", () => {
  // Use an absurdly long nick+host to trigger the floor
  const nick = "a".repeat(100);
  const host = "b".repeat(400);
  const budget = computeByteBudget(nick, "u", host, "#chan");
  assert.equal(budget, 50);
});

test("STATIC_MAX_CHARS constant is 400", () => {
  assert.equal(STATIC_MAX_CHARS, 400);
});

// ── chunkIrcMessage ───────────────────────────────────────────────────────────

test("chunkIrcMessage: short message returns single chunk", () => {
  const chunks = chunkIrcMessage("Hello, world!", 100);
  assert.deepEqual(chunks, ["Hello, world!"]);
});

test("chunkIrcMessage: empty string returns empty array", () => {
  const chunks = chunkIrcMessage("", 100);
  assert.deepEqual(chunks, []);
});

test("chunkIrcMessage: exactly fits budget returns one chunk", () => {
  const text = "a".repeat(100);
  const chunks = chunkIrcMessage(text, 100);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0], text);
});

test("chunkIrcMessage: splits at byte boundary when no whitespace preference", () => {
  const text = "a".repeat(201); // 201 bytes, budget=100 → chunks of 100, 100, 1
  const chunks = chunkIrcMessage(text, 100);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]!.length, 100);
  assert.equal(chunks[1]!.length, 100);
  assert.equal(chunks[2]!.length, 1);
  assert.equal(chunks.join(""), text);
});

test("chunkIrcMessage: prefers splitting at whitespace in latter half", () => {
  // "hello world" with budget=8 → should split at space (position 5 > 8/2=4)
  // Actually "hello world" is 11 chars; with budget=8, space is at position 5
  // 5 > floor(7/2)=3 (window=0..7) → yes, prefer whitespace
  const chunks = chunkIrcMessage("hello world", 8);
  // Should split at the space after "hello"
  assert.ok(chunks.includes("hello") || chunks.some((c) => c.startsWith("hello")));
  assert.equal(chunks.join(" ").replace(/\s+/g, " ").trim(), "hello world");
});

test("chunkIrcMessage: skips leading spaces on continuation chunk", () => {
  // "hello world" splits at the space; "world" should not start with space
  const chunks = chunkIrcMessage("hello world", 6);
  for (const chunk of chunks) {
    assert.ok(!chunk.startsWith(" "), `Chunk must not start with space: "${chunk}"`);
  }
});

test("chunkIrcMessage: handles multi-byte UTF-8 emoji correctly", () => {
  // Each emoji is 4 bytes in UTF-8 (e.g. 😀 = U+1F600)
  // Budget 8 bytes → can fit 2 emojis per chunk (8 bytes exactly)
  const emoji = "😀";
  const text = emoji.repeat(6); // 24 bytes
  const chunks = chunkIrcMessage(text, 8);
  // Each chunk: 2 emojis × 4 bytes = 8 bytes
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(
      Buffer.byteLength(chunk, "utf8") <= 8,
      `Chunk exceeds budget: "${chunk}" (${Buffer.byteLength(chunk, "utf8")} bytes)`,
    );
  }
  assert.equal(chunks.join(""), text);
});

test("chunkIrcMessage: 3-byte CJK character splits on code-point boundary", () => {
  // Each Chinese character is 3 bytes in UTF-8
  // Budget 6 → 2 chars per chunk
  const text = "你好世界"; // 4 chars × 3 bytes = 12 bytes
  const chunks = chunkIrcMessage(text, 6);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "你好");
  assert.equal(chunks[1], "世界");
});

test("chunkIrcMessage: maxBytes <= 0 returns original text as single chunk", () => {
  const chunks = chunkIrcMessage("hello", 0);
  assert.deepEqual(chunks, ["hello"]);
});

test("chunkIrcMessage: joined chunks reconstruct original (no loss)", () => {
  const text = "The quick brown fox jumps over the lazy dog. " +
    "Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow.";
  const chunks = chunkIrcMessage(text, 30);
  // Reconstruct: chunks may drop leading spaces from continuation lines
  const reconstructed = chunks.join(" ");
  // All words from the original must appear somewhere in the reconstruction
  for (const word of text.split(/\s+/).filter(Boolean)) {
    assert.ok(reconstructed.includes(word), `Word "${word}" missing from chunks`);
  }
});

// ── chunkIrcMessage: newline pre-split (F4) ───────────────────────────────────

test("chunkIrcMessage: multi-line short body produces N chunks (one per line)", () => {
  // Two short lines, each well within the budget — should produce exactly 2 chunks.
  const chunks = chunkIrcMessage("hello\nworld", 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "hello");
  assert.equal(chunks[1], "world");
});

test("chunkIrcMessage: blank lines between content lines are skipped", () => {
  // IRC cannot send an empty PRIVMSG; blank lines must be dropped.
  const chunks = chunkIrcMessage("hello\n\n\nworld", 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "hello");
  assert.equal(chunks[1], "world");
});

test("chunkIrcMessage: whitespace-only lines are skipped", () => {
  const chunks = chunkIrcMessage("hello\n   \nworld", 100);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "hello");
  assert.equal(chunks[1], "world");
});

test("chunkIrcMessage: mixed newline styles (\\r\\n, \\n, \\r) all split correctly", () => {
  const chunks = chunkIrcMessage("a\r\nb\nc\rd", 100);
  assert.equal(chunks.length, 4);
  assert.equal(chunks[0], "a");
  assert.equal(chunks[1], "b");
  assert.equal(chunks[2], "c");
  assert.equal(chunks[3], "d");
});

test("chunkIrcMessage: multi-line body with over-budget lines splits each line independently", () => {
  // Budget of 5 bytes per chunk — each 10-char line must produce two chunks.
  // "hello worl" and "foo barrr" both exceed 5 bytes so each gets split.
  const chunks = chunkIrcMessage("hello world\nfoo barrr", 5);
  // No chunk should be empty.
  assert.ok(chunks.every((c) => c.length > 0), "all chunks must be non-empty");
  // No chunk should contain a newline (newlines must have been pre-split).
  assert.ok(chunks.every((c) => !/[\n\r]/.test(c)), "no chunk should contain a newline");
  // Both lines must have contributed chunks: the joined content must include all
  // non-whitespace characters from both lines.
  const joined = chunks.join("");
  // Check that characters from both original lines appear in the output.
  assert.ok(joined.includes("h"), "first line chars must appear");
  assert.ok(joined.includes("f"), "second line chars must appear");
  // More than two chunks expected (both lines needed splitting).
  assert.ok(chunks.length > 2, `expected >2 chunks, got ${chunks.length}: ${JSON.stringify(chunks)}`);
});

// ── syntheticMsgId ────────────────────────────────────────────────────────────

test("syntheticMsgId: format is syn:<ms>:<nick>:<counter>", () => {
  _resetCounters();
  const ts = 1234567890000;
  const id = syntheticMsgId("acc1", ts, "miku");
  assert.match(id, /^syn:\d+:[^:]+:\d+$/, "Should match syn:<ms>:<nick>:<counter>");
  assert.ok(id.startsWith(`syn:${ts}:miku:`), `Expected syn:${ts}:miku: prefix, got: ${id}`);
});

test("syntheticMsgId: monotonically increasing counter per account", () => {
  _resetCounters();
  const id1 = syntheticMsgId("acc1", 1000, "miku");
  const id2 = syntheticMsgId("acc1", 1000, "miku");
  const id3 = syntheticMsgId("acc1", 1000, "miku");
  const counter = (id: string) => parseInt(id.split(":").at(-1)!);
  assert.ok(counter(id1) < counter(id2), "Counter should increase");
  assert.ok(counter(id2) < counter(id3), "Counter should increase");
});

test("syntheticMsgId: different accounts have independent counters", () => {
  _resetCounters();
  const a1 = syntheticMsgId("accA", 1000, "botA");
  const b1 = syntheticMsgId("accB", 1000, "botB");
  const a2 = syntheticMsgId("accA", 1000, "botA");
  // accA counter: 1, 2; accB counter: 1
  const counterOf = (id: string) => parseInt(id.split(":").at(-1)!);
  assert.equal(counterOf(a1), 1);
  assert.equal(counterOf(b1), 1);
  assert.equal(counterOf(a2), 2);
});

test("syntheticMsgId: ids are unique across calls", () => {
  _resetCounters();
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    ids.add(syntheticMsgId("acc", Date.now(), "bot"));
  }
  assert.equal(ids.size, 100, "All 100 synthetic ids should be unique");
});

// ── normalizeIrcMessage ───────────────────────────────────────────────────────

test("normalizeIrcMessage: basic privmsg from another user in a channel", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "alice",
    ident: "alice",
    hostname: "example.com",
    target: "#general",
    message: "Hello everyone!",
    tags: { "msgid": "server-id-123", "time": "2024-01-01T00:00:00Z" },
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.equal(inbound.provider, "irc");
  assert.equal(inbound.channelType, "group");
  assert.equal(inbound.event.body, "Hello everyone!");
  assert.equal(inbound.event.sender.id, "alice");
  assert.equal(inbound.event.sender.isSelf, false);
  assert.equal(inbound.event.externalId, "server-id-123");
  assert.ok(inbound.event.trigger === undefined, "No mention → no trigger");
});

test("normalizeIrcMessage: channel privmsg with mention triggers", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "bob",
    ident: "bob",
    hostname: "example.com",
    target: "#general",
    message: "miku: can you help?",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.ok(inbound.event.trigger, "Mention should set trigger");
  assert.equal(inbound.event.trigger?.type, "mention");
  assert.equal(inbound.event.trigger?.triggeredBy.id, "bob");
});

test("normalizeIrcMessage: DM from a user triggers with type='dm'", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "carol",
    ident: "carol",
    hostname: "example.com",
    target: "miku", // DM: target is the bot's nick
    message: "hey, what's up?",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.equal(inbound.channelType, "dm");
  assert.ok(inbound.event.trigger, "DM should trigger");
  assert.equal(inbound.event.trigger?.type, "dm");
});

test("normalizeIrcMessage: CTCP ACTION prefixes body with '* nick'", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "dave",
    ident: "dave",
    hostname: "example.com",
    target: "#general",
    message: "waves hello",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: true,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.equal(inbound.event.body, "* dave waves hello");
});

test("normalizeIrcMessage: channel NOTICE is ingested but has no trigger", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "service",
    ident: "service",
    hostname: "services.example.com",
    target: "#general",
    message: "miku: this is a notice mentioning you",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: true,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.equal(inbound.channelType, "group");
  assert.equal(inbound.event.trigger, undefined, "NOTICE must never trigger");
});

test("normalizeIrcMessage: strips control codes from body before storing", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "alice",
    ident: "alice",
    hostname: "example.com",
    target: "#general",
    message: "\x02bold\x02 and \x034red text\x03",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.equal(inbound.event.body, "bold and red text");
});

test("normalizeIrcMessage: self-echo has isSelf: true on sender", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "miku", // same as selfNick
    ident: "miku",
    hostname: "example.com",
    target: "#general",
    message: "I said something",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.equal(inbound.event.sender.isSelf, true);
});

test("normalizeIrcMessage: uses synthetic id when no msgid tag present", () => {
  _resetCounters();
  const ctx = { accountId: "myacc", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "alice",
    ident: "alice",
    hostname: "example.com",
    target: "#chan",
    message: "hello",
    tags: {}, // no msgid
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.ok(
    inbound.event.externalId?.startsWith("syn:"),
    `Expected synthetic id starting with "syn:", got: ${inbound.event.externalId}`,
  );
});

test("normalizeIrcMessage: timeline key is irc:<accountId>:room:<channel> for channel", () => {
  _resetCounters();
  const ctx = { accountId: "acc1", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "alice",
    ident: "a",
    hostname: "h",
    target: "#general",
    message: "hi",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  assert.equal(inbound.timelineKey, "irc:acc1:room:#general");
});

test("normalizeIrcMessage: timeline key is irc:<accountId>:dm:<nick> for DM", () => {
  _resetCounters();
  const ctx = { accountId: "acc1", selfNick: "miku", casemapping: "ascii" };
  const msg = {
    nick: "Alice",
    ident: "a",
    hostname: "h",
    target: "miku",
    message: "hey",
    tags: {},
    time: 1704067200000,
    account: undefined,
    isAction: false,
    isNotice: false,
  };
  const inbound = normalizeIrcMessage(msg, ctx);
  // DM key uses casemapped sender nick
  assert.equal(inbound.timelineKey, "irc:acc1:dm:alice");
});
