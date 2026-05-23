export interface InferenceClientOptions {
  maxConcurrency: number;
  // TODO: wire to actual captioning model config when ready
  captionModel?: { id: string; endpoint: string; api_key: string };
}

export interface CaptionRequest {
  imageData: Buffer;
  mediaType: string;
  filename: string;
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
      // TODO: replace with actual model inference call
      // For now, generate metadata-based caption as placeholder
      return {
        caption: `Image file ${request.filename}; ${request.mediaType}, ${request.imageData.byteLength} bytes.`,
        model: "placeholder",
      };
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
