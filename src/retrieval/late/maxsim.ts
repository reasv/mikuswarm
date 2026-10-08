/**
 * The `exact` MaxSim scorer (ARCHITECTURE.md §9d "Late interaction"): fp32
 * MaxSim on the ONNX runtime in a worker process, the portable fallback of the
 * {@link MaxSimScorer} seam.
 *
 * The worker keeps each resident window pre-packed into padded batches bucketed
 * by token count (src/retrieval/late/maxsim-worker.ts), so a query costs one
 * graph run per batch and nothing on the event loop but message passing.
 * Vectors cross to the worker as structured-clone copies over IPC, sent in
 * bounded chunks so loading a large window never blocks the event loop for
 * long; stored fp16 / int8 rows cross as they are and are decoded in the
 * worker. (A process, not a worker thread: see src/retrieval/onnx/worker-rpc.ts.)
 *
 * A worker that dies (a crash, an OOM kill, the hang watchdog) is respawned on
 * the next call, after a doubling backoff (immediately the first time); its
 * resident windows are gone, which {@link ExactMaxSimScorer.hasWindow} reports
 * so the caller rebuilds them.
 */
import { availableParallelism } from "node:os";
import type { Logger } from "../../observability/logger.js";
import type { TokenMatrix } from "../models/types.js";
import { siblingWorkerUrl, WorkerRpc } from "../onnx/worker-rpc.js";
import type { MaxSimScorer, ScoredDoc, ScoreTarget } from "./scorer.js";
import type { WireDoc, WorkerInit } from "./maxsim-worker.js";

export interface ExactMaxSimOptions {
  /** onnxruntime intra-op threads (default min(8, cores)). */
  threads?: number;
  /** Padded token budget per graph run (default 32768). */
  maxBatchTokens?: number;
  /** First respawn delay after a second consecutive death (default 1 s), doubling up to `maxRespawnDelayMs`. */
  respawnDelayMs?: number;
  /** Respawn delay cap (default 60 s). */
  maxRespawnDelayMs?: number;
  logger?: Logger;
}

/** A worker up this long before dying resets the respawn backoff. */
const STABLE_MS = 5 * 60_000;

/** Bytes per message (~2 MB): bounds each main-thread serialisation to a few ms. */
const CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * The array as a standalone copy when it is a view: structured clone copies a
 * view's whole backing buffer, so a view into a larger buffer is sliced first.
 */
function ownArray<T extends Float32Array | Uint8Array>(a: T, length: number): T {
  if (a.length < length) throw new Error(`MaxSim: array has ${a.length} elements, expected ${length}`);
  const whole = a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.length === length;
  return whole ? a : (a.slice(0, length) as T);
}

function toWire(doc: ScoredDoc): WireDoc {
  if (doc.matrix) {
    const m = doc.matrix;
    return { key: doc.key, tokens: m.tokens, dim: m.dim, data: ownArray(m.data, m.tokens * m.dim) };
  }
  const e = doc.encoded;
  return {
    key: doc.key,
    tokens: e.tokenCount,
    dim: e.dim,
    dtype: e.dtype,
    vectors: ownArray(new Uint8Array(e.vectors.buffer, e.vectors.byteOffset, e.vectors.byteLength), e.vectors.byteLength),
    scales: e.scales ? ownArray(new Uint8Array(e.scales.buffer, e.scales.byteOffset, e.scales.byteLength), e.scales.byteLength) : null,
  };
}

function wireBytes(doc: ScoredDoc): number {
  return doc.matrix ? doc.matrix.tokens * doc.matrix.dim * 4 : doc.encoded.vectors.byteLength;
}

export class ExactMaxSimScorer implements MaxSimScorer {
  readonly backend = "exact";
  readonly approximate = false;
  private rpc: WorkerRpc | null;
  private starting: Promise<WorkerRpc> | null = null;
  /** Windows resident in the current worker (a respawn starts empty). */
  private readonly resident = new Set<string>();
  private deaths = 0;
  private nextSpawnAt = 0;
  private spawnedAt = Date.now();
  private nextStage = 1;
  private closed = false;

  private constructor(
    rpc: WorkerRpc,
    private readonly init: WorkerInit,
    private readonly opts: ExactMaxSimOptions,
  ) {
    this.rpc = rpc;
  }

  private static spawn(init: WorkerInit, opts: ExactMaxSimOptions, onDead: (rpc: () => WorkerRpc | null) => void): Promise<WorkerRpc> {
    let self: WorkerRpc | null = null;
    return WorkerRpc.start(siblingWorkerUrl(import.meta.url, "maxsim-worker"), "maxsim", init, {
      label: "maxsim",
      logger: opts.logger,
      onDead: () => onDead(() => self),
    }).then(({ rpc }) => (self = rpc));
  }

  static async create(opts: ExactMaxSimOptions = {}): Promise<ExactMaxSimScorer> {
    const init: WorkerInit = {
      threads: opts.threads ?? Math.min(8, availableParallelism()),
      maxBatchTokens: opts.maxBatchTokens ?? 32768,
    };
    let scorer: ExactMaxSimScorer | null = null;
    const rpc = await ExactMaxSimScorer.spawn(init, opts, (dead) => scorer?.onDead(dead()));
    scorer = new ExactMaxSimScorer(rpc, init, opts);
    opts.logger?.debug("maxsim_worker_ready", { threads: init.threads, max_batch_tokens: init.maxBatchTokens });
    return scorer;
  }

  private onDead(dead: WorkerRpc | null): void {
    if (dead !== null && dead !== this.rpc) return;
    this.rpc = null;
    this.resident.clear();
    // A worker that ran a while before dying starts the backoff over.
    if (Date.now() - this.spawnedAt > STABLE_MS) this.deaths = 0;
    this.deaths++;
    const base = this.opts.respawnDelayMs ?? 1000;
    const cap = this.opts.maxRespawnDelayMs ?? 60_000;
    // The first death respawns at once; repeated ones back off.
    this.nextSpawnAt = Date.now() + (this.deaths <= 1 ? 0 : Math.min(cap, base * 2 ** (this.deaths - 2)));
  }

  /** The live worker, respawning a dead one (subject to the backoff). */
  private async worker(): Promise<WorkerRpc> {
    if (this.closed) throw new Error("maxsim closed");
    if (this.rpc && !this.rpc.dead) return this.rpc;
    if (this.starting) return this.starting;
    const wait = this.nextSpawnAt - Date.now();
    if (wait > 0) throw new Error(`maxsim worker died; respawning in ${Math.ceil(wait / 1000)} s`);
    this.opts.logger?.info("maxsim_worker_respawn", { deaths: this.deaths });
    this.starting = ExactMaxSimScorer.spawn(this.init, this.opts, (dead) => this.onDead(dead()))
      .then(
        (rpc) => {
          if (this.closed) {
            void rpc.close();
            throw new Error("maxsim closed");
          }
          this.rpc = rpc;
          this.spawnedAt = Date.now();
          return rpc;
        },
        (error: unknown) => {
          this.onDead(null);
          throw error;
        },
      )
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private async call<T>(op: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const rpc = await this.worker();
    return rpc.call<T>(op, payload, signal);
  }

  /** Send `docs` to `op` in bounded chunks. */
  private async sendChunked(op: string, windowId: string, docs: ScoredDoc[]): Promise<void> {
    let chunk: WireDoc[] = [];
    let bytes = 0;
    for (const doc of docs) {
      chunk.push(toWire(doc));
      bytes += wireBytes(doc);
      if (bytes >= CHUNK_BYTES) {
        await this.call(op, { windowId, docs: chunk });
        chunk = [];
        bytes = 0;
      }
    }
    if (chunk.length > 0) await this.call(op, { windowId, docs: chunk });
  }

  async setWindow(windowId: string, docs: ScoredDoc[]): Promise<void> {
    this.resident.delete(windowId);
    await this.call("windowBegin", { windowId });
    await this.sendChunked("windowAppend", windowId, docs);
    await this.call("windowCommit", { windowId });
    this.resident.add(windowId);
  }

  async addToWindow(windowId: string, docs: ScoredDoc[]): Promise<void> {
    const rpc = await this.worker();
    if (!this.resident.has(windowId)) await rpc.call("windowAdd", { windowId, docs: [] });
    this.resident.add(windowId);
    await this.sendChunked("windowAdd", windowId, docs);
    if (this.rpc !== rpc) this.resident.delete(windowId);
  }

  async removeFromWindow(windowId: string, keys: string[]): Promise<void> {
    if (!this.resident.has(windowId) || keys.length === 0) return;
    await this.call("windowRemove", { windowId, keys });
  }

  hasWindow(windowId: string): boolean {
    return this.resident.has(windowId) && this.rpc !== null && !this.rpc.dead;
  }

  async dropWindow(windowId: string): Promise<void> {
    this.resident.delete(windowId);
    if (this.rpc && !this.rpc.dead) await this.rpc.call("dropWindow", { windowId });
  }

  /**
   * Mean best-match score per document key (documents with no tokens, or a
   * corrupt stored blob, are omitted). Rejects with an AbortError when `signal`
   * aborts; the worker stops at its next batch boundary and the result is discarded.
   */
  async score(query: TokenMatrix, target: ScoreTarget, signal?: AbortSignal): Promise<Map<string, number>> {
    // Large ad-hoc sets cross in bounded messages (staged in the worker), the last with the query.
    const chunks: ScoredDoc[][] = [[]];
    let bytes = 0;
    for (const doc of target.docs ?? []) {
      if (bytes >= CHUNK_BYTES) {
        chunks.push([]);
        bytes = 0;
      }
      chunks[chunks.length - 1]!.push(doc);
      bytes += wireBytes(doc);
    }
    const stageId = chunks.length > 1 ? `s${this.nextStage++}` : undefined;
    let reply: { keys: string[]; scores: Float32Array } | null;
    try {
      for (const chunk of chunks.slice(0, -1)) {
        await this.call("stageDocs", { stageId, docs: chunk.map(toWire) }, signal);
      }
      reply = await this.call<{ keys: string[]; scores: Float32Array } | null>(
        "score",
        {
          query: { tokens: query.tokens, dim: query.dim, data: ownArray(query.data, query.tokens * query.dim) },
          windowId: target.windowId,
          stageId,
          docs: chunks[chunks.length - 1]!.map(toWire),
        },
        signal,
      );
    } catch (error) {
      if (stageId && this.rpc && !this.rpc.dead) void this.rpc.call("unstage", { stageId }).catch(() => undefined);
      throw error;
    }
    const out = new Map<string, number>();
    if (reply) for (let i = 0; i < reply.keys.length; i++) out.set(reply.keys[i]!, reply.scores[i]!);
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.resident.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.close();
  }
}

/** Alias kept for callers that name the engine rather than the backend. */
export { ExactMaxSimScorer as MaxSimEngine };
