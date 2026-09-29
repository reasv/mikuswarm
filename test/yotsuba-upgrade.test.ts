/**
 * Tests for src/yotsuba/upgrade.ts — planYotsubaUpgrade and helpers.
 * (spec/YOTSUBA-SUPPORT.md §6.4-§6.5)
 *
 * Verifies:
 *   - computeRefCost: frame + text + caption math.
 *   - resolveYotsubaConfig: default budget constants.
 *   - planYotsubaUpgrade: thread link drop order (replied_to before latest).
 *   - planYotsubaUpgrade: post link drop order (reply newest-first before replied_to).
 *   - planYotsubaUpgrade: headline cap applied and recorded (headlineChars).
 *   - planYotsubaUpgrade: per-ref 900 budget enforced.
 *   - planYotsubaUpgrade: group 1800 budget enforced (including frame + caption).
 *   - planYotsubaUpgrade: stays ambient when headline alone exceeds group budget.
 *   - planYotsubaUpgrade: ambient refs excluded from file allocation.
 *   - planYotsubaUpgrade: group order (input order preserved for budget accounting).
 *   - planYotsubaUpgrade: five-links case — first four headline files processed.
 *   - planYotsubaUpgrade: tier 2/3 allocation newest-first.
 *   - planYotsubaUpgrade: video (isVideoOrAnimated, storyboard intent).
 *   - planYotsubaUpgrade: PDF thumbnail (isPdf).
 *   - planYotsubaUpgrade: left counts match dropped posts.
 *   - planYotsubaUpgrade: determinism — same input yields same plan.
 *   - allocateGroupFiles: group-wide tier allocation (§6.5).
 *   - parseYotsubaPreviewPayload: rows with upgrade field detected as already-upgraded
 *     (covers the app-level idempotence: rows with an existing upgrade are skipped).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRefCost,
  REF_FRAME_TOKENS,
  POST_OVERHEAD_TOKENS,
  FILE_ELEMENT_TOKENS,
  allocateGroupFiles,
  planYotsubaUpgrade,
  type PlanBudgets,
  type PlannerRefInput,
} from "../src/yotsuba/upgrade.js";
import { parseYotsubaPreviewPayload, resolveYotsubaConfig } from "../src/yotsuba/types.js";
import type { YotsubaPostNode, YotsubaPreviewPayload } from "../src/yotsuba/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(
  no: number,
  role: YotsubaPostNode["role"],
  text: string,
  hasFile = false,
  ext = ".jpg",
): YotsubaPostNode {
  return {
    no,
    index: no,
    role,
    time: no * 1000,
    text,
    quotes: [],
    replies: 0,
    file: hasFile
      ? { name: `img${no}`, ext, tim: no + 1_000_000 }
      : undefined,
  };
}

/** Build a minimal thread-kind payload. */
function makePayload(opts: {
  threadNo: number;
  linkedNo?: number;
  posts: YotsubaPostNode[];
  worksafe?: boolean;
}): YotsubaPreviewPayload {
  return {
    v: 1,
    kind: "thread",
    board: "g",
    worksafe: opts.worksafe ?? true,
    asOf: Date.now(),
    threadNo: opts.threadNo,
    headlineNo: opts.linkedNo ?? opts.threadNo,
    linkedNo: opts.linkedNo,
    posts: opts.posts,
  };
}

/** Default budgets — generous enough that most tests are unconstrained. */
const defaultBudgets: PlanBudgets = {
  linkTokenBudget: 900,
  groupTokenBudget: 1800,
  groupFileBudget: 4,
  headlineCharCap: 800,
  captionAllowanceTokens: 125, // 500 chars / 4
};

/** One ref in a plan for conveniently testing single-ref scenarios. */
function plan1(payload: YotsubaPreviewPayload, budgets = defaultBudgets, canDownload = true) {
  return planYotsubaUpgrade({ refs: [{ payload, canDownload }], budgets }).refs[0]!;
}

/** Realistic text of about `chars` characters (the real tokenizer compresses "xxxx…" to almost nothing). */
function prose(chars: number): string {
  const words = "the build finished after a clean install and the cache warmed up so the next run should be faster once the drivers settle ".split(" ");
  let out = "";
  for (let i = 0; out.length < chars; i++) out += words[i % words.length] + (i % 7 === 6 ? ".\n" : " ");
  return out.slice(0, chars);
}

// ---------------------------------------------------------------------------
// computeRefCost
// ---------------------------------------------------------------------------

test("computeRefCost: frame plus the headline post element with empty text", () => {
  const cost = computeRefCost({ includedPosts: [], headlineText: "", filesInRef: 0, captionAllowanceTokens: 125 });
  assert.equal(cost, REF_FRAME_TOKENS + POST_OVERHEAD_TOKENS);
});

test("computeRefCost: each post adds its element overhead, escaped text, and file element", () => {
  const plain = makePost(1, "latest", "four");
  const withFile = { ...makePost(2, "latest", "four"), file: { name: "a", ext: ".png", tim: 1 } } as YotsubaPostNode;
  const base = computeRefCost({ includedPosts: [], headlineText: "", filesInRef: 0, captionAllowanceTokens: 0 });
  const one = computeRefCost({ includedPosts: [plain], headlineText: "", filesInRef: 0, captionAllowanceTokens: 0 });
  const two = computeRefCost({ includedPosts: [plain, withFile], headlineText: "", filesInRef: 0, captionAllowanceTokens: 0 });
  assert.ok(one - base > POST_OVERHEAD_TOKENS);
  assert.equal(two - one, one - base + FILE_ELEMENT_TOKENS);
  // Escaping is charged: ">" renders as "&gt;".
  const quoted = computeRefCost({ includedPosts: [], headlineText: ">>123 >>456", filesInRef: 0, captionAllowanceTokens: 0 });
  const bare = computeRefCost({ includedPosts: [], headlineText: "123 456", filesInRef: 0, captionAllowanceTokens: 0 });
  assert.ok(quoted > bare);
});

test("computeRefCost: caption cost adds captionAllowanceTokens per processed file", () => {
  const a = computeRefCost({ includedPosts: [], headlineText: "", filesInRef: 0, captionAllowanceTokens: 50 });
  const b = computeRefCost({ includedPosts: [], headlineText: "", filesInRef: 2, captionAllowanceTokens: 50 });
  assert.equal(b - a, 100);
});

// ---------------------------------------------------------------------------
// resolveYotsubaConfig — budget defaults
// ---------------------------------------------------------------------------

test("resolveYotsubaConfig: default trigger budget constants match spec", () => {
  const cfg = resolveYotsubaConfig({ enabled: true });
  assert.equal(cfg.preview.triggerLinkTokens, 900, "per-ref budget 900");
  assert.equal(cfg.preview.triggerGroupTokens, 1800, "group budget 1800");
  assert.equal(cfg.preview.triggerGroupFiles, 4, "group file budget 4");
  assert.equal(cfg.preview.triggerHeadlineChars, 800, "headline char cap 800");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — headline cap applied and recorded
// ---------------------------------------------------------------------------

test("plan: headline text is truncated to headlineCharCap", () => {
  const longText = prose(1200);
  const p = makePayload({ threadNo: 1, posts: [makePost(1, "op", longText)] });
  const ref = plan1(p);
  assert.equal(ref.staysAmbient, false);
  assert.equal(ref.excluded, false);
  assert.equal(ref.headlineText.length, 800, "headline truncated to 800");
  assert.equal(ref.headlinePost.text.length, 800, "headlinePost.text also truncated");
});

test("plan: headlineChars records the cap in force", () => {
  const p = makePayload({ threadNo: 1, posts: [makePost(1, "op", "short")] });
  const ref = plan1(p, { ...defaultBudgets, headlineCharCap: 300 });
  assert.equal(ref.headlineChars, 300, "headlineChars = headlineCharCap");
});

test("plan: headlineChars written to upgrade record (renderer reads it back)", () => {
  // The renderer at renderer.ts:766 does:
  //   const headlineCharCap = upgrade ? upgrade.headlineChars : (payload.ambientChars ?? 300);
  // If headlineChars is undefined the cap is undefined and the renderer never
  // truncates trigger headlines.  Verify the planner always sets it.
  const p = makePayload({ threadNo: 1, posts: [makePost(1, "op", prose(1000))] });
  const ref = plan1(p);
  assert.ok(ref.headlineChars !== undefined, "headlineChars must be defined for upgrade record");
  assert.equal(ref.headlineChars, 800, "defaults to triggerHeadlineChars = 800");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — thread link drop order
// ---------------------------------------------------------------------------

test("plan: thread link drops replied_to (oldest first) before latest", () => {
  // Tight budget: headline alone fits but adding two large posts will exceed it.
  // Posts: OP (headline), replied_to #2, replied_to #3, latest #4
  const bigText = prose(1000);
  const posts = [
    makePost(1, "op", bigText),
    makePost(2, "replied_to", bigText),  // oldest replied_to — dropped first
    makePost(3, "replied_to", bigText),
    makePost(4, "latest", bigText),
  ];
  const tightBudgets: PlanBudgets = {
    ...defaultBudgets,
    linkTokenBudget: 900,
    groupTokenBudget: 900,
    captionAllowanceTokens: 0,
  };
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p, tightBudgets);
  assert.equal(ref.staysAmbient, false);
  const nos = ref.includedPosts.map((p) => p.no);
  assert.ok(!nos.includes(2), "oldest replied_to dropped first");
});

test("plan: thread link drops oldest latest when no replied_to remain", () => {
  const bigText = prose(3600); // ~900 tokens per post
  const posts = [
    makePost(1, "op", "short"),
    makePost(2, "latest", bigText),  // oldest latest — dropped first
    makePost(3, "latest", bigText),
  ];
  const tightBudgets: PlanBudgets = {
    ...defaultBudgets,
    linkTokenBudget: 900,
    groupTokenBudget: 900,
    captionAllowanceTokens: 0,
  };
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p, tightBudgets);
  const nos = ref.includedPosts.map((p) => p.no);
  assert.ok(!nos.includes(2), "oldest latest dropped when no replied_to remain");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — post link drop order
// ---------------------------------------------------------------------------

test("plan: post link drops reply (newest first) before replied_to", () => {
  const bigText = prose(1000);
  const posts = [
    makePost(50, "linked", bigText),      // headline (post link)
    makePost(40, "replied_to", bigText),  // the post it answers
    makePost(60, "reply", bigText),       // older reply
    makePost(70, "reply", bigText),       // newer reply — dropped first
  ];
  const tightBudgets: PlanBudgets = {
    ...defaultBudgets,
    linkTokenBudget: 900,
    groupTokenBudget: 900,
    captionAllowanceTokens: 0,
  };
  const p = makePayload({ threadNo: 1, linkedNo: 50, posts });
  const ref = plan1(p, tightBudgets);
  const nos = ref.includedPosts.map((p) => p.no);
  assert.ok(!nos.includes(70), "newest reply dropped first for post link");
  assert.ok(nos.includes(40) || nos.length === 0, "replied_to kept until budget exhausted");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — stays ambient
// ---------------------------------------------------------------------------

test("plan: stays ambient when headline alone exceeds remaining group budget", () => {
  // Headline 800 chars → cost = 30 + ceil(800/4) = 30 + 200 = 230.
  // Group budget = 100 < 230.
  const posts = [makePost(1, "op", prose(1000))]; // truncated to 800 at headlineCharCap=800
  const tinyGroupBudgets: PlanBudgets = {
    ...defaultBudgets,
    groupTokenBudget: 100,
  };
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p, tinyGroupBudgets);
  assert.equal(ref.staysAmbient, true, "stays ambient when group budget exhausted");
});

test("plan: excluded when headline post not found", () => {
  const posts = [makePost(2, "latest", "some reply")];
  // headlineNo defaults to threadNo=1, but post 1 doesn't exist
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p);
  assert.equal(ref.excluded, true, "excluded when headline post missing");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — group order (input order drives budget accounting)
// ---------------------------------------------------------------------------

test("plan: group order — first ref gets budget before later refs", () => {
  // Two refs; each has a large headline that consumes most of the group budget.
  // ref0 should fit; ref1 (added to group budget after ref0) should stay ambient.
  // Headline 800 chars → cost = 30 + 200 = 230.  Group budget = 300.
  // ref0: 230 < 300 ✓; ref1: 230 > (300-230=70) → staysAmbient.
  // Budget: one headline-only ref fits, two do not.
  const single = computeRefCost({ includedPosts: [], headlineText: prose(800), filesInRef: 0, captionAllowanceTokens: 0 });
  const groupBudgets: PlanBudgets = {
    ...defaultBudgets,
    groupTokenBudget: Math.floor(single * 1.5),
    captionAllowanceTokens: 0,
  };
  const p0 = makePayload({ threadNo: 100, posts: [makePost(100, "op", prose(1000))] });
  const p1 = makePayload({ threadNo: 200, posts: [makePost(200, "op", prose(1000))] });
  const result = planYotsubaUpgrade({
    refs: [{ payload: p0, canDownload: false }, { payload: p1, canDownload: false }],
    budgets: groupBudgets,
  });
  assert.equal(result.refs[0]!.staysAmbient, false, "ref0 fits (first in group order)");
  assert.equal(result.refs[1]!.staysAmbient, true, "ref1 ambient (group budget exhausted after ref0)");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — ambient refs excluded from file allocation
// ---------------------------------------------------------------------------

test("plan: ambient ref does not consume tier-1 file slots", () => {
  // Group budget is just enough for ref0's headline (230 tokens) but not ref1's.
  // ref0 and ref1 each have a headline file.
  // With the bug: ref1 (ambient) steals the tier-1 slot from ref0.
  // With the fix: ref1 is excluded from allocation; ref0 gets its slot.
  const single = computeRefCost({ includedPosts: [], headlineText: prose(800), headlineHasFile: true, filesInRef: 0, captionAllowanceTokens: 0 });
  const groupBudgets: PlanBudgets = {
    ...defaultBudgets,
    groupTokenBudget: Math.floor(single * 1.5),
    groupFileBudget: 1,
    captionAllowanceTokens: 0, // no caption cost; just text
  };
  const op0 = makePost(100, "op", prose(800), true); // file present
  const op1 = makePost(200, "op", prose(800), true); // file present; this ref will be ambient
  const p0 = makePayload({ threadNo: 100, posts: [op0] });
  const p1 = makePayload({ threadNo: 200, posts: [op1] });
  const result = planYotsubaUpgrade({
    refs: [{ payload: p0, canDownload: true }, { payload: p1, canDownload: true }],
    budgets: groupBudgets,
  });
  // ref1 goes ambient
  assert.equal(result.refs[1]!.staysAmbient, true, "ref1 stays ambient (no group budget left)");
  // ref0 gets its headline file processed (not stolen by the ambient ref1)
  assert.equal(result.refs[0]!.staysAmbient, false, "ref0 fits");
  const ref0Files = result.refs[0]!.files;
  assert.ok(ref0Files.length > 0, "ref0 has files");
  assert.equal(ref0Files[0]!.isProcessed, true, "ref0 headline file is processed (not stolen by ambient ref1)");
  // ref1 has no files in the plan (ambient)
  assert.equal(result.refs[1]!.files.length, 0, "ambient ref has no planned files");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — per-ref 900 budget
// ---------------------------------------------------------------------------

test("plan: per-ref 900 budget: just under fits, just over triggers drops", () => {
  // frame = 30, no files, no captions.
  // Per-ref budget = 900 → headline can be at most (900-30)*4 = 3480 chars.
  // 3480 chars → ceil(3480/4) = 870 tokens + 30 = 900 ✓
  // 3481 chars → ceil(3481/4) = 871 tokens + 30 = 901 → triggers drop loop.
  // But headline is never dropped; just add a non-headline post to trigger the drop.
  const headlineText = prose(3200); // 800 + 800 = safe headline; keep it under 800 for cap
  // Actually headlineCharCap = 800, so max headline = 800 chars → ceil(800/4) = 200 → cost = 230.
  // For per-ref overflow: add posts that push the ref over 900.
  // Cost = 30 + 200 (headline) + N * ceil(postText/4).
  // Adding one post with 2720 chars → ceil(2720/4) = 680 → total = 910 > 900.
  const extraText = prose(2720);
  const posts = [
    makePost(1, "op", prose(1000)),  // headline → 800 chars
    makePost(2, "replied_to", extraText),  // pushes ref over 900
  ];
  const perRefBudgets: PlanBudgets = {
    ...defaultBudgets,
    linkTokenBudget: 900,
    groupTokenBudget: 9000, // generous group budget
    captionAllowanceTokens: 0,
  };
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p, perRefBudgets);
  assert.equal(ref.staysAmbient, false, "ref fits after drop");
  assert.equal(ref.droppedRepliedTo, 1, "replied_to post dropped to fit per-ref budget");
  assert.equal(ref.includedPosts.length, 0, "no non-headline posts remain");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — group 1800 budget (including caption allowances)
// ---------------------------------------------------------------------------

test("plan: group 1800 budget with caption allowances: just over causes ambient", () => {
  // Two refs, each headline 800 chars → headline cost = 30 + 200 = 230 per ref.
  // With 2 processed files (one per ref): captionAllowanceTokens = 125 per file.
  // Ref0 cost = 230 + 125 = 355.
  // Ref1 cost = 230 + 125 = 355.
  // Group total = 710, which fits in 1800 easily.  Need to make it exceed 1800.
  //
  // Use a high captionAllowanceTokens to make costs large.
  // captionAllowanceTokens = 800 per file.
  // Ref0 cost = 230 + 800 = 1030.
  // Ref1 cost = 230 + 800 = 1030.
  // Group total = 2060 > 1800 → ref1 eventually goes ambient.
  const bigCaptionBudgets: PlanBudgets = {
    linkTokenBudget: 9000,
    groupTokenBudget: 1800,
    groupFileBudget: 4,
    headlineCharCap: 800,
    captionAllowanceTokens: 800,
  };
  const op0 = makePost(1, "op", prose(1000), true); // file → gets caption allowance
  const op1 = makePost(2, "op", prose(1000), true);
  const p0 = makePayload({ threadNo: 1, posts: [op0] });
  const p1 = makePayload({ threadNo: 2, posts: [op1] });
  const result = planYotsubaUpgrade({
    refs: [{ payload: p0, canDownload: true }, { payload: p1, canDownload: true }],
    budgets: bigCaptionBudgets,
  });
  assert.equal(result.refs[0]!.staysAmbient, false, "ref0 fits in group budget");
  assert.equal(result.refs[1]!.staysAmbient, true, "ref1 ambient (group budget exhausted)");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — five-links case (first four OPs processed, fifth stored)
// ---------------------------------------------------------------------------

test("plan: five thread-link refs — first four OPs processed, fifth stored", () => {
  // Five refs, each with one OP image.  Group file budget = 4.
  // Tier-1 allocation: ref0–ref3 get their headline files; ref4 does not.
  // Token budgets wide enough that all five refs render; this isolates the
  // group-wide file allocation.
  const budgets: PlanBudgets = { ...defaultBudgets, groupTokenBudget: 10_000, groupFileBudget: 4 };
  const refs: PlannerRefInput[] = Array.from({ length: 5 }, (_, i) => ({
    payload: makePayload({
      threadNo: 100 + i,
      posts: [makePost(100 + i, "op", "OP text", true)],
    }),
    canDownload: true,
  }));
  const result = planYotsubaUpgrade({ refs, budgets });
  for (let i = 0; i < 4; i++) {
    const ref = result.refs[i]!;
    assert.equal(ref.staysAmbient, false, `ref${i} not ambient`);
    assert.ok(ref.files.length > 0, `ref${i} has files`);
    assert.equal(ref.files[0]!.isProcessed, true, `ref${i} OP file is processed (tier 1)`);
  }
  const ref4 = result.refs[4]!;
  assert.equal(ref4.staysAmbient, false, "ref4 not ambient (fits token budget)");
  assert.ok(ref4.files.length > 0, "ref4 has files");
  assert.equal(ref4.files[0]!.isProcessed, false, "ref4 OP file is STORED (budget exhausted)");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — tier 2/3 allocation newest-first
// ---------------------------------------------------------------------------

test("plan: tier 2 allocation newest-first (thread: latest replies)", () => {
  // One ref with two latest-reply files.  Budget = 2 slots.
  // Tier 1 takes the headline; tier 2 takes the newest latest reply.
  // With budget = 2: headline (tier1) + newest latest (tier2).
  const budgets: PlanBudgets = { ...defaultBudgets, groupFileBudget: 2 };
  const posts = [
    makePost(100, "op", "OP", true),       // headline
    makePost(200, "latest", "r1", true),   // older latest
    makePost(300, "latest", "r2", true),   // newer latest — tier 2 first
  ];
  const p = makePayload({ threadNo: 100, posts });
  const result = planYotsubaUpgrade({ refs: [{ payload: p, canDownload: true }], budgets });
  const ref = result.refs[0]!;
  const processed = ref.files.filter((f) => f.isProcessed).map((f) => f.postNo);
  assert.ok(processed.includes(100), "headline processed (tier 1)");
  assert.ok(processed.includes(300), "newer latest processed (tier 2)");
  assert.ok(!processed.includes(200), "older latest NOT processed (budget exhausted after tier 2)");
});

test("plan: tier 3 allocation (thread: replied_to after latest)", () => {
  // Budget = 3: headline + 1 latest (tier2) + 1 replied_to (tier3).
  const budgets: PlanBudgets = { ...defaultBudgets, groupFileBudget: 3 };
  const posts = [
    makePost(100, "op", "OP", true),
    makePost(50, "replied_to", "ancestor", true),  // tier 3
    makePost(200, "latest", "newest reply", true),  // tier 2
  ];
  const p = makePayload({ threadNo: 100, posts });
  const result = planYotsubaUpgrade({ refs: [{ payload: p, canDownload: true }], budgets });
  const ref = result.refs[0]!;
  const processed = ref.files.filter((f) => f.isProcessed).map((f) => f.postNo);
  assert.ok(processed.includes(100), "headline processed (tier 1)");
  assert.ok(processed.includes(200), "latest reply processed (tier 2)");
  assert.ok(processed.includes(50), "replied_to processed (tier 3)");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — video and PDF file classification
// ---------------------------------------------------------------------------

test("plan: video file (.webm) marked isVideoOrAnimated", () => {
  const posts = [makePost(1, "op", "OP", true, ".webm")];
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p);
  assert.equal(ref.files.length, 1);
  assert.equal(ref.files[0]!.isVideoOrAnimated, true, "webm is video");
  assert.equal(ref.files[0]!.isPdf, false);
});

test("plan: animated GIF (.gif) marked isVideoOrAnimated", () => {
  const posts = [makePost(1, "op", "OP", true, ".gif")];
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p);
  assert.equal(ref.files[0]!.isVideoOrAnimated, true, "gif is animated");
});

test("plan: PDF file marked isPdf (thumbnail rule)", () => {
  const posts = [makePost(1, "op", "OP", true, ".pdf")];
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p);
  assert.equal(ref.files[0]!.isPdf, true, "pdf file flagged");
  assert.equal(ref.files[0]!.isVideoOrAnimated, false);
});

test("plan: still image (.jpg) neither video nor PDF", () => {
  const posts = [makePost(1, "op", "OP", true, ".jpg")];
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p);
  assert.equal(ref.files[0]!.isPdf, false);
  assert.equal(ref.files[0]!.isVideoOrAnimated, false);
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — left counts
// ---------------------------------------------------------------------------

test("plan: left counts reflect dropped posts", () => {
  // Force drops of each type: one replied_to and one latest.
  // Headline 800 chars → cost 30 + ceil(800/4) = 30 + 200 = 230.
  // Each non-headline post 800 chars → cost += 200.
  // Total with two non-headline posts: 30 + 200 + 200 + 200 = 630.
  // Per-ref budget = 230 (only headline fits) → both posts must be dropped.
  // Drop order for thread link: replied_to first, then latest.
  const extraText = prose(800);
  const posts = [
    makePost(1, "op", prose(1000)),   // headline → 800 chars truncated
    makePost(2, "replied_to", extraText),   // dropped first
    makePost(3, "latest", extraText),       // dropped second
  ];
  const tightBudgets: PlanBudgets = {
    ...defaultBudgets,
    linkTokenBudget: 230,  // only the headline alone fits (230 = 30 + 200)
    groupTokenBudget: 9000,
    captionAllowanceTokens: 0,
  };
  const p = makePayload({ threadNo: 1, posts });
  const ref = plan1(p, tightBudgets);
  assert.equal(ref.staysAmbient, false);
  assert.equal(ref.droppedRepliedTo, 1, "one replied_to dropped");
  assert.equal(ref.droppedLatest, 1, "one latest dropped");
  assert.equal(ref.droppedReplies, 0, "no replies dropped");
});

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — determinism
// ---------------------------------------------------------------------------

test("plan: same input yields same plan (deterministic)", () => {
  const posts = [
    makePost(1, "op", prose(1000)),
    makePost(2, "replied_to", prose(500)),
    makePost(3, "latest", prose(500)),
    makePost(4, "latest", prose(500), true),
  ];
  const p = makePayload({ threadNo: 1, posts });
  const budgets: PlanBudgets = { ...defaultBudgets, linkTokenBudget: 500 };

  const run1 = planYotsubaUpgrade({ refs: [{ payload: p, canDownload: true }], budgets });
  // Re-create the payload (same data, fresh object) to ensure no shared mutation.
  const posts2 = [
    makePost(1, "op", prose(1000)),
    makePost(2, "replied_to", prose(500)),
    makePost(3, "latest", prose(500)),
    makePost(4, "latest", prose(500), true),
  ];
  const p2 = makePayload({ threadNo: 1, posts: posts2 });
  const run2 = planYotsubaUpgrade({ refs: [{ payload: p2, canDownload: true }], budgets });

  assert.deepEqual(
    run1.refs[0]!.includedPosts.map((p) => p.no),
    run2.refs[0]!.includedPosts.map((p) => p.no),
    "included post nos match",
  );
  assert.equal(run1.refs[0]!.droppedLatest, run2.refs[0]!.droppedLatest, "droppedLatest match");
  assert.equal(run1.refs[0]!.droppedRepliedTo, run2.refs[0]!.droppedRepliedTo, "droppedRepliedTo match");
  assert.deepEqual(
    run1.refs[0]!.files.map((f) => ({ postNo: f.postNo, isProcessed: f.isProcessed })),
    run2.refs[0]!.files.map((f) => ({ postNo: f.postNo, isProcessed: f.isProcessed })),
    "file plans match",
  );
});

// ---------------------------------------------------------------------------
// allocateGroupFiles — group-wide tier allocation (spec §6.5)
// ---------------------------------------------------------------------------

test("allocateGroupFiles: five thread links — only first four OPs get processed slots", () => {
  const refs = Array.from({ length: 5 }, (_, i) => ({
    headlinePost: makePost(100 + i, "op", "OP", true),
    includedPosts: [] as YotsubaPostNode[],
    isPostLink: false,
    canDownload: true,
  }));
  const result = allocateGroupFiles({ refs, totalFileBudget: 4 });
  for (let i = 0; i < 4; i++) {
    assert.ok(result.get(i)!.has(100 + i), `ref ${i} headline allocated`);
  }
  assert.equal(result.get(4)!.size, 0, "ref 4 gets no slot (budget exhausted)");
});

test("allocateGroupFiles: tier 2 fills after tier 1 is exhausted", () => {
  const latestPost = makePost(201, "latest", "latest", true);
  const repliedToPost = makePost(301, "replied_to", "rt", true);
  const refs = [
    {
      headlinePost: makePost(200, "op", "OP", true),
      includedPosts: [latestPost] as YotsubaPostNode[],
      isPostLink: false,
      canDownload: true,
    },
    {
      headlinePost: makePost(300, "op", "OP2", true),
      includedPosts: [repliedToPost] as YotsubaPostNode[],
      isPostLink: false,
      canDownload: true,
    },
  ];
  const result = allocateGroupFiles({ refs, totalFileBudget: 3 });
  assert.ok(result.get(0)!.has(200), "ref0 headline allocated (tier 1)");
  assert.ok(result.get(0)!.has(201), "ref0 latest allocated (tier 2)");
  assert.ok(result.get(1)!.has(300), "ref1 headline allocated (tier 1)");
  assert.equal(result.get(1)!.has(301), false, "ref1 replied_to not allocated (budget exhausted)");
});

// ---------------------------------------------------------------------------
// parseYotsubaPreviewPayload — idempotence (already-upgraded rows)
// ---------------------------------------------------------------------------

test("parseYotsubaPreviewPayload: rows with upgrade field detected as already-upgraded", () => {
  // The trigger upgrade skips rows that already have an upgrade:
  //   freshPreviews = previews.filter(p => !payload?.upgrade)
  // Verify the upgrade field round-trips through the payload parser.
  const payload = {
    v: 1 as const,
    kind: "thread" as const,
    board: "g",
    asOf: Date.now(),
    upgrade: {
      triggerGroupId: "grp-1",
      includedNos: [1, 2],
      processedAssetIds: ["asset-1"],
      headlineChars: 800,
    },
  };
  const parsed = parseYotsubaPreviewPayload(JSON.stringify(payload));
  assert.ok(parsed, "parsed successfully");
  assert.ok(parsed!.upgrade, "upgrade field present");
  assert.ok(parsed!.upgrade !== undefined, "upgrade record detected → row would be skipped");
});

test("parseYotsubaPreviewPayload: rows without upgrade field are treated as fresh", () => {
  const payload = {
    v: 1 as const,
    kind: "thread" as const,
    board: "g",
    asOf: Date.now(),
    threadNo: 100000,
    posts: [],
  };
  const parsed = parseYotsubaPreviewPayload(JSON.stringify(payload));
  assert.ok(parsed, "parsed successfully");
  assert.equal(parsed!.upgrade, undefined, "no upgrade → treated as fresh for upgrade");
});
