/**
 * Pure budget math and post-selection logic for the yotsuba trigger upgrade
 * (spec §6.4-§6.5).  Extracted from app.ts so this can be unit-tested without
 * spinning up the full application.
 */

import type { YotsubaPostNode } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UpgradeBudgets {
  /** Per-ref token budget (default 900). */
  linkTokenBudget: number;
  /** Remaining group token budget for this ref (decreases after each ref). */
  remainingGroupTokenBudget: number;
  /** Caption allowance per processed file in tokens (captionMaxChars / 4). */
  captionAllowanceTokens: number;
  /** Char cap applied to the headline text before budget accounting. */
  headlineCharCap: number;
}

export interface UpgradeSelection {
  /** The headline text after applying headlineCharCap. */
  headlineText: string;
  /** Non-headline posts that survived the drop loop (may be empty). */
  includedPosts: YotsubaPostNode[];
  /**
   * True when even the headline alone does not fit in the remaining group
   * budget.  The ref stays ambient; the caller should store an empty upgrade.
   */
  staysAmbient: boolean;
}

// ---------------------------------------------------------------------------
// computeRefCost
// ---------------------------------------------------------------------------

/**
 * Estimated token cost of one ref's rendered output, including frame overhead
 * and a caption allowance for every processed file.
 *
 * frame cost:  30 tokens (thread element + gap markers + footer)
 * text cost:   ceil(chars / 4) per post (headline + included)
 * caption:     captionAllowanceTokens × filesInRef
 */
export function computeRefCost(opts: {
  includedPosts: YotsubaPostNode[];
  headlineTextLen: number;
  filesInRef: number;
  captionAllowanceTokens: number;
}): number {
  const frameCost = 30;
  const textCost =
    opts.includedPosts.reduce((sum, p) => sum + Math.ceil(p.text.length / 4), 0) +
    Math.ceil(opts.headlineTextLen / 4);
  const captionCost = opts.filesInRef * opts.captionAllowanceTokens;
  return frameCost + textCost + captionCost;
}

// ---------------------------------------------------------------------------
// selectUpgradePosts
// ---------------------------------------------------------------------------

/**
 * Select which non-headline posts to include in the trigger rendering for one
 * ref, applying the per-ref and group token budgets from spec §6.4.
 *
 * The headline post is always included (never dropped).  Non-headline posts are
 * dropped in drop order until the ref fits within both budgets, or until all
 * non-headline posts are gone.
 *
 * Drop order:
 *   thread link: replied_to (oldest first) → latest (oldest first)
 *   post link:   reply (newest first)      → replied_to (oldest first)
 */
export function selectUpgradePosts(opts: {
  posts: YotsubaPostNode[];
  headlineNo: number;
  isPostLink: boolean;
  budgets: UpgradeBudgets;
  remainingGroupFileBudget: number;
  canDownload: boolean;
}): UpgradeSelection {
  const {
    posts,
    headlineNo,
    isPostLink,
    budgets,
    remainingGroupFileBudget,
    canDownload,
  } = opts;

  const headlinePost = posts.find((p) => p.no === headlineNo);
  if (!headlinePost) {
    return { headlineText: "", includedPosts: [], staysAmbient: true };
  }

  const headlineText = headlinePost.text.slice(0, budgets.headlineCharCap);
  const headlinePostDefined: YotsubaPostNode = headlinePost;
  let includedPosts = posts.filter((p) => p.no !== headlineNo);

  function countPostFiles(inc: YotsubaPostNode[]): number {
    return (
      inc.filter((p) => p.file?.assetId || (p.file && canDownload)).length +
      (headlinePostDefined.file ? 1 : 0)
    );
  }

  function computeCost(inc: YotsubaPostNode[]): number {
    return computeRefCost({
      includedPosts: inc,
      headlineTextLen: headlineText.length,
      filesInRef: Math.min(countPostFiles(inc), remainingGroupFileBudget),
      captionAllowanceTokens: budgets.captionAllowanceTokens,
    });
  }

  const effectiveBudget = Math.min(
    budgets.linkTokenBudget,
    budgets.remainingGroupTokenBudget,
  );
  let refCost = computeCost(includedPosts);

  while (refCost > effectiveBudget && includedPosts.length > 0) {
    let dropped = false;
    if (!isPostLink) {
      // Thread link: drop replied_to (oldest first), then latest (oldest first).
      const repliedToIdx = includedPosts.findIndex((p) => p.role === "replied_to");
      if (repliedToIdx >= 0) {
        includedPosts.splice(repliedToIdx, 1);
        dropped = true;
      } else {
        const latestIdx = includedPosts.findIndex((p) => p.role === "latest");
        if (latestIdx >= 0) {
          includedPosts.splice(latestIdx, 1);
          dropped = true;
        }
      }
    } else {
      // Post link: drop reply (newest first), then replied_to (oldest first).
      const replyIndices = includedPosts.reduce<number[]>((acc, p, i) => {
        if (p.role === "reply") acc.push(i);
        return acc;
      }, []);
      if (replyIndices.length > 0) {
        includedPosts.splice(replyIndices[replyIndices.length - 1]!, 1);
        dropped = true;
      } else {
        const repliedToIdx = includedPosts.findIndex((p) => p.role === "replied_to");
        if (repliedToIdx >= 0) {
          includedPosts.splice(repliedToIdx, 1);
          dropped = true;
        }
      }
    }
    if (!dropped) break;
    refCost = computeCost(includedPosts);
  }

  // If even the headline alone does not fit the remaining group budget, stay ambient.
  const headlineOnlyCost = computeRefCost({
    includedPosts: [],
    headlineTextLen: headlineText.length,
    filesInRef: headlinePostDefined.file ? 1 : 0,
    captionAllowanceTokens: budgets.captionAllowanceTokens,
  });
  if (headlineOnlyCost > budgets.remainingGroupTokenBudget) {
    return { headlineText, includedPosts: [], staysAmbient: true };
  }

  return { headlineText, includedPosts, staysAmbient: false };
}

// ---------------------------------------------------------------------------
// fileAllocationOrder
// ---------------------------------------------------------------------------

/**
 * The order in which post files are processed for the group image budget per
 * spec §6.5.
 *
 * 1. Headline file first.
 * 2. Thread: latest replies' files, newest first.
 *    Post:   replied-to files, newest first.
 * 3. Thread: replied-to files, newest first.
 *    Post:   reply files, newest first.
 */
export function fileAllocationOrder(opts: {
  headlinePost: YotsubaPostNode;
  includedPosts: YotsubaPostNode[];
  isPostLink: boolean;
}): YotsubaPostNode[] {
  const { headlinePost, includedPosts, isPostLink } = opts;
  const result: YotsubaPostNode[] = [headlinePost];
  if (!isPostLink) {
    const latestPosts = includedPosts
      .filter((p) => p.role === "latest")
      .sort((a, b) => b.no - a.no);
    const repliedToPosts = includedPosts
      .filter((p) => p.role === "replied_to")
      .sort((a, b) => b.no - a.no);
    result.push(...latestPosts, ...repliedToPosts);
  } else {
    const repliedToPosts = includedPosts
      .filter((p) => p.role === "replied_to")
      .sort((a, b) => b.no - a.no);
    const replyPosts = includedPosts
      .filter((p) => p.role === "reply")
      .sort((a, b) => b.no - a.no);
    result.push(...repliedToPosts, ...replyPosts);
  }
  return result;
}

// ---------------------------------------------------------------------------
// allocateGroupFiles
// ---------------------------------------------------------------------------

/**
 * Allocate processed file slots across all refs in the group, in §6.5 tier
 * order.  Returns a Map<refIndex, Set<postNo>> of posts that receive a
 * processed slot.
 *
 * Tier 1: headline file of each ref, in group order.
 * Tier 2: per ref in order — thread = latest newest-first; post = replied-to
 *          newest-first.
 * Tier 3: per ref in order — thread = replied-to newest-first; post = replies
 *          newest-first.
 *
 * A slot is only granted when the ref's canDownload flag is true.
 */
export function allocateGroupFiles(opts: {
  refs: Array<{
    headlinePost: YotsubaPostNode;
    includedPosts: YotsubaPostNode[];
    isPostLink: boolean;
    canDownload: boolean;
  }>;
  totalFileBudget: number;
}): Map<number, Set<number>> {
  const processed = new Map<number, Set<number>>();
  for (let i = 0; i < opts.refs.length; i++) processed.set(i, new Set());

  let remaining = opts.totalFileBudget;

  function tryAllocate(refIdx: number, post: YotsubaPostNode): boolean {
    if (remaining <= 0) return false;
    if (!post.file || post.file.deleted) return false;
    if (!opts.refs[refIdx]!.canDownload) return false;
    processed.get(refIdx)!.add(post.no);
    remaining--;
    return true;
  }

  // Tier 1: headline of each ref.
  for (let i = 0; i < opts.refs.length; i++) {
    tryAllocate(i, opts.refs[i]!.headlinePost);
  }

  // Tier 2: per ref in order.
  for (let i = 0; i < opts.refs.length; i++) {
    const { includedPosts, isPostLink } = opts.refs[i]!;
    const tier2 = !isPostLink
      ? includedPosts.filter((p) => p.role === "latest").sort((a, b) => b.no - a.no)
      : includedPosts.filter((p) => p.role === "replied_to").sort((a, b) => b.no - a.no);
    for (const p of tier2) tryAllocate(i, p);
  }

  // Tier 3: per ref in order.
  for (let i = 0; i < opts.refs.length; i++) {
    const { includedPosts, isPostLink } = opts.refs[i]!;
    const tier3 = !isPostLink
      ? includedPosts.filter((p) => p.role === "replied_to").sort((a, b) => b.no - a.no)
      : includedPosts.filter((p) => p.role === "reply").sort((a, b) => b.no - a.no);
    for (const p of tier3) tryAllocate(i, p);
  }

  return processed;
}
