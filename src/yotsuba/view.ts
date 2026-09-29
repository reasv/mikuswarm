/**
 * Yotsuba (4chan) post-view engine.
 * (spec/YOTSUBA-SUPPORT.md §5)
 *
 * Pure and deterministic: given a thread graph, a slot list, and a budget,
 * produces the selected posts in thread order plus gap counts and unplaced
 * lists. Renders nothing itself — callers (format.ts, the enrichment renderer,
 * the tool) perform the actual string/XML building from the output.
 *
 * The engine is the single source of truth for selection rules so preview and
 * tool output describe omissions in the same vocabulary.
 */

import type { GraphPost, ThreadGraph } from "./graph.js";
import { gapBetween, gapToEnd } from "./graph.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * Role precedence order (lower index = higher precedence). When a post appears
 * in multiple slots, it is placed once at the highest-precedence role.
 */
export const ROLE_PRECEDENCE = [
  "linked",
  "op",
  "replied_to",
  "reply",
  "most_replied",
  "match",
  "latest",
  "context",
] as const;

export type SlotRole = (typeof ROLE_PRECEDENCE)[number];
export type SlotTier = "full" | "excerpt";

export interface Slot {
  /** Post number. */
  no: number;
  /** Semantic role in this view. */
  role: SlotRole;
  /** Rendering tier. */
  tier: SlotTier;
  /**
   * Character cap for `full` tier (0 = uncapped). When set, the post's text
   * is truncated to this many characters and a `[… N more characters]` marker
   * is appended. Tool views use 0 (no cap); preview trigger views use 800 for
   * the headline.
   */
  textCap?: number;
  /**
   * Priority within the tier for file allocation and slot processing order.
   * Lower = higher priority.
   */
  priority?: number;
  /**
   * If true, this post is always placed even if the budget is exceeded.
   * Pinned slots (the linked post, the OP) must always appear.
   */
  pinned?: boolean;
}

export interface ViewBudget {
  /** Maximum number of posts to place (not counting pinned overflows). */
  maxPosts: number;
  /**
   * Maximum token cost of text content (estimated by the injected `costFn`),
   * inclusive of `reserveTokens`. Pinned posts may take the budget over this.
   */
  maxTextTokens: number;
  /** Maximum number of attachments to show (file pass). 0 = no limit; negative = none. */
  maxFiles: number;
  /**
   * Tokens reserved up front for the frame (thread element, gap markers,
   * footer, caption allowances). Charged against `maxTextTokens` before any
   * post is placed.
   */
  reserveTokens?: number;
  /**
   * When true (contiguous paging), selection stops at the first slot that
   * does not fit, so a page never skips a post in the middle.
   */
  contiguous?: boolean;
  /**
   * Excerpt fallback: when a `full` slot does not fit, try placing it as
   * `excerpt` instead. Trigger previews turn this OFF (their posts are whole
   * or absent); tool pages leave it ON.
   */
  excerptFallback?: boolean;
}

/** Default excerpt length in characters. */
export const DEFAULT_EXCERPT_CHARS = 160;

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface PlacedPost {
  post: GraphPost;
  /** The role and tier at which this post was placed. */
  role: SlotRole;
  tier: SlotTier;
  /** Effective text cap (0 = uncapped). */
  textCap: number;
  /** True when the file of this post was allocated to the shown-files budget. */
  fileShown: boolean;
  /** Priority used for file allocation (lower = higher priority). */
  filePriority: number;
}

export interface GapMarker {
  /** Number of posts in this gap. */
  posts: number;
  /** Number of those posts that have files. */
  files: number;
}

export interface ViewResult {
  /**
   * Placed posts in thread order, with gap markers between non-adjacent ones.
   * Interleaved: `PlacedPost | GapMarker`.
   */
  items: Array<PlacedPost | GapMarker>;
  /**
   * Posts that were requested but not placed (budget exhausted), in slot order.
   */
  unplaced: Array<{ no: number; role: SlotRole }>;
  /**
   * True when the last placed post is not the last post of the thread.
   */
  hasTrailingGap: boolean;
  /** Gap after the last placed post (posts and files to end of thread). */
  trailingGap: GapMarker;
  /** Number of posts placed. */
  placedCount: number;
  /** Number of files shown. */
  shownFiles: number;
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

/**
 * Run the post-view engine.
 *
 * @param graph    The thread graph.
 * @param slots    Requested slots (may reference posts not in the graph).
 * @param budget   Budget constraints.
 * @param costFn   Token estimator for a post's text (caller provides this so
 *                 the engine has no direct dependency on the tokenizer).
 */
export function runView(
  graph: ThreadGraph,
  slots: Slot[],
  budget: ViewBudget,
  costFn: (text: string) => number,
): ViewResult {
  const {
    maxPosts,
    maxTextTokens,
    maxFiles,
    reserveTokens = 0,
    contiguous = false,
    excerptFallback = true,
  } = budget;

  // --- Phase 1: Deduplicate slots by post number ---
  // A post that appears in multiple slots is placed once: at the highest tier
  // any slot asks for, with the highest-precedence role.
  const merged = new Map<number, Slot>();
  for (const slot of slots) {
    const existing = merged.get(slot.no);
    if (!existing) {
      merged.set(slot.no, { ...slot });
    } else {
      // Higher-precedence role (lower index in ROLE_PRECEDENCE).
      const existingIdx = ROLE_PRECEDENCE.indexOf(existing.role);
      const newIdx = ROLE_PRECEDENCE.indexOf(slot.role);
      if (newIdx < existingIdx) existing.role = slot.role;
      // Higher tier: full > excerpt.
      if (slot.tier === "full" && existing.tier === "excerpt") existing.tier = "full";
      // Higher-priority textCap: more generous (higher cap value or uncapped).
      const existingCap = existing.textCap ?? 0;
      const newCap = slot.textCap ?? 0;
      if (newCap === 0 || (existingCap !== 0 && newCap > existingCap)) {
        existing.textCap = newCap;
      }
      // Lower priority number = higher priority.
      const ep = existing.priority ?? 999;
      const np = slot.priority ?? 999;
      if (np < ep) existing.priority = np;
      // A slot is pinned if ANY of its source slots is pinned.
      if (slot.pinned) existing.pinned = true;
    }
  }

  // --- Phase 2: Sort by priority, then by post index for stability ---
  const sortedSlots = [...merged.values()].sort((a, b) => {
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;
    const ga = graph.byNo.get(a.no);
    const gb = graph.byNo.get(b.no);
    return (ga?.index ?? 99999) - (gb?.index ?? 99999);
  });

  // --- Phase 3: Placement loop ---
  let usedTokens = reserveTokens;
  let placedCount = 0;
  const placed = new Map<number, PlacedPost>();
  const unplaced: Array<{ no: number; role: SlotRole }> = [];
  let stoppedContiguous = false;

  for (const slot of sortedSlots) {
    if (stoppedContiguous) {
      // After a contiguous stop, remaining non-pinned slots are unplaced.
      if (!slot.pinned) {
        unplaced.push({ no: slot.no, role: slot.role });
        continue;
      }
    }

    const gpost = graph.byNo.get(slot.no);
    if (!gpost) {
      // Post not in the graph (e.g. captured but not in this subset).
      unplaced.push({ no: slot.no, role: slot.role });
      continue;
    }

    if (slot.pinned) {
      // Pinned posts always go in.
      placed.set(slot.no, {
        post: gpost,
        role: slot.role,
        tier: slot.tier,
        textCap: slot.textCap ?? 0,
        fileShown: false,
        filePriority: slot.priority ?? 999,
      });
      placedCount++;
      const cost = computePostCost(gpost, slot.tier, slot.textCap ?? 0, costFn);
      usedTokens += cost;
      continue;
    }

    // Budget check.
    if (placedCount >= maxPosts) {
      if (contiguous) stoppedContiguous = true;
      unplaced.push({ no: slot.no, role: slot.role });
      continue;
    }

    // Compute cost at requested tier.
    let tier = slot.tier;
    let textCap = slot.textCap ?? 0;
    let cost = computePostCost(gpost, tier, textCap, costFn);
    const remainingTokens = maxTextTokens - usedTokens;

    if (cost > remainingTokens) {
      if (tier === "full" && excerptFallback) {
        // Try excerpt tier.
        tier = "excerpt";
        textCap = DEFAULT_EXCERPT_CHARS;
        cost = computePostCost(gpost, tier, textCap, costFn);
      }
      if (cost > remainingTokens) {
        if (contiguous) stoppedContiguous = true;
        unplaced.push({ no: slot.no, role: slot.role });
        continue;
      }
    }

    placed.set(slot.no, {
      post: gpost,
      role: slot.role,
      tier,
      textCap,
      fileShown: false,
      filePriority: slot.priority ?? 999,
    });
    usedTokens += cost;
    placedCount++;
  }

  // --- Phase 4: File pass ---
  // Assign files to placed full-tier posts in file-priority order, up to maxFiles.
  if (maxFiles > 0) {
    const withFiles = [...placed.values()]
      .filter((p) => p.tier === "full" && p.post.file != null)
      .sort((a, b) => a.filePriority - b.filePriority);
    let shownFiles = 0;
    for (const p of withFiles) {
      if (shownFiles >= maxFiles) break;
      p.fileShown = true;
      shownFiles++;
    }
  } else if (maxFiles === 0) {
    // No limit: show all files of placed full posts.
    for (const p of placed.values()) {
      if (p.tier === "full" && p.post.file != null) {
        p.fileShown = true;
      }
    }
  }

  // --- Phase 5: Build output in thread order ---
  // Sort placed posts by thread index.
  const placedInOrder = [...placed.values()].sort((a, b) => a.post.index - b.post.index);

  const items: Array<PlacedPost | GapMarker> = [];
  let lastIndex = -1;

  for (const pp of placedInOrder) {
    const idx = pp.post.index;
    if (lastIndex >= 0) {
      const gap = gapBetween(graph, lastIndex, idx);
      if (gap.posts > 0) {
        items.push(gap);
      }
    }
    items.push(pp);
    lastIndex = idx;
  }

  // --- Phase 6: Trailing gap ---
  const trailingGap =
    lastIndex >= 0 ? gapToEnd(graph, lastIndex) : { posts: graph.posts.length, files: graph.posts.filter((p) => p.file != null).length };
  const hasTrailingGap = trailingGap.posts > 0;

  // Count shown files
  const shownFiles = [...placed.values()].filter((p) => p.fileShown).length;

  return {
    items,
    unplaced,
    hasTrailingGap,
    trailingGap,
    placedCount,
    shownFiles,
  };
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------

function computePostCost(
  post: GraphPost,
  tier: SlotTier,
  textCap: number,
  costFn: (text: string) => number,
): number {
  if (tier === "excerpt") {
    const text = post.text.slice(0, DEFAULT_EXCERPT_CHARS);
    return costFn(text);
  }
  // Full tier.
  const text = textCap > 0 ? post.text.slice(0, textCap) : post.text;
  return costFn(text);
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isGapMarker(item: PlacedPost | GapMarker): item is GapMarker {
  return "posts" in item && !("post" in item);
}

export function isPlacedPost(item: PlacedPost | GapMarker): item is PlacedPost {
  return "post" in item;
}
