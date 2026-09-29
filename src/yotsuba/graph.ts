/**
 * Yotsuba (4chan) thread graph.
 * (spec/YOTSUBA-SUPPORT.md §4 graph.ts bullet)
 *
 * Indexes a thread's posts by number, computes position (index), validates
 * same-thread quotes (only existing posts qualify), and builds backlink
 * (reply) maps. Provides helpers used by the post-view engine (view.ts) and
 * by the tool views (chronological, conversation, replies, most_replied, search).
 */

import type { YotsubaPostNode } from "./types.js";

// ---------------------------------------------------------------------------
// Thread graph
// ---------------------------------------------------------------------------

export interface GraphPost extends YotsubaPostNode {
  /** 0-based position in thread order (OP = 0). */
  index: number;
  /** Validated backlink post numbers (replies to this post, in thread order). */
  backlinks: number[];
}

export interface ThreadGraph {
  /** Posts in thread order (index 0 = OP). */
  posts: GraphPost[];
  /** Lookup by post number. */
  byNo: Map<number, GraphPost>;
  /** OP post number. */
  opNo: number;
}

/**
 * Build a ThreadGraph from a list of YotsubaPostNodes (as stored in
 * YotsubaPreviewPayload.posts). The input nodes must already have their `text`,
 * `quotes`, `deadQuotes`, and `crossQuotes` populated by the markup converter.
 *
 * The graph:
 *   - Assigns sequential `index` values (OP = 0).
 *   - Filters `quotes` to only existing same-thread posts (so deleted/missing
 *     posts only appear in `deadQuotes`, never in `quotes`).
 *   - Builds `backlinks` (reverse map: for post A quoting B, B.backlinks += A).
 *   - The `replies` field on each node is the total backlink count as seen in
 *     the full thread (stored in the payload); `backlinks` is only the
 *     replies visible in the captured posts.
 */
export function buildThreadGraph(nodes: YotsubaPostNode[]): ThreadGraph {
  const posts: GraphPost[] = nodes.map((n, idx) => ({
    ...n,
    index: idx,
    backlinks: [],
  }));

  const byNo = new Map<number, GraphPost>();
  for (const p of posts) {
    byNo.set(p.no, p);
  }

  // Validate quotes and build backlinks.
  for (const p of posts) {
    // Filter quotes to existing posts only.
    p.quotes = p.quotes.filter((no) => byNo.has(no));
    // Build backlinks.
    for (const quotedNo of p.quotes) {
      const quoted = byNo.get(quotedNo);
      if (quoted && !quoted.backlinks.includes(p.no)) {
        quoted.backlinks.push(p.no);
      }
    }
  }

  const opNo = posts[0]?.no ?? 0;
  return { posts, byNo, opNo };
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

/**
 * Returns the posts that a given post quotes (its parents), in the order they
 * appear in the thread (oldest first). Only same-thread, existing posts.
 */
export function quotedPosts(graph: ThreadGraph, no: number): GraphPost[] {
  const post = graph.byNo.get(no);
  if (!post) return [];
  return post.quotes
    .map((qNo) => graph.byNo.get(qNo))
    .filter((p): p is GraphPost => p != null)
    .sort((a, b) => a.index - b.index);
}

/**
 * Returns the direct replies to a post, in thread order.
 */
export function repliesTo(graph: ThreadGraph, no: number): GraphPost[] {
  const post = graph.byNo.get(no);
  if (!post) return [];
  return post.backlinks
    .map((rNo) => graph.byNo.get(rNo))
    .filter((p): p is GraphPost => p != null)
    .sort((a, b) => a.index - b.index);
}

/**
 * Returns the latest N replies to the thread (the last N posts in thread order
 * that are not the OP), for use in the capture preview rules.
 */
export function latestReplies(graph: ThreadGraph, n: number): GraphPost[] {
  const all = graph.posts.slice(1); // skip OP
  return all.slice(-n);
}

/**
 * Returns the posts that the given set of posts quote, excluding posts already
 * in the given set and the OP, newest first (highest index first). Used to find
 * "replied_to" candidates in the capture.
 */
export function repliedToPosts(
  graph: ThreadGraph,
  sourcePosts: GraphPost[],
  exclude: ReadonlySet<number>,
  max: number,
): GraphPost[] {
  const seen = new Set<number>();
  const result: GraphPost[] = [];
  // Process source posts in reverse thread order (newest first) to get newest
  // replied-to posts first.
  const sorted = [...sourcePosts].sort((a, b) => b.index - a.index);
  for (const sp of sorted) {
    for (const qNo of sp.quotes) {
      if (exclude.has(qNo) || seen.has(qNo)) continue;
      const qp = graph.byNo.get(qNo);
      if (!qp) continue;
      seen.add(qNo);
      result.push(qp);
      if (result.length >= max) break;
    }
    if (result.length >= max) break;
  }
  // Return newest first.
  return result.sort((a, b) => b.index - a.index);
}

/**
 * Returns posts ranked by reply count (descending), excluding the OP, with a
 * minimum threshold. Ties broken by thread order (earlier posts rank higher).
 *
 * @param graph
 * @param minReplies  Minimum number of replies to be included (spec: 2).
 * @param after       Optional offset in the ranking for pagination.
 */
export function mostRepliedPosts(
  graph: ThreadGraph,
  minReplies = 2,
  after = 0,
): GraphPost[] {
  const candidates = graph.posts
    .slice(1) // exclude OP
    .filter((p) => p.backlinks.length >= minReplies);
  // Sort by reply count (backlinks within the thread) desc, then by thread
  // order asc for stability.
  candidates.sort((a, b) => {
    const ra = a.backlinks.length;
    const rb = b.backlinks.length;
    if (rb !== ra) return rb - ra;
    return a.index - b.index;
  });
  return candidates.slice(after);
}

/**
 * Returns posts whose plain text contains all of the query terms (case-insensitive).
 * Each term must appear in the post's `text` field.
 *
 * @param graph
 * @param terms  Array of search terms; ALL must match.
 * @param after  Optional post number to start after (exclusive).
 */
export function searchPosts(
  graph: ThreadGraph,
  terms: string[],
  after?: number,
): GraphPost[] {
  const lowerTerms = terms.map((t) => t.toLowerCase());
  let startIndex = 0;
  if (after != null) {
    const afterPost = graph.byNo.get(after);
    if (afterPost) startIndex = afterPost.index + 1;
  }
  return graph.posts.slice(startIndex).filter((p) => {
    const lower = p.text.toLowerCase();
    return lowerTerms.every((t) => lower.includes(t));
  });
}

/**
 * Returns ancestors of a post up to the given depth, following the first quote
 * in each post's quotes list (the spec says depth 3, depth 1 = full, deeper
 * as excerpts). Returns in ascending thread-order (oldest first).
 *
 * @param graph
 * @param no    The post to trace ancestors from.
 * @param depth Maximum depth (spec default: 3).
 */
export function ancestorChain(
  graph: ThreadGraph,
  no: number,
  depth = 3,
): GraphPost[] {
  const chain: GraphPost[] = [];
  const visited = new Set<number>([no]);
  let current = graph.byNo.get(no);
  for (let d = 0; d < depth; d++) {
    if (!current || current.quotes.length === 0) break;
    // Follow the first (oldest) quoted post.
    const parentNo = current.quotes.reduce((best, qNo) => {
      const qp = graph.byNo.get(qNo);
      if (!qp) return best;
      const bp = graph.byNo.get(best);
      return !bp || qp.index < bp.index ? qNo : best;
    }, current.quotes[0]);
    if (visited.has(parentNo)) break;
    visited.add(parentNo);
    const parent = graph.byNo.get(parentNo);
    if (!parent) break;
    chain.unshift(parent); // prepend so result is oldest-first
    current = parent;
  }
  return chain;
}

/**
 * Gap count: how many posts (and how many of those carry files) lie between two
 * adjacent placed posts at the given indices, exclusive of both endpoints.
 */
export function gapBetween(
  graph: ThreadGraph,
  fromIndex: number,
  toIndex: number,
): { posts: number; files: number } {
  if (toIndex <= fromIndex + 1) return { posts: 0, files: 0 };
  const gap = graph.posts.slice(fromIndex + 1, toIndex);
  const files = gap.filter((p) => p.file != null).length;
  return { posts: gap.length, files };
}

/**
 * Gap count from the last placed post to the end of the thread.
 */
export function gapToEnd(
  graph: ThreadGraph,
  lastIndex: number,
): { posts: number; files: number } {
  if (lastIndex >= graph.posts.length - 1) return { posts: 0, files: 0 };
  const gap = graph.posts.slice(lastIndex + 1);
  const files = gap.filter((p) => p.file != null).length;
  return { posts: gap.length, files };
}
