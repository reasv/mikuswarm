import path from "node:path";
import type { MediaAssetRow, Storage } from "../storage/index.js";
import type { ConcurrencyLimitedInferenceClient } from "./inference-client.js";
import { resizeImageForInference } from "./image-resize.js";

export interface CaptionWorkerOptions {
  storage: Storage;
  inferenceClient: ConcurrencyLimitedInferenceClient;
  workspaceRoot: string;
  imageResize: {
    maxWidth: number;
    maxHeight: number;
    maxBytes: number;
  };
}

export class CaptionWorker {
  constructor(private readonly options: CaptionWorkerOptions) {}

  async process(asset: MediaAssetRow): Promise<string> {
    const absolutePath = path.join(this.options.workspaceRoot, asset.local_path!);

    const resized = await resizeImageForInference({
      inputPath: absolutePath,
      maxWidth: this.options.imageResize.maxWidth,
      maxHeight: this.options.imageResize.maxHeight,
      maxBytes: this.options.imageResize.maxBytes,
    });

    const result = await this.options.inferenceClient.caption({
      imageData: resized.data,
      mediaType: resized.mediaType,
      filename: asset.original_filename ?? path.basename(asset.local_path!),
    });

    await this.options.storage.updateCaptionResult(asset.id, result.caption, result.model);
    return asset.event_id;
  }
}
