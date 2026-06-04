import { readFile, unlink } from "node:fs/promises";
import { describeMedia, type CaptionModelConfig, type MediaModality } from "./describe.js";
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
  maxConcurrency?: number;
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

export class ConcurrencyLimitedInferenceClient {
  private active = 0;
  private readonly queue: Array<{
    resolve: (value: CaptionResponse) => void;
    reject: (reason: unknown) => void;
    request: CaptionRequest;
  }> = [];
  private stopped = false;

  constructor(private readonly options: InferenceClientOptions) {}

  get modality(): MediaModality {
    return this.options.modality;
  }

  /** Configured concurrency cap for this modality, or undefined when unbounded. */
  get maxConcurrency(): number | undefined {
    return this.options.maxConcurrency;
  }

  async caption(request: CaptionRequest): Promise<CaptionResponse> {
    if (this.stopped) throw new Error("InferenceClient is stopped");

    const limit = this.options.maxConcurrency;
    if (limit == null || this.active < limit) {
      return this.doCaption(request);
    }
    return new Promise<CaptionResponse>((resolve, reject) => {
      this.queue.push({ resolve, reject, request });
    });
  }

  stop(): void {
    this.stopped = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      item.reject(new Error("InferenceClient stopped"));
    }
  }

  private async doCaption(request: CaptionRequest): Promise<CaptionResponse> {
    this.active++;
    try {
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

      const result = await describeMedia({
        modality: this.options.modality,
        data,
        mimeType,
        prompt: request.prompt ?? this.options.prompt,
        model: this.options.model,
        maxChars: this.options.maxChars,
        maxTokens: this.options.maxTokens,
        timeoutMs: this.options.timeoutMs,
      });

      let caption = result.text;
      if (processed?.truncated && processed.processedRange && processed.totalDuration) {
        caption = formatTruncationWarning(caption, processed, request.context ?? "pipeline");
      }

      return { caption, model: result.model };
    } finally {
      this.active--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    const limit = this.options.maxConcurrency;
    while (this.queue.length > 0 && (limit == null || this.active < limit)) {
      const item = this.queue.shift()!;
      this.doCaption(item.request).then(item.resolve, item.reject);
    }
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
