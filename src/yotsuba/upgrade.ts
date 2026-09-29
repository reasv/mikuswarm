/**
 * Pure budget math and upgrade planning for the yotsuba trigger upgrade
 * (spec §6.4-§6.5).  Extracted from app.ts so it can be unit-tested without
 * spinning up the full application.
 *
 * The public entry point is `planYotsubaUpgrade`.  `computeRefCost` and
 * `allocateGroupFiles` are also exported for use in tests.
 */

import type { YotsubaPostNode, YotsubaPreviewPayload } from "./types.js";
import { safeYotsubaExt } from "./types.js";
import { estimateTokens } from "../context/tokens.js";
import { escapeXml } from "../context/xml.js";

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
/**
 * Rendering overheads of the trigger rendering (spec §6.6 C/E), measured on
 * real threads: the `<link_preview>` + `<thread …>` frame and the footer; each
 * `<post …>` element with its attributes plus the gap marker before it; each
 * `<file …>` element (processed or stored). Text is costed with the real
 * tokenizer over its escaped form (`>` renders as `&gt;`), so the planned cost
 * tracks what the context actually carries.
 */
export const REF_FRAME_TOKENS = 190;
export const POST_OVERHEAD_TOKENS = 32;
export const FILE_ELEMENT_TOKENS = 40;

export function computeRefCost(opts: {
  includedPosts: YotsubaPostNode[];
  /** The headline text as rendered (already capped). */
  headlineText: string;
  /** Whether the headline post has a file element. */
  headlineHasFile?: boolean;
  /** Processed files in this ref: each reserves a caption allowance. */
  filesInRef: number;
  captionAllowanceTokens: number;
}): number {
  const textCost = (t: string) => estimateTokens(escapeXml(t));
  let cost = REF_FRAME_TOKENS + POST_OVERHEAD_TOKENS + textCost(opts.headlineText);
  if (opts.headlineHasFile) cost += FILE_ELEMENT_TOKENS;
  for (const p of opts.includedPosts) {
    cost += POST_OVERHEAD_TOKENS + textCost(p.text);
    if (p.file) cost += FILE_ELEMENT_TOKENS;
  }
  return cost + opts.filesInRef * opts.captionAllowanceTokens;
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

// ---------------------------------------------------------------------------
// planYotsubaUpgrade — types
// ---------------------------------------------------------------------------

/** Input for a single ref passed to planYotsubaUpgrade. */
export interface PlannerRefInput {
  /**
   * Parsed payload.  Must be kind = "thread"; the caller filters out board
   * refs and null payloads before calling the planner.
   */
  payload: YotsubaPreviewPayload;
  /** Whether file downloads are permitted for this ref. */
  canDownload: boolean;
}

/** Budget constants for one trigger-group upgrade. */
export interface PlanBudgets {
  /** Per-ref token budget (default 900). */
  linkTokenBudget: number;
  /** Group-wide token budget (default 1800). */
  groupTokenBudget: number;
  /** Group-wide processed-file slot budget (default 4). */
  groupFileBudget: number;
  /** Char cap applied to the headline text before budget accounting (default 800). */
  headlineCharCap: number;
  /** Caption token allowance per processed file (captionMaxChars / 4). */
  captionAllowanceTokens: number;
}

/** File-level plan for one included post in a ref. */
export interface PlannedFileInfo {
  postNo: number;
  /** True if this file slot is "processed" (captioned + image-block eligible). */
  isProcessed: boolean;
  /** True if the file is a PDF (download the page-1 thumbnail: `${tim}s.jpg`). */
  isPdf: boolean;
  /**
   * True if the file is a video (.webm/.mp4) or animated GIF.
   * Processing: download original (video caption lane) + build storyboard (image block).
   */
  isVideoOrAnimated: boolean;
}

/** Plan for one ref after the convergent selection loop has settled. */
export interface PlannedRef {
  /** True when no headline post was found; no upgrade record will be written. */
  excluded: boolean;
  /**
   * True when the headline alone does not fit the remaining group budget;
   * no upgrade record will be written.
   */
  staysAmbient: boolean;
  /** Headline post — text already truncated to headlineCharCap. */
  headlinePost: YotsubaPostNode;
  headlineText: string;
  /**
   * The char cap in force — write this into the upgrade record's `headlineChars`
   * field so the renderer applies the same cap at render time.
   */
  headlineChars: number;
  /** Non-headline posts that survived the drop loop. */
  includedPosts: YotsubaPostNode[];
  isPostLink: boolean;
  /** Whether file downloads are permitted for this ref. */
  canDownload: boolean;
  /**
   * File plan for all included posts (including headline) that have a
   * non-deleted file.  Empty for excluded and staysAmbient refs.
   */
  files: PlannedFileInfo[];
  droppedLatest: number;
  droppedRepliedTo: number;
  droppedReplies: number;
}

export interface UpgradePlan {
  /** One entry per input ref, in the same order as the input. */
  refs: PlannedRef[];
}

// ---------------------------------------------------------------------------
// planYotsubaUpgrade
// ---------------------------------------------------------------------------

/**
 * Pure, synchronous, deterministic upgrade planner (spec §6.4-§6.5).
 *
 * Accepts refs in group order (trigger message refs first, then reply-context
 * refs, then other grouped events — the caller orders them).  Returns a plan
 * describing which posts survive the budget loop, which file slots are
 * processed, and whether each ref stays ambient.
 *
 * Makes no I/O.  Input ref payloads must be kind = "thread"; board refs and
 * null payloads are filtered out by the caller before passing refs here.
 */
export function planYotsubaUpgrade(input: {
  refs: PlannerRefInput[];
  budgets: PlanBudgets;
}): UpgradePlan {
  const { budgets } = input;

  // ── Internal working state (mutated during the convergence loop) ────────────
  interface WorkingRef {
    payload: YotsubaPreviewPayload;
    headlinePost: YotsubaPostNode;
    includedPosts: YotsubaPostNode[];
    isPostLink: boolean;
    canDownload: boolean;
    headlineText: string;
    excluded: boolean;
    staysAmbient: boolean;
    droppedLatest: number;
    droppedRepliedTo: number;
    droppedReplies: number;
  }

  const working: WorkingRef[] = [];

  for (const { payload, canDownload } of input.refs) {
    const headlineNo = payload.headlineNo ?? payload.threadNo ?? 0;
    const allPosts = payload.posts ?? [];
    const headlinePost = allPosts.find((p) => p.no === headlineNo);

    if (!headlinePost) {
      // No headline post — excluded; no upgrade record written for this ref.
      working.push({
        payload,
        headlinePost: {
          no: 0, index: 0, role: "op" as const, time: 0,
          text: "", quotes: [], replies: 0,
        },
        includedPosts: [],
        isPostLink: false,
        canDownload,
        headlineText: "",
        excluded: true,
        staysAmbient: false,
        droppedLatest: 0,
        droppedRepliedTo: 0,
        droppedReplies: 0,
      });
      continue;
    }

    const headlineText = headlinePost.text.slice(0, budgets.headlineCharCap);
    working.push({
      payload,
      headlinePost: { ...headlinePost, text: headlineText },
      includedPosts: allPosts.filter((p) => p.no !== headlineNo),
      isPostLink: payload.linkedNo != null,
      canDownload,
      headlineText,
      excluded: false,
      staysAmbient: false,
      droppedLatest: 0,
      droppedRepliedTo: 0,
      droppedReplies: 0,
    });
  }

  // ── Convergent selection loop (spec §6.4) ───────────────────────────────────
  // Each iteration allocates files over currently active (non-excluded,
  // non-ambient) refs, computes costs in group order, drops one post from any
  // over-budget ref, and restarts.  Restarts are needed because dropping a post
  // can free a file slot (and thus a caption allowance) that may cascade.
  // Posts only decrease, so the loop terminates.
  let changed = true;
  while (changed) {
    changed = false;

    // Only non-excluded, non-ambient refs participate in file allocation (fix
    // for defect: ambient refs must not consume tier-1 file slots).
    const active = working.filter((r) => !r.excluded && !r.staysAmbient);

    const fileAlloc = allocateGroupFiles({
      refs: active.map((r) => ({
        headlinePost: r.headlinePost,
        includedPosts: r.includedPosts,
        isPostLink: r.isPostLink,
        canDownload: r.canDownload,
      })),
      totalFileBudget: budgets.groupFileBudget,
    });

    let groupTokensAccum = 0;
    for (let ai = 0; ai < active.length; ai++) {
      const r = active[ai]!;

      const processedNos = fileAlloc.get(ai) ?? new Set<number>();
      const filesInRef =
        (processedNos.has(r.headlinePost.no) ? 1 : 0) +
        r.includedPosts.filter((p) => processedNos.has(p.no)).length;

      const refCost = computeRefCost({
        includedPosts: r.includedPosts,
        headlineText: r.headlineText,
        headlineHasFile: !!r.headlinePost.file,
        filesInRef,
        captionAllowanceTokens: budgets.captionAllowanceTokens,
      });

      const effectiveBudget = Math.min(
        budgets.linkTokenBudget,
        budgets.groupTokenBudget - groupTokensAccum,
      );

      if (refCost > effectiveBudget) {
        let dropped = false;
        if (!r.isPostLink) {
          // Thread link: drop replied_to (oldest first), then latest (oldest first).
          const rtIdx = r.includedPosts.findIndex((p) => p.role === "replied_to");
          if (rtIdx >= 0) {
            r.includedPosts.splice(rtIdx, 1);
            r.droppedRepliedTo++;
            dropped = true;
          } else {
            const latIdx = r.includedPosts.findIndex((p) => p.role === "latest");
            if (latIdx >= 0) {
              r.includedPosts.splice(latIdx, 1);
              r.droppedLatest++;
              dropped = true;
            }
          }
        } else {
          // Post link: drop reply (newest first), then replied_to (oldest first).
          const replyIndices = r.includedPosts.reduce<number[]>((acc, p, idx) => {
            if (p.role === "reply") acc.push(idx);
            return acc;
          }, []);
          if (replyIndices.length > 0) {
            r.includedPosts.splice(replyIndices[replyIndices.length - 1]!, 1);
            r.droppedReplies++;
            dropped = true;
          } else {
            const rtIdx = r.includedPosts.findIndex((p) => p.role === "replied_to");
            if (rtIdx >= 0) {
              r.includedPosts.splice(rtIdx, 1);
              r.droppedRepliedTo++;
              dropped = true;
            }
          }
        }
        if (dropped) {
          changed = true;
          continue;
        }

        // No more posts to drop — check whether the headline alone fits.
        const headlineFilesInRef = processedNos.has(r.headlinePost.no) ? 1 : 0;
        const headlineCost = computeRefCost({
          includedPosts: [],
          headlineText: r.headlineText,
          headlineHasFile: !!r.headlinePost.file,
          filesInRef: headlineFilesInRef,
          captionAllowanceTokens: budgets.captionAllowanceTokens,
        });
        if (headlineCost > budgets.groupTokenBudget - groupTokensAccum) {
          r.staysAmbient = true;
          changed = true;
          continue;
        }
      }

      groupTokensAccum += refCost;
    }
  }

  // ── Final file allocation (post-convergence, ambient refs excluded) ─────────
  const finalActive = working.filter((r) => !r.excluded && !r.staysAmbient);
  const finalFileAlloc = allocateGroupFiles({
    refs: finalActive.map((r) => ({
      headlinePost: r.headlinePost,
      includedPosts: r.includedPosts,
      isPostLink: r.isPostLink,
      canDownload: r.canDownload,
    })),
    totalFileBudget: budgets.groupFileBudget,
  });

  // ── Build output ────────────────────────────────────────────────────────────
  const refs: PlannedRef[] = working.map((wr) => {
    if (wr.excluded) {
      return {
        excluded: true,
        staysAmbient: false,
        headlinePost: wr.headlinePost,
        headlineText: "",
        headlineChars: budgets.headlineCharCap,
        includedPosts: [],
        isPostLink: wr.isPostLink,
        canDownload: wr.canDownload,
        files: [],
        droppedLatest: 0,
        droppedRepliedTo: 0,
        droppedReplies: 0,
      };
    }

    if (wr.staysAmbient) {
      return {
        excluded: false,
        staysAmbient: true,
        headlinePost: wr.headlinePost,
        headlineText: wr.headlineText,
        headlineChars: budgets.headlineCharCap,
        includedPosts: wr.includedPosts,
        isPostLink: wr.isPostLink,
        canDownload: wr.canDownload,
        files: [],
        droppedLatest: wr.droppedLatest,
        droppedRepliedTo: wr.droppedRepliedTo,
        droppedReplies: wr.droppedReplies,
      };
    }

    const ai = finalActive.indexOf(wr);
    const processedNos = finalFileAlloc.get(ai) ?? new Set<number>();

    // Build the file list: all included posts (headline + includedPosts) with
    // a non-deleted file.
    const allIncluded = [wr.headlinePost, ...wr.includedPosts];
    const files: PlannedFileInfo[] = [];
    for (const post of allIncluded) {
      if (!post.file || post.file.deleted) continue;
      const ext = safeYotsubaExt(post.file.ext);
      const isPdf = ext === ".pdf";
      const isVideoOrAnimated = ext === ".webm" || ext === ".mp4" || ext === ".gif";
      files.push({
        postNo: post.no,
        isProcessed: processedNos.has(post.no),
        isPdf,
        isVideoOrAnimated,
      });
    }

    return {
      excluded: false,
      staysAmbient: false,
      headlinePost: wr.headlinePost,
      headlineText: wr.headlineText,
      headlineChars: budgets.headlineCharCap,
      includedPosts: wr.includedPosts,
      isPostLink: wr.isPostLink,
      canDownload: wr.canDownload,
      files,
      droppedLatest: wr.droppedLatest,
      droppedRepliedTo: wr.droppedRepliedTo,
      droppedReplies: wr.droppedReplies,
    };
  });

  return { refs };
}
