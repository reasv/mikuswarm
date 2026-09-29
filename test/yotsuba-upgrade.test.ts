/**
 * Tests for src/yotsuba/upgrade.ts — trigger upgrade budget logic.
 * (spec/YOTSUBA-SUPPORT.md §12, §6.4-§6.5)
 *
 * Verifies:
 *   - computeRefCost: frame + text + caption math.
 *   - selectUpgradePosts: drop order for thread and post links.
 *   - selectUpgradePosts: headline cap (headlineCharCap truncation).
 *   - selectUpgradePosts: per-ref (900) and group (1800) budget enforcement.
 *   - selectUpgradePosts: stays ambient when even headline alone doesn't fit.
 *   - selectUpgradePosts: idempotent (already-upgraded rows are skipped upstream
 *     via parseYotsubaPreviewPayload; the filter behavior is tested via the parse).
 *   - fileAllocationOrder: headline first; thread = latest then replied_to;
 *     post = replied_to then replies; newest first within each tier.
 *   - resolveYotsubaConfig returns the correct default budget constants.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  computeRefCost,
  selectUpgradePosts,
  fileAllocationOrder,
  allocateGroupFiles,
  type UpgradeBudgets,
} from "../src/yotsuba/upgrade.js";
import { parseYotsubaPreviewPayload, resolveYotsubaConfig } from "../src/yotsuba/types.js";
import type { YotsubaPostNode } from "../src/yotsuba/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePost(
  no: number,
  role: YotsubaPostNode["role"],
  text: string,
  hasFile = false,
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
      ? { name: `img${no}`, ext: ".jpg", tim: no + 1_000_000 }
      : undefined,
  };
}

/** Default budgets for most tests (no group pressure). */
const defaultBudgets: UpgradeBudgets = {
  linkTokenBudget: 900,
  remainingGroupTokenBudget: 1800,
  captionAllowanceTokens: 125, // 500 chars / 4
  headlineCharCap: 800,
};

// ---------------------------------------------------------------------------
// computeRefCost
// ---------------------------------------------------------------------------

test("computeRefCost: frame cost alone with no posts and no files", () => {
  const cost = computeRefCost({
    includedPosts: [],
    headlineTextLen: 0,
    filesInRef: 0,
    captionAllowanceTokens: 125,
  });
  assert.equal(cost, 30, "frame cost = 30");
});

test("computeRefCost: text cost rounds up", () => {
  // 5-char headline → ceil(5/4) = 2; 4-char post → ceil(4/4) = 1; frame = 30
  const post = makePost(1, "latest", "four");
  const cost = computeRefCost({
    includedPosts: [post],
    headlineTextLen: 5,
    filesInRef: 0,
    captionAllowanceTokens: 0,
  });
  assert.equal(cost, 30 + 2 + 1, "frame(30) + headline(2) + post(1)");
});

test("computeRefCost: caption cost adds captionAllowanceTokens per file", () => {
  const cost = computeRefCost({
    includedPosts: [],
    headlineTextLen: 0,
    filesInRef: 2,
    captionAllowanceTokens: 50,
  });
  assert.equal(cost, 30 + 100, "frame(30) + 2 × 50 caption");
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
// selectUpgradePosts — headline cap
// ---------------------------------------------------------------------------

test("selectUpgradePosts: headline text is capped at headlineCharCap", () => {
  const longText = "a".repeat(1200);
  const posts = [makePost(1, "op", longText)];
  const result = selectUpgradePosts({
    posts,
    headlineNo: 1,
    isPostLink: false,
    budgets: defaultBudgets,
    remainingGroupFileBudget: 4,
    canDownload: true,
  });
  assert.equal(result.staysAmbient, false);
  assert.equal(result.headlineText.length, 800, "headline capped at 800 chars");
});

// ---------------------------------------------------------------------------
// selectUpgradePosts — thread link drop order
// ---------------------------------------------------------------------------

test("selectUpgradePosts: thread link drops replied_to (oldest) before latest", () => {
  // Use big text so the budget is immediately over unless posts are dropped.
  const bigText = "x".repeat(1000);
  const posts = [
    makePost(1, "op", bigText),
    makePost(2, "replied_to", bigText),  // oldest replied_to
    makePost(3, "replied_to", bigText),  // newer replied_to
    makePost(4, "latest", bigText),
  ];
  // Budget that fits headline + 1 post.
  const tightBudgets: UpgradeBudgets = {
    linkTokenBudget: 900,
    remainingGroupTokenBudget: 900,
    captionAllowanceTokens: 0,
    headlineCharCap: 800,
  };
  const result = selectUpgradePosts({
    posts,
    headlineNo: 1,
    isPostLink: false,
    budgets: tightBudgets,
    remainingGroupFileBudget: 0,
    canDownload: false,
  });
  assert.equal(result.staysAmbient, false);
  // replied_to posts should be dropped before latest.
  const nos = result.includedPosts.map((p) => p.no);
  assert.ok(!nos.includes(2), "oldest replied_to dropped first");
});

test("selectUpgradePosts: thread link drops oldest latest when no replied_to remain", () => {
  const bigText = "y".repeat(3600); // ~900 tokens per post
  const posts = [
    makePost(1, "op", "short"),
    makePost(2, "latest", bigText),
    makePost(3, "latest", bigText),
  ];
  const tightBudgets: UpgradeBudgets = {
    linkTokenBudget: 900,
    remainingGroupTokenBudget: 900,
    captionAllowanceTokens: 0,
    headlineCharCap: 800,
  };
  const result = selectUpgradePosts({
    posts,
    headlineNo: 1,
    isPostLink: false,
    budgets: tightBudgets,
    remainingGroupFileBudget: 0,
    canDownload: false,
  });
  const nos = result.includedPosts.map((p) => p.no);
  // post 2 (oldest latest) dropped first; post 3 may survive if budget allows.
  assert.ok(!nos.includes(2), "oldest latest dropped when no replied_to");
});

// ---------------------------------------------------------------------------
// selectUpgradePosts — post link drop order
// ---------------------------------------------------------------------------

test("selectUpgradePosts: post link drops reply (newest first) before replied_to", () => {
  const bigText = "z".repeat(1000);
  const posts = [
    makePost(50, "linked", bigText),     // headline (post link)
    makePost(40, "replied_to", bigText), // the post it answers
    makePost(60, "reply", bigText),      // older reply
    makePost(70, "reply", bigText),      // newer reply — dropped first
  ];
  const tightBudgets: UpgradeBudgets = {
    linkTokenBudget: 900,
    remainingGroupTokenBudget: 900,
    captionAllowanceTokens: 0,
    headlineCharCap: 800,
  };
  const result = selectUpgradePosts({
    posts,
    headlineNo: 50,
    isPostLink: true,
    budgets: tightBudgets,
    remainingGroupFileBudget: 0,
    canDownload: false,
  });
  const nos = result.includedPosts.map((p) => p.no);
  // Newest reply (70) dropped first.
  assert.ok(!nos.includes(70), "newest reply dropped first for post link");
  // replied_to kept as long as possible.
  assert.ok(nos.includes(40) || nos.length === 0, "replied_to kept until budget exhausted");
});

// ---------------------------------------------------------------------------
// selectUpgradePosts — stays ambient
// ---------------------------------------------------------------------------

test("selectUpgradePosts: stays ambient when even headline alone exceeds group budget", () => {
  // Headline text > 800 chars truncated to 800; cost = 30 + ceil(800/4) = 30+200 = 230.
  // Make group budget < 230.
  const posts = [makePost(1, "op", "x".repeat(1000))];
  const tinyGroupBudgets: UpgradeBudgets = {
    linkTokenBudget: 900,
    remainingGroupTokenBudget: 100, // smaller than headline-only cost
    captionAllowanceTokens: 0,
    headlineCharCap: 800,
  };
  const result = selectUpgradePosts({
    posts,
    headlineNo: 1,
    isPostLink: false,
    budgets: tinyGroupBudgets,
    remainingGroupFileBudget: 0,
    canDownload: false,
  });
  assert.equal(result.staysAmbient, true, "stays ambient when group budget exhausted");
});

// ---------------------------------------------------------------------------
// selectUpgradePosts — fits within budget
// ---------------------------------------------------------------------------

test("selectUpgradePosts: short OP fits within default budgets with no non-headline posts", () => {
  const posts = [makePost(1, "op", "short OP text")];
  const result = selectUpgradePosts({
    posts,
    headlineNo: 1,
    isPostLink: false,
    budgets: defaultBudgets,
    remainingGroupFileBudget: 4,
    canDownload: true,
  });
  assert.equal(result.staysAmbient, false);
  assert.equal(result.includedPosts.length, 0, "no non-headline posts");
  assert.ok(result.headlineText.startsWith("short OP"), "headline text preserved");
});

test("selectUpgradePosts: missing headline post returns staysAmbient", () => {
  const posts = [makePost(2, "latest", "some reply")];
  const result = selectUpgradePosts({
    posts,
    headlineNo: 999, // not in posts
    isPostLink: false,
    budgets: defaultBudgets,
    remainingGroupFileBudget: 4,
    canDownload: true,
  });
  assert.equal(result.staysAmbient, true, "stays ambient when headline post not found");
});

// ---------------------------------------------------------------------------
// parseYotsubaPreviewPayload — idempotence (already-upgraded rows)
// ---------------------------------------------------------------------------

test("parseYotsubaPreviewPayload: rows with upgrade field detected as already-upgraded", () => {
  const payload = {
    v: 1 as const,
    kind: "thread" as const,
    board: "g",
    asOf: Date.now(),
    upgrade: {
      triggerGroupId: "grp-1",
      includedNos: [1, 2],
      processedAssetIds: ["asset-1"],
    },
  };
  const parsed = parseYotsubaPreviewPayload(JSON.stringify(payload));
  assert.ok(parsed, "parsed successfully");
  assert.ok(parsed!.upgrade, "upgrade field present");
  // The trigger upgrade skips fresh rows that already have an upgrade:
  // freshPreviews = previews.filter(p => !payload?.upgrade)
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

// ---------------------------------------------------------------------------
// fileAllocationOrder — thread link
// ---------------------------------------------------------------------------

test("fileAllocationOrder: thread link — headline first, latest newest first, then replied_to newest first", () => {
  const headline = makePost(100, "op", "OP");
  const latest1 = makePost(200, "latest", "reply 1");
  const latest2 = makePost(300, "latest", "reply 2");
  const rt1 = makePost(150, "replied_to", "first answered");
  const rt2 = makePost(180, "replied_to", "second answered");

  const order = fileAllocationOrder({
    headlinePost: headline,
    includedPosts: [latest1, latest2, rt1, rt2],
    isPostLink: false,
  });

  assert.equal(order[0]!.no, 100, "headline is first");
  // Latest: newest first (300 before 200)
  assert.equal(order[1]!.no, 300, "newest latest second");
  assert.equal(order[2]!.no, 200, "older latest third");
  // Replied-to: newest first (180 before 150)
  assert.equal(order[3]!.no, 180, "newest replied_to fourth");
  assert.equal(order[4]!.no, 150, "older replied_to fifth");
});

// ---------------------------------------------------------------------------
// fileAllocationOrder — post link
// ---------------------------------------------------------------------------

test("fileAllocationOrder: post link — headline first, replied_to newest first, then replies newest first", () => {
  const headline = makePost(500, "linked", "linked post");
  const rt1 = makePost(400, "replied_to", "earlier answer");
  const rt2 = makePost(450, "replied_to", "later answer");
  const reply1 = makePost(510, "reply", "older reply");
  const reply2 = makePost(520, "reply", "newer reply");

  const order = fileAllocationOrder({
    headlinePost: headline,
    includedPosts: [rt1, rt2, reply1, reply2],
    isPostLink: true,
  });

  assert.equal(order[0]!.no, 500, "headline is first");
  // Replied-to: newest first (450 before 400)
  assert.equal(order[1]!.no, 450, "newest replied_to second");
  assert.equal(order[2]!.no, 400, "older replied_to third");
  // Replies: newest first (520 before 510)
  assert.equal(order[3]!.no, 520, "newest reply fourth");
  assert.equal(order[4]!.no, 510, "older reply fifth");
});

test("fileAllocationOrder: thread link with only latest posts", () => {
  const headline = makePost(1, "op", "OP");
  const r1 = makePost(5, "latest", "r1");
  const r2 = makePost(3, "latest", "r2");

  const order = fileAllocationOrder({
    headlinePost: headline,
    includedPosts: [r1, r2],
    isPostLink: false,
  });

  assert.equal(order[0]!.no, 1, "headline first");
  assert.equal(order[1]!.no, 5, "newer latest before older");
  assert.equal(order[2]!.no, 3, "older latest last");
});

// ---------------------------------------------------------------------------
// allocateGroupFiles — group-wide tier allocation (spec §6.5)
// Note: the upgrade function itself makes no API calls — no client.thread()
// or similar; it only processes the stored payload capture.  This is enforced
// by the upgrade function design: all data comes from the payload, and the
// only I/O is file downloads via client.fetchFilePath (tested at the app
// level, not here).
// ---------------------------------------------------------------------------

test("allocateGroupFiles: five thread links — only first four OPs get processed slots", () => {
  // Budget = 4.  Each ref has a headline file and no included posts.
  const refs = Array.from({ length: 5 }, (_, i) => ({
    headlinePost: makePost(100 + i, "op", "OP", true),
    includedPosts: [] as YotsubaPostNode[],
    isPostLink: false,
    canDownload: true,
  }));

  const result = allocateGroupFiles({ refs, totalFileBudget: 4 });

  // Refs 0–3 get their headline allocated (tier 1 fills budget).
  for (let i = 0; i < 4; i++) {
    assert.ok(result.get(i)!.has(100 + i), `ref ${i} headline allocated`);
  }
  // Ref 4 gets nothing (budget exhausted).
  assert.equal(result.get(4)!.size, 0, "ref 4 gets no slot (budget exhausted)");
});

test("allocateGroupFiles: tier 2 fills after tier 1 is exhausted", () => {
  // Budget = 3.  Two refs.
  // ref0: headline (file) + 1 latest post (file).
  // ref1: headline (file) + 1 replied_to post (file).
  // Tier-1 allocation: ref0 headline (slot 1), ref1 headline (slot 2).
  // Tier-2 allocation: ref0 latest (slot 3 — thread=latest newest-first).
  // ref1 replied_to cannot get a slot (budget exhausted).
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

  // ref0 gets headline + latest (tier 1 + tier 2).
  assert.ok(result.get(0)!.has(200), "ref0 headline allocated (tier 1)");
  assert.ok(result.get(0)!.has(201), "ref0 latest allocated (tier 2)");
  // ref1 gets only headline (tier 1); its replied_to didn't get a slot.
  assert.ok(result.get(1)!.has(300), "ref1 headline allocated (tier 1)");
  assert.equal(result.get(1)!.has(301), false, "ref1 replied_to not allocated (budget exhausted)");
});
