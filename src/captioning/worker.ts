import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MediaAssetRow, Storage } from "../storage/index.js";
import type { ConcurrencyLimitedInferenceClient } from "./inference-client.js";
import type { MediaModality } from "./describe.js";
import { isAnimatedImage, convertAnimatedToVideo, extractFirstFrame } from "./animated.js";

export interface CaptionWorkerOptions {
  storage: Storage;
  clients: Map<MediaModality, ConcurrencyLimitedInferenceClient>;
  workspaceRoot: string;
}

function mimeTypeDefault(modality: MediaModality): string {
  switch (modality) {
    case "image": return "image/jpeg";
    case "video": return "video/mp4";
    case "audio": return "audio/mpeg";
  }
}

export class CaptionWorker {
  constructor(private readonly options: CaptionWorkerOptions) {}

  async process(asset: MediaAssetRow): Promise<string> {
    const absolutePath = path.join(this.options.workspaceRoot, asset.local_path!);
    const modality = asset.media_type as MediaModality;

    if (modality === "image" && await isAnimatedImage(absolutePath)) {
      return this.processAnimatedImage(asset, absolutePath);
    }

    const client = this.options.clients.get(modality);
    if (!client) {
      throw new Error(`No inference client configured for modality: ${modality}`);
    }

    const data = await readFile(absolutePath);
    const result = await client.caption({
      data,
      mimeType: asset.mime_type ?? mimeTypeDefault(modality),
      filename: asset.original_filename ?? path.basename(asset.local_path!),
    });

    await this.options.storage.updateCaptionResult(asset.id, result.caption, result.model);
    return asset.event_id;
  }

  private async processAnimatedImage(asset: MediaAssetRow, absolutePath: string): Promise<string> {
    const videoClient = this.options.clients.get("video");
    if (videoClient) {
      const converted = await convertAnimatedToVideo(absolutePath);
      if (converted) {
        try {
          const result = await videoClient.caption({
            data: converted.data,
            mimeType: converted.mimeType,
            filename: asset.original_filename ?? path.basename(asset.local_path!),
          });
          await this.options.storage.updateCaptionResult(asset.id, result.caption, result.model);
          return asset.event_id;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[captioning] Video captioning failed for animated image ${asset.id}, falling back to first-frame: ${msg}`);
        } finally {
          await converted.cleanup();
        }
      }
    }

    const imageClient = this.options.clients.get("image");
    if (!imageClient) {
      throw new Error("No inference client configured for image fallback");
    }

    const firstFrame = await extractFirstFrame(absolutePath);
    const result = await imageClient.caption({
      data: firstFrame,
      mimeType: "image/jpeg",
      filename: asset.original_filename ?? path.basename(asset.local_path!),
    });

    await this.options.storage.updateCaptionResult(asset.id, result.caption, result.model);
    return asset.event_id;
  }
}
