import { readFile, unlink } from "node:fs/promises";
import { describeMedia, type CaptionModelConfig, type MediaModality } from "./describe.js";
import { modelHealthKey, type LlmScheduler } from "../agent/scheduler.js";
import { classifyLlmError, extractStatus } from "../agent/request-retry.js";
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
   * N×`llm_probe_interval_ms` during a caption-model outage, because only the
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

    return { caption, model: result.model };
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
