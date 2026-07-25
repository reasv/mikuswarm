/**
 * Tests for EmojiCatalog (spec DISCORD-SUPPORT-DESIGN §10.2/§10.3).
 *
 * Pure unit tests — no gateway, no REST, no discord.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EmojiCatalog } from "../src/discord/emoji-catalog.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEmoji(id: string, name: string, animated = false) {
  return { id, name, animated };
}

// ── setGuildEmoji / clearGuildEmoji ───────────────────────────────────────────

describe("EmojiCatalog: guild emoji CRUD", () => {
  it("setGuildEmoji replaces the entire guild set", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "wave"), makeEmoji("2", "smile")]);
    assert.equal(cat.getSendableEmoji("g1").length, 2);

    // Replace with a different set
    cat.setGuildEmoji("g1", [makeEmoji("3", "cry")]);
    const result = cat.getSendableEmoji("g1");
    assert.equal(result.length, 1);
    assert.equal(result[0]?.shortcode, "cry");
  });

  it("setGuildEmoji for different guilds are independent", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "wave")]);
    cat.setGuildEmoji("g2", [makeEmoji("2", "cry"), makeEmoji("3", "smile")]);

    assert.equal(cat.getSendableEmoji("g1").length, 1);
    assert.equal(cat.getSendableEmoji("g2").length, 2);
  });

  it("clearGuildEmoji removes the guild", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "wave")]);
    cat.clearGuildEmoji("g1");
    assert.equal(cat.getSendableEmoji("g1").length, 0);
  });

  it("clearGuildEmoji on non-existent guild is a no-op", () => {
    const cat = new EmojiCatalog();
    assert.doesNotThrow(() => cat.clearGuildEmoji("ghost"));
  });
});

// ── setAppEmoji ───────────────────────────────────────────────────────────────

describe("EmojiCatalog: app emoji", () => {
  it("setAppEmoji populates global sendable set", () => {
    const cat = new EmojiCatalog();
    cat.setAppEmoji([makeEmoji("10", "star"), makeEmoji("11", "rocket")]);
    const result = cat.getSendableEmoji(undefined);
    assert.equal(result.length, 2);
    assert.ok(result.some((e) => e.shortcode === "star"));
    assert.ok(result.some((e) => e.shortcode === "rocket"));
  });

  it("setAppEmoji replaces the previous set (not additive)", () => {
    const cat = new EmojiCatalog();
    cat.setAppEmoji([makeEmoji("10", "star")]);
    cat.setAppEmoji([makeEmoji("11", "rocket")]);
    const result = cat.getSendableEmoji(undefined);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.shortcode, "rocket");
  });

  it("app emoji appear in getSendableEmoji even when guildId is provided", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "wave")]);
    cat.setAppEmoji([makeEmoji("10", "star")]);
    const result = cat.getSendableEmoji("g1");
    assert.equal(result.length, 2);
    assert.ok(result.some((e) => e.shortcode === "wave"));
    assert.ok(result.some((e) => e.shortcode === "star"));
  });
});

// ── observeEmoji ─────────────────────────────────────────────────────────────

describe("EmojiCatalog: observeEmoji (observed pairs)", () => {
  it("observed emoji are NOT returned by getSendableEmoji", () => {
    const cat = new EmojiCatalog();
    cat.observeEmoji("999", "pepe", false);
    const result = cat.getSendableEmoji(undefined);
    assert.equal(result.length, 0, "observed emoji must NOT be sendable");
  });

  it("observeEmoji with a guild context: still not sendable", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "wave")]);
    cat.observeEmoji("999", "pepe", false);
    const result = cat.getSendableEmoji("g1");
    assert.equal(result.length, 1, "only guild emoji; observed is excluded");
    assert.equal(result[0]?.shortcode, "wave");
  });
});

// ── getSendableEmoji ordering ─────────────────────────────────────────────────

describe("EmojiCatalog: getSendableEmoji stable sort", () => {
  it("guild emoji appear before app emoji, each group alphabetical", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("2", "zoo"), makeEmoji("1", "apple")]);
    cat.setAppEmoji([makeEmoji("10", "mango"), makeEmoji("11", "banana")]);

    const result = cat.getSendableEmoji("g1").map((e) => e.shortcode);
    // Guild first: apple, zoo; then app: banana, mango
    assert.deepEqual(result, ["apple", "zoo", "banana", "mango"]);
  });

  it("animated flag is preserved", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "fire", true)]);
    const result = cat.getSendableEmoji("g1");
    assert.equal(result[0]?.animated, true);
  });
});

// ── resolve ───────────────────────────────────────────────────────────────────

describe("EmojiCatalog: resolve()", () => {
  it("unicode glyph passes through with kind=unicode", () => {
    const cat = new EmojiCatalog();
    const r = cat.resolve("👍", "g1");
    assert.ok(r !== null);
    assert.equal(r?.kind, "unicode");
    assert.equal((r as { kind: "unicode"; emoji: string }).emoji, "👍");
  });

  it("multi-codepoint unicode glyph passes through", () => {
    const cat = new EmojiCatalog();
    const r = cat.resolve("🏳️‍🌈", undefined);
    assert.ok(r !== null);
    assert.equal(r?.kind, "unicode");
  });

  it(":name: matching a guild emoji returns kind=custom", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("42", "blobfish", false)]);
    const r = cat.resolve(":blobfish:", "g1");
    assert.ok(r !== null);
    assert.equal(r?.kind, "custom");
    const custom = r as { kind: "custom"; id: string; name: string; animated: boolean };
    assert.equal(custom.id, "42");
    assert.equal(custom.name, "blobfish");
    assert.equal(custom.animated, false);
  });

  it(":name: matching an app emoji returns kind=custom", () => {
    const cat = new EmojiCatalog();
    cat.setAppEmoji([makeEmoji("99", "globalstar", true)]);
    const r = cat.resolve(":globalstar:", undefined);
    assert.ok(r !== null);
    assert.equal(r?.kind, "custom");
    const custom = r as { kind: "custom"; id: string; name: string; animated: boolean };
    assert.equal(custom.id, "99");
    assert.equal(custom.animated, true);
  });

  it(":name: falls back to app emoji when not in guild", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "local")]);
    cat.setAppEmoji([makeEmoji("99", "globalstar")]);
    const r = cat.resolve(":globalstar:", "g1");
    assert.ok(r !== null);
    assert.equal(r?.kind, "custom");
    const custom = r as { kind: "custom"; id: string };
    assert.equal(custom.id, "99");
  });

  it("guild emoji takes priority over app emoji with same name", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "star")]);
    cat.setAppEmoji([makeEmoji("99", "star")]);
    const r = cat.resolve(":star:", "g1") as { kind: "custom"; id: string } | null;
    assert.ok(r !== null);
    assert.equal(r?.id, "1", "guild emoji wins over app emoji");
  });

  it(":name: returns null when not in sendable set", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "wave")]);
    const r = cat.resolve(":unknown:", "g1");
    assert.equal(r, null);
  });

  it("observed emoji are not resolvable via :name:", () => {
    const cat = new EmojiCatalog();
    cat.observeEmoji("999", "pepe", false);
    const r = cat.resolve(":pepe:", undefined);
    assert.equal(r, null, "observed emoji must NOT be resolvable (not sendable)");
  });
});

// ── nearMatches ───────────────────────────────────────────────────────────────

describe("EmojiCatalog: nearMatches()", () => {
  it("returns names containing the query substring (case-insensitive)", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [
      makeEmoji("1", "wave_hello"),
      makeEmoji("2", "wave_bye"),
      makeEmoji("3", "smile"),
    ]);
    const matches = cat.nearMatches("wave", "g1");
    assert.equal(matches.length, 2);
    assert.ok(matches.includes(":wave_hello:"));
    assert.ok(matches.includes(":wave_bye:"));
  });

  it("results are capped at 5", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", Array.from({ length: 10 }, (_, i) => makeEmoji(String(i), `match_${i}`)));
    const matches = cat.nearMatches("match", "g1");
    assert.equal(matches.length, 5);
  });

  it("searches app emoji when guildId undefined", () => {
    const cat = new EmojiCatalog();
    cat.setAppEmoji([makeEmoji("99", "globalstar")]);
    const matches = cat.nearMatches("global", undefined);
    assert.equal(matches.length, 1);
    assert.ok(matches.includes(":globalstar:"));
  });

  it("returns empty array when no matches", () => {
    const cat = new EmojiCatalog();
    cat.setGuildEmoji("g1", [makeEmoji("1", "wave")]);
    const matches = cat.nearMatches("zzz", "g1");
    assert.equal(matches.length, 0);
  });
});

// ── Static helpers ────────────────────────────────────────────────────────────

describe("EmojiCatalog: static helpers", () => {
  it("formatForApi returns name:id format", () => {
    assert.equal(EmojiCatalog.formatForApi("12345", "blobfish"), "blobfish:12345");
  });

  it("normalizedKey returns discord:<id>", () => {
    assert.equal(EmojiCatalog.normalizedKey("42"), "discord:42");
  });
});
