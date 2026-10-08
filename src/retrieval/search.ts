import type { LexicalHit, Storage } from "../storage/index.js";
import { agentDateStamp, parseZonedWallClock, getConfiguredTimezone } from "../time/index.js";
import type { Logger } from "../observability/logger.js";
import type { MemoryIndexer } from "./indexer.js";
import type { ResolvedRetrievalConfig } from "./config.js";
import type { EmbeddingProvider } from "./embedding/provider.js";
import type { VectorStore, VecHit } from "./vector-store.js";
import { makeExcerpt } from "./excerpt.js";

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
  /** Match-centred, cleaned excerpt (§9d "Excerpts"). */
  snippet: string;
  /** Chunk content identity, for dedup across read-paths (§8c). */
  id: string;
  /** sha256 of the chunk text (the filter / tag / vector key). */
  contentHash: string;
}

export interface SearchOptions {
  query: string;
  maxResults: number;
  minScore: number;
  room?: string;
  /** Inclusive `YYYY-MM-DD` lower/upper bounds on entry date. */
  after?: string;
  before?: string;
  /** Excerpt length cap in characters (`recall_memory`, §9d "Excerpts"). */
  snippetMaxChars: number;
  /** Restrict to these chunk rowids (a scoped search, e.g. `recall_memory` `user`). */
  rowidScope?: number[];
  /** Override "now" for temporal decay (testing); defaults to Date.now(). */
  now?: number;
  /**
   * Bounds the query-embed wait (§9d #7). Auto-retrieval inside an INTERACTIVE
   * context build passes a deadline-derived signal so an embed-model outage
   * degrades this query to lexical-only (the catch below) instead of blocking
   * the build for minutes. Unset for the `recall_memory` tool and tests.
   */
  signal?: AbortSignal;
  /**
   * In agents mode: restrict retrieval to this agent's memory corpus (spec §7.1).
   * Null / absent = legacy mode — no filter, all chunks visible. The `"__legacy__"`
   * sentinel is treated as null (no filter).
   */
  agentName?: string | null;
}

/**
 * Inputs for the lexical "who am I talking to" lane (ARCHITECTURE.md §9d). Driven by
 * the trigger user's display name(s), not free text — see `MemorySearch.searchUserLane`.
 */
export interface UserLaneOptions {
  /** Trigger-user display name(s); tokenized + deduped into name terms. */
  names: string[];
  maxResults: number;
  /** Pre-decay relevance floor (lower than the topical lane — the lane is already
   *  name-scoped, so the floor only drops near-noise; see config defaults). */
  minScore: number;
  /** Allow shortened-name prefix matching (§3) in addition to exact. */
  prefixEnabled: boolean;
  /** Stem length for prefix matching; also the min token length to attempt it. */
  prefixMinChars: number;
  snippetMaxChars: number;
  /** Decay anchor (trigger timestamp) for cache determinism; defaults to Date.now(). */
  now?: number;
  /**
   * In agents mode: restrict to this agent's memory corpus (spec §7.1).
   * Null / absent = legacy mode (no filter). `"__legacy__"` treated as null.
   */
  agentName?: string | null;
  /** The caller already ran {@link MemorySearch.ensureFresh} for this request. */
  fresh?: boolean;
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
  /**
   * True when **both** `after` and `before` resolved to valid bounds but the range is
   * empty because `afterTs >= beforeTs` (the caller asked for an inverted window, e.g.
   * `after=2026-06-10 before=2026-06-01`). The query matches nothing — distinct from
   * "no such memory" — so the caller surfaces it (review issue #12). Both bounds parsed,
   * so they are *not* in `ignoredDateBounds`.
   */
  contradictoryDateBounds: boolean;
}

/** Options of the candidate-level search behind recall (§9d "Wide recall"). */
export interface ScoredSearchOptions {
  query: string;
  /** Candidates returned (pre-floor, best decayed score first). */
  limit: number;
  /** Pre-decay relevance floor. */
  minScore: number;
  now?: number;
  signal?: AbortSignal;
  agentName?: string | null;
  /** Vector half only (the conversation-window query); empty when embeddings are down. */
  semanticOnly?: boolean;
  room?: string;
  afterTs?: number;
  beforeTs?: number;
  rowidScope?: number[];
  /** The caller already ran {@link MemorySearch.ensureFresh} for this request. */
  fresh?: boolean;
}

/** One scored candidate chunk (pre-excerpt). */
export interface ScoredChunk extends LexicalHit {
  vecScore: number;
  bm25Score: number;
  /** Pre-decay combined relevance (the floor tests this). */
  relevance: number;
  /** Relevance after temporal decay (ordering only). */
  score: number;
}

/** Where a hybrid search's time went (ms). */
export interface SearchTimings {
  /** The corpus freshness check (and any reconcile it waited for). */
  freshMs: number;
  /** The FTS half. */
  lexicalMs: number;
  /** The query embedding (and, on the dual index, the hedge between embedders). */
  embedMs: number;
  /** The KNN (or the scope's exact cosine) and the hits' rows. */
  vectorMs: number;
}

/**
 * The query-side vector seam: embeds a query and runs KNN on the index that
 * matches the embedder. With a primary embedder (§9d "Two vector indexes") it
 * picks the primary index when its embedder answers in time, else the
 * built-in one; never mixes spaces within one query.
 */
export interface QueryVectorIndex {
  query(
    text: string,
    k: number,
    signal?: AbortSignal,
  ): Promise<{ hits: VecHit[]; store: VectorStore; index: string; vector: Float32Array; knnMs?: number } | null>;
  /** Stored vectors of the index last used for `query` (MMR). */
  vectors(store: VectorStore, rowids: number[]): Map<number, Float32Array>;
  /**
   * Cosine similarity of a query to some short texts on the built-in embedder
   * (excerpt windows, §9d "Excerpts"); absent when no embedder is wired.
   */
  similarity?(query: string, texts: string[], signal?: AbortSignal): Promise<number[]>;
}

export interface MemorySearchDeps {
  /** Overrides the provider/vectorStore pair (the dual-index seam). */
  vectorIndex?: QueryVectorIndex;
  provider?: EmbeddingProvider;
  vectorStore?: VectorStore;
  /** Optional structured logger for degraded-path warnings (e.g. lexical FTS failure, #9). */
  logger?: Logger;
}

interface Scored extends LexicalHit {
  vecScore: number;
  bm25Score: number;
  /** Pre-decay combined relevance (`wv·vec + wt·bm25`, or the normalized RRF score
   * under `fusion = "rrf"`). The `min_score` floor tests
   * THIS, not the decayed `score` — so a high-relevance old chunk survives the cut and
   * merely ranks lower (review issue #13). */
  relevance: number;
  /** Relevance after temporal decay (when enabled). Used ONLY for ordering, never for
   * the `min_score` cut. Equals `relevance` when decay is off. */
  score: number;
}

/**
 * The shared query path behind `recall_memory` (§9) and auto-retrieval (§8c). Hybrid
 * when an embedding provider + vector store are wired (§8a): parallel vector-KNN and
 * FTS5/BM25 candidate fetch → weighted (or reciprocal-rank) merge → temporal decay (§8b) → optional MMR
 * diversity re-rank → minScore cut → top-K. Degrades to lexical-only (a strict
 * upgrade over ripgrep) whenever embeddings are unavailable — never an error, never a
 * cross-space mismatch (§4/§5a).
 */
export class MemorySearch {
  private readonly vectorIndex?: QueryVectorIndex;
  private readonly logger?: Logger;
  /**
   * All indexers managed by this search instance. In legacy mode there is exactly
   * one; in agents mode there is one per configured agent workspace. `ensureFreshForQuery`
   * refreshes all of them so that a multi-agent startup completes fully before any
   * search returns. Accepts a single `MemoryIndexer` for backward compatibility with
   * tests and legacy callers.
   */
  private readonly indexers: MemoryIndexer[];

  constructor(
    private readonly storage: Storage,
    indexerOrIndexers: MemoryIndexer | MemoryIndexer[],
    private readonly config: ResolvedRetrievalConfig,
    deps?: MemorySearchDeps,
  ) {
    this.indexers = Array.isArray(indexerOrIndexers) ? indexerOrIndexers : [indexerOrIndexers];
    this.vectorIndex =
      deps?.vectorIndex ??
      (deps?.provider && deps.vectorStore ? singleVectorIndex(deps.provider, deps.vectorStore) : undefined);
    this.logger = deps?.logger;
  }

  /** Semantic unit scores for excerpt windows (undefined without an embedder). */
  get unitScorer(): ((query: string, texts: string[], signal?: AbortSignal) => Promise<number[]>) | undefined {
    const index = this.vectorIndex;
    return index?.similarity ? (query, texts, signal) => index.similarity!(query, texts, signal) : undefined;
  }

  /** True when a semantic half is wired (the index may still be empty). */
  get hasSemantic(): boolean {
    return this.vectorIndex !== undefined;
  }

  /** Refresh every indexer's corpus signature (cheap when clean). */
  async ensureFresh(): Promise<void> {
    for (const idx of this.indexers) await idx.ensureFreshForQuery();
  }

  async search(opts: SearchOptions): Promise<SearchOutcome> {
    // Temporal-decay anchor. Callers that need determinism across context rebuilds
    // and replay (auto-retrieval, diary) pass `opts.now` = the trigger timestamp so
    // the cache-stable layers stay byte-identical (review issue #15). The
    // `recall_memory` tool intentionally omits `now` and falls through to wall-clock
    // `Date.now()`: it is a live, one-shot agent action reasoning in the present, not
    // a cached context layer, so the determinism rationale does not apply — anchoring
    // its decay on "now" is the correct behavior.
    const q = this.config.query;
    const candidateLimit = Math.max(opts.maxResults, opts.maxResults * q.candidateMultiplier);
    // Resolve the optional date filters. A bound that's present but unparseable (bad
    // month/day, wrong shape) yields `invalid`, surfaced in the outcome so the caller
    // can tell the agent the filter was ignored rather than silently dropping it
    // (review issue #4b). `beforeTs` is an *exclusive* start-of-next-day bound so the
    // `before` day is fully inclusive down to 23:59:59.999 (review issue #12).
    const after = dateBoundTs(opts.after, "start");
    const before = dateBoundTs(opts.before, "end");
    const invalidDateBounds: string[] = [];
    if (after.invalid) invalidDateBounds.push("after");
    if (before.invalid) invalidDateBounds.push("before");
    // Both bounds parsed but the window is inverted (`after` is on/after `before`'s
    // exclusive next-day start) → the range is empty and the query matches nothing.
    // Distinct from an unparseable bound (which lands in `ignoredDateBounds`); surfaced
    // separately so the caller can tell "empty window" from "no such memory" (#12).
    const contradictoryDateBounds =
      after.ts !== undefined && before.ts !== undefined && after.ts >= before.ts;

    const outcome = await this.searchScored({
      query: opts.query,
      limit: candidateLimit,
      minScore: 0,
      now: opts.now,
      signal: opts.signal,
      agentName: opts.agentName,
      room: opts.room,
      afterTs: after.ts,
      beforeTs: before.ts,
      rowidScope: opts.rowidScope,
    });
    // Floor on PRE-DECAY relevance, order by the decayed score (review issue #13).
    const aboveThreshold = outcome.scored.filter((s) => s.relevance >= opts.minScore);
    const ranked =
      q.mmrEnabled && outcome.vectorStore
        ? this.mmrRerank(aboveThreshold, q.mmrLambda, opts.maxResults, outcome.vectorStore)
        : aboveThreshold.slice(0, opts.maxResults);

    return {
      results: await Promise.all(ranked.map((s) => this.toResult(s, opts.snippetMaxChars, [opts.query]))),
      mode: outcome.mode,
      degraded: outcome.degraded,
      ignoredDateBounds: invalidDateBounds,
      contradictoryDateBounds,
    };
  }

  /**
   * The candidate-level hybrid search (§9d): lexical BM25 and vector KNN merged
   * into pre-decay relevance and decayed score, best score first, floored on
   * relevance. Never throws for a degraded half.
   */
  async searchScored(opts: ScoredSearchOptions): Promise<{
    scored: ScoredChunk[];
    mode: "hybrid" | "lexical";
    degraded: boolean;
    vectorStore?: VectorStore;
    /** Which vector index served the semantic half ("builtin" | "primary"). */
    vectorIndex?: string;
    /** Where the call's time went (ms). */
    timings: SearchTimings;
  }> {
    // Normalize the sentinel so it's never accidentally used as a filter.
    const agentName = opts.agentName === "__legacy__" ? null : (opts.agentName ?? null);
    const timings: SearchTimings = { freshMs: 0, lexicalMs: 0, embedMs: 0, vectorMs: 0 };
    let t0 = performance.now();
    if (!opts.fresh) await this.ensureFresh();
    timings.freshMs = performance.now() - t0;
    const now = opts.now ?? Date.now();
    const q = this.config.query;
    const candidateLimit = Math.max(1, opts.limit);
    const scope = opts.rowidScope ? new Set(opts.rowidScope) : undefined;

    // --- Lexical candidates (always, unless semantic-only) ---
    // The lexical half is wrapped (mirroring the semantic half below) so a future
    // `buildFtsMatch`/FTS5 change that emits a rejectable MATCH degrades to empty
    // lexical results rather than throwing out of `search()` into context assembly,
    // which has no caller-side guard (review issue #9). `buildFtsMatch` strips FTS
    // specials and returns null on degenerate input, so this is defensive insurance.
    const match = opts.semanticOnly ? null : buildFtsMatch(opts.query);
    let ftsHits: LexicalHit[] = [];
    t0 = performance.now();
    if (match) {
      try {
        ftsHits = this.storage.searchMemoryLexical({
          match,
          limit: scope ? Math.max(candidateLimit, scope.size) : candidateLimit,
          room: opts.room,
          afterTs: opts.afterTs,
          beforeTs: opts.beforeTs,
          agent: agentName ?? undefined,
          rowids: opts.rowidScope,
        });
      } catch (error) {
        this.logger?.warn("memory_lexical_search_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        ftsHits = [];
      }
    }
    timings.lexicalMs = performance.now() - t0;

    // --- Vector candidates (when embeddings are available) ---
    let vecScoreByRow = new Map<number, number>();
    let vecMeta: LexicalHit[] = [];
    let semanticRan = false;
    let degraded = false;
    let vectorStore: VectorStore | undefined;
    let vectorIndexUsed: string | undefined;
    // The vec0 KNN can't cleanly carry the room/date predicate (it ranks purely by
    // vector distance), so the filter is applied post-hoc via `getChunksByRowids`.
    // With a narrow room/date filter the top-`candidateLimit` neighbours can all fall
    // outside the range, collapsing the semantic contribution to ~zero while in-range
    // relevant chunks sit deeper in the KNN ranking. To reduce that silent degradation,
    // over-fetch the KNN when a filter is active so enough in-range neighbours survive
    // the post-filter (review issue #2). No filter → no over-fetch (the plain top-K is
    // already correct). A rowid scope is scored exactly (below), not through KNN.
    const filterActive =
      opts.room !== undefined || opts.afterTs !== undefined || opts.beforeTs !== undefined;
    // Cap the over-fetched `k` so the resulting `getChunksByRowids` IN-list stays within
    // the bound the config maxima target (see src/config/schema.ts) — over-fetch is a
    // recall improvement, never a path to blow SQLite's bound-parameter limit.
    const knnK = filterActive
      ? Math.min(candidateLimit * FILTERED_KNN_OVERFETCH, MAX_KNN_CANDIDATES)
      : Math.min(candidateLimit, MAX_KNN_CANDIDATES);
    if (this.vectorIndex) {
      t0 = performance.now();
      try {
        const found = await this.vectorIndex.query(opts.query, scope ? 1 : knnK, opts.signal);
        const queried = performance.now() - t0;
        timings.embedMs = queried - (found?.knnMs ?? 0);
        t0 = performance.now() - (found?.knnMs ?? 0);
        if (found) {
          vectorStore = found.store;
          vectorIndexUsed = found.index;
          if (scope) {
            // Exact cosine against the scope's stored vectors (no KNN cut-off).
            const vectors = this.vectorIndex.vectors(found.store, [...scope]);
            for (const [rowid, v] of vectors) vecScoreByRow.set(rowid, clamp01(dot(found.vector, v)));
          } else if (found.hits.length > 0) {
            vecScoreByRow = new Map(found.hits.map((h) => [h.chunkId, clamp01(1 - h.distance)]));
          }
          if (vecScoreByRow.size > 0) {
            // Fetch metadata for vector hits, applying the same room/date filters.
            vecMeta = this.storage.getChunksByRowids([...vecScoreByRow.keys()], {
              room: opts.room,
              afterTs: opts.afterTs,
              beforeTs: opts.beforeTs,
              agent: agentName ?? undefined,
            });
          }
          semanticRan = true;
          timings.vectorMs = performance.now() - t0;
        } else {
          degraded = true;
        }
      } catch (error) {
        timings.embedMs = performance.now() - t0;
        // Query-embed or KNN failed → lexical-only for this query (never cross spaces).
        // This also covers the bounded-embed-wait abort (§9d #7): when an
        // interactive build's deadline elapses, `embedQuery` rejects and we
        // degrade here rather than blocking the build for minutes.
        degraded = true;
        this.logger?.debug("memory_semantic_degraded", {
          error: error instanceof Error ? error.message : String(error),
        });
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

    // Does the semantic half actually contribute to the *post-filter* candidate set?
    // `vecScoreByRow` is pre-filter (raw KNN), so testing its size would report `hybrid`
    // even when every vector neighbour was filtered out by room/date and the result
    // effectively degraded to lexical. Test the post-filter survivors instead, so the
    // reported `mode` reflects reality (review issue #2). `vecMeta` is exactly the KNN
    // rows that passed the room/date filter.
    const useVec = semanticRan && vecMeta.length > 0;
    // Parenthesized so a zero-sum (both weights 0) falls back to 1 rather than
    // `0 || 1` binding as `vectorWeight + (textWeight || 1)` (review issue #6). Config
    // resolution also rejects a zero-sum weight pair, so this is belt-and-suspenders.
    // A semantic-only query weighs the vector half alone.
    const wSum = useVec ? (q.vectorWeight + q.textWeight) || 1 : 1;
    const wv = opts.semanticOnly ? (useVec ? 1 : 0) : useVec ? q.vectorWeight / wSum : 0;
    const wt = opts.semanticOnly ? 0 : useVec ? q.textWeight / wSum : 1;
    // Reciprocal-rank fusion (`fusion = "rrf"`): each lane that returned candidates
    // ranks its own survivors (post room/date/scope filter), and the fused relevance
    // is the normalized RRF score (see `rrfFuse`). The semantic-only window query and
    // the scoped user-lane ranking go through the same path with their one lane.
    let rrf: Map<number, number> | undefined;
    if (q.fusion === "rrf") {
      const inScope = (rowid: number) => candidateRows.has(rowid) && (!scope || scope.has(rowid));
      const lanes: number[][] = [];
      if (wt > 0) lanes.push(rankLane(ftsHits.map((h) => h.rowid).filter(inScope), bm25ByRow));
      if (wv > 0) lanes.push(rankLane([...vecScoreByRow.keys()].filter(inScope), vecScoreByRow));
      rrf = rrfFuse(lanes.filter((l) => l.length > 0), q.rrfK);
    }

    const scored: ScoredChunk[] = [];
    for (const rowid of candidateRows) {
      if (scope && !scope.has(rowid)) continue;
      const meta = metaByRow.get(rowid)!;
      const vecScore = vecScoreByRow.get(rowid) ?? 0;
      const bm25Score = bm25ByRow.get(rowid) ?? 0;
      // `relevance` is the pre-decay combined relevance; the `min_score` floor tests
      // THIS (an absolute relevance floor, the point of the saturating BM25 transform).
      // `score` adds temporal decay and is used ONLY for ordering, so a high-relevance
      // *old* match survives the floor but ranks below a fresher equal-relevance one,
      // instead of decaying below the floor and vanishing (review issue #13).
      const relevance = rrf ? (rrf.get(rowid) ?? 0) : wv * vecScore + wt * bm25Score;
      if (relevance < opts.minScore) continue;
      const score = q.temporalDecayEnabled
        ? relevance * decayFactor(meta.entryTs, now, q.temporalDecayHalfLifeDays)
        : relevance;
      scored.push({ ...meta, vecScore, bm25Score, relevance, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return {
      scored: scored.slice(0, candidateLimit),
      mode: useVec ? "hybrid" : "lexical",
      degraded,
      ...(useVec ? { vectorStore, vectorIndex: vectorIndexUsed } : {}),
      timings,
    };
  }

  /** MMR diversity re-rank (§8a) using stored vectors; falls back to plain top-K. */
  private mmrRerank(cands: ScoredChunk[], lambda: number, k: number, store: VectorStore): ScoredChunk[] {
    if (cands.length <= 1 || !this.vectorIndex) return cands.slice(0, k);
    const vectors = this.vectorIndex.vectors(store, cands.map((c) => c.rowid));
    if (vectors.size === 0) return cands.slice(0, k);
    const selected: ScoredChunk[] = [];
    const pool = [...cands];
    while (selected.length < k && pool.length > 0) {
      let bestIdx = 0;
      let bestVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i]!;
        const cv = vectors.get(c.rowid);
        // `maxSim` deliberately starts at 0 and is only ever raised, so a negative
        // cosine (anti-similar to everything already selected) is clamped to 0 — i.e.
        // anti-similar is treated as orthogonal, never as a *diversity bonus*. This is a
        // defensible MMR variant: the redundancy penalty `(1-λ)·maxSim` is one-sided, so
        // it can only push a candidate down for overlap, never reward it for opposing an
        // already-picked vector (review issue #16). L2-normalized vectors → `dot` is the
        // cosine in [-1,1].
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

  private async toResult(hit: ScoredChunk, snippetMaxChars: number, queries: string[]): Promise<RetrievalResult> {
    return {
      id: hit.id,
      contentHash: hit.contentHash,
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      room: hit.room,
      date: agentDateStamp(hit.entryTs),
      entryTs: hit.entryTs,
      score: hit.score,
      snippet: await makeExcerpt(hit.text, {
        queries,
        budget: { chars: snippetMaxChars },
        ...(this.unitScorer ? { scoreUnits: (units: string[]) => this.unitScorer!(queries.join("\n"), units) } : {}),
      }),
    };
  }

  /**
   * Lexical-only "who am I talking to" lane (ARCHITECTURE.md §9d / design §8c). Diary
   * entries carry no structural author tag, but people are named by display name
   * constantly in the prose, so an exact BM25 match on the trigger user's display
   * name reliably surfaces "my recent history with this person"; temporal decay then
   * orders it toward the most recent interactions. Deliberately NOT hybrid — a bare
   * name embeds poorly (pure noise to the vector half), and the exact-token lexical
   * hit IS the whole signal — so this also dodges the embed-wait/degrade machinery.
   *
   * Exact is always preferred (the operator's explicit requirement): every qualifying
   * exact hit is returned before any prefix-only hit, so prefix matches (shortened
   * display-name forms, §3) only fill slots exact leaves empty. The two false-positive
   * controls are `minScore` and the prefix stem length (`prefixMinChars`).
   */
  async searchUserLane(opts: UserLaneOptions): Promise<RetrievalResult[]> {
    const scored = await this.userLaneScored(opts);
    return Promise.all(scored.map((s) => this.toResult(s, opts.snippetMaxChars, opts.names)));
  }

  /** The user lane's scored candidates (exact hits before prefix-only hits). */
  async userLaneScored(opts: Omit<UserLaneOptions, "snippetMaxChars">): Promise<ScoredChunk[]> {
    if (opts.maxResults <= 0) return [];
    const agentName =
      opts.agentName === "__legacy__" ? null : (opts.agentName ?? null);
    if (!opts.fresh) await this.ensureFresh();
    const now = opts.now ?? Date.now();
    const q = this.config.query;
    const tokens = userLaneTokens(opts.names);
    if (tokens.length === 0) return [];
    const candidateLimit = Math.max(opts.maxResults, opts.maxResults * q.candidateMultiplier);

    const exactHits = this.userLaneLexical(
      `{text} : (${tokens.map((t) => `"${t}"`).join(" OR ")})`,
      candidateLimit,
      agentName,
    );
    const stems = opts.prefixEnabled
      ? Array.from(
          new Set(
            tokens
              .map((t) => userLanePrefixStem(t, opts.prefixMinChars))
              .filter((s): s is string => s !== null),
          ),
        )
      : [];
    const prefixHits = stems.length
      ? this.userLaneLexical(
          `{text} : (${stems.map((s) => `"${s}"*`).join(" OR ")})`,
          candidateLimit,
          agentName,
        )
      : [];

    // Score a hit set with the same saturating-BM25 → temporal-decay transform the
    // hybrid path uses, but lexical-only (relevance == normalized bm25; vec half off).
    const score = (hits: LexicalHit[]): ScoredChunk[] => {
      const rel = normalizeBm25(hits);
      return hits.map((h) => {
        const relevance = rel.get(h.rowid) ?? 0;
        const decayed = q.temporalDecayEnabled
          ? relevance * decayFactor(h.entryTs, now, q.temporalDecayHalfLifeDays)
          : relevance;
        return { ...h, vecScore: 0, bm25Score: relevance, relevance, score: decayed };
      });
    };

    const exactScored = score(exactHits)
      .filter((s) => s.relevance >= opts.minScore)
      .sort((a, b) => b.score - a.score);
    const exactIds = new Set(exactScored.map((s) => s.rowid));
    const prefixScored = score(prefixHits)
      .filter((s) => s.relevance >= opts.minScore && !exactIds.has(s.rowid))
      .sort((a, b) => b.score - a.score);

    // Exact always before prefix (favor exact); prefix only fills remaining slots.
    return [...exactScored, ...prefixScored].slice(0, opts.maxResults);
  }

  /** FTS lookup for the user lane, degrading to empty (mirrors the topical guard, #9). */
  private userLaneLexical(match: string, limit: number, agentName: string | null): LexicalHit[] {
    try {
      return this.storage.searchMemoryLexical({ match, limit, agent: agentName ?? undefined });
    } catch (error) {
      this.logger?.warn("memory_user_lane_search_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }
}

/** The single-index vector seam over one provider + store (no primary embedder). */
export function singleVectorIndex(provider: EmbeddingProvider, store: VectorStore): QueryVectorIndex {
  const embed = memoizeQueryEmbed((text, signal) => provider.embedQuery(text, signal));
  return {
    async query(text, k, signal) {
      const vector = await embed(text, signal);
      const t0 = performance.now();
      const hits = store.knn(vector, k, "memory");
      return { hits, store, index: "builtin", vector, knnMs: performance.now() - t0 };
    },
    vectors: (s, rowids) => s.getVectors(rowids),
    similarity: (query, texts, signal) => textSimilarity(provider, query, texts, signal),
  };
}

/**
 * Remembers the last few query embeddings by text: one retrieval embeds the
 * same request text for its trigger lane and again for the user lanes' ranking.
 * Only answered embeddings are kept (a failed or aborted one is never reused).
 */
export function memoizeQueryEmbed(
  embed: (text: string, signal?: AbortSignal) => Promise<Float32Array>,
  size = 16,
): (text: string, signal?: AbortSignal) => Promise<Float32Array> {
  const cache = new Map<string, Float32Array>();
  return async (text, signal) => {
    const hit = cache.get(text);
    if (hit) {
      cache.delete(text);
      cache.set(text, hit);
      return hit;
    }
    const vector = await embed(text, signal);
    cache.set(text, vector);
    if (cache.size > size) cache.delete(cache.keys().next().value!);
    return vector;
  };
}

/** Cosine of a query to texts on one embedder (L2-normalized vectors → dot). */
export async function textSimilarity(
  provider: EmbeddingProvider,
  query: string,
  texts: string[],
  signal?: AbortSignal,
): Promise<number[]> {
  const q = await provider.embedQuery(query, signal);
  const docs = await provider.embedDocuments(texts, signal);
  return docs.map((d) => dot(q, d));
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
 * Distinct, usable name terms from one or more trigger-user display names for the
 * user lane (`searchUserLane`). Lowercased and split on non-alphanumerics so a
 * multi-word display name ("Atomic Tiger") yields both tokens; 1-char fragments and
 * bare stopwords are dropped (a display name that is only "the"/"an" carries no
 * recall signal and would match everything). Deduped, capped at 32.
 */
export function userLaneTokens(names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const tok of name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (tok.length >= 2 && !STOPWORDS.has(tok)) out.add(tok);
    }
  }
  return Array.from(out).slice(0, 32);
}

/**
 * Prefix stem for a name token, or null when prefix matching shouldn't apply. Returns
 * null when the token length is <= `minChars`: the stem would be the whole token
 * (catching only rare *lengthenings*) and a short stem invites false positives. Above
 * that, the first `minChars` characters, so a longer display name still matches a
 * common shortened form ("plaguis" → stem "plag" → matches a diary mention of
 * "plagu"). Exact matching always runs and is always preferred; this only ever fills
 * slots exact leaves empty.
 */
export function userLanePrefixStem(token: string, minChars: number): string | null {
  if (token.length <= minChars) return null;
  return token.slice(0, minChars);
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
 * KNN over-fetch multiplier when a room/date filter is active (review issue #2). The
 * vec0 KNN ranks purely by vector distance and can't carry the room/date predicate, so
 * the filter is applied post-hoc; a narrow filter can otherwise let all top-K neighbours
 * fall outside the range and silently zero out the semantic half. Fetching `k × this`
 * candidates gives the post-filter enough in-range neighbours to keep the hybrid score
 * meaningful. A documented constant (like `BM25_SATURATION`), not a config knob — promote
 * to `[retrieval.query]` later if tuning demands it.
 */
const FILTERED_KNN_OVERFETCH = 4;

/**
 * Hard ceiling on KNN candidates after the filtered over-fetch (review issue #2). The
 * fetched rowids become an IN-list in `getChunksByRowids`; this keeps that list within
 * the bound the `[retrieval.query]` config maxima already target (src/config/schema.ts)
 * and safely under SQLite's bound-parameter limit (32766), even at the largest
 * configurable `candidate_multiplier`.
 */
const MAX_KNN_CANDIDATES = 5000;

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

/**
 * One lane's rowids, best first, by that lane's own score (stable: the lane's
 * original order breaks ties).
 */
function rankLane(rowids: number[], scoreByRow: Map<number, number>): number[] {
  return [...new Set(rowids)].sort((a, b) => (scoreByRow.get(b) ?? 0) - (scoreByRow.get(a) ?? 0));
}

/**
 * Reciprocal-rank fusion (ARCHITECTURE.md §9d "Fusion"): per lane `1 / (k + rank)`
 * (rank 1-based), summed over the lanes a block appears in, then divided by the
 * maximum possible score, `lanes × 1 / (k + 1)`, so the fused relevance lives in
 * (0, 1] and the `[0,1]` relevance floors keep their meaning: a block ranked first
 * in every lane scores 1, first in one of two lanes 0.5, and 60th in one of two
 * lanes at k = 60 about 0.25. `lanes` counts only the lanes that returned
 * candidates. Exported for tests.
 */
export function rrfFuse(lanes: number[][], k: number): Map<number, number> {
  const out = new Map<number, number>();
  if (lanes.length === 0) return out;
  for (const lane of lanes) lane.forEach((rowid, i) => out.set(rowid, (out.get(rowid) ?? 0) + 1 / (k + i + 1)));
  const max = lanes.length / (k + 1);
  for (const [rowid, v] of out) out.set(rowid, Math.min(1, v / max));
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

/**
 * Inner product. All retrieval vectors are L2-normalized and come from the single
 * active model (§9d single-active-model invariant), so in practice `a` and `b` always
 * share a length and this is the cosine. It deliberately iterates over
 * `min(a.length, b.length)` so a hypothetical dim mismatch truncates rather than
 * throwing out of the MMR re-rank (review issue #16). A dev-only assert catches a
 * mismatch in tests/dev without affecting production ranking behavior.
 */
function dot(a: Float32Array, b: Float32Array): number {
  if (process.env.NODE_ENV !== "production" && a.length !== b.length) {
    throw new Error(`dot(): vector length mismatch ${a.length} != ${b.length}`);
  }
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
