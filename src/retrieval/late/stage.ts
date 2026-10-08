/**
 * The late-interaction query stage (ARCHITECTURE.md §9d "Late interaction").
 *
 * Two branches, one score:
 * - **Exhaustive window**: the newest `late.exhaustive_blocks` indexed blocks
 *   outside the recency layer are scored on every query. Their scan codes
 *   stay resident (`late.resident`) in the scan scorer: TurboQuant codes in
 *   the native kernel (default), or fp32 on the ONNX runtime when the kernel
 *   is unavailable or `quantization = "none"`. A quantised scan returns its
 *   top `late.rescore` blocks, re-scored exactly from the stored vectors.
 * - **Beyond the window**, the recall candidates are re-scored exactly.
 *
 * The scores merge into one MaxSim list; the caller cuts it to `late.top_n`.
 * The query is the trigger plus its reply target, capped at
 * `late.query_max_tokens` by the query encoder chain (`late.query_chain`: any
 * member serving a model of the index's shared-space family, e.g. a large
 * model on a GPU first and a small one on CPU; switching members never
 * touches the index). The whole stage
 * (query encode + MaxSim) is bounded by `late.timeout_ms`; past it the stage
 * is skipped for that query. Windows are rebuilt in the background when the
 * index or the recency layer changes, never on the query path: a query uses
 * the window it finds (or none, the first time).
 */
import type { Logger } from "../../observability/logger.js";
import type { LexicalHit } from "../../storage/database.js";
import type { MemoryRetrievalStore } from "../../storage/memory-retrieval-store.js";
import type { ResolvedRetrievalConfig } from "../config.js";
import type { ProviderChain } from "../models/chain.js";
import type { LateEncoder, TokenMatrix } from "../models/types.js";
import { decodeTokenMatrix } from "./codec.js";
import type { MaxSimScorer, ScoredDoc } from "./scorer.js";

export interface LateOutcome {
  status: "ok" | "timeout" | "unavailable" | "error" | "aborted";
  /** MaxSim score per content hash (blocks without vectors are absent). */
  scores: Map<string, number>;
  /** Window blocks to merge into the candidate pool (the shortlist on a quantised scan). */
  windowChunks: LexicalHit[];
  backend: string | null;
  /** The model of the query-chain member that encoded the query (null when none did). */
  queryModel: string | null;
  /** Candidates that had no vectors (they bypass the cut). */
  missing: number;
  windowSize: number;
  ms: number;
  error?: string;
}

interface WindowState {
  key: string;
  chunks: Map<string, LexicalHit>;
  /** Decoded vectors when the window is not resident in the scan scorer. */
  docs?: ScoredDoc[];
}

export interface LateStageOptions {
  config: ResolvedRetrievalConfig["late"];
  store: MemoryRetrievalStore;
  queryChain: ProviderChain<LateEncoder>;
  /** Exact fp32 scorer (rescoring, ad-hoc candidates, and the window when no quantised scan). */
  exact: MaxSimScorer;
  /** The window scan scorer: the quantised one, or `exact` itself. */
  scan: MaxSimScorer;
  recencyPaths: (agent: string | null) => Promise<Set<string>>;
  /** Current index version (bumps when vectors change). */
  indexVersion: () => number;
  logger?: Logger;
  now?: () => number;
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export class LateStage {
  private readonly windows = new Map<string, WindowState>();
  private readonly building = new Map<string, Promise<void>>();
  private indexedCache: { version: number; hashes: Set<string> } | null = null;

  constructor(private readonly options: LateStageOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private windowId(agent: string | null): string {
    return `agent:${agent ?? ""}`;
  }

  private indexedHashes(): Set<string> {
    const version = this.options.indexVersion();
    if (!this.indexedCache || this.indexedCache.version !== version) {
      this.indexedCache = { version, hashes: this.options.store.lateIndexedHashes(this.options.config.model) };
    }
    return this.indexedCache.hashes;
  }

  private decode(hashes: string[]): ScoredDoc[] {
    const rows = this.options.store.lateVectors(this.options.config.model, hashes);
    const out: ScoredDoc[] = [];
    for (const [hash, row] of rows) {
      try {
        out.push({ key: hash, matrix: decodeTokenMatrix(row) });
      } catch {
        // a corrupt blob is skipped (the block bypasses the cut)
      }
    }
    return out;
  }

  /** Rebuild an agent's window in the background when the index or recency layer changed. */
  refreshWindow(agent: string | null): Promise<void> {
    const id = this.windowId(agent);
    const running = this.building.get(id);
    if (running) return running;
    const task = (async () => {
      const cfg = this.options.config;
      if (cfg.exhaustiveBlocks <= 0) return;
      const recency = await this.options.recencyPaths(agent);
      const key = `${this.options.indexVersion()}|${[...recency].sort().join(",")}`;
      if (this.windows.get(id)?.key === key) return;
      const indexed = this.indexedHashes();
      const limit = Number.isFinite(cfg.exhaustiveBlocks) ? cfg.exhaustiveBlocks : Number.MAX_SAFE_INTEGER;
      const rows = this.options.store.newestChunks(agent, limit, recency, (r) => indexed.has(r.contentHash));
      const chunks = new Map(rows.map((r) => [r.contentHash, r]));
      const docs = this.decode([...chunks.keys()]);
      if (cfg.resident) {
        await this.options.scan.setWindow(id, docs);
        this.windows.set(id, { key, chunks });
      } else {
        this.windows.set(id, { key, chunks, docs });
      }
      this.options.logger?.debug("late_window_built", { agent: agent ?? undefined, blocks: docs.length, resident: cfg.resident });
    })()
      .catch((error) =>
        this.options.logger?.warn("late_window_build_failed", { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => this.building.delete(id));
    this.building.set(id, task);
    return task;
  }

  /** Score one query: the window (when built) plus the given recall candidates. */
  async score(input: {
    agent: string | null;
    queryText: string;
    candidates: Array<{ contentHash: string }>;
    signal?: AbortSignal;
  }): Promise<LateOutcome> {
    const cfg = this.options.config;
    const started = this.now();
    const base = (status: LateOutcome["status"], extra: Partial<LateOutcome> = {}): LateOutcome => ({
      status,
      scores: new Map(),
      windowChunks: [],
      backend: null,
      queryModel: null,
      missing: input.candidates.length,
      windowSize: 0,
      ms: this.now() - started,
      ...extra,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    // The window rebuild never blocks a query.
    if (cfg.exhaustiveBlocks > 0) void this.refreshWindow(input.agent);
    try {
      const queryText = input.queryText.trim();
      if (!queryText) return base("unavailable", { error: "empty query" });
      let query: TokenMatrix;
      let queryModel: string | null = null;
      try {
        const encoded = await this.options.queryChain.run((p, s) => p.encodeQuery(queryText, cfg.queryMaxTokens, s), { signal: controller.signal });
        query = encoded.value;
        queryModel = encoded.provider.model ?? cfg.model;
      } catch (error) {
        if (controller.signal.aborted) throw abortError();
        return base("unavailable", { error: error instanceof Error ? error.message : String(error) });
      }
      const win = cfg.exhaustiveBlocks > 0 ? this.windows.get(this.windowId(input.agent)) : undefined;
      const inWindow = win?.chunks ?? new Map<string, LexicalHit>();
      const beyond = [...new Set(input.candidates.map((c) => c.contentHash).filter((h) => !inWindow.has(h)))];
      const beyondDocs = this.decode(beyond);
      let scores = new Map<string, number>();
      let windowChunks: LexicalHit[] = [];
      let backend = this.options.exact.backend;
      if (win && this.options.scan.approximate && cfg.resident) {
        // Quantised scan → shortlist → exact rescoring from the stored vectors.
        backend = this.options.scan.backend;
        const shortlist = await this.options.scan.score(query, { windowId: this.windowId(input.agent), windowTopK: cfg.rescore }, controller.signal);
        const keys = [...shortlist.keys()];
        const rescoreDocs = this.decode(keys);
        scores = await this.options.exact.score(query, { docs: [...rescoreDocs, ...beyondDocs] }, controller.signal);
        windowChunks = keys.map((k) => inWindow.get(k)).filter((r): r is LexicalHit => r !== undefined);
      } else if (win) {
        backend = this.options.scan.backend;
        const target = cfg.resident
          ? { windowId: this.windowId(input.agent), docs: beyondDocs }
          : { docs: [...(win.docs ?? []), ...beyondDocs] };
        scores = await this.options.scan.score(query, target, controller.signal);
        windowChunks = [...inWindow.values()];
      } else {
        scores = beyondDocs.length > 0 ? await this.options.exact.score(query, { docs: beyondDocs }, controller.signal) : new Map();
      }
      const missing = input.candidates.filter((c) => !scores.has(c.contentHash) && !inWindow.has(c.contentHash)).length;
      return {
        status: "ok",
        scores,
        windowChunks,
        backend,
        queryModel,
        missing,
        windowSize: inWindow.size,
        ms: this.now() - started,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return base(input.signal?.aborted ? "aborted" : "timeout");
      }
      return base("error", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** The calibrated cutoff of a query encoder model's scores, if any (fallback selection). */
  cutoff(queryModel: string | null): number | undefined {
    return queryModel ? this.options.config.calibration[queryModel] : undefined;
  }

  async close(): Promise<void> {
    await Promise.all([this.options.scan.close(), this.options.scan === this.options.exact ? undefined : this.options.exact.close()]);
  }
}
