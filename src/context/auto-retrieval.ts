import type {
  MemorySearch,
  ResolvedRetrievalConfig,
  RetrievalResult,
} from "../retrieval/index.js";
import { estimateTokens } from "./tokens.js";

export interface AutoRetrievalDeps {
  search: MemorySearch;
  config: ResolvedRetrievalConfig;
}

export interface AutoRetrievalInput {
  /**
   * The query (§8c): the plain message body the user typed — the bare `body` of
   * each trigger event joined by newlines, NOT the rich `<message …>` envelope.
   * Reply/caption/attachment context is deliberately excluded (see builder.ts).
   */
  query: string;
  /**
   * Distinct trigger-user display name(s) for the user lane (§9d) — the single
   * strongest relevance signal we have. Drives a separate lexical "history with this
   * person" sub-search whose hits are reserved ahead of the topical results. Empty for
   * proactive builds (no trigger sender) or when the sender has no display name.
   */
  triggerUsers: string[];
  /** The recency-layer (§10a) content for dedup, or null when absent. */
  recencyContent: string | null;
  /** Anchor for temporal decay (the trigger timestamp), not wall-clock. */
  now: number;
  /**
   * Bounds the query-embed wait for an INTERACTIVE build (§9d #7). When it fires
   * (the build's interactive wall-clock deadline, or shutdown drain), the search
   * degrades to lexical-only instead of blocking inline during an embed-model
   * outage. The block itself never fails the build — the builder's `.catch(…null)`
   * already omits it on rejection.
   */
  signal?: AbortSignal;
}

const NOTE =
  "Possibly-relevant past diary entries (not necessarily recent). Read-only; open the " +
  "cited file:lines with your read tools if you want the full entry.";

/** Normalize for substring dedup: collapse whitespace, lowercase. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Neutralize angle brackets before embedding a snippet in the tag-delimited
 * `<retrieved_memory>…</retrieved_memory>` block (review issue #10). `makeSnippet`
 * collapses whitespace but preserves `<`/`>`, so a diary entry that quotes a literal
 * `</retrieved_memory>` (or any other tag) would otherwise forge the block's
 * structure. Escaping to HTML entities keeps the text human-readable while making it
 * impossible to terminate or fabricate a tag mid-block. The dedup probe runs on the
 * raw snippet (above) so escaping doesn't perturb it.
 */
function escapeAngleBrackets(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Build the small, cited auto-retrieval block (ARCHITECTURE.md §9d / design §8c).
 * Rides INSIDE the final user turn (cache-safe), small and conservative: a tight
 * `min_score`, a low `max_results`, a hard token budget, and dedup against the
 * always-loaded recency layer (recency already covers "recent" — this spends its
 * budget on *relevant-but-not-recent*). Returns null when there's nothing to add.
 */
export async function buildAutoRetrievalBlock(
  deps: AutoRetrievalDeps,
  input: AutoRetrievalInput,
): Promise<string | null> {
  const auto = deps.config.auto;
  const query = input.query.trim();

  // Topical lane: the existing free-text hybrid search over the trigger body.
  const topical: RetrievalResult[] =
    query.length === 0
      ? []
      : (
          await deps.search.search({
            query,
            maxResults: auto.maxResults,
            minScore: auto.minScore,
            snippetMaxChars: 200,
            now: input.now,
            signal: input.signal,
          })
        ).results;

  // User lane: lexical "history with this person" by trigger display name (§9d).
  // Lexical-only, so no embed wait — runs unconditionally of the embed deadline.
  const userLane: RetrievalResult[] =
    auto.userLane.enabled && input.triggerUsers.length > 0
      ? await deps.search.searchUserLane({
          names: input.triggerUsers,
          maxResults: auto.userLane.maxResults,
          minScore: auto.userLane.minScore,
          prefixEnabled: auto.userLane.prefixEnabled,
          prefixMinChars: auto.userLane.prefixMinChars,
          snippetMaxChars: 200,
          now: input.now,
        })
      : [];

  // Combine, user-lane first (reserved, priority placement) then topical, deduped by
  // chunk id so a chunk surfaced by both lanes appears once (in its user-lane slot).
  const seen = new Set<string>();
  const results: RetrievalResult[] = [];
  for (const r of [...userLane, ...topical]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    results.push(r);
  }
  if (results.length === 0) return null;

  const recencyNorm =
    deps.config.auto.dedupAgainstRecency && input.recencyContent ? norm(input.recencyContent) : null;

  const lines: string[] = [];
  let tokenBudget = auto.maxTokens - estimateTokens(`<retrieved_memory note="${NOTE}">\n</retrieved_memory>`);
  for (const r of results) {
    // Dedup against the recency layer: skip a chunk whose body already appears there.
    //
    // This is a deliberate best-effort substring heuristic, NOT chunk-`id` identity
    // (review issue #15). The recency layer (`recentMemoryWindow` → `diary-layer`) is
    // index-free: it renders raw block text and exposes only that concatenated/trimmed
    // string — it carries no chunk ids and loses each block's path/line provenance once
    // the blocks are joined and trimmed to the token budget. An id-based dedup would
    // therefore have to recover identity by matching the recency text back to chunk
    // rows via fragile byte-identity, coupling the recency path to the chunk-id scheme —
    // more plumbing for a low-stakes miss (at worst the model occasionally sees one
    // diary entry twice). So we probe a normalized 60-char prefix of the snippet against
    // the normalized recency text. The `>= 12` guard skips probes too short to be a
    // confident match (per operator: not a concern).
    if (recencyNorm) {
      const probe = norm(r.snippet).slice(0, 60);
      if (probe.length >= 12 && recencyNorm.includes(probe)) continue;
    }
    const room = r.room ? ` · ${r.room}` : "";
    const line = `- [${r.path}:${r.startLine}-${r.endLine}${room} · ${r.date}] ${escapeAngleBrackets(r.snippet)}`;
    const cost = estimateTokens(line) + 1;
    if (cost > tokenBudget) break;
    tokenBudget -= cost;
    lines.push(line);
  }
  if (lines.length === 0) return null;

  return `<retrieved_memory note="${NOTE}">\n${lines.join("\n")}\n</retrieved_memory>`;
}
