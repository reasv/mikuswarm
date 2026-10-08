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
 * long. (A process, not a worker thread: see src/retrieval/onnx/worker-rpc.ts.)
 */
import { availableParallelism } from "node:os";
import type { Logger } from "../../observability/logger.js";
import type { TokenMatrix } from "../models/types.js";
import { siblingWorkerUrl, WorkerRpc } from "../onnx/worker-rpc.js";
import type { MaxSimScorer, ScoredDoc, ScoreTarget } from "./scorer.js";
import type { WireMatrix, WorkerInit } from "./maxsim-worker.js";

export interface ExactMaxSimOptions {
  /** onnxruntime intra-op threads (default min(8, cores)). */
  threads?: number;
  /** Padded token budget per graph run (default 32768). */
  maxBatchTokens?: number;
  logger?: Logger;
}

/** Floats per window-load message (~32 MB): bounds each main-thread copy. */
const WINDOW_CHUNK_FLOATS = 8 * 1024 * 1024;

/**
 * The matrix's floats as a standalone array: structured clone copies a view's
 * whole backing buffer, so a view into a larger buffer is sliced first.
 */
function ownFloats(m: TokenMatrix): Float32Array {
  const n = m.tokens * m.dim;
  if (m.data.length < n) throw new Error(`MaxSim: matrix has ${m.data.length} floats, expected ${n}`);
  const whole = m.data.byteOffset === 0 && m.data.byteLength === m.data.buffer.byteLength && m.data.length === n;
  return whole ? m.data : m.data.slice(0, n);
}

function toWire(doc: ScoredDoc): WireMatrix {
  return { key: doc.key, tokens: doc.matrix.tokens, dim: doc.matrix.dim, data: ownFloats(doc.matrix) };
}

export class ExactMaxSimScorer implements MaxSimScorer {
  readonly backend = "exact";
  readonly approximate = false;

  private constructor(private readonly rpc: WorkerRpc) {}

  static async create(opts: ExactMaxSimOptions = {}): Promise<ExactMaxSimScorer> {
    const init: WorkerInit = {
      threads: opts.threads ?? Math.min(8, availableParallelism()),
      maxBatchTokens: opts.maxBatchTokens ?? 32768,
    };
    const { rpc } = await WorkerRpc.start(siblingWorkerUrl(import.meta.url, "maxsim-worker"), "maxsim", init, {
      label: "maxsim",
      logger: opts.logger,
    });
    opts.logger?.debug("maxsim_worker_ready", { threads: init.threads, max_batch_tokens: init.maxBatchTokens });
    return new ExactMaxSimScorer(rpc);
  }

  async setWindow(windowId: string, docs: ScoredDoc[]): Promise<void> {
    await this.rpc.call("windowBegin", { windowId });
    let chunk: WireMatrix[] = [];
    let floats = 0;
    for (const doc of docs) {
      chunk.push(toWire(doc));
      floats += doc.matrix.tokens * doc.matrix.dim;
      if (floats >= WINDOW_CHUNK_FLOATS) {
        await this.rpc.call("windowAppend", { windowId, docs: chunk });
        chunk = [];
        floats = 0;
      }
    }
    if (chunk.length > 0) await this.rpc.call("windowAppend", { windowId, docs: chunk });
    await this.rpc.call("windowCommit", { windowId });
  }

  async dropWindow(windowId: string): Promise<void> {
    await this.rpc.call("dropWindow", { windowId });
  }

  /**
   * Mean best-match score per document key (documents with no tokens are
   * omitted). Rejects with an AbortError when `signal` aborts; the worker stops
   * at its next batch boundary and the result is discarded.
   */
  async score(query: TokenMatrix, target: ScoreTarget, signal?: AbortSignal): Promise<Map<string, number>> {
    const reply = await this.rpc.call<{ keys: string[]; scores: Float32Array } | null>(
      "score",
      {
        query: { tokens: query.tokens, dim: query.dim, data: ownFloats(query) },
        windowId: target.windowId,
        docs: target.docs?.map(toWire),
      },
      signal,
    );
    const out = new Map<string, number>();
    if (reply) for (let i = 0; i < reply.keys.length; i++) out.set(reply.keys[i]!, reply.scores[i]!);
    return out;
  }

  async close(): Promise<void> {
    await this.rpc.close();
  }
}

/** Alias kept for callers that name the engine rather than the backend. */
export { ExactMaxSimScorer as MaxSimEngine };
