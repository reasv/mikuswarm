import assert from "node:assert/strict";
import test from "node:test";

import { assertBrowserUrl } from "../src/browser/url-policy.js";
import { isBrowserError } from "../src/browser/errors.js";

// ── #17: assertBrowserUrl is the tool-layer scheme allowlist (spec §5.5) ─────
//
// Table-driven coverage of the http/https-only boundary. This is defense-in-
// depth on top of the network-layer RFC1918 block, so it must reject every
// non-http(s) scheme (file:, javascript:, data:, chrome:, blob:, about:, …),
// be case-insensitive on the scheme, and reject non-URL garbage — all as
// `bad_url`.

const ACCEPT_CASES: Array<{ name: string; input: string; expected: string }> = [
  { name: "http", input: "http://example.com", expected: "http://example.com/" },
  { name: "https", input: "https://example.com", expected: "https://example.com/" },
  // Scheme + host are lower-cased by URL parsing, so a mixed/upper-case URL is
  // accepted and normalized rather than rejected.
  { name: "mixed-case HTTPS", input: "HTTPS://EXAMPLE.COM", expected: "https://example.com/" },
];

for (const { name, input, expected } of ACCEPT_CASES) {
  test(`assertBrowserUrl: accepts ${name} (#17)`, () => {
    assert.equal(assertBrowserUrl(input), expected);
  });
}

// Every rejection must throw a BrowserError with code `bad_url` — the exact
// code the model and observability branch on. Includes the empirically-verified
// ambiguous cases (see notes per entry).
const REJECT_CASES: Array<{ name: string; input: string }> = [
  { name: "file://", input: "file:///etc/passwd" },
  { name: "javascript:", input: "javascript:alert(1)" },
  { name: "data:", input: "data:text/html,x" },
  { name: "chrome://", input: "chrome://settings" },
  { name: "blob:", input: "blob:http://x" },
  { name: "about:blank", input: "about:blank" },
  // Scheme matching is case-insensitive (URL lower-cases the protocol), so an
  // upper-case FILE:// is still caught as a blocked scheme.
  { name: "mixed-case FILE://", input: "FILE://x" },
  // new URL() strips surrounding ASCII whitespace before parsing, so a padded
  // file:// still parses to the file: scheme and is rejected as a scheme
  // violation (NOT a parse error). assertBrowserUrl does no trimming of its own.
  { name: "whitespace-padded file://", input: "  file://x  " },
  // Non-URL garbage fails URL parsing entirely → bad_url ("not a valid URL").
  { name: "non-URL garbage", input: "not a url" },
  // "localhost:8080" parses with protocol "localhost:" (NOT host:port), so it is
  // rejected as a blocked scheme — not silently accepted as an http host.
  { name: "host:port without scheme", input: "localhost:8080" },
];

for (const { name, input } of REJECT_CASES) {
  test(`assertBrowserUrl: rejects ${name} as bad_url (#17)`, () => {
    assert.throws(
      () => assertBrowserUrl(input),
      (err: unknown) => isBrowserError(err) && err.code === "bad_url",
      `${name} must throw a BrowserError("bad_url")`,
    );
  });
}
