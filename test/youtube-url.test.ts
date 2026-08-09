/**
 * Tests for src/youtube/url.ts — URL parser + extractor.
 * (spec/YOUTUBE-VIDEO-UNDERSTANDING.md §4; Phase 1 §10)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { extractYouTubeUrls, parseYouTubeUrl } from "../src/youtube/url.js";

// ── parseYouTubeUrl — recognized forms ──────────────────────────────────────

test("parseYouTubeUrl: watch?v= on youtube.com", () => {
  const result = parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
  assert.equal(result.startSec, undefined);
});

test("parseYouTubeUrl: watch?v= without www.", () => {
  const result = parseYouTubeUrl("https://youtube.com/watch?v=dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: watch?v= on m.youtube.com", () => {
  const result = parseYouTubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: watch?v= on music.youtube.com", () => {
  const result = parseYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: youtu.be short link", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: youtu.be with www.", () => {
  const result = parseYouTubeUrl("https://www.youtu.be/dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: /shorts/ form", () => {
  const result = parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: /live/ form", () => {
  const result = parseYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: /embed/ form", () => {
  const result = parseYouTubeUrl("https://www.youtube.com/embed/dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

test("parseYouTubeUrl: http (non-https) works too", () => {
  const result = parseYouTubeUrl("http://www.youtube.com/watch?v=dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
});

// ── t= / start= parameter parsing ───────────────────────────────────────────

test("parseYouTubeUrl: t= plain seconds on watch", () => {
  const result = parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcY&t=123");
  assert.ok(result);
  assert.equal(result.startSec, 123);
});

test("parseYouTubeUrl: t= plain seconds on youtu.be", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY?t=42");
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
  assert.equal(result.startSec, 42);
});

test("parseYouTubeUrl: t= HMS form 1h2m3s", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY?t=1h2m3s");
  assert.ok(result);
  assert.equal(result.startSec, 3600 + 120 + 3); // 3723
});

test("parseYouTubeUrl: t= HMS form 2m30s", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY?t=2m30s");
  assert.ok(result);
  assert.equal(result.startSec, 150);
});

test("parseYouTubeUrl: t= HMS form 45s only", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY?t=45s");
  assert.ok(result);
  assert.equal(result.startSec, 45);
});

test("parseYouTubeUrl: t= HMS form 1h only", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY?t=1h");
  assert.ok(result);
  assert.equal(result.startSec, 3600);
});

test("parseYouTubeUrl: start= alias recognized", () => {
  const result = parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcY&start=90");
  assert.ok(result);
  assert.equal(result.startSec, 90);
});

test("parseYouTubeUrl: t=0 yields startSec 0 (falsy but valid)", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY?t=0");
  assert.ok(result);
  assert.equal(result.startSec, 0);
});

test("parseYouTubeUrl: no t= yields undefined startSec", () => {
  const result = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcY");
  assert.ok(result);
  assert.equal(result.startSec, undefined);
});

// ── video id validation ──────────────────────────────────────────────────────

test("parseYouTubeUrl: rejects video id shorter than 11 chars", () => {
  assert.equal(parseYouTubeUrl("https://youtu.be/short"), null);
});

test("parseYouTubeUrl: rejects video id longer than 11 chars", () => {
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcYextra"), null);
});

test("parseYouTubeUrl: rejects video id with invalid chars", () => {
  // Contain spaces or special characters that aren't [A-Za-z0-9_-]
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgX!Y"), null);
  assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgX Y"), null);
});

test("parseYouTubeUrl: accepts all valid id chars including _ and -", () => {
  // _-dQw4w9WgX has exactly 11 chars: 2 special + 9 alphanum
  const result = parseYouTubeUrl("https://youtu.be/_-dQw4w9WgX");
  assert.ok(result);
  assert.equal(result.videoId, "_-dQw4w9WgX");
});

// ── rejections (non-video URLs) ───────────────────────────────────────────────

test("parseYouTubeUrl: rejects channel URLs", () => {
  assert.equal(parseYouTubeUrl("https://www.youtube.com/@SomeChannel"), null);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/channel/UCxxxxxx"), null);
  assert.equal(parseYouTubeUrl("https://www.youtube.com/c/SomeChannel"), null);
});

test("parseYouTubeUrl: rejects playlist URLs", () => {
  assert.equal(
    parseYouTubeUrl("https://www.youtube.com/playlist?list=PLabcdefg123"),
    null,
  );
});

test("parseYouTubeUrl: rejects search result URLs", () => {
  assert.equal(
    parseYouTubeUrl("https://www.youtube.com/results?search_query=cats"),
    null,
  );
});

test("parseYouTubeUrl: rejects youtube.com homepage", () => {
  assert.equal(parseYouTubeUrl("https://www.youtube.com/"), null);
  assert.equal(parseYouTubeUrl("https://www.youtube.com"), null);
});

test("parseYouTubeUrl: rejects non-YouTube URLs", () => {
  assert.equal(parseYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcY"), null);
  assert.equal(parseYouTubeUrl("https://youtu.be.evil.com/dQw4w9WgXcY"), null);
  assert.equal(parseYouTubeUrl("https://notyoutube.com/watch?v=dQw4w9WgXcY"), null);
});

test("parseYouTubeUrl: rejects ftp:// and non-http protocols", () => {
  assert.equal(parseYouTubeUrl("ftp://www.youtube.com/watch?v=dQw4w9WgXcY"), null);
});

test("parseYouTubeUrl: rejects bare video id strings (no URL context)", () => {
  // Unlike x-status which accepts bare IDs, YouTube IDs clash with too many
  // other tokens, so we require a URL.
  assert.equal(parseYouTubeUrl("dQw4w9WgXcY"), null);
  assert.equal(parseYouTubeUrl("not a url"), null);
});

test("parseYouTubeUrl: rejects unknown subdomain patterns", () => {
  // Only www., m., music. are accepted.
  assert.equal(parseYouTubeUrl("https://api.youtube.com/watch?v=dQw4w9WgXcY"), null);
  assert.equal(parseYouTubeUrl("https://evil.youtube.com/watch?v=dQw4w9WgXcY"), null);
});

// ── watch URL extra params ────────────────────────────────────────────────────

test("parseYouTubeUrl: ignores extra query params after v=", () => {
  const result = parseYouTubeUrl(
    "https://www.youtube.com/watch?v=dQw4w9WgXcY&feature=shared&si=AbCdEfGhIjK",
  );
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
  assert.equal(result.startSec, undefined);
});

test("parseYouTubeUrl: picks up t= alongside other params", () => {
  const result = parseYouTubeUrl(
    "https://www.youtube.com/watch?v=dQw4w9WgXcY&feature=shared&t=300&si=abc",
  );
  assert.ok(result);
  assert.equal(result.videoId, "dQw4w9WgXcY");
  assert.equal(result.startSec, 300);
});

// ── extractYouTubeUrls ────────────────────────────────────────────────────────

test("extractYouTubeUrls: finds multiple URLs, dedupes by video id", () => {
  const body =
    "check https://youtu.be/dQw4w9WgXcY and also " +
    "https://www.youtube.com/watch?v=dQw4w9WgXcY&t=30 " +
    "and a different one https://youtu.be/abcdefghijk";
  const results = extractYouTubeUrls(body);
  assert.equal(results.length, 2);
  assert.equal(results[0].videoId, "dQw4w9WgXcY");
  // First occurrence wins — no t= on the first URL
  assert.equal(results[0].startSec, undefined);
  assert.equal(results[1].videoId, "abcdefghijk");
  assert.ok(results[0].bodyIndex < results[1].bodyIndex);
});

test("extractYouTubeUrls: empty result when no YouTube URLs found", () => {
  assert.deepEqual(extractYouTubeUrls("see https://example.com/page"), []);
});

test("extractYouTubeUrls: includes rawUrl and bodyIndex", () => {
  const body = "watch https://youtu.be/dQw4w9WgXcY now";
  const [match] = extractYouTubeUrls(body);
  assert.ok(match);
  assert.equal(match.rawUrl, "https://youtu.be/dQw4w9WgXcY");
  assert.equal(match.bodyIndex, 6); // after "watch "
});
