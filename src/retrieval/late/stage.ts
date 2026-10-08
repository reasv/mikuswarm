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
 * is skipped for that query.
 *
 * Every recall candidate inside the window is re-scored exactly along with the
 * shortlist, so only a block with no (decodable) vectors goes unscored; those
 * are reported in `missingHashes` and bypass the cut. The window itself merges
 * into the pool as its best `max(late.rescore, late.top_n)` blocks (the rest
 * could never survive the cut).
 *
 * With `late.resident = false` nothing stays resident: the window's stored
 * vectors are read and scored exactly on every query (the quantised scan is
 * never used per query; re-quantising per query would be both slower and
 * approximate).
 *
 * Windows are maintained in the background, never on the query path: a query
 * uses the window it finds (or none, the first time). Index and recency
 * changes are coalesced (`refreshDebounceMs`, at most `refreshMaxWaitMs`
 * apart during a backfill) and applied incrementally: only blocks that joined
 * or left the window are read, and they cross to the scorer as stored rows,
 * decoded off the event loop (natively or in the scorer worker). Per-query
 * vectors are read in small chunks with a yield in between, so the query's
 * deadline is honoured.
 */
import type { Logger } from "../../observability/logger.js";
import type { LexicalHit } from "../../storage/database.js";
import type { MemoryRetrievalStore } from "../../storage/memory-retrieval-store.js";
import type { ResolvedRetrievalConfig } from "../config.js";
import type { ProviderChain } from "../models/chain.js";
import type { LateEncoder, TokenMatrix } from "../models/types.js";
import { lateIndexKey } from "./index-key.js";
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
  /** ... their content hashes. */
  missingHashes: string[];
  windowSize: number;
  ms: number;
  error?: string;
}

interface WindowState {
  key: string;
  /** Member content hash → the chunk rowid it was taken from. */
  members: Map<string, number>;
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
  /** Quiet time before a requested window update runs (default 2 s). */
  refreshDebounceMs?: number;
  /** Longest a requested update waits while requests keep coming (default 60 s). */
  refreshMaxWaitMs?: number;
  logger?: Logger;
  now?: () => number;
}

/** Stored vectors read per synchronous query (~16 blocks, ~1.4 MB at 340 × 128 fp16: a few ms). */
const READ_CHUNK = 16;
/** Bytes of stored rows per scorer load call during a window update. */
const LOAD_BYTES = 8 * 1024 * 1024;

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class LateStage {
  private readonly windows = new Map<string, WindowState>();
  private readonly building = new Map<string, Promise<void>>();
  /** Window ids whose update was requested while one was running. */
  private readonly rerun = new Set<string>();
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; firstAt: number }>();
  private closed = false;
  /** The vector index key (the model plus its document-side settings). */
  readonly indexKey: string;

  constructor(private readonly options: LateStageOptions) {
    this.indexKey = lateIndexKey(options.config);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private windowId(agent: string | null): string {
    return `agent:${agent ?? ""}`;
  }

  /** Stored rows of `hashes` (missing ones are absent), as scorer docs. */
  private readEncoded(hashes: string[]): ScoredDoc[] {
    const rows = this.options.store.lateVectors(this.indexKey, hashes);
    const out: ScoredDoc[] = [];
    for (const [key, row] of rows) {
      out.push({ key, encoded: { dtype: row.dtype, dim: row.dim, tokenCount: row.tokenCount, vectors: row.vectors, scales: row.scales } });
    }
    return out;
  }

  /** {@link readEncoded} in chunks with a yield between them; rejects once `signal` aborts. */
  private async readEncodedAsync(hashes: string[], signal: AbortSignal): Promise<ScoredDoc[]> {
    const out: ScoredDoc[] = [];
    for (let i = 0; i < hashes.length; i += READ_CHUNK) {
      if (signal.aborted) throw abortError();
      if (i > 0) await yieldToLoop();
      if (signal.aborted) throw abortError();
      out.push(...this.readEncoded(hashes.slice(i, i + READ_CHUNK)));
    }
    return out;
  }

  /**
   * Ask for an agent's window to be brought up to date: coalesced, run after
   * `refreshDebounceMs` of quiet, and at most `refreshMaxWaitMs` after the
   * first pending request.
   */
  requestRefresh(agent: string | null): void {
    if (this.closed || this.options.config.exhaustiveBlocks <= 0) return;
    const id = this.windowId(agent);
    const debounce = this.options.refreshDebounceMs ?? 2000;
    const maxWait = this.options.refreshMaxWaitMs ?? 60_000;
    const pending = this.timers.get(id);
    const firstAt = pending?.firstAt ?? this.now();
    if (pending) clearTimeout(pending.timer);
    const delay = Math.max(0, Math.min(debounce, firstAt + maxWait - this.now()));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.refreshWindow(agent);
    }, delay);
    timer.unref();
    this.timers.set(id, { timer, firstAt });
  }

  /** Bring an agent's window up to date now (one update at a time per agent). */
  refreshWindow(agent: string | null): Promise<void> {
    const id = this.windowId(agent);
    const running = this.building.get(id);
    if (running) {
      this.rerun.add(id);
      return running;
    }
    const task = this.update(agent)
      .catch((error) =>
        this.options.logger?.warn("late_window_build_failed", { error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => {
        this.building.delete(id);
        if (this.rerun.delete(id) && !this.closed) void this.refreshWindow(agent);
      });
    this.building.set(id, task);
    return task;
  }

  private async update(agent: string | null): Promise<void> {
    const cfg = this.options.config;
    if (cfg.exhaustiveBlocks <= 0 || this.closed) return;
    const id = this.windowId(agent);
    const recency = await this.options.recencyPaths(agent);
    const key = `${this.options.indexVersion()}|${[...recency].sort().join(",")}`;
    const current = this.windows.get(id);
    const scanHas = !cfg.resident || this.options.scan.hasWindow(id);
    if (current?.key === key && scanHas) return;
    const started = this.now();
    const limit = Number.isFinite(cfg.exhaustiveBlocks) ? cfg.exhaustiveBlocks : Number.MAX_SAFE_INTEGER;
    const rows = await this.options.store.newestLateWindow(agent, this.indexKey, limit, recency);
    const members = new Map(rows.map((r) => [r.contentHash, r.rowid]));
    let added = 0;
    let removed: string[] = [];
    if (cfg.resident) {
      const base = scanHas && current ? current.members : new Map<string, number>();
      const toAdd = [...members.keys()].filter((h) => !base.has(h));
      removed = [...base.keys()].filter((h) => !members.has(h));
      if (!this.options.scan.hasWindow(id)) await this.options.scan.addToWindow(id, []);
      // Small synchronous reads with a yield between them, handed to the scorer in ~8 MB loads.
      let batch: ScoredDoc[] = [];
      let bytes = 0;
      for (let i = 0; i < toAdd.length && !this.closed; i += READ_CHUNK) {
        if (i > 0) await yieldToLoop();
        for (const d of this.readEncoded(toAdd.slice(i, i + READ_CHUNK))) {
          batch.push(d);
          bytes += d.encoded!.vectors.byteLength;
        }
        if (bytes >= LOAD_BYTES || i + READ_CHUNK >= toAdd.length) {
          added += batch.length;
          await this.options.scan.addToWindow(id, batch);
          batch = [];
          bytes = 0;
        }
      }
      if (this.closed) return;
      this.windows.set(id, { key, members });
      if (removed.length > 0) await this.options.scan.removeFromWindow(id, removed);
    } else {
      this.windows.set(id, { key, members });
    }
    this.options.logger?.debug("late_window_updated", {
      agent: agent ?? undefined,
      blocks: members.size,
      added,
      removed: removed.length,
      resident: cfg.resident,
      ms: this.now() - started,
    });
  }

  /** The window's chunk rows for `keys` (the member rowid's row when several share a hash), in order. */
  private windowRows(agent: string | null, keys: string[], members: Map<string, number>): LexicalHit[] {
    if (keys.length === 0) return [];
    const byHash = new Map<string, LexicalHit>();
    for (const row of this.options.store.chunksByContentHashes(keys, agent)) {
      const have = byHash.get(row.contentHash);
      if (!have || row.rowid === members.get(row.contentHash)) byHash.set(row.contentHash, row);
    }
    return keys.map((k) => byHash.get(k)).filter((r): r is LexicalHit => r !== undefined);
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
    const candidateHashes = [...new Set(input.candidates.map((c) => c.contentHash))];
    const base = (status: LateOutcome["status"], extra: Partial<LateOutcome> = {}): LateOutcome => ({
      status,
      scores: new Map(),
      windowChunks: [],
      backend: null,
      queryModel: null,
      missing: input.candidates.length,
      missingHashes: candidateHashes,
      windowSize: 0,
      ms: this.now() - started,
      ...extra,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const onAbort = () => controller.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    // Window updates never block a query.
    this.requestRefresh(input.agent);
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
      const id = this.windowId(input.agent);
      const { exact, scan } = this.options;
      const found = cfg.exhaustiveBlocks > 0 ? this.windows.get(id) : undefined;
      // A resident window the scorer lost (a worker restart) is rebuilt in the background.
      const win = found && (!cfg.resident || scan.hasWindow(id)) ? found : undefined;
      const members = win?.members ?? new Map<string, number>();
      const beyond = candidateHashes.filter((h) => !members.has(h));
      const inWindow = candidateHashes.filter((h) => members.has(h));
      const keep = Math.max(cfg.rescore, cfg.topN);
      const best = (scores: Map<string, number>): string[] =>
        [...members.keys()]
          .filter((k) => scores.has(k))
          .sort((a, b) => scores.get(b)! - scores.get(a)!)
          .slice(0, keep);
      let scores = new Map<string, number>();
      let windowKeys: string[] = [];
      let backend = exact.backend;
      if (win && cfg.resident && scan.approximate) {
        // Quantised scan → shortlist; the shortlist, every in-window candidate
        // and the beyond-window candidates are re-scored exactly.
        backend = scan.backend;
        const shortlist = await scan.score(query, { windowId: id, windowTopK: cfg.rescore }, controller.signal);
        windowKeys = [...shortlist.keys()].filter((k) => members.has(k));
        const docs = await this.readEncodedAsync([...new Set([...windowKeys, ...inWindow, ...beyond])], controller.signal);
        if (docs.length > 0) scores = await exact.score(query, { docs }, controller.signal);
        windowKeys = windowKeys.filter((k) => scores.has(k));
      } else if (win && cfg.resident) {
        // An exact resident window (the scan is the exact scorer) plus the beyond-window candidates.
        backend = scan.backend;
        const docs = await this.readEncodedAsync(beyond, controller.signal);
        scores = await scan.score(query, { windowId: id, docs }, controller.signal);
        windowKeys = best(scores);
      } else if (win) {
        // Not resident: the window's stored vectors are read and scored exactly per query.
        const docs = await this.readEncodedAsync([...new Set([...members.keys(), ...beyond])], controller.signal);
        if (docs.length > 0) scores = await exact.score(query, { docs }, controller.signal);
        windowKeys = best(scores);
      } else {
        const docs = await this.readEncodedAsync(beyond, controller.signal);
        if (docs.length > 0) scores = await exact.score(query, { docs }, controller.signal);
      }
      if (controller.signal.aborted) throw abortError();
      const missingHashes = candidateHashes.filter((h) => !scores.has(h));
      return {
        status: "ok",
        scores,
        windowChunks: this.windowRows(input.agent, windowKeys, members),
        backend,
        queryModel,
        missing: missingHashes.length,
        missingHashes,
        windowSize: members.size,
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
    this.closed = true;
    for (const t of this.timers.values()) clearTimeout(t.timer);
    this.timers.clear();
    await Promise.all([...this.building.values()]).catch(() => undefined);
    await Promise.all([this.options.scan.close(), this.options.scan === this.options.exact ? undefined : this.options.exact.close()]);
  }
}
