import { describeMedia, type CaptionModelConfig, type MediaModality } from "./describe.js";
import type { ResizeBufferOptions } from "./image-resize.js";

export interface InferenceClientOptions {
  modality: MediaModality;
  model: CaptionModelConfig;
  prompt: string;
  maxChars: number;
  maxConcurrency?: number;
  resize?: ResizeBufferOptions;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface CaptionRequest {
  data: Buffer;
  mimeType: string;
  filename: string;
  prompt?: string;
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

  async caption(request: CaptionRequest): Promise<CaptionResponse> {
    if (this.stopped) throw new Error("InferenceClient is stopped");

    if (this.options.maxBytes && request.data.byteLength > this.options.maxBytes) {
      throw new Error(
        `Media too large: ${request.data.byteLength} bytes exceeds ${this.options.maxBytes} limit`,
      );
    }

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
      const result = await describeMedia({
        modality: this.options.modality,
        data: request.data,
        mimeType: request.mimeType,
        prompt: request.prompt ?? this.options.prompt,
        model: this.options.model,
        maxChars: this.options.maxChars,
        resize: this.options.resize,
        timeoutMs: this.options.timeoutMs,
      });
      return { caption: result.text, model: result.model };
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
