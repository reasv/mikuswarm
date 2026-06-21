import { readFile, unlink } from "node:fs/promises";
import { describeMedia, type CaptionModelConfig, type MediaModality } from "./describe.js";
import { modelHealthKey, type LlmScheduler } from "../agent/scheduler.js";
import { classifyLlmError, extractStatus } from "../agent/request-retry.js";
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

export interface InferenceClientOptions {
  modality: MediaModality;
  model: CaptionModelConfig;
  prompt: string;
  maxChars: number;
  maxTokens: number;
  /**
   * LLM request scheduler (spec §5.4): when set, every caption inference call
   * acquires a slot in `rateLimitGroup` (at `background` priority — captioning
   * sits on its own budget and needs no per-workload split, §9.4) around the
   * network call only, not the local media processing.
   */
  scheduler?: LlmScheduler;
  /** Rate-limit group for caption inference. Unset = `default`. */
  rateLimitGroup?: string;
  /**
   * USD/1M-token cost rates for this modality's caption model (spec
   * AUXILIARY-USAGE-TRACKING §5/§7.1), resolved modality → top-level → unset.
   * When unset (or all-zero), token usage is still captured but cost is 0
   * ("untracked"). Auxiliary spend is a separate lane — never folded into the
   * §8b session counters (spec §4).
   */
  costRates?: CostRates;
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
  model: string;
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

    // Scheduler admission (spec §5.4) wraps the network call only — media
    // processing above runs unscheduled. Outcomes feed BOTH scheduler axes
    // (spec LLM-FAILURE-HANDLING §5): the group's unconditional 429/503
    // throttle backoff and the caption model's health streak — the health key
    // derives from (endpoint, model id), the same failure domain agent
    // sessions use, so a broken caption model trips half-open probing here
    // too while this client's own pool-level retries stay in charge of the
    // job lifecycle.
    const group = this.options.rateLimitGroup ?? "default";
    const healthKey = modelHealthKey({ baseUrl: this.options.model.endpoint, id: this.options.model.id });
    const release = this.options.scheduler
      ? await this.options.scheduler.acquire({
          group,
          priority: "background",
          modelKey: healthKey,
          // Shutdown abort seam (#6): a queued waiter is rejected the moment
          // `stop()` fires (an `AbortError` from `acquire`, propagated out of
          // `caption()` without touching `noteOutcome` — shutdown is neutral),
          // so `captionPool.stop()` never stalls waiting for the next probe
          // window during a caption-model outage.
          signal: this.stopController.signal,
        })
      : undefined;
    let result;
    try {
      result = await describeMedia({
        modality: this.options.modality,
        data,
        mimeType,
        prompt: request.prompt ?? this.options.prompt,
        model: this.options.model,
        maxChars: this.options.maxChars,
        maxTokens: this.options.maxTokens,
        timeoutMs: this.options.timeoutMs,
        // Shutdown abort seam (#6): aborts an in-flight caption fetch at stop.
        signal: this.stopController.signal,
      });
      this.options.scheduler?.noteOutcome(group, healthKey, undefined);
    } catch (err) {
      // A fetch aborted by the shutdown stop signal (#6) is a NEUTRAL shutdown
      // event, not an environmental health-streak hit — do not feed noteOutcome
      // for it (mirrors the remote-embedding stop-abort exclusion). All other
      // failures still feed the model-health streak.
      if (!this.stopController.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err);
        this.options.scheduler?.noteOutcome(
          group,
          healthKey,
          classifyLlmError(message, undefined),
          extractStatus(message.toLowerCase()),
        );
      }
      throw err;
    } finally {
      release?.();
    }

    let caption = result.text;
    if (processed?.truncated && processed.processedRange && processed.totalDuration) {
      caption = formatTruncationWarning(caption, processed, request.context ?? "pipeline");
    }

    // Auxiliary cost (spec §5/§11): compute from config rates when the provider
    // reported usage. Cost is 0 (not null) when usage is known but no rates are
    // configured — tokens are still recorded; only the price is "untracked".
    const usage = result.usage;
    const cost = usage ? computeUsageCost(this.options.costRates ?? ZERO_RATES, usage).total : null;

    return { caption, model: result.model, provider: this.options.model.provider ?? null, usage, cost };
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
