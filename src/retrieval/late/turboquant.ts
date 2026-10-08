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
 *
 * Windows are updated in place (`addToWindow` / `removeFromWindow`) from the
 * stored fp16 / int8 rows, which the native side decodes off the event loop.
 * A replaced, dropped or temporary native instance is freed explicitly, and
 * the native side reports its codes to V8 as external memory.
 */
import { createRequire } from "node:module";
import type { Logger } from "../../observability/logger.js";
import type { TokenMatrix } from "../models/types.js";
import { docDim, docTokens, type MaxSimScorer, type ScoredDoc, type ScoreTarget } from "./scorer.js";

/** N-API surface of `TurboQuantMaxSim` (native/crates/matrix-core/src/turboquant). */
export declare class NativeTurboQuantMaxSim {
  constructor(options: { dim: number; bits: number; seed?: number; threads?: number });
  readonly dim: number;
  readonly bits: number;
  /** Replace the resident set; encoding runs off the JS thread. */
  setBlocks(keys: string[], tokenCounts: Uint32Array | number[], vectors: Float32Array): Promise<void>;
  /** Add or replace (by key) blocks. */
  addBlocks(keys: string[], tokenCounts: Uint32Array | number[], vectors: Float32Array): Promise<void>;
  /** Add or replace blocks from stored fp16 / int8 rows (decoded off the JS thread); `replace` replaces the set. */
  addEncoded(
    keys: string[],
    tokenCounts: Uint32Array | number[],
    dtype: "fp16" | "int8",
    vectors: Uint8Array | Uint8Array[],
    scales: Uint8Array | Uint8Array[] | null | undefined,
    replace?: boolean,
  ): Promise<void>;
  /** Remove blocks by key; returns how many were present. */
  removeBlocks(keys: string[]): number;
  /** Release the codes now; later mutations are discarded. */
  free(): void;
  blockCount(): number;
  memoryBytes(): number;
  /** Bytes reported to V8 as external memory. */
  externalBytes(): number;
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

/** Bytes per native load call (~8 MB): bounds each main-thread concatenation to a short memcpy. */
const LOAD_CHUNK_BYTES = 8 * 1024 * 1024;

const require = createRequire(import.meta.url);

/** Load the native class; throws when the module or the export is missing. */
export function loadTurboQuantBinding(): typeof NativeTurboQuantMaxSim {
  let binding: { TurboQuantMaxSim?: typeof NativeTurboQuantMaxSim };
  try {
    binding = require("../../../npm/index.js") as typeof binding;
  } catch (error) {
    throw new Error(`TurboQuant native kernel unavailable: ${(error as Error).message}`);
  }
  const proto = (binding.TurboQuantMaxSim as { prototype?: Record<string, unknown> } | undefined)?.prototype;
  if (typeof binding.TurboQuantMaxSim !== "function" || typeof proto?.addEncoded !== "function" || typeof proto?.free !== "function") {
    throw new Error(
      "TurboQuant native kernel unavailable: the native module does not export a current TurboQuantMaxSim " +
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

/** Stored bytes of a doc's rows (for chunking). */
function docBytes(d: ScoredDoc): number {
  return d.matrix ? d.matrix.tokens * d.matrix.dim * 4 : d.encoded.vectors.byteLength;
}

/** A run of docs sharing one representation (f32, fp16 or int8). */
function kindOf(d: ScoredDoc): string {
  return d.matrix ? "f32" : d.encoded.dtype;
}

interface Window {
  native: NativeTurboQuantMaxSim | null;
  dim: number;
}

function safeFree(native: NativeTurboQuantMaxSim | null | undefined): void {
  try {
    native?.free();
  } catch {
    // an older module without free(): left to GC
  }
}

class TurboQuantScorer implements MaxSimScorer {
  readonly backend = "turboquant";
  readonly approximate = true;
  private readonly windows = new Map<string, Window>();
  /** Latest load per window id: a slower, older `setWindow` never overwrites a newer one. */
  private readonly generations = new Map<string, number>();
  /** Per-window mutation chain: incremental updates apply in call order. */
  private readonly chains = new Map<string, Promise<unknown>>();
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

  /**
   * Encode `docs` (non-empty, one dim) into `native` in bounded chunks of one
   * representation; with `replace` the first chunk replaces the set. Stored
   * rows are passed as they are; decoding runs natively, off the event loop.
   */
  private async load(native: NativeTurboQuantMaxSim, docs: ScoredDoc[], dim: number, replace: boolean): Promise<void> {
    let first = replace;
    for (let i = 0; i < docs.length; ) {
      const kind = kindOf(docs[i]!);
      const chunk: ScoredDoc[] = [];
      let bytes = 0;
      while (i < docs.length && kindOf(docs[i]!) === kind && (bytes === 0 || bytes + docBytes(docs[i]!) <= LOAD_CHUNK_BYTES)) {
        const d = docs[i]!;
        const dDim = d.matrix ? d.matrix.dim : d.encoded.dim;
        if (dDim !== dim) throw new Error(`TurboQuant: doc ${d.key} has dim ${dDim}, expected ${dim}`);
        chunk.push(d);
        bytes += docBytes(d);
        i++;
      }
      const keys = chunk.map((d) => d.key);
      const counts = Uint32Array.from(chunk, (d) => (d.matrix ? d.matrix.tokens : d.encoded.tokenCount));
      if (kind === "f32") {
        const floats = chunk.reduce((n, d) => n + d.matrix!.tokens * dim, 0);
        const vectors = new Float32Array(floats);
        let offset = 0;
        for (const d of chunk) {
          const data = floatsOf(d.matrix!);
          vectors.set(data, offset);
          offset += data.length;
        }
        await (first ? native.setBlocks(keys, counts, vectors) : native.addBlocks(keys, counts, vectors));
      } else {
        // One buffer per block: the native side reads them in place (no JS-side copy).
        const vectors = chunk.map((d) => d.encoded!.vectors);
        const scales = kind === "int8" ? chunk.map((d) => d.encoded!.scales ?? new Uint8Array(0)) : null;
        await native.addEncoded(keys, counts, kind as "fp16" | "int8", vectors, scales, first);
      }
      first = false;
    }
  }

  /** Run `fn` after the window's earlier mutations (failures do not break the chain). */
  private serial<T>(windowId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(windowId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(windowId, next);
    void next.finally(() => {
      if (this.chains.get(windowId) === next) this.chains.delete(windowId);
    }).catch(() => undefined);
    return next;
  }

  async setWindow(windowId: string, docs: ScoredDoc[]): Promise<void> {
    this.assertOpen();
    const generation = this.nextGeneration++;
    this.generations.set(windowId, generation);
    const kept = docs.filter((d) => docTokens(d) > 0);
    const started = Date.now();
    let window: Window = { native: null, dim: this.opts.dim ?? 0 };
    if (kept.length > 0) {
      const dim = docDim(kept[0]!);
      const native = this.create(dim);
      // A fresh instance: scans keep using the previous window until this one is complete.
      try {
        await this.load(native, kept, dim, true);
      } catch (error) {
        safeFree(native);
        throw error;
      }
      window = { native, dim };
    }
    if (this.closed || this.generations.get(windowId) !== generation) {
      safeFree(window.native);
      return;
    }
    const old = this.windows.get(windowId);
    this.windows.set(windowId, window);
    if (old && old.native !== window.native) safeFree(old.native);
    this.opts.logger?.debug("turboquant_window_set", {
      window: windowId,
      blocks: kept.length,
      bytes: window.native?.memoryBytes() ?? 0,
      ms: Date.now() - started,
    });
  }

  addToWindow(windowId: string, docs: ScoredDoc[]): Promise<void> {
    this.assertOpen();
    const generation = this.generations.get(windowId);
    return this.serial(windowId, async () => {
      const kept = docs.filter((d) => docTokens(d) > 0);
      if (this.closed || this.generations.get(windowId) !== generation) return;
      let window = this.windows.get(windowId);
      if (!window) {
        window = { native: null, dim: this.opts.dim ?? 0 };
        this.windows.set(windowId, window);
      }
      if (kept.length === 0) return;
      const dim = docDim(kept[0]!);
      if (!window.native) {
        window.native = this.create(dim);
        window.dim = dim;
      } else if (dim !== window.dim) {
        throw new Error(`TurboQuant: docs have dim ${dim}, window ${windowId} has dim ${window.dim}`);
      }
      await this.load(window.native, kept, dim, false);
    });
  }

  removeFromWindow(windowId: string, keys: string[]): Promise<void> {
    this.assertOpen();
    return this.serial(windowId, async () => {
      if (keys.length > 0) this.windows.get(windowId)?.native?.removeBlocks(keys);
    });
  }

  hasWindow(windowId: string): boolean {
    return this.windows.has(windowId);
  }

  async dropWindow(windowId: string): Promise<void> {
    this.generations.set(windowId, this.nextGeneration++);
    const old = this.windows.get(windowId);
    this.windows.delete(windowId);
    safeFree(old?.native);
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

    const adHoc = (target.docs ?? []).filter((d) => docTokens(d) > 0);
    if (adHoc.length > 0) {
      const native = this.create(query.dim);
      scans.push(
        this.load(native, adHoc, query.dim, true)
          .then(() => native.scan(q, query.tokens, 0))
          .finally(() => safeFree(native)),
      );
    }

    const results = await withAbort(Promise.all(scans), signal);
    for (const r of results) {
      for (let i = 0; i < r.keys.length; i++) out.set(r.keys[i]!, r.scores[i]!);
    }
    return out;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const w of this.windows.values()) safeFree(w.native);
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
    probe.free();
    if (r.keys[0] !== "probe" || !(Math.abs(r.scores[0]! - 1) < 0.1)) {
      throw new Error(`TurboQuant native kernel failed its probe (score ${r.scores[0]})`);
    }
  } else {
    // Validates `bits` without waiting for the first window.
    new Native({ dim: 8, bits: opts.bits, threads: 1 }).free();
  }
  opts.logger?.debug("turboquant_ready", { bits: opts.bits, dim: opts.dim ?? null });
  return new TurboQuantScorer(Native, opts);
}
