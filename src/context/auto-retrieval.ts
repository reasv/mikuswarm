import type { MemorySearch, ResolvedRetrievalConfig } from "../retrieval/index.js";
import { estimateTokens } from "./tokens.js";

export interface AutoRetrievalDeps {
  search: MemorySearch;
  config: ResolvedRetrievalConfig;
}

export interface AutoRetrievalInput {
  /** The trigger-group text driving this run — the query (§8c). */
  query: string;
  /** The recency-layer (§10a) content for dedup, or null when absent. */
  recencyContent: string | null;
  /** Anchor for temporal decay (the trigger timestamp), not wall-clock. */
  now: number;
}

const NOTE =
  "Possibly-relevant past diary entries (not necessarily recent). Read-only; open the " +
  "cited file:lines with your read tools if you want the full entry.";

/** Normalize for substring dedup: collapse whitespace, lowercase. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
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
  if (query.length === 0) return null;

  const outcome = await deps.search.search({
    query,
    maxResults: auto.maxResults,
    minScore: auto.minScore,
    snippetMaxChars: 200,
    now: input.now,
  });
  if (outcome.results.length === 0) return null;

  const recencyNorm =
    deps.config.auto.dedupAgainstRecency && input.recencyContent ? norm(input.recencyContent) : null;

  const lines: string[] = [];
  let tokenBudget = auto.maxTokens - estimateTokens(`<retrieved_memory note="${NOTE}">\n</retrieved_memory>`);
  for (const r of outcome.results) {
    // Dedup against the recency layer: skip a chunk whose body already appears there.
    if (recencyNorm) {
      const probe = norm(r.snippet).slice(0, 60);
      if (probe.length >= 12 && recencyNorm.includes(probe)) continue;
    }
    const room = r.room ? ` · ${r.room}` : "";
    const line = `- [${r.path}:${r.startLine}-${r.endLine}${room} · ${r.date}] ${r.snippet}`;
    const cost = estimateTokens(line) + 1;
    if (cost > tokenBudget) break;
    tokenBudget -= cost;
    lines.push(line);
  }
  if (lines.length === 0) return null;

  return `<retrieved_memory note="${NOTE}">\n${lines.join("\n")}\n</retrieved_memory>`;
}
