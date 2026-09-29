/**
 * Tests for src/yotsuba/url.ts
 * (spec/YOTSUBA-SUPPORT.md §4.1)
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  isYotsubaHost,
  parseYotsubaUrl,
  extractYotsubaRefs,
  stripYotsubaUrls,
  parseToolInput,
  yotsubaRefKey,
  YOTSUBA_BASE_HOSTS,
} from "../src/yotsuba/url.js";

// ---------------------------------------------------------------------------
// isYotsubaHost
// ---------------------------------------------------------------------------

test("isYotsubaHost: accepts canonical hosts", () => {
  for (const h of YOTSUBA_BASE_HOSTS) {
    assert.ok(isYotsubaHost(h), `expected ${h} to be accepted`);
  }
});

test("isYotsubaHost: accepts subdomains", () => {
  assert.ok(isYotsubaHost("i.4chan.org"));
  assert.ok(isYotsubaHost("s.4chan.org"));
});

test("isYotsubaHost: rejects lookalikes", () => {
  assert.equal(isYotsubaHost("evil4chan.org"), false);
  assert.equal(isYotsubaHost("4chan.org.evil.com"), false);
  assert.equal(isYotsubaHost("not4chan.org"), false);
});

test("isYotsubaHost: accepts extra_hosts", () => {
  assert.ok(isYotsubaHost("my.archive.example.com", ["archive.example.com"]));
  assert.equal(isYotsubaHost("archive.example.com.evil.com", ["archive.example.com"]), false);
});

test("isYotsubaHost: case-insensitive", () => {
  assert.ok(isYotsubaHost("BOARDS.4CHAN.ORG"));
});

// ---------------------------------------------------------------------------
// parseYotsubaUrl — thread forms
// ---------------------------------------------------------------------------

test("parseYotsubaUrl: plain thread URL", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/thread/109934266");
  assert.ok(ref);
  assert.equal(ref.kind, "thread");
  assert.equal(ref.board, "g");
  assert.equal((ref as { threadNo: number }).threadNo, 109934266);
  assert.equal((ref as { postNo?: number }).postNo, undefined);
});

test("parseYotsubaUrl: thread with post anchor", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/thread/109934266#p109934500");
  assert.ok(ref && ref.kind === "thread");
  assert.equal(ref.threadNo, 109934266);
  assert.equal(ref.postNo, 109934500);
});

test("parseYotsubaUrl: thread anchor equal to thread number is dropped (plain thread ref)", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/thread/109934266#p109934266");
  assert.ok(ref && ref.kind === "thread");
  assert.equal(ref.postNo, undefined, "OP anchor should be normalized away");
});

test("parseYotsubaUrl: thread URL with slug", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/thread/109934266/local-models-general");
  assert.ok(ref && ref.kind === "thread");
  assert.equal(ref.threadNo, 109934266);
});

test("parseYotsubaUrl: 4channel.org thread", () => {
  const ref = parseYotsubaUrl("https://boards.4channel.org/v/thread/666000000");
  assert.ok(ref && ref.kind === "thread");
  assert.equal(ref.board, "v");
  assert.equal(ref.threadNo, 666000000);
});

test("parseYotsubaUrl: canonical URL uses siteBase default", () => {
  const ref = parseYotsubaUrl("https://boards.4channel.org/g/thread/109934266");
  assert.ok(ref && ref.kind === "thread");
  assert.equal(ref.canonicalUrl, "https://boards.4chan.org/g/thread/109934266");
});

test("parseYotsubaUrl: custom siteBase used in canonical", () => {
  const ref = parseYotsubaUrl(
    "https://boards.4chan.org/g/thread/109934266",
    [],
    "https://archive.example.com",
  );
  assert.ok(ref && ref.kind === "thread");
  assert.ok(ref.canonicalUrl.startsWith("https://archive.example.com/"));
});

// ---------------------------------------------------------------------------
// parseYotsubaUrl — board forms
// ---------------------------------------------------------------------------

test("parseYotsubaUrl: board URL with trailing slash", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/");
  assert.ok(ref && ref.kind === "board");
  assert.equal(ref.board, "g");
});

test("parseYotsubaUrl: board catalog URL", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/catalog");
  assert.ok(ref && ref.kind === "board");
  assert.equal(ref.board, "g");
});

test("parseYotsubaUrl: board page URL", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/2");
  assert.ok(ref && ref.kind === "board");
  assert.equal(ref.board, "g");
});

// ---------------------------------------------------------------------------
// parseYotsubaUrl — rejections
// ---------------------------------------------------------------------------

test("parseYotsubaUrl: non-4chan domain returns null", () => {
  assert.equal(parseYotsubaUrl("https://example.com/g/thread/123"), null);
});

test("parseYotsubaUrl: non-http protocol returns null", () => {
  assert.equal(parseYotsubaUrl("ftp://boards.4chan.org/g/"), null);
});

test("parseYotsubaUrl: completely unrelated URL returns null", () => {
  assert.equal(parseYotsubaUrl("https://google.com"), null);
});

test("parseYotsubaUrl: malformed string returns null", () => {
  assert.equal(parseYotsubaUrl("not-a-url"), null);
});

// ---------------------------------------------------------------------------
// extractYotsubaRefs
// ---------------------------------------------------------------------------

test("extractYotsubaRefs: finds thread link in body", () => {
  const body = "Check out https://boards.4chan.org/g/thread/109934266 — cool thread";
  const refs = extractYotsubaRefs(body);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].kind, "thread");
  assert.equal((refs[0] as { threadNo: number }).threadNo, 109934266);
  assert.ok(refs[0].bodyIndex >= 0);
});

test("extractYotsubaRefs: deduplicates same thread (first occurrence wins)", () => {
  const body =
    "https://boards.4chan.org/g/thread/100 then https://boards.4chan.org/g/thread/100#p200";
  const refs = extractYotsubaRefs(body);
  assert.equal(refs.length, 2, "thread ref and post ref are distinct keys");
});

test("extractYotsubaRefs: deduplicates exact duplicates", () => {
  const body =
    "https://boards.4chan.org/g/thread/100 and https://boards.4chan.org/g/thread/100 again";
  const refs = extractYotsubaRefs(body);
  assert.equal(refs.length, 1);
});

test("extractYotsubaRefs: empty body returns empty array", () => {
  assert.deepEqual(extractYotsubaRefs(""), []);
});

test("extractYotsubaRefs: ignores non-4chan URLs", () => {
  const refs = extractYotsubaRefs("see https://example.com/foo");
  assert.equal(refs.length, 0);
});

// ---------------------------------------------------------------------------
// stripYotsubaUrls
// ---------------------------------------------------------------------------

test("stripYotsubaUrls: removes recognized 4chan URLs", () => {
  const body = "thread: https://boards.4chan.org/g/thread/123 here";
  const stripped = stripYotsubaUrls(body);
  assert.ok(!stripped.includes("boards.4chan.org"), "URL should be removed");
  assert.ok(stripped.includes("thread:"), "surrounding text should remain");
});

test("stripYotsubaUrls: leaves non-4chan URLs intact", () => {
  const body = "see https://example.com/foo for details";
  assert.equal(stripYotsubaUrls(body), body);
});

// ---------------------------------------------------------------------------
// parseToolInput
// ---------------------------------------------------------------------------

test("parseToolInput: full thread URL", () => {
  const r = parseToolInput("https://boards.4chan.org/g/thread/109934266");
  assert.ok(r);
  assert.equal(r.board, "g");
  assert.equal(r.threadNo, 109934266);
  assert.equal(r.postNo, undefined);
});

test("parseToolInput: bare number treated as thread number", () => {
  const r = parseToolInput("109934266");
  assert.ok(r);
  assert.equal(r.threadNo, 109934266);
});

test("parseToolInput: >>N notation", () => {
  const r = parseToolInput(">>109934266");
  assert.ok(r);
  assert.equal(r.threadNo, 109934266);
});

test("parseToolInput: >>>/b/123 cross-board notation", () => {
  const r = parseToolInput(">>>/g/109934266");
  assert.ok(r);
  assert.equal(r.board, "g");
  assert.equal(r.postNo, 109934266);
  assert.equal(r.isCrossQuote, true);
});

test("parseToolInput: board code /g/", () => {
  const r = parseToolInput("/g/");
  assert.ok(r);
  assert.equal(r.board, "g");
  assert.equal(r.threadNo, undefined);
});

test("parseToolInput: bare board code g", () => {
  const r = parseToolInput("g");
  assert.ok(r);
  assert.equal(r.board, "g");
});

test("parseToolInput: empty string returns null", () => {
  assert.equal(parseToolInput(""), null);
});

test("parseToolInput: whitespace only returns null", () => {
  assert.equal(parseToolInput("   "), null);
});

// ---------------------------------------------------------------------------
// yotsubaRefKey
// ---------------------------------------------------------------------------

test("yotsubaRefKey: thread ref produces stable key", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/thread/109934266#p109934500")!;
  assert.ok(ref);
  const key = yotsubaRefKey({ ...ref, bodyIndex: 0 });
  assert.equal(key, "thread:g:109934266:109934500");
});

test("yotsubaRefKey: board ref produces stable key", () => {
  const ref = parseYotsubaUrl("https://boards.4chan.org/g/")!;
  assert.ok(ref);
  const key = yotsubaRefKey({ ...ref, bodyIndex: 0 });
  assert.equal(key, "board:g");
});
