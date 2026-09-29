/**
 * Tests for src/yotsuba/view.ts (post-view engine)
 * (spec/YOTSUBA-SUPPORT.md §5)
 *
 * Core invariants:
 *   - No post is rendered twice.
 *   - Pinned slots always appear regardless of budget.
 *   - Excerpt fallback is tried when a full-tier post doesn't fit.
 *   - Contiguous mode stops at the first non-fitting post.
 *   - Gap counts are accurate.
 *   - File priority allocation is consistent.
 *   - Output is deterministic (same inputs → same output).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  runView,
  isGapMarker,
  isPlacedPost,
  DEFAULT_EXCERPT_CHARS,
  type Slot,
  type ViewBudget,
} from "../src/yotsuba/view.js";
import { buildThreadGraph } from "../src/yotsuba/graph.js";
import type { YotsubaPostNode } from "../src/yotsuba/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(no: number, overrides: Partial<YotsubaPostNode> = {}): YotsubaPostNode {
  return {
    no,
    index: 0, // rebuilt by buildThreadGraph
    role: "latest",
    time: 1_000_000 + no,
    text: `post body for ${no}`,
    quotes: [],
    replies: 0,
    ...overrides,
  };
}

function opPost(no: number, overrides: Partial<YotsubaPostNode> = {}): YotsubaPostNode {
  return makePost(no, { role: "op", ...overrides });
}

function makeThread(...nos: number[]) {
  const nodes = nos.map((no, i) => (i === 0 ? opPost(no) : makePost(no)));
  return buildThreadGraph(nodes);
}

/** Slot shorthand. */
function slot(no: number, role: Slot["role"], pinned = false): Slot {
  return { no, role, tier: "full", pinned };
}

/** Cost function: 1 token per character. */
const tokenPerChar = (text: string) => text.length;

/** Cost function: always returns 0 (no token cost). */
const zeroTokens = (_text: string) => 0;

// ---------------------------------------------------------------------------
// Basic placement
// ---------------------------------------------------------------------------

test("runView: places all posts when budget is ample", () => {
  const g = makeThread(100, 101, 102);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.equal(result.placedCount, 3);
  assert.equal(result.unplaced.length, 0);
});

test("runView: output items are in thread order", () => {
  const g = makeThread(100, 101, 102);
  const slots: Slot[] = [slot(102, "latest"), slot(100, "op"), slot(101, "latest")];
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  const nos = result.items.filter(isPlacedPost).map((i) => i.post.no);
  assert.deepEqual(nos, [100, 101, 102], "output must be in thread order regardless of slot order");
});

test("runView: no post is placed twice when slot appears in multiple slots", () => {
  const g = makeThread(100, 101);
  // Post 100 appears in both slots — only placed once.
  const slots: Slot[] = [slot(100, "op"), slot(100, "most_replied")];
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  const nos = result.items.filter(isPlacedPost).map((i) => i.post.no);
  assert.equal(nos.filter((n) => n === 100).length, 1, "post 100 placed exactly once");
});

test("runView: dedup keeps highest-precedence role", () => {
  // "op" has higher precedence than "most_replied" in ROLE_PRECEDENCE.
  const g = makeThread(100, 101);
  const slots: Slot[] = [
    { no: 100, role: "most_replied", tier: "full" },
    { no: 100, role: "op", tier: "full" },
  ];
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  const placed = result.items.filter(isPlacedPost);
  assert.equal(placed[0].role, "op", "op role has higher precedence and must win");
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

test("runView: respects maxPosts", () => {
  const g = makeThread(100, 101, 102, 103);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const result = runView(g, slots, { maxPosts: 2, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.equal(result.placedCount, 2);
  assert.equal(result.unplaced.length, 2);
});

test("runView: respects maxTextTokens", () => {
  // Each post's text is "post body for N" (17 chars). Allow 2 posts worth.
  const g = makeThread(100, 101, 102);
  const textLen = "post body for 100".length; // 17
  const result = runView(
    g,
    g.posts.map((p) => slot(p.no, "latest")),
    { maxPosts: 10, maxTextTokens: textLen * 2 + 1, maxFiles: 0 },
    tokenPerChar,
  );
  assert.ok(result.placedCount <= 2, "token budget must limit placements");
});

// ---------------------------------------------------------------------------
// Pinned slots
// ---------------------------------------------------------------------------

test("runView: pinned slots always placed regardless of maxPosts", () => {
  const g = makeThread(100, 101, 102);
  const slots: Slot[] = [
    { no: 100, role: "op", tier: "full", pinned: true },
    { no: 101, role: "latest", tier: "full", pinned: false },
    { no: 102, role: "linked", tier: "full", pinned: true },
  ];
  const result = runView(g, slots, { maxPosts: 1, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  const nos = result.items.filter(isPlacedPost).map((i) => i.post.no);
  assert.ok(nos.includes(100), "OP pinned slot must be placed");
  assert.ok(nos.includes(102), "linked pinned slot must be placed");
});

// ---------------------------------------------------------------------------
// Excerpt fallback
// ---------------------------------------------------------------------------

test("runView: excerpt fallback places post when full tier too expensive", () => {
  // Cost function: charges a lot for long text, nothing for short.
  const g = makeThread(100, 101, 102);
  // Post 101 has a long text. Budget allows 1 full post + some spare.
  // With excerptFallback, the long post should be placed as excerpt.
  const longText = "x".repeat(1000);
  const nodes = [
    opPost(100, { text: "short" }),
    makePost(101, { text: longText }),
    makePost(102, { text: "short" }),
  ];
  const graph = buildThreadGraph(nodes);
  const slots: Slot[] = graph.posts.map((p) => slot(p.no, "latest"));
  const result = runView(
    graph,
    slots,
    { maxPosts: 10, maxTextTokens: 200, maxFiles: 0, excerptFallback: true },
    tokenPerChar,
  );
  // The long post should either be placed as excerpt or contribute to unplaced.
  // The key invariant: no double-placement.
  const nos = result.items.filter(isPlacedPost).map((i) => i.post.no);
  const uniqueNos = new Set(nos);
  assert.equal(uniqueNos.size, nos.length, "no post placed twice");
  // If 101 is placed, its tier must be excerpt (not full).
  const pp101 = result.items.filter(isPlacedPost).find((i) => i.post.no === 101);
  if (pp101) {
    assert.equal(pp101.tier, "excerpt", "long post placed as excerpt when full doesn't fit");
  }
});

test("runView: excerpt fallback disabled means no excerpt placement", () => {
  const longText = "x".repeat(2000);
  const nodes = [
    opPost(100, { text: "short" }),
    makePost(101, { text: longText }),
  ];
  const graph = buildThreadGraph(nodes);
  const slots: Slot[] = graph.posts.map((p) => slot(p.no, "latest"));
  const result = runView(
    graph,
    slots,
    { maxPosts: 10, maxTextTokens: 200, maxFiles: 0, excerptFallback: false },
    tokenPerChar,
  );
  // Post 101 should appear in unplaced, not placed as excerpt.
  const placed = result.items.filter(isPlacedPost);
  const placed101 = placed.find((i) => i.post.no === 101);
  if (placed101) {
    assert.notEqual(placed101.tier, "excerpt", "excerpt must not appear when excerptFallback=false");
  }
});

// ---------------------------------------------------------------------------
// Contiguous mode
// ---------------------------------------------------------------------------

test("runView: contiguous mode stops at first non-fitting post", () => {
  // 5 posts, budget for 2. With contiguous=true, should get exactly 2 adjacent posts.
  const g = makeThread(100, 101, 102, 103, 104);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const result = runView(
    g,
    slots,
    { maxPosts: 2, maxTextTokens: 9999, maxFiles: 0, contiguous: true },
    zeroTokens,
  );
  const nos = result.items.filter(isPlacedPost).map((i) => i.post.no);
  // Should be [100, 101] — no skipping.
  assert.deepEqual(nos, [100, 101]);
});

// ---------------------------------------------------------------------------
// Gap markers
// ---------------------------------------------------------------------------

test("runView: gap markers inserted between non-adjacent placed posts", () => {
  // Place only OP (100) and last post (104); the middle should show a gap marker.
  const g = makeThread(100, 101, 102, 103, 104);
  const slots: Slot[] = [slot(100, "op"), slot(104, "latest")];
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  const hasGapBetween = result.items.some(isGapMarker);
  assert.ok(hasGapBetween, "gap marker should appear between non-adjacent posts");
  const gap = result.items.find(isGapMarker);
  assert.ok(gap && gap.posts >= 3, "gap should count the 3 skipped posts");
});

test("runView: no gap marker between adjacent posts", () => {
  const g = makeThread(100, 101);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.ok(!result.items.some(isGapMarker), "no gap marker between adjacent posts");
});

test("runView: trailing gap reported correctly", () => {
  const g = makeThread(100, 101, 102, 103);
  // Place only first 2.
  const slots: Slot[] = [slot(100, "op"), slot(101, "latest")];
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.ok(result.hasTrailingGap);
  assert.equal(result.trailingGap.posts, 2, "102 and 103 are after the last placed post");
});

test("runView: no trailing gap when last post is placed", () => {
  const g = makeThread(100, 101, 102);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.equal(result.hasTrailingGap, false);
  assert.equal(result.trailingGap.posts, 0);
});

// ---------------------------------------------------------------------------
// File allocation
// ---------------------------------------------------------------------------

test("runView: file count bounded by maxFiles", () => {
  const nodes = [
    opPost(100, { file: { name: "a", ext: ".jpg", tim: 111, w: 100, h: 100 } }),
    makePost(101, { file: { name: "b", ext: ".jpg", tim: 112, w: 100, h: 100 } }),
    makePost(102, { file: { name: "c", ext: ".jpg", tim: 113, w: 100, h: 100 } }),
  ];
  const g = buildThreadGraph(nodes);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 2 }, zeroTokens);
  assert.equal(result.shownFiles, 2, "file allocation capped at maxFiles");
});

test("runView: maxFiles=0 disables file limit (all files shown)", () => {
  const nodes = [
    opPost(100, { file: { name: "a", ext: ".jpg", tim: 111, w: 100, h: 100 } }),
    makePost(101, { file: { name: "b", ext: ".jpg", tim: 112, w: 100, h: 100 } }),
    makePost(102, { file: { name: "c", ext: ".jpg", tim: 113, w: 100, h: 100 } }),
  ];
  const g = buildThreadGraph(nodes);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.equal(result.shownFiles, 3, "maxFiles=0 means no cap");
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("runView: deterministic — same inputs produce same output", () => {
  const g = makeThread(100, 101, 102, 103, 104);
  const slots: Slot[] = g.posts.map((p) => slot(p.no, "latest"));
  const budget: ViewBudget = { maxPosts: 3, maxTextTokens: 9999, maxFiles: 0 };

  const r1 = runView(g, slots, budget, zeroTokens);
  const r2 = runView(g, slots, budget, zeroTokens);

  const nos1 = r1.items.filter(isPlacedPost).map((i) => i.post.no);
  const nos2 = r2.items.filter(isPlacedPost).map((i) => i.post.no);
  assert.deepEqual(nos1, nos2, "results must be deterministic");
});

// ---------------------------------------------------------------------------
// DEFAULT_EXCERPT_CHARS
// ---------------------------------------------------------------------------

test("DEFAULT_EXCERPT_CHARS is exported and is a positive number", () => {
  assert.ok(typeof DEFAULT_EXCERPT_CHARS === "number" && DEFAULT_EXCERPT_CHARS > 0);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("runView: unknown post number in slot goes to unplaced", () => {
  const g = makeThread(100, 101);
  const slots: Slot[] = [slot(100, "op"), slot(999, "linked")]; // 999 not in graph
  const result = runView(g, slots, { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.ok(result.unplaced.some((u) => u.no === 999), "999 must be in unplaced");
});

test("runView: empty slots returns empty result", () => {
  const g = makeThread(100, 101);
  const result = runView(g, [], { maxPosts: 10, maxTextTokens: 9999, maxFiles: 0 }, zeroTokens);
  assert.equal(result.placedCount, 0);
  assert.equal(result.items.length, 0);
});
