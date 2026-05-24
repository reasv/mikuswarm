import { describeImage, type CaptionModelConfig } from "./describe.js";
import type { ResizeBufferOptions } from "./image-resize.js";

export interface InferenceClientOptions {
  maxConcurrency: number;
  model: CaptionModelConfig;
  prompt: string;
  resize: ResizeBufferOptions;
}

export interface CaptionRequest {
  imageData: Buffer;
  mediaType: string;
  filename: string;
  /** Override the default prompt for this request (used by the image tool). */
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

  async caption(request: CaptionRequest): Promise<CaptionResponse> {
    if (this.stopped) throw new Error("InferenceClient is stopped");
    if (this.active < this.options.maxConcurrency) {
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
      const result = await describeImage({
        imageData: request.imageData,
        prompt: request.prompt ?? this.options.prompt,
        model: this.options.model,
        resize: this.options.resize,
      });
      return { caption: result.text, model: result.model };
    } finally {
      this.active--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    while (this.queue.length > 0 && this.active < this.options.maxConcurrency) {
      const item = this.queue.shift()!;
      this.doCaption(item.request).then(item.resolve, item.reject);
    }
  }
}
