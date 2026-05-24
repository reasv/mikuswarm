import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MediaAssetRow, Storage } from "../storage/index.js";
import type { ConcurrencyLimitedInferenceClient } from "./inference-client.js";

export interface CaptionWorkerOptions {
  storage: Storage;
  inferenceClient: ConcurrencyLimitedInferenceClient;
  workspaceRoot: string;
}

export class CaptionWorker {
  constructor(private readonly options: CaptionWorkerOptions) {}

  async process(asset: MediaAssetRow): Promise<string> {
    const absolutePath = path.join(this.options.workspaceRoot, asset.local_path!);
    const imageData = await readFile(absolutePath);

    const result = await this.options.inferenceClient.caption({
      imageData,
      mediaType: asset.media_type ?? "image/jpeg",
      filename: asset.original_filename ?? path.basename(asset.local_path!),
    });

    await this.options.storage.updateCaptionResult(asset.id, result.caption, result.model);
    return asset.event_id;
  }
}
