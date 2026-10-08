/**
 * The `turboquant` MaxSim scorer (spec/MEMORY-RETRIEVAL.md §5.0d): resident
 * windows held as 2–4-bit TurboQuant codes in the native N-API crate and
 * scanned by its fused MaxSim kernel on the libuv thread pool, never on the
 * event loop. Scores are approximate (`approximate = true`): callers take the
 * top `windowTopK` keys and re-score them exactly.
 *
 * Ad-hoc `target.docs` are quantised on the fly into a temporary native
 * instance and scanned with the same kernel, so their scores are on the same
 * (approximate) scale as the window's. Re-rank candidates that need exact
 * scores belong to the exact backend.
 */
import { createRequire } from "node:module";
import type { Logger } from "../../observability/logger.js";
import type { TokenMatrix } from "../models/types.js";
import type { MaxSimScorer, ScoredDoc, ScoreTarget } from "./scorer.js";

/** N-API surface of `TurboQuantMaxSim` (native/crates/matrix-core/src/turboquant). */
export declare class NativeTurboQuantMaxSim {
  constructor(options: { dim: number; bits: number; seed?: number; threads?: number });
  readonly dim: number;
  readonly bits: number;
  /** Replace the resident set; encoding runs off the JS thread. */
  setBlocks(keys: string[], tokenCounts: Uint32Array | number[], vectors: Float32Array): Promise<void>;
  /** Add or replace (by key) blocks. */
  addBlocks(keys: string[], tokenCounts: Uint32Array | number[], vectors: Float32Array): Promise<void>;
  /** Remove blocks by key; returns how many were present. */
  removeBlocks(keys: string[]): number;
  blockCount(): number;
  memoryBytes(): number;
  /** Best `topK` (0 = all) blocks by MaxSim / queryTokens, best first. */
  scan(query: Float32Array, queryTokens: number, topK: number): Promise<{ keys: string[]; scores: Float64Array }>;
}

export interface TurboQuantScorerOptions {
  /** Token vector dimension, when known up front (validated at creation). Otherwise taken from each window's docs. */
  dim?: number;
  /** Bits per coordinate. */
  bits: 2 | 3 | 4;
  /** Rotation seed (default: the library's fixed rotation). */
  seed?: number;
  /** Scan threads (default: all cores). */
  threads?: number;
  logger?: Logger;
}

/** Floats per native load call (~32 MB): bounds each main-thread concatenation. */
const LOAD_CHUNK_FLOATS = 8 * 1024 * 1024;

const require = createRequire(import.meta.url);

/** Load the native class; throws when the module or the export is missing. */
export function loadTurboQuantBinding(): typeof NativeTurboQuantMaxSim {
  let binding: { TurboQuantMaxSim?: typeof NativeTurboQuantMaxSim };
  try {
    binding = require("../../../npm/index.js") as typeof binding;
  } catch (error) {
    throw new Error(`TurboQuant native kernel unavailable: ${(error as Error).message}`);
  }
  if (typeof binding.TurboQuantMaxSim !== "function") {
    throw new Error(
      "TurboQuant native kernel unavailable: the native module does not export TurboQuantMaxSim " +
        "(rebuild it with `pnpm build:native`)",
    );
  }
  return binding.TurboQuantMaxSim;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("MaxSim scoring aborted", "AbortError");
}

/** `promise`, or an AbortError as soon as `signal` aborts (the native work finishes and is discarded). */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function floatsOf(m: TokenMatrix): Float32Array {
  const n = m.tokens * m.dim;
  if (m.data.length < n) throw new Error(`TurboQuant: matrix has ${m.data.length} floats, expected ${n}`);
  return m.data.length === n ? m.data : m.data.subarray(0, n);
}

interface Window {
  native: NativeTurboQuantMaxSim | null;
  dim: number;
}

class TurboQuantScorer implements MaxSimScorer {
  readonly backend = "turboquant";
  readonly approximate = true;
  private readonly windows = new Map<string, Window>();
  /** Latest load per window id: a slower, older `setWindow` never overwrites a newer one. */
  private readonly generations = new Map<string, number>();
  private nextGeneration = 1;
  private closed = false;

  constructor(
    private readonly Native: typeof NativeTurboQuantMaxSim,
    private readonly opts: TurboQuantScorerOptions,
  ) {}

  private create(dim: number): NativeTurboQuantMaxSim {
    if (this.opts.dim !== undefined && dim !== this.opts.dim) {
      throw new Error(`TurboQuant: vectors have dim ${dim}, scorer was created for dim ${this.opts.dim}`);
    }
    return new this.Native({ dim, bits: this.opts.bits, seed: this.opts.seed, threads: this.opts.threads });
  }

  /** Encode `docs` (non-empty, one dim) into `native`, in bounded chunks; the first chunk replaces. */
  private async load(native: NativeTurboQuantMaxSim, docs: ScoredDoc[], dim: number): Promise<void> {
    let first = true;
    for (let i = 0; i < docs.length; ) {
      const keys: string[] = [];
      const counts: number[] = [];
      let floats = 0;
      const start = i;
      while (i < docs.length && (floats === 0 || floats + docs[i]!.matrix.tokens * dim <= LOAD_CHUNK_FLOATS)) {
        const m = docs[i]!.matrix;
        if (m.dim !== dim) throw new Error(`TurboQuant: doc ${docs[i]!.key} has dim ${m.dim}, expected ${dim}`);
        keys.push(docs[i]!.key);
        counts.push(m.tokens);
        floats += m.tokens * dim;
        i++;
      }
      const vectors = new Float32Array(floats);
      let offset = 0;
      for (let j = start; j < i; j++) {
        const data = floatsOf(docs[j]!.matrix);
        vectors.set(data, offset);
        offset += data.length;
      }
      const counts32 = Uint32Array.from(counts);
      await (first ? native.setBlocks(keys, counts32, vectors) : native.addBlocks(keys, counts32, vectors));
      first = false;
    }
  }

  async setWindow(windowId: string, docs: ScoredDoc[]): Promise<void> {
    this.assertOpen();
    const generation = this.nextGeneration++;
    this.generations.set(windowId, generation);
    const kept = docs.filter((d) => d.matrix.tokens > 0);
    const started = Date.now();
    let window: Window = { native: null, dim: this.opts.dim ?? 0 };
    if (kept.length > 0) {
      const dim = kept[0]!.matrix.dim;
      const native = this.create(dim);
      // A fresh instance: scans keep using the previous window until this one is complete.
      await this.load(native, kept, dim);
      window = { native, dim };
    }
    if (this.closed || this.generations.get(windowId) !== generation) return;
    this.windows.set(windowId, window);
    this.opts.logger?.debug("turboquant_window_set", {
      window: windowId,
      blocks: kept.length,
      bytes: window.native?.memoryBytes() ?? 0,
      ms: Date.now() - started,
    });
  }

  async dropWindow(windowId: string): Promise<void> {
    this.generations.set(windowId, this.nextGeneration++);
    this.windows.delete(windowId);
  }

  /**
   * Approximate MaxSim / query length per key: the resident window's best
   * `target.windowTopK` (default all) plus every ad-hoc doc with tokens.
   * Rejects with an AbortError when `signal` aborts.
   */
  async score(query: TokenMatrix, target: ScoreTarget, signal?: AbortSignal): Promise<Map<string, number>> {
    this.assertOpen();
    if (signal?.aborted) throw abortError(signal);
    const out = new Map<string, number>();
    if (query.tokens <= 0) return out;
    const q = floatsOf(query);
    const scans: Array<Promise<{ keys: string[]; scores: Float64Array }>> = [];

    if (target.windowId !== undefined) {
      const window = this.windows.get(target.windowId);
      if (!window) throw new Error(`TurboQuant: unknown window ${target.windowId}`);
      if (window.native) {
        if (query.dim !== window.dim) {
          throw new Error(`TurboQuant: query dim ${query.dim} does not match window dim ${window.dim}`);
        }
        const topK = target.windowTopK !== undefined ? Math.max(1, Math.floor(target.windowTopK)) : 0;
        scans.push(window.native.scan(q, query.tokens, topK));
      }
    }

    const adHoc = (target.docs ?? []).filter((d) => d.matrix.tokens > 0);
    if (adHoc.length > 0) {
      const native = this.create(query.dim);
      scans.push(this.load(native, adHoc, query.dim).then(() => native.scan(q, query.tokens, 0)));
    }

    const results = await withAbort(Promise.all(scans), signal);
    for (const r of results) {
      for (let i = 0; i < r.keys.length; i++) out.set(r.keys[i]!, r.scores[i]!);
    }
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.windows.clear();
    this.generations.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("TurboQuant scorer closed");
  }
}

/**
 * Create the native TurboQuant scorer. Throws when the native kernel is
 * unavailable (stale or missing module) or rejects the options; the caller
 * falls back to the exact backend. When `dim` is given, a one-token probe is
 * encoded and scanned off-thread, which also warms the codebook.
 */
export async function createTurboQuantScorer(opts: TurboQuantScorerOptions): Promise<MaxSimScorer> {
  const Native = loadTurboQuantBinding();
  if (opts.dim !== undefined) {
    const probe = new Native({ dim: opts.dim, bits: opts.bits, seed: opts.seed, threads: 1 });
    const v = new Float32Array(opts.dim);
    v[0] = 1;
    await probe.setBlocks(["probe"], [1], v);
    const r = await probe.scan(v, 1, 1);
    if (r.keys[0] !== "probe" || !(Math.abs(r.scores[0]! - 1) < 0.1)) {
      throw new Error(`TurboQuant native kernel failed its probe (score ${r.scores[0]})`);
    }
  } else {
    // Validates `bits` without waiting for the first window.
    new Native({ dim: 8, bits: opts.bits, threads: 1 });
  }
  opts.logger?.debug("turboquant_ready", { bits: opts.bits, dim: opts.dim ?? null });
  return new TurboQuantScorer(Native, opts);
}
