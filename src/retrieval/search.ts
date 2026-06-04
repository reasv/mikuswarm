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
    const afterTs = dateBoundTs(opts.after, "start");
    const beforeTs = dateBoundTs(opts.before, "end");

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
    const wSum = useVec ? q.vectorWeight + q.textWeight || 1 : 1;
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
 * Sanitize free-text into an FTS5 MATCH expression: extract word tokens and OR them
 * (each phrase-quoted so FTS operators / punctuation in the user text can't inject
 * syntax). Returns null when the query has no usable terms.
 */
export function buildFtsMatch(query: string): string | null {
  const tokens = Array.from(
    new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2)),
  ).slice(0, 32);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/** Min-max normalize BM25 cost into a [0,1] relevance per rowid (best match → 1). */
function normalizeBm25(hits: LexicalHit[]): Map<number, number> {
  const out = new Map<number, number>();
  if (hits.length === 0) return out;
  const rels = hits.map((h) => -h.bm25); // bm25() is a cost; flip to relevance
  const min = Math.min(...rels);
  const max = Math.max(...rels);
  const span = max - min;
  hits.forEach((h, i) => out.set(h.rowid, span === 0 ? 1 : (rels[i]! - min) / span));
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

/** A `YYYY-MM-DD` bound → epoch ms at the day's start (00:00) or end (23:59). */
function dateBoundTs(date: string | undefined, edge: "start" | "end"): number | undefined {
  if (!date) return undefined;
  const wall = edge === "start" ? `${date} 00:00` : `${date} 23:59`;
  return parseZonedWallClock(wall, getConfiguredTimezone()) ?? undefined;
}

/** Strip a leading `## ` header line, collapse whitespace, truncate to N chars. */
function makeSnippet(text: string, maxChars: number): string {
  const body = text.replace(/^##[^\n]*\n?/, "").replace(/\s+/g, " ").trim();
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars).trimEnd()}…`;
}
