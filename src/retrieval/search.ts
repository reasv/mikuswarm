import type { LexicalHit, Storage } from "../storage/index.js";
import { agentDateStamp, parseZonedWallClock, getConfiguredTimezone } from "../time/index.js";
import type { MemoryIndexer } from "./indexer.js";
import type { ResolvedRetrievalConfig } from "./config.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import type { VectorStore } from "./vector-store.js";

/** One ranked, source-cited retrieval result (ARCHITECTURE.md §9d / design §9). */
export interface RetrievalResult {
  path: string;
  startLine: number;
  endLine: number;
  room: string | null;
  /** `YYYY-MM-DD` of the entry (from `entry_ts`, agent zone). */
  date: string;
  entryTs: number;
  /** Combined relevance in [0,1] (post-decay). */
  score: number;
  /** Short human snippet (header line stripped, whitespace-collapsed). */
  snippet: string;
  /** Chunk content identity, for dedup across read-paths (§8c). */
  id: string;
}

export interface SearchOptions {
  query: string;
  maxResults: number;
  minScore: number;
  room?: string;
  /** Inclusive `YYYY-MM-DD` lower/upper bounds on entry date. */
  after?: string;
  before?: string;
  /** Snippet length cap in characters (tool ≈700; auto-retrieval ≈200). */
  snippetMaxChars: number;
  /** Override "now" for temporal decay (testing); defaults to Date.now(). */
  now?: number;
}

export interface SearchOutcome {
  results: RetrievalResult[];
  /** 'hybrid' when the semantic half ran; 'lexical' otherwise / on degrade. */
  mode: "hybrid" | "lexical";
  /** True when embeddings were configured but unavailable for this query. */
  degraded: boolean;
  /**
   * Names of date-range args (`"after"`/`"before"`) that were provided but failed to
   * parse to a valid bound, so they were *ignored* (review issue #4b). Empty when both
   * resolved or neither was given. The caller surfaces this so the agent doesn't
   * believe it constrained the range when it didn't.
   */
  ignoredDateBounds: string[];
}

export interface MemorySearchDeps {
  provider?: EmbeddingProvider;
  vectorStore?: VectorStore;
}

interface Scored extends LexicalHit {
  vecScore: number;
  bm25Score: number;
  score: number;
}

/**
 * The shared query path behind `recall_memory` (§9) and auto-retrieval (§8c). Hybrid
 * when an embedding provider + vector store are wired (§8a): parallel vector-KNN and
 * FTS5/BM25 candidate fetch → weighted merge → temporal decay (§8b) → optional MMR
 * diversity re-rank → minScore cut → top-K. Degrades to lexical-only (a strict
 * upgrade over ripgrep) whenever embeddings are unavailable — never an error, never a
 * cross-space mismatch (§4/§5a).
 */
export class MemorySearch {
  private readonly provider?: EmbeddingProvider;
  private readonly vectorStore?: VectorStore;

  constructor(
    private readonly storage: Storage,
    private readonly indexer: MemoryIndexer,
    private readonly config: ResolvedRetrievalConfig,
    deps?: MemorySearchDeps,
  ) {
    this.provider = deps?.provider;
    this.vectorStore = deps?.vectorStore;
  }

  async search(opts: SearchOptions): Promise<SearchOutcome> {
    await this.indexer.ensureFreshForQuery();
    const now = opts.now ?? Date.now();
    const q = this.config.query;
    const candidateLimit = Math.max(opts.maxResults, opts.maxResults * q.candidateMultiplier);
    // Resolve the optional date filters. A bound that's present but unparseable (bad
    // month/day, wrong shape) yields `invalid`, surfaced in the outcome so the caller
    // can tell the agent the filter was ignored rather than silently dropping it
    // (review issue #4b). `beforeTs` is an *exclusive* start-of-next-day bound so the
    // `before` day is fully inclusive down to 23:59:59.999 (review issue #12).
    const after = dateBoundTs(opts.after, "start");
    const before = dateBoundTs(opts.before, "end");
    const afterTs = after.ts;
    const beforeTs = before.ts;
    const invalidDateBounds: string[] = [];
    if (after.invalid) invalidDateBounds.push("after");
    if (before.invalid) invalidDateBounds.push("before");

    // --- Lexical candidates (always) ---
    const match = buildFtsMatch(opts.query);
    const ftsHits = match
      ? this.storage.searchMemoryLexical({ match, limit: candidateLimit, room: opts.room, afterTs, beforeTs })
      : [];

    // --- Vector candidates (when embeddings are available) ---
    let vecScoreByRow = new Map<number, number>();
    let vecMeta: LexicalHit[] = [];
    let semanticRan = false;
    let degraded = false;
    if (this.provider && this.vectorStore) {
      try {
        const queryVec = await this.provider.embedQuery(opts.query);
        const hits = this.vectorStore.knn(queryVec, candidateLimit, "memory");
        if (hits.length > 0) {
          vecScoreByRow = new Map(
            hits.map((h) => [h.chunkId, clamp01(1 - h.distance)]),
          );
          // Fetch metadata for vector hits, applying the same room/date filters.
          vecMeta = this.storage.getChunksByRowids([...vecScoreByRow.keys()], {
            room: opts.room,
            afterTs,
            beforeTs,
          });
        }
        semanticRan = true;
      } catch (error) {
        // Query-embed or KNN failed → lexical-only for this query (never cross spaces).
        degraded = true;
      }
    }

    // --- Merge ---
    const bm25ByRow = normalizeBm25(ftsHits);
    const metaByRow = new Map<number, LexicalHit>();
    for (const h of ftsHits) metaByRow.set(h.rowid, h);
    for (const h of vecMeta) if (!metaByRow.has(h.rowid)) metaByRow.set(h.rowid, h);
    // Drop vector hits whose metadata was filtered out (room/date) — keep only rows
    // we actually have metadata for.
    const candidateRows = new Set<number>();
    for (const h of ftsHits) candidateRows.add(h.rowid);
    for (const rowid of vecScoreByRow.keys()) if (metaByRow.has(rowid)) candidateRows.add(rowid);

    // Weights: normalize when both halves are present; lexical-only → all text weight.
    const useVec = semanticRan && vecScoreByRow.size > 0;
    // Parenthesized so a zero-sum (both weights 0) falls back to 1 rather than
    // `0 || 1` binding as `vectorWeight + (textWeight || 1)` (review issue #6). Config
    // resolution also rejects a zero-sum weight pair, so this is belt-and-suspenders.
    const wSum = useVec ? (q.vectorWeight + q.textWeight) || 1 : 1;
    const wv = useVec ? q.vectorWeight / wSum : 0;
    const wt = useVec ? q.textWeight / wSum : 1;

    const scored: Scored[] = [];
    for (const rowid of candidateRows) {
      const meta = metaByRow.get(rowid)!;
      const vecScore = vecScoreByRow.get(rowid) ?? 0;
      const bm25Score = bm25ByRow.get(rowid) ?? 0;
      let score = wv * vecScore + wt * bm25Score;
      if (q.temporalDecayEnabled) {
        score *= decayFactor(meta.entryTs, now, q.temporalDecayHalfLifeDays);
      }
      scored.push({ ...meta, vecScore, bm25Score, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const aboveThreshold = scored.filter((s) => s.score >= opts.minScore);

    const ranked =
      q.mmrEnabled && useVec
        ? this.mmrRerank(aboveThreshold, q.mmrLambda, opts.maxResults)
        : aboveThreshold.slice(0, opts.maxResults);

    return {
      results: ranked.map((s) => this.toResult(s, opts.snippetMaxChars)),
      mode: useVec ? "hybrid" : "lexical",
      degraded,
      ignoredDateBounds: invalidDateBounds,
    };
  }

  /** MMR diversity re-rank (§8a) using stored vectors; falls back to plain top-K. */
  private mmrRerank(cands: Scored[], lambda: number, k: number): Scored[] {
    if (cands.length <= 1 || !this.vectorStore) return cands.slice(0, k);
    const vectors = this.vectorStore.getVectors(cands.map((c) => c.rowid));
    if (vectors.size === 0) return cands.slice(0, k);
    const selected: Scored[] = [];
    const pool = [...cands];
    while (selected.length < k && pool.length > 0) {
      let bestIdx = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i]!;
        const cv = vectors.get(c.rowid);
        let maxSim = 0;
        if (cv) {
          for (const s of selected) {
            const sv = vectors.get(s.rowid);
            if (sv) maxSim = Math.max(maxSim, dot(cv, sv));
          }
        }
        const val = lambda * c.score - (1 - lambda) * maxSim;
        if (val > bestVal) {
          bestVal = val;
          bestIdx = i;
        }
      }
      selected.push(pool.splice(bestIdx, 1)[0]!);
    }
    return selected;
  }

  private toResult(hit: Scored, snippetMaxChars: number): RetrievalResult {
    return {
      id: hit.id,
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      room: hit.room,
      date: agentDateStamp(hit.entryTs),
      entryTs: hit.entryTs,
      score: hit.score,
      snippet: makeSnippet(hit.text, snippetMaxChars),
    };
  }
}

/**
 * Common English stopwords dropped from FTS queries (review issue #5a). Without this,
 * a query carrying only function words (the full trigger text in auto-retrieval is the
 * worst case) matches on "the"/"and"/etc. and surfaces weak material. Kept small and
 * dependency-free — just the high-frequency closed-class words that never carry recall
 * signal. Content words (including short ones like "ai", "go", "k8s") are preserved.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "can",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "hers",
  "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of",
  "on", "or", "our", "ours", "out", "she", "so", "than", "that", "the", "their",
  "theirs", "them", "then", "there", "these", "they", "this", "those", "to", "up",
  "us", "was", "we", "were", "what", "when", "where", "which", "who", "whom", "why",
  "will", "with", "would", "you", "your", "yours",
]);

/**
 * Sanitize free-text into an FTS5 MATCH expression: extract word tokens, drop common
 * stopwords (#5a), and OR them — each phrase-quoted so FTS operators / punctuation in
 * the user text can't inject syntax. The OR group is scoped to the `text` column via
 * the FTS5 column-filter form `{text} : (...)` so a token equal to a `room` label
 * can't match the indexed `room` column and inflate BM25 for off-topic chunks (#9 —
 * room stays a metadata filter on `memory_chunks.room`, applied separately in
 * `searchMemoryLexical`). Returns null when no usable (non-stopword) terms remain.
 */
export function buildFtsMatch(query: string): string | null {
  const tokens = Array.from(
    new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (t) => t.length >= 2 && !STOPWORDS.has(t),
      ),
    ),
  ).slice(0, 32);
  if (tokens.length === 0) return null;
  const orGroup = tokens.map((t) => `"${t}"`).join(" OR ");
  return `{text} : (${orGroup})`;
}

/**
 * Saturating BM25-relevance constant (review issue #5b). SQLite FTS5 `bm25()` returns
 * a *cost* (more-negative = better); we flip via `-h.bm25` to a relevance `rel ≥ 0`
 * that grows with match quality (more/rarer query-term hits → larger `rel`). The
 * saturating map `rel / (rel + BM25_SATURATION)` then sends that to [0,1) with
 * *absolute* meaning: a lone weak match (small `rel`) scores low and can fall below
 * `min_score`, while strong matches approach 1. `k ≈ 1.5` is tuned for FTS5's default
 * BM25 (k1=1.2, b=0.75): a single solid term hit lands around the 0.45 auto-retrieval
 * floor, multi-term matches clear it comfortably, and a marginal common-word-only hit
 * stays below. Not a config knob (kept as a documented constant) — flagged in the
 * tracker; promote to `[retrieval.query]` later if tuning demands it.
 */
const BM25_SATURATION = 1.5;

/**
 * Map FTS5 BM25 cost into an absolute [0,1) relevance per rowid via a saturating
 * transform (review issue #5b). Replaces the old within-candidate min-max normalize
 * (which always forced the best hit to 1.0 regardless of absolute quality, so
 * `min_score` was a relative rank cut, not an absolute floor). Now a weak lone match
 * scores low and can be dropped by `min_score`. Better match → higher score.
 */
function normalizeBm25(hits: LexicalHit[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const h of hits) {
    const rel = Math.max(0, -h.bm25); // bm25() is a cost; flip to non-negative relevance
    out.set(h.rowid, rel / (rel + BM25_SATURATION));
  }
  return out;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** exp(-ln2/halfLife · ageDays) == 2^(-ageDays/halfLife). */
function decayFactor(entryTs: number, now: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now - entryTs) / 86_400_000);
  return Math.pow(2, -ageDays / halfLifeDays);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** One resolved date bound: `ts` is the epoch-ms cutoff (undefined = no constraint). */
interface DateBound {
  /** The resolved bound, or undefined when no date was given OR it was invalid. */
  ts: number | undefined;
  /** True when a non-empty date was given but didn't parse to a bound (review #4b). */
  invalid: boolean;
}

/**
 * Resolve a `YYYY-MM-DD` filter into an epoch-ms bound (review issues #4b, #12).
 *
 * - `"start"` → 00:00 of that day, used as an inclusive lower bound (`entry_ts >= ts`).
 * - `"end"` → 00:00 of the **next** day, used as an *exclusive* upper bound
 *   (`entry_ts < ts`). This makes `before` fully day-inclusive: the old `23:59` cutoff
 *   silently dropped `[23:59:00.001, 23:59:59.999]`.
 *
 * No date → `{ ts: undefined, invalid: false }` (no constraint). A non-empty date that
 * fails to parse (bad calendar field, wrong shape — `parseZonedWallClock` now rejects
 * overflow, review #4a) → `{ ts: undefined, invalid: true }` so the caller surfaces
 * the ignored filter rather than silently widening the range.
 */
function dateBoundTs(date: string | undefined, edge: "start" | "end"): DateBound {
  if (date === undefined || date.trim() === "") return { ts: undefined, invalid: false };
  const tz = getConfiguredTimezone();
  if (edge === "start") {
    const ts = parseZonedWallClock(`${date.trim()} 00:00`, tz);
    return ts === null ? { ts: undefined, invalid: true } : { ts, invalid: false };
  }
  // End bound = start of the next day. Parse the day at noon to dodge any DST edge,
  // then add 24h and snap to that day's 00:00 via the agent-zone date stamp.
  const noon = parseZonedWallClock(`${date.trim()} 12:00`, tz);
  if (noon === null) return { ts: undefined, invalid: true };
  const nextDay = agentDateStamp(noon + 86_400_000);
  const ts = parseZonedWallClock(`${nextDay} 00:00`, tz);
  return ts === null ? { ts: undefined, invalid: true } : { ts, invalid: false };
}

/** Strip a leading `## ` header line, collapse whitespace, truncate to N chars. */
function makeSnippet(text: string, maxChars: number): string {
  const body = text.replace(/^##[^\n]*\n?/, "").replace(/\s+/g, " ").trim();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars).trimEnd()}…`;
}
