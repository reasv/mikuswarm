/**
 * Tests for src/yotsuba/markup.ts
 * (spec/YOTSUBA-SUPPORT.md §4.4)
 */

import assert from "node:assert/strict";
import test from "node:test";
import { convertComment, annotateQuotes } from "../src/yotsuba/markup.js";

// ---------------------------------------------------------------------------
// Basic conversions
// ---------------------------------------------------------------------------

test("convertComment: empty/null/undefined input", () => {
  assert.deepEqual(convertComment(null), { text: "", quotes: [] });
  assert.deepEqual(convertComment(undefined), { text: "", quotes: [] });
  assert.deepEqual(convertComment(""), { text: "", quotes: [] });
});

test("convertComment: plain text with no HTML", () => {
  const r = convertComment("hello world");
  assert.equal(r.text, "hello world");
  assert.deepEqual(r.quotes, []);
});

test("convertComment: <br> becomes newline", () => {
  const r = convertComment("line one<br>line two");
  assert.equal(r.text, "line one\nline two");
});

test("convertComment: <wbr> is removed with no whitespace", () => {
  const r = convertComment("long<wbr>word");
  assert.equal(r.text, "longword");
});

test("convertComment: HTML entities are decoded", () => {
  const r = convertComment("it&#039;s &amp; &lt;nice&gt; &quot;yes&quot;");
  assert.equal(r.text, "it's & <nice> \"yes\"");
});

// ---------------------------------------------------------------------------
// Quotelinks
// ---------------------------------------------------------------------------

test("convertComment: same-thread quotelink extracted", () => {
  const html = '<a href="#p109933635" class="quotelink">&gt;&gt;109933635</a>';
  const r = convertComment(html);
  assert.ok(r.text.includes(">>109933635"), "quotelink text preserved");
  assert.deepEqual(r.quotes, [109933635]);
  assert.equal(r.deadQuotes, undefined);
});

test("convertComment: multiple quotelinks collected", () => {
  const html =
    '<a href="#p100" class="quotelink">&gt;&gt;100</a><br>' +
    '<a href="#p200" class="quotelink">&gt;&gt;200</a>';
  const r = convertComment(html);
  assert.deepEqual(r.quotes, [100, 200]);
});

test("convertComment: deadlink collected in deadQuotes not quotes", () => {
  const html = '<span class="deadlink">&gt;&gt;99999</span>';
  const r = convertComment(html);
  assert.ok(r.text.includes(">>99999"));
  assert.deepEqual(r.quotes, []);
  assert.deepEqual(r.deadQuotes, [99999]);
});

test("convertComment: cross-thread quotelink extracted", () => {
  // 4chan uses relative paths: /b/thread/12345#p12345 (not full URLs).
  const html = '<a href="/b/thread/12345#p12345" class="quotelink">&gt;&gt;&gt;/b/12345</a>';
  const r = convertComment(html);
  assert.ok(r.text.includes(">>>/b/12345"));
  assert.deepEqual(r.quotes, []);
  assert.ok(Array.isArray(r.crossQuotes) && r.crossQuotes.includes(">>>/b/12345"));
});

// ---------------------------------------------------------------------------
// Greentext
// ---------------------------------------------------------------------------

test("convertComment: greentext line keeps leading >", () => {
  const html = '<span class="quote">&gt;be me</span>';
  const r = convertComment(html);
  assert.ok(r.text.includes(">be me"));
});

// ---------------------------------------------------------------------------
// Spoilers
// ---------------------------------------------------------------------------

test("convertComment: spoiler wrapped in [spoiler]…[/spoiler]", () => {
  const html = '<s>hidden text</s>';
  const r = convertComment(html);
  assert.equal(r.text, "[spoiler]hidden text[/spoiler]");
});

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

test("convertComment: prettyprint code fenced with backticks", () => {
  const html = '<pre class="prettyprint">let x = 1;</pre>';
  const r = convertComment(html);
  assert.ok(r.text.includes("```"), "code block must be fenced");
  assert.ok(r.text.includes("let x = 1;"));
});

// ---------------------------------------------------------------------------
// Mod text
// ---------------------------------------------------------------------------

test("convertComment: strong.warning-text wrapped in [mod: …]", () => {
  const html = '<strong class="warning-text">USER WAS BANNED FOR THIS POST</strong>';
  const r = convertComment(html);
  assert.ok(r.text.includes("[mod:"), "mod marker must appear");
  assert.ok(r.text.includes("USER WAS BANNED FOR THIS POST"));
});

// ---------------------------------------------------------------------------
// Complex sample (realistic API com field)
// ---------------------------------------------------------------------------

test("convertComment: realistic quoting thread post", () => {
  const html =
    '<a href="#p109933635" class="quotelink">&gt;&gt;109933635</a><br>' +
    '<span class="quote">&gt;soft skills</span><br>' +
    'yeah no';
  const r = convertComment(html);
  assert.ok(r.text.includes(">>109933635"));
  assert.ok(r.text.includes(">soft skills"));
  assert.ok(r.text.includes("yeah no"));
  assert.deepEqual(r.quotes, [109933635]);
});

// ---------------------------------------------------------------------------
// annotateQuotes
// ---------------------------------------------------------------------------

test("annotateQuotes: marks OP quote when the OP is not shown", () => {
  const text = "see >>100 for more";
  const annotated = annotateQuotes(text, new Set([200]), 100, new Set());
  assert.ok(annotated.includes(">>100 (OP)"));
});

test("annotateQuotes: leaves a quote of a shown OP bare (spec §5.4)", () => {
  const text = "see >>100 for more";
  const annotated = annotateQuotes(text, new Set([100, 200]), 100, new Set());
  assert.equal(annotated, "see >>100 for more");
});

test("annotateQuotes: marks not-shown post", () => {
  const text = ">>999 is relevant";
  const annotated = annotateQuotes(text, new Set([100]), 100, new Set());
  assert.ok(annotated.includes(">>999 (not shown)"));
});

test("annotateQuotes: marks deleted post", () => {
  const text = ">>888 was good";
  const annotated = annotateQuotes(text, new Set([100]), 100, new Set([888]));
  assert.ok(annotated.includes(">>888 (deleted)"));
});

test("annotateQuotes: shown non-OP post gets no annotation", () => {
  const text = "see >>200";
  const annotated = annotateQuotes(text, new Set([100, 200]), 100, new Set());
  assert.ok(!annotated.includes("(OP)"));
  assert.ok(!annotated.includes("(not shown)"));
  assert.ok(!annotated.includes("(deleted)"));
});

test("annotateQuotes: plain text with no >>N is returned unchanged", () => {
  const text = "hello world";
  assert.equal(annotateQuotes(text, new Set([1]), 1, new Set()), text);
});
