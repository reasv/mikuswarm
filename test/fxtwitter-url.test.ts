import assert from "node:assert/strict";
import test from "node:test";
import { extractXStatusUrls, parseXStatusUrl, stripXStatusUrls } from "../src/fxtwitter/url.js";

// ── parseXStatusUrl ──────────────────────────────────────────────────────────

test("parseXStatusUrl recognizes x.com and twitter.com status forms", () => {
  for (const url of [
    "https://x.com/FRIERENanime_/status/2065147052665737270",
    "https://www.x.com/FRIERENanime_/status/2065147052665737270",
    "https://twitter.com/FRIERENanime_/status/2065147052665737270",
    "https://www.twitter.com/FRIERENanime_/status/2065147052665737270",
    "https://mobile.twitter.com/FRIERENanime_/status/2065147052665737270",
  ]) {
    const parsed = parseXStatusUrl(url);
    assert.ok(parsed, `recognizes ${url}`);
    assert.equal(parsed.statusId, "2065147052665737270");
    assert.equal(parsed.screenName, "frierenanime_");
    assert.equal(parsed.canonicalUrl, "https://x.com/frierenanime_/status/2065147052665737270");
  }
});

test("parseXStatusUrl recognizes FxTwitter share domains", () => {
  for (const host of ["fxtwitter.com", "fixupx.com", "fixvx.com", "twittpr.com", "www.fxtwitter.com"]) {
    const parsed = parseXStatusUrl(`https://${host}/someone/status/123456`);
    assert.ok(parsed, `recognizes ${host}`);
    assert.equal(parsed.statusId, "123456");
  }
});

test("parseXStatusUrl recognizes the extended mirror domains", () => {
  for (const host of [
    "vxtwitter.com",
    "pxtwitter.com",
    "girlcockx.com",
    "stupidpenisx.com",
    "cunnyx.com",
  ]) {
    const parsed = parseXStatusUrl(`https://${host}/someone/status/123456`);
    assert.ok(parsed, `recognizes ${host}`);
    assert.equal(parsed.statusId, "123456");
    assert.equal(parsed.canonicalUrl, "https://x.com/someone/status/123456");
  }
});

test("parseXStatusUrl matches arbitrary subdomains of a recognized base", () => {
  for (const url of [
    "https://d.fxtwitter.com/u/status/777",
    "https://g.fxtwitter.com/u/status/777",
    "https://m.twitter.com/u/status/777",
    "https://www.vxtwitter.com/u/status/777",
  ]) {
    assert.equal(parseXStatusUrl(url)?.statusId, "777", `recognizes ${url}`);
  }
});

test("parseXStatusUrl does not false-positive on lookalike hosts", () => {
  assert.equal(parseXStatusUrl("https://notfxtwitter.com/u/status/1"), null);
  assert.equal(parseXStatusUrl("https://evilx.com/u/status/1"), null);
  assert.equal(parseXStatusUrl("https://x.com.evil.com/u/status/1"), null);
  assert.equal(parseXStatusUrl("https://fxtwitter.com.evil.com/u/status/1"), null);
});

test("parseXStatusUrl honors an extended bases set (extra_status_hosts)", () => {
  const url = "https://newmirror.example/u/status/55";
  assert.equal(parseXStatusUrl(url), null, "unknown by default");
  const withExtra = parseXStatusUrl(url, ["x.com", "newmirror.example"]);
  assert.equal(withExtra?.statusId, "55");
  assert.equal(withExtra?.canonicalUrl, "https://x.com/u/status/55");
  // Subdomain tolerance applies to extras too.
  assert.equal(
    parseXStatusUrl("https://a.newmirror.example/u/status/55", ["newmirror.example"])?.statusId,
    "55",
  );
});

test("extractXStatusUrls / stripXStatusUrls honor a custom bases set", () => {
  const body = "x https://newmirror.example/u/status/9 y https://x.com/u/status/10";
  const bases = ["x.com", "newmirror.example"];
  const refs = extractXStatusUrls(body, bases);
  assert.equal(refs.length, 2);
  const stripped = stripXStatusUrls(body, bases);
  assert.ok(!stripped.includes("newmirror.example"), "extra-host URL stripped");
  assert.ok(!stripped.includes("x.com/u/status"), "x.com URL stripped");
});

test("parseXStatusUrl recognizes /i/status and /i/web/status forms", () => {
  const a = parseXStatusUrl("https://x.com/i/status/9000");
  assert.ok(a);
  assert.equal(a.screenName, undefined);
  assert.equal(a.canonicalUrl, "https://x.com/i/status/9000");

  const b = parseXStatusUrl("https://twitter.com/i/web/status/9000");
  assert.ok(b);
  assert.equal(b.canonicalUrl, "https://x.com/i/status/9000");
});

test("parseXStatusUrl tolerates query strings and trailing media segments", () => {
  const a = parseXStatusUrl("https://x.com/user/status/42?s=20&t=abc");
  assert.equal(a?.statusId, "42");
  const b = parseXStatusUrl("https://x.com/user/status/42/photo/1");
  assert.equal(b?.statusId, "42");
});

test("parseXStatusUrl accepts a bare numeric status id", () => {
  const parsed = parseXStatusUrl("2065147052665737270");
  assert.ok(parsed);
  assert.equal(parsed.statusId, "2065147052665737270");
  assert.equal(parsed.canonicalUrl, "https://x.com/i/status/2065147052665737270");
});

test("parseXStatusUrl rejects non-status X URLs and other hosts", () => {
  assert.equal(parseXStatusUrl("https://x.com/FRIERENanime_"), null);
  assert.equal(parseXStatusUrl("https://x.com/i/lists/123"), null);
  assert.equal(parseXStatusUrl("https://x.com/user/status/notdigits"), null);
  assert.equal(parseXStatusUrl("https://example.com/user/status/123"), null);
  assert.equal(parseXStatusUrl("https://nitter.net/user/status/123"), null);
  assert.equal(parseXStatusUrl("ftp://x.com/user/status/123"), null);
  assert.equal(parseXStatusUrl("not a url"), null);
});

// ── extractXStatusUrls ───────────────────────────────────────────────────────

test("extractXStatusUrls dedupes by status id, first occurrence wins", () => {
  const body =
    "look https://x.com/a/status/111 and again https://twitter.com/a/status/111 plus https://x.com/b/status/222";
  const refs = extractXStatusUrls(body);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].statusId, "111");
  assert.equal(refs[0].rawUrl, "https://x.com/a/status/111");
  assert.equal(refs[1].statusId, "222");
  assert.ok(refs[0].bodyIndex < refs[1].bodyIndex, "ordered by first appearance");
});

test("extractXStatusUrls ignores non-status URLs", () => {
  const refs = extractXStatusUrls("see https://example.com/page and https://x.com/profile");
  assert.equal(refs.length, 0);
});

// ── stripXStatusUrls ─────────────────────────────────────────────────────────

test("stripXStatusUrls removes every X status match but keeps other URLs", () => {
  const body =
    "a https://x.com/a/status/111 b https://example.com/page c https://twitter.com/a/status/111?s=20 d";
  const stripped = stripXStatusUrls(body);
  assert.ok(!stripped.includes("x.com/a/status"), "x.com form stripped");
  assert.ok(!stripped.includes("twitter.com/a/status"), "twitter.com duplicate stripped too");
  assert.ok(stripped.includes("https://example.com/page"), "other URLs survive");
});
