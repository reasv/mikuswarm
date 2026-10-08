/**
 * Lazy loading of an in-process ONNX model plus its tokenizer, shared by the
 * local cross-encoder and late-interaction providers (ARCHITECTURE.md §9d
 * "Re-rank stages").
 *
 * The model lives in its own worker process (src/retrieval/onnx/onnx-worker.ts;
 * a process, not a thread: see src/retrieval/onnx/worker-rpc.ts): session
 * creation, tokenization and every forward pass run there, so neither a load
 * nor an inference ever blocks the event loop. Only the file download (async
 * I/O) runs in the main process.
 *
 * A trigger never waits on a download or a model load: {@link LazyOnnxModel.get}
 * throws {@link ProviderNotReadyError} until the worker reports the model
 * loaded (the chain skips the member without a health strike) and starts
 * loading in the background on first use. A failed load, or a worker that
 * dies, is retried on a later use after a doubling backoff.
 */
import type { Logger } from "../../observability/logger.js";
import type { ResolvedModelProvider } from "../config.js";
import { ProviderNotReadyError } from "../models/types.js";
import { resolveModelFiles, type ModelFiles } from "./model-files.js";
import type { OnnxWorkerInfo, OnnxWorkerInit } from "./onnx-worker.js";
import { siblingWorkerUrl, WorkerRpc } from "./worker-rpc.js";

export interface LazyOnnxModelOptions {
  /** Provider name, for logs and errors. */
  name: string;
  /** Hugging Face repo id (when `modelDir` is unset). */
  model?: string;
  modelDir?: string;
  /** Pinned Hugging Face commit (default main). */
  revision?: string;
  /** Expected sha256 per model file. */
  sha256?: Record<string, string>;
  onnxFile: string;
  /** Download cache root (`<cacheRoot>/<repo slug>/`). */
  cacheRoot: string;
  httpProxyUrl?: string;
  /** Hub base URL override (default https://huggingface.co). */
  baseUrl?: string;
  /** onnxruntime intra-op threads of this model's worker (default: onnxruntime's own choice). */
  intraOpNumThreads?: number;
  /** OS niceness of the worker process (e.g. 10 for background encoding); best effort. */
  nice?: number;
  /** First retry delay after a failed load (default 30 s), doubling up to `maxRetryDelayMs`. */
  retryDelayMs?: number;
  /** Retry delay cap (default 15 min). */
  maxRetryDelayMs?: number;
  logger?: Logger;
}

/** Operations the model worker serves (src/retrieval/onnx/onnx-worker.ts). */
export type OnnxOp = "crossScore" | "lateEncode";

/** A loaded model: its declared inputs/outputs and a call into its worker. */
export interface OnnxModelHandle {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  readonly files: ModelFiles;
  /** One worker request; rejects with an AbortError at once when `signal` aborts. */
  call<T>(op: OnnxOp, payload: unknown, signal?: AbortSignal): Promise<T>;
}

export class LazyOnnxModel {
  private loaded: (OnnxModelHandle & { rpc: WorkerRpc }) | null = null;
  private loading: Promise<void> | null = null;
  private lastError: Error | null = null;
  private failures = 0;
  private nextAttemptAt = 0;
  private closed = false;

  constructor(private readonly opts: LazyOnnxModelOptions) {}

  /**
   * Start loading (download, worker, session, tokenizer) unless loaded,
   * loading, or in a retry backoff. Resolves when this attempt settles; never
   * rejects (the error is logged and kept in {@link error}), so callers may
   * fire and forget.
   */
  warm(): Promise<void> {
    if (this.loaded || this.closed) return Promise.resolve();
    if (this.loading) return this.loading;
    if (Date.now() < this.nextAttemptAt) return Promise.resolve();
    const started = Date.now();
    this.opts.logger?.info("onnx_model_load_started", { provider: this.opts.name, model: this.label() });
    this.loading = this.load()
      .then(async (loaded) => {
        if (this.closed) {
          await loaded.rpc.close();
          return;
        }
        this.loaded = loaded;
        this.lastError = null;
        this.failures = 0;
        this.opts.logger?.info("onnx_model_loaded", {
          provider: this.opts.name,
          model: this.label(),
          ms: Date.now() - started,
          inputs: loaded.inputNames,
          outputs: loaded.outputNames,
        });
      })
      .catch((error: unknown) => this.recordFailure(error, "onnx_model_load_failed"))
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  ready(): boolean {
    return this.loaded !== null;
  }

  /** The last load failure, if the most recent attempt failed. */
  error(): Error | null {
    return this.lastError;
  }

  /** The model's declared input names (empty until loaded). */
  get inputNames(): readonly string[] {
    return this.loaded?.inputNames ?? [];
  }

  /**
   * The loaded model. Throws {@link ProviderNotReadyError} when not loaded yet,
   * after starting a background load (subject to the retry backoff).
   */
  get(): OnnxModelHandle {
    if (this.loaded) return this.loaded;
    if (this.closed) throw new ProviderNotReadyError(`${this.opts.name}: closed`);
    void this.warm();
    const why = this.loading
      ? "model loading"
      : this.lastError
        ? `model load failed (${this.lastError.message}); retrying in ${Math.max(0, Math.ceil((this.nextAttemptAt - Date.now()) / 1000))} s`
        : "model not loaded";
    throw new ProviderNotReadyError(`${this.opts.name}: ${why}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    const loaded = this.loaded;
    this.loaded = null;
    if (loaded) await loaded.rpc.close();
  }

  private label(): string {
    return this.opts.modelDir ?? this.opts.model ?? "";
  }

  private recordFailure(error: unknown, event: string): void {
    this.lastError = error instanceof Error ? error : new Error(String(error));
    this.failures++;
    const base = this.opts.retryDelayMs ?? 30_000;
    const cap = this.opts.maxRetryDelayMs ?? 15 * 60_000;
    const delay = Math.min(cap, base * 2 ** (this.failures - 1));
    this.nextAttemptAt = Date.now() + delay;
    this.opts.logger?.warn(event, {
      provider: this.opts.name,
      model: this.label(),
      error: this.lastError.message,
      retry_in_ms: delay,
    });
  }

  private async load(): Promise<OnnxModelHandle & { rpc: WorkerRpc }> {
    const files = await resolveModelFiles({
      model: this.opts.model,
      modelDir: this.opts.modelDir,
      revision: this.opts.revision,
      sha256: this.opts.sha256,
      onnxFile: this.opts.onnxFile,
      cacheRoot: this.opts.cacheRoot,
      httpProxyUrl: this.opts.httpProxyUrl,
      baseUrl: this.opts.baseUrl,
    });
    const init: OnnxWorkerInit = {
      onnxPath: files.onnxPath,
      tokenizerPath: files.tokenizerPath,
      configPath: files.configPath,
      threads: this.opts.intraOpNumThreads,
    };
    let handle: (OnnxModelHandle & { rpc: WorkerRpc }) | null = null;
    const { rpc, info } = await WorkerRpc.start<OnnxWorkerInfo>(siblingWorkerUrl(import.meta.url, "onnx-worker"), "onnx", init, {
      label: `onnx:${this.opts.name}`,
      logger: this.opts.logger,
      nice: this.opts.nice,
      // A crashed worker unloads the model; the next use reloads it after a backoff.
      onDead: (error) => {
        if (this.loaded === handle) this.loaded = null;
        this.recordFailure(error, "onnx_model_worker_died");
      },
    });
    handle = {
      rpc,
      files,
      inputNames: info.inputNames,
      outputNames: info.outputNames,
      call: <T>(op: OnnxOp, payload: unknown, signal?: AbortSignal) => rpc.call<T>(op, payload, signal),
    };
    return handle;
  }
}

export interface LocalOnnxProviderOptions {
  /** Download cache root for Hugging Face models (`<cacheRoot>/<repo slug>/`). */
  cacheRoot: string;
  httpProxyUrl?: string;
  /** Hub base URL override (default https://huggingface.co). */
  baseUrl?: string;
  logger?: Logger;
  /** onnxruntime intra-op threads of the provider's worker. */
  threads?: number;
  /** First retry delay after a failed load (default 30 s). */
  retryDelayMs?: number;
}

/** The lazy model of one `[retrieval.<stage>.providers.<name>]` local provider. */
export function lazyModelFor(
  provider: ResolvedModelProvider,
  opts: LocalOnnxProviderOptions,
  threads?: number,
  nice?: number,
): LazyOnnxModel {
  return new LazyOnnxModel({
    name: provider.name,
    model: provider.model,
    modelDir: provider.modelDir,
    revision: provider.revision,
    sha256: provider.sha256,
    onnxFile: provider.onnxFile,
    cacheRoot: opts.cacheRoot,
    httpProxyUrl: opts.httpProxyUrl,
    baseUrl: opts.baseUrl,
    intraOpNumThreads: threads,
    nice,
    retryDelayMs: opts.retryDelayMs,
    logger: opts.logger,
  });
}
