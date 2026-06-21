import path from "node:path";
import type { MediaAssetRow, Storage } from "../storage/index.js";
import type { InferenceClient } from "./inference-client.js";
import type { MediaModality } from "./describe.js";
import { isAnimatedImage, convertAnimatedToVideo, extractFirstFrame } from "./animated.js";
import type { RawTokenUsage } from "../agent/usage.js";

export interface CaptionWorkerOptions {
  storage: Storage;
  clients: Map<MediaModality, InferenceClient>;
  workspaceRoot: string;
  /**
   * Unified-ledger sink (spec USAGE-COST-LIMITS §3.1): emits one class='caption'
   * `usage_events` row per completed caption, alongside the atomic
   * `media_assets.caption_*` write. Detached enrichment — no session attribution.
   * Optional so tests construct a bare worker.
   */
  recordUsage?: (
    result: { model: string; logicalModelId: string; provider: string | null; usage: RawTokenUsage | null; cost: number | null },
    asset: MediaAssetRow,
  ) => void;
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

  /**
   * Persist the caption result atomically to `media_assets.caption_*` and emit
   * the unified-ledger row (spec USAGE-COST-LIMITS §3.1). Single funnel for all
   * three caption paths so the ledger write can never be forgotten on one.
   */
  private async persist(
    asset: MediaAssetRow,
    result: { caption: string; model: string; logicalModelId: string; provider: string | null; usage: RawTokenUsage | null; cost: number | null },
  ): Promise<void> {
    await this.options.storage.updateCaptionResult(asset.id, result.caption, result.model, result.usage, result.cost);
    this.options.recordUsage?.(result, asset);
  }

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

    const result = await client.caption({
      filePath: absolutePath,
      mimeType: asset.mime_type ?? mimeTypeDefault(modality),
      filename: asset.original_filename ?? path.basename(asset.local_path!),
      context: "pipeline",
    });

    await this.persist(asset, result);
    return asset.event_id;
  }

  private async processAnimatedImage(asset: MediaAssetRow, absolutePath: string): Promise<string> {
    const videoClient = this.options.clients.get("video");
    if (videoClient) {
      const converted = await convertAnimatedToVideo(absolutePath);
      if (converted) {
        try {
          const result = await videoClient.caption({
            filePath: converted.path,
            mimeType: converted.mimeType,
            filename: asset.original_filename ?? path.basename(asset.local_path!),
            context: "pipeline",
          });
          await this.persist(asset, result);
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
    const { writeFile, unlink } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { randomBytes } = await import("node:crypto");
    const tmpPath = path.join(tmpdir(), `miku-frame-${randomBytes(8).toString("hex")}.jpg`);
    await writeFile(tmpPath, firstFrame);

    try {
      const result = await imageClient.caption({
        filePath: tmpPath,
        mimeType: "image/jpeg",
        filename: asset.original_filename ?? path.basename(asset.local_path!),
        context: "pipeline",
      });
      await this.persist(asset, result);
      return asset.event_id;
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }
}
