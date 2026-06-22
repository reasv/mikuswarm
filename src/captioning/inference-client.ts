import { readFile, unlink } from "node:fs/promises";
import { describeMedia, type CaptionModelConfig, type MediaModality } from "./describe.js";
import { type LlmScheduler } from "../agent/scheduler.js";
import { extractStatus } from "../agent/request-retry.js";
import {
  runFetchWithFallback,
  type ModelChainEntry,
  type FetchChainMember,
} from "../agent/model-fallback.js";
import { computeUsageCost, type CostRates, type RawTokenUsage } from "../agent/usage.js";
import {
  processImageForInference,
  processVideoForInference,
  processAudioForInference,
  cleanupProcessedImage,
  type ImageProcessingOptions,
  type VideoProcessingOptions,
  type AudioProcessingOptions,
  type ProcessedMedia,
} from "../media/index.js";

/** All-zero cost rates: usage captured, cost "untracked" (spec §7.1 unset case). */
const ZERO_RATES: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Per-model caption cost rates from a resolved `[models.*]` block (spec MODEL-FALLBACK §2.3). */
function costRatesOf(config: ModelChainEntry["config"]): CostRates {
  return config.cost
    ? {
        input: config.cost.input,
        output: config.cost.output,
        cacheRead: config.cost.cache_read,
        cacheWrite: config.cost.cache_write,
      }
    : ZERO_RATES;
}

/** Build the caption wire-call descriptor from a resolved chain member. */
function toCaptionModelConfig(config: ModelChainEntry["config"]): CaptionModelConfig {
  return { id: config.id, endpoint: config.endpoint, api_key: config.api_key, provider: config.provider ?? null };
}

export interface InferenceClientOptions {
  modality: MediaModality;
  /**
   * Resolved caption model chain (spec MODEL-FALLBACK §2.3/§6): the referenced
   * `[models.*]` head plus its `fallback` members. The caption call runs through
   * `runFetchWithFallback` over the chain — connection, pricing, rate-limit group,
   * and per-model probe cap all live on each member's block (no separate
   * `model`/`costRates`/`rateLimitGroup` options any more). This is the headline
   * §2.2 case: cap an expensive caption model and fall to a cheap one transparently.
   */
  chain: ModelChainEntry[];
  prompt: string;
  maxChars: number;
  maxTokens: number;
  /**
   * LLM request scheduler (spec §5.4): when set, every caption inference attempt
   * acquires a slot in its member's rate-limit group (at `background` priority —
   * captioning sits on its own budget and needs no per-workload split, §9.4)
   * around the network call only, not the local media processing.
   */
  scheduler?: LlmScheduler;
  /** Budget availability by logical id (spec §3/§7) — skips an over-cap member. */
  isModelAvailable?: (logicalId: string) => boolean;
  imageProcessing?: ImageProcessingOptions;
  videoProcessing?: VideoProcessingOptions;
  audioProcessing?: AudioProcessingOptions;
  timeoutMs?: number;
}

export interface CaptionRequest {
  filePath: string;
  mimeType: string;
  filename: string;
  prompt?: string;
  startTime?: number;
  context?: "tool" | "pipeline";
}

export interface CaptionResponse {
  caption: string;
  /** Upstream wire model id of the member actually billed. */
  model: string;
  /** Logical id (config block name) of the billed member — for the ledger (spec MODEL-FALLBACK §2.2). */
  logicalModelId: string;
  /** pi-ai provider label for this caption call (from config), or null when unset. */
  provider: string | null;
  /** Provider-reported token usage (spec §6.1), or null when the gateway omits it. */
  usage: RawTokenUsage | null;
  /**
   * USD cost for this call (`computeUsageCost(...).total`), or null when usage is
   * unknown. May be 0 when usage is known but no cost rates are configured.
   */
  cost: number | null;
}

/**
 * Per-modality caption inference client. It does NOT cap concurrency: in-flight
 * caption calls are governed by the LLM scheduler's rate-limit-group admission
 * (`max_in_flight`, spec §9.4). The old per-modality `concurrency` knob (a
 * deprecated transitional alias) was removed — review issue #29.
 */
export class InferenceClient {
  private stopped = false;
  /**
   * Shutdown abort seam (#6). `stop()` aborts this; its signal is passed to the
   * scheduler `acquire` below so a queued caption waiter is rejected promptly at
   * shutdown instead of lingering until the next half-open probe window. Without
   * it, `captionPool.stop()` (which awaits in-flight workers) could stall for
   * up to one capped-backoff probe window during a caption-model outage, because only the
   * later `llmScheduler.stop()` would otherwise reject the queued waiter.
   */
  private readonly stopController = new AbortController();

  constructor(private readonly options: InferenceClientOptions) {}

  get modality(): MediaModality {
    return this.options.modality;
  }

  stop(): void {
    this.stopped = true;
    this.stopController.abort();
  }

  async caption(request: CaptionRequest): Promise<CaptionResponse> {
    if (this.stopped) throw new Error("InferenceClient is stopped");

    let processed: ProcessedMedia | undefined;
    let data: Buffer;
    let mimeType = request.mimeType;

    if (this.options.modality === "image" && this.options.imageProcessing) {
      processed = await processImageForInference(request.filePath, this.options.imageProcessing);
      try {
        data = await readFile(processed.path);
        mimeType = processed.mimeType;
      } finally {
        await cleanupProcessedImage(processed);
      }
    } else if (this.options.modality === "video" && this.options.videoProcessing) {
      const videoOpts = { ...this.options.videoProcessing };
      if (request.startTime != null) videoOpts.startTime = request.startTime;
      processed = await processVideoForInference(request.filePath, videoOpts);
      try {
        data = await readFile(processed.path);
        mimeType = processed.mimeType;
      } finally {
        await unlink(processed.path).catch(() => {});
      }
    } else if (this.options.modality === "audio" && this.options.audioProcessing) {
      const audioOpts = { ...this.options.audioProcessing };
      if (request.startTime != null) audioOpts.startTime = request.startTime;
      processed = await processAudioForInference(request.filePath, audioOpts);
      try {
        data = await readFile(processed.path);
        mimeType = processed.mimeType;
      } finally {
        await unlink(processed.path).catch(() => {});
      }
    } else {
      data = await readFile(request.filePath);
    }

    // Transparent caption-model fallback (spec MODEL-FALLBACK §6) over the chain:
    // `runFetchWithFallback` owns per-attempt member selection, scheduler
    // admission (`background` priority, per-member group/health key — the same
    // (endpoint, model id) failure domain agent sessions use), both-axes
    // `noteOutcome` feeding, and the canary. Media processing above runs
    // unscheduled. The shutdown stop signal aborts admission + the in-flight
    // fetch; a stop-abort surfaces as an AbortError that runFetchWithFallback
    // treats as a NEUTRAL teardown (never a health-streak hit), so the pool's
    // stop() never stalls for a probe window during a caption-model outage.
    let billed: FetchChainMember | undefined;
    const result = await runFetchWithFallback(
      this.options.chain,
      {
        consumer: `caption:${this.options.modality}`,
        priority: "background",
        scheduler: this.options.scheduler,
        isModelAvailable: this.options.isModelAvailable,
        probeBackoffMaxMs: (cfg) => cfg.llm_probe_backoff_max_ms,
        signal: this.stopController.signal,
      },
      async (member) => {
        billed = member;
        try {
          const r = await describeMedia({
            modality: this.options.modality,
            data,
            mimeType,
            prompt: request.prompt ?? this.options.prompt,
            model: toCaptionModelConfig(member.config),
            maxChars: this.options.maxChars,
            maxTokens: this.options.maxTokens,
            timeoutMs: this.options.timeoutMs,
            signal: this.stopController.signal,
          });
          return { ok: true as const, value: r };
        } catch (err) {
          // A stop-signal abort is a neutral teardown — let it propagate so the
          // helper classifies it `aborted` (never a streak hit). Other failures
          // map to content (deterministic 4xx) / environmental (fall over).
          if (this.stopController.signal.aborted) throw err;
          const message = err instanceof Error ? err.message : String(err);
          const status = extractStatus(message.toLowerCase());
          const kind = status === 400 || status === 413 || status === 422 ? "content" : "environmental";
          return { ok: false as const, kind, status, error: err };
        }
      },
    );

    let caption = result.text;
    if (processed?.truncated && processed.processedRange && processed.totalDuration) {
      caption = formatTruncationWarning(caption, processed, request.context ?? "pipeline");
    }

    // Auxiliary cost (spec §5/§11): priced from the BILLED member's [models.*]
    // cost (spec MODEL-FALLBACK §2.3) when the provider reported usage. Cost is 0
    // (not null) when usage is known but the model has no cost block ("untracked").
    const usage = result.usage;
    const cost = usage ? computeUsageCost(billed ? costRatesOf(billed.config) : ZERO_RATES, usage).total : null;

    return {
      caption,
      model: result.model,
      logicalModelId: billed?.logicalId ?? result.model,
      provider: billed?.config.provider ?? null,
      usage,
      cost,
    };
  }
}

function formatTruncationWarning(caption: string, processed: ProcessedMedia, context: "tool" | "pipeline"): string {
  const [start, end] = processed.processedRange!;
  const total = processed.totalDuration!;
  const startFmt = formatTimestamp(start);
  const endFmt = formatTimestamp(end);
  const totalFmt = formatTimestamp(total);

  if (context === "tool") {
    return `Warning: media duration is ${totalFmt}. Only ${startFmt}-${endFmt} was processed (duration limit). Use start_time to analyze a different segment.\n\n${caption}`;
  }
  return `${caption}\n[processed ${startFmt}-${endFmt} of ${totalFmt} total; duration limit]`;
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
