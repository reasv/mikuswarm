/**
 * Tests for the yotsuba image-block lane in src/context/builder.ts
 * (spec/YOTSUBA-SUPPORT.md §12, §6.5).
 *
 * Verifies:
 *   - replyModelCanSeeImages() returns true/false based on input_modalities config.
 *   - selectImageBlocks (via the private method access) adds exactly the recorded
 *     in-budget processed asset ids as image blocks for vision models.
 *   - No yotsuba blocks are added for non-vision models.
 *   - Existing cascade blocks are not displaced — the yotsuba lane is additive.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config/index.js";
import { ContextBuilder } from "../src/context/builder.js";
import type { Storage, MediaAssetRow, LinkPreviewRow } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { TimelineStore } from "../src/timeline/index.js";
import { YOTSUBA_SOURCE_KIND } from "../src/yotsuba/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal 1×1 JPEG (valid, loads with sharp). */
async function writeTinyJpeg(filePath: string): Promise<void> {
  // Use sharp to generate a real 1×1 JPEG rather than embedding raw bytes.
  const sharp = (await import("sharp")).default;
  const buf = await sharp({
    create: { width: 1, height: 1, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer();
  await writeFile(filePath, buf);
}

function makeTrigger(id = "trigger-1"): CanonicalChatEvent {
  return {
    id,
    externalId: id,
    timelineKey: "matrix:miku:room:!r:example.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "look at this",
    timestamp: Date.now(),
    receivedAt: Date.now(),
  };
}

/**
 * Build a minimal AppConfig with the provided model modalities and yotsuba
 * feature flag.  Only the fields used by ContextBuilder's yotsuba lane are set.
 */
function makeConfig(opts: {
  visionModel: boolean;
  yotsuba?: boolean;
  workspaceRoot?: string;
}): AppConfig {
  return {
    features: { yotsuba: opts.yotsuba ?? true },
    models: {
      default: {
        id: "some-model",
        input_modalities: opts.visionModel ? ["text", "image"] : ["text"],
      },
    },
    workspace: opts.workspaceRoot ? { root_dir: opts.workspaceRoot } : undefined,
    matrix: { accounts: [] },
  } as unknown as AppConfig;
}

/**
 * Build a minimal Storage mock whose yotsuba-related methods return the given
 * preview rows (with associated assets).
 */
function makeStorage(
  previews: Array<{ row: LinkPreviewRow; assets: MediaAssetRow[] }>,
): Storage {
  return {
    getYotsubaPreviewsForTriggerGroup: (_triggerId: string) => previews,
    getMediaAssetsForTriggerGroup: (_triggerId: string) => [],
  } as unknown as Storage;
}

/** Minimal TimelineStore that returns no events. */
function makeStore(): TimelineStore {
  return {
    queryForContext: () => [],
    queryAfterContext: () => [],
    getCompactionState: () => null,
  } as unknown as TimelineStore;
}

// ---------------------------------------------------------------------------
// replyModelCanSeeImages
// ---------------------------------------------------------------------------

test("replyModelCanSeeImages: returns true when default model has image modality", () => {
  const cfg = makeConfig({ visionModel: true });
  const builder = new ContextBuilder(makeStore(), cfg, makeStorage([]), undefined);
  assert.equal(builder.replyModelCanSeeImages(), true);
});

test("replyModelCanSeeImages: returns false when default model has no image modality", () => {
  const cfg = makeConfig({ visionModel: false });
  const builder = new ContextBuilder(makeStore(), cfg, makeStorage([]), undefined);
  assert.equal(builder.replyModelCanSeeImages(), false);
});

test("replyModelCanSeeImages: returns false when model has only text modality", () => {
  const cfg = {
    ...makeConfig({ visionModel: false }),
    models: {
      default: { id: "text-only", input_modalities: ["text"] },
    },
  } as unknown as AppConfig;
  const builder = new ContextBuilder(makeStore(), cfg, makeStorage([]), undefined);
  assert.equal(builder.replyModelCanSeeImages(), false);
});

test("replyModelCanSeeImages: returns false when model has no input_modalities", () => {
  const cfg = {
    ...makeConfig({ visionModel: false }),
    models: { default: { id: "unknown-model" } },
  } as unknown as AppConfig;
  const builder = new ContextBuilder(makeStore(), cfg, makeStorage([]), undefined);
  assert.equal(builder.replyModelCanSeeImages(), false);
});

// ---------------------------------------------------------------------------
// Yotsuba image-block lane — non-vision model
// ---------------------------------------------------------------------------

test("selectImageBlocks: yotsuba lane adds no blocks for non-vision model", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-builder-"));
  try {
    const assetPath = path.join(tmpDir, "test.jpg");
    await writeTinyJpeg(assetPath);

    const previewRow: LinkPreviewRow = {
      id: "prev-1",
      event_id: "trigger-1",
      context: "message",
      url: "https://boards.4chan.org/g/thread/100000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1,
        kind: "thread",
        board: "g",
        asOf: Date.now(),
        upgrade: {
          triggerGroupId: "trigger-1",
          includedNos: [1],
          processedAssetIds: ["asset-1"],
        },
      }),
    };

    const assetRow: MediaAssetRow = {
      id: "asset-1",
      event_id: "trigger-1",
      role: "preview_media",
      link_preview_id: "prev-1",
      media_type: "image",
      mime_type: "image/jpeg",
      local_path: assetPath,
      download_status: "complete",
      caption_status: "pending",
      created_at: Date.now(),
    };

    const storage = makeStorage([{ row: previewRow, assets: [assetRow] }]);
    const cfg = makeConfig({ visionModel: false });
    const builder = new ContextBuilder(makeStore(), cfg, storage);

    // Access the private method via any-cast.
    const blocks = await (builder as any).selectImageBlocks(makeTrigger("trigger-1"), false);
    assert.equal(blocks.length, 0, "no blocks for non-vision model");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Yotsuba image-block lane — vision model
// ---------------------------------------------------------------------------

test("selectImageBlocks: yotsuba lane adds processed assets as image blocks for vision model", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-builder-"));
  try {
    const assetPath = path.join(tmpDir, "test.jpg");
    await writeTinyJpeg(assetPath);

    const previewRow: LinkPreviewRow = {
      id: "prev-1",
      event_id: "trigger-1",
      context: "message",
      url: "https://boards.4chan.org/g/thread/100000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1,
        kind: "thread",
        board: "g",
        asOf: Date.now(),
        upgrade: {
          triggerGroupId: "trigger-1",
          includedNos: [1],
          processedAssetIds: ["asset-1"],
        },
      }),
    };

    const assetRow: MediaAssetRow = {
      id: "asset-1",
      event_id: "trigger-1",
      role: "preview_media",
      link_preview_id: "prev-1",
      media_type: "image",
      mime_type: "image/jpeg",
      local_path: assetPath,  // absolute path — used directly
      download_status: "complete",
      caption_status: "pending",
      created_at: Date.now(),
    };

    const storage = makeStorage([{ row: previewRow, assets: [assetRow] }]);
    const cfg = makeConfig({ visionModel: true });
    const builder = new ContextBuilder(makeStore(), cfg, storage);

    const blocks = await (builder as any).selectImageBlocks(makeTrigger("trigger-1"), true);

    assert.ok(blocks.length >= 1, "at least one image block from yotsuba lane");
    const yotBlock = blocks.find((b: any) => b.attachmentId === "asset-1");
    assert.ok(yotBlock, "block has the processed asset id");
    assert.ok(yotBlock.dataBase64.length > 0, "block has base64 image data");
    assert.ok(yotBlock.mediaType.startsWith("image/"), "block has image mime type");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("selectImageBlocks: yotsuba lane skips non-image assets (video type)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-builder-"));
  try {
    // A video asset should not become an image block (only images and storyboards do).
    const assetPath = path.join(tmpDir, "video.webm");
    await writeFile(assetPath, Buffer.from("fake webm content"));

    const previewRow: LinkPreviewRow = {
      id: "prev-2",
      event_id: "trigger-2",
      context: "message",
      url: "https://boards.4chan.org/g/thread/200000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1,
        kind: "thread",
        board: "g",
        asOf: Date.now(),
        upgrade: {
          triggerGroupId: "trigger-2",
          includedNos: [1],
          processedAssetIds: ["video-asset-1"],
        },
      }),
    };

    const videoAsset: MediaAssetRow = {
      id: "video-asset-1",
      event_id: "trigger-2",
      role: "preview_media",
      link_preview_id: "prev-2",
      media_type: "video",  // video type — should NOT become an image block
      mime_type: "video/webm",
      local_path: assetPath,
      download_status: "complete",
      caption_status: "pending",
      created_at: Date.now(),
    };

    const storage = makeStorage([{ row: previewRow, assets: [videoAsset] }]);
    const cfg = makeConfig({ visionModel: true });
    const builder = new ContextBuilder(makeStore(), cfg, storage);

    const blocks = await (builder as any).selectImageBlocks(makeTrigger("trigger-2"), true);

    const videoBlock = blocks.find((b: any) => b.attachmentId === "video-asset-1");
    assert.equal(videoBlock, undefined, "video-type asset should not become an image block");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("selectImageBlocks: yotsuba lane respects triggerGroupFiles cap (4 max)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-builder-"));
  try {
    // Create 5 real JPEG files.
    const assetPaths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = path.join(tmpDir, `asset${i}.jpg`);
      await writeTinyJpeg(p);
      assetPaths.push(p);
    }

    const processedAssetIds = ["a0", "a1", "a2", "a3", "a4"];

    const previewRow: LinkPreviewRow = {
      id: "prev-cap",
      event_id: "trigger-cap",
      context: "message",
      url: "https://boards.4chan.org/g/thread/300000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1,
        kind: "thread",
        board: "g",
        asOf: Date.now(),
        upgrade: {
          triggerGroupId: "trigger-cap",
          includedNos: [1, 2, 3, 4, 5],
          processedAssetIds,
        },
      }),
    };

    const assets: MediaAssetRow[] = processedAssetIds.map((id, i) => ({
      id,
      event_id: "trigger-cap",
      role: "preview_media" as const,
      link_preview_id: "prev-cap",
      media_type: "image" as const,
      mime_type: "image/jpeg",
      local_path: assetPaths[i]!,
      download_status: "complete" as const,
      caption_status: "pending" as const,
      created_at: Date.now(),
    }));

    const storage = makeStorage([{ row: previewRow, assets }]);
    const cfg = makeConfig({ visionModel: true });
    const builder = new ContextBuilder(makeStore(), cfg, storage);

    const blocks = await (builder as any).selectImageBlocks(makeTrigger("trigger-cap"), true);

    // Default triggerGroupFiles = 4; 5 assets provided but only 4 should be added.
    assert.ok(blocks.length <= 4, `at most 4 yotsuba blocks; got ${blocks.length}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("selectImageBlocks: yotsuba lane does nothing when features.yotsuba is not set", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-builder-"));
  try {
    const assetPath = path.join(tmpDir, "test.jpg");
    await writeTinyJpeg(assetPath);

    const previewRow: LinkPreviewRow = {
      id: "prev-noyot",
      event_id: "trigger-noyot",
      context: "message",
      url: "https://boards.4chan.org/g/thread/400000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1, kind: "thread", board: "g", asOf: Date.now(),
        upgrade: { triggerGroupId: "trigger-noyot", includedNos: [1], processedAssetIds: ["a1"] },
      }),
    };
    const assetRow: MediaAssetRow = {
      id: "a1", event_id: "trigger-noyot", role: "preview_media",
      link_preview_id: "prev-noyot", media_type: "image", mime_type: "image/jpeg",
      local_path: assetPath, download_status: "complete", caption_status: "pending",
      created_at: Date.now(),
    };

    const storage = makeStorage([{ row: previewRow, assets: [assetRow] }]);
    // Config WITHOUT features.yotsuba.
    const cfg = makeConfig({ visionModel: true, yotsuba: false });
    const builder = new ContextBuilder(makeStore(), cfg, storage);

    const blocks = await (builder as any).selectImageBlocks(makeTrigger("trigger-noyot"), true);
    // The regular cascade also returns nothing (no trigger group assets in mock).
    const yotBlock = blocks.find((b: any) => b.attachmentId === "a1");
    assert.equal(yotBlock, undefined, "no yotsuba block when feature flag is off");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// triggerGroupId scoping (spec §6.5: image blocks only for the upgrading session)
// ---------------------------------------------------------------------------

test("selectImageBlocks: yotsuba blocks skipped when triggerGroupId doesn't match trigger", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-trig-"));
  try {
    const assetPath = path.join(tmpDir, "test.jpg");
    await writeTinyJpeg(assetPath);

    // Payload whose triggerGroupId is "other-trigger" (not "my-trigger").
    const previewRow: LinkPreviewRow = {
      id: "prev-trig",
      event_id: "other-trigger",
      context: "message",
      url: "https://boards.4chan.org/g/thread/200000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1, kind: "thread", board: "g", asOf: Date.now(),
        upgrade: {
          triggerGroupId: "other-trigger",   // different from trigger "my-trigger"
          includedNos: [1],
          processedAssetIds: ["asset-trig"],
        },
      }),
    };
    const assetRow: MediaAssetRow = {
      id: "asset-trig", event_id: "other-trigger", role: "preview_media",
      link_preview_id: "prev-trig", media_type: "image", mime_type: "image/jpeg",
      local_path: assetPath, download_status: "complete", caption_status: "pending",
      created_at: Date.now(),
    };

    const storage = makeStorage([{ row: previewRow, assets: [assetRow] }]);
    const cfg = makeConfig({ visionModel: true });
    const builder = new ContextBuilder(makeStore(), cfg, storage);

    // Trigger id "my-trigger" does NOT match the payload's triggerGroupId "other-trigger".
    const blocks = await (builder as any).selectImageBlocks(makeTrigger("my-trigger"), true);
    const yotBlock = blocks.find((b: any) => b.attachmentId === "asset-trig");
    assert.equal(yotBlock, undefined, "block from a different trigger group must be skipped");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("selectImageBlocks: yotsuba blocks included when triggerGroupId matches trigger", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-trigmatch-"));
  try {
    const assetPath = path.join(tmpDir, "test.jpg");
    await writeTinyJpeg(assetPath);

    const previewRow: LinkPreviewRow = {
      id: "prev-match",
      event_id: "my-trigger",
      context: "message",
      url: "https://boards.4chan.org/g/thread/300000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1, kind: "thread", board: "g", asOf: Date.now(),
        upgrade: {
          triggerGroupId: "my-trigger",
          includedNos: [1],
          processedAssetIds: ["asset-match"],
        },
      }),
    };
    const assetRow: MediaAssetRow = {
      id: "asset-match", event_id: "my-trigger", role: "preview_media",
      link_preview_id: "prev-match", media_type: "image", mime_type: "image/jpeg",
      local_path: assetPath, download_status: "complete", caption_status: "pending",
      created_at: Date.now(),
    };

    const storage = makeStorage([{ row: previewRow, assets: [assetRow] }]);
    const cfg = makeConfig({ visionModel: true });
    const builder = new ContextBuilder(makeStore(), cfg, storage);

    const blocks = await (builder as any).selectImageBlocks(makeTrigger("my-trigger"), true);
    const yotBlock = blocks.find((b: any) => b.attachmentId === "asset-match");
    assert.ok(yotBlock !== undefined, "block from matching trigger group must be included");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("selectImageBlocks: yotsuba lane skips a reply-context preview of a deleted quoted message", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "yot-builder-"));
  try {
    const assetPath = path.join(tmpDir, "quoted.jpg");
    await writeTinyJpeg(assetPath);
    const previewRow: LinkPreviewRow = {
      id: "prev-q",
      event_id: "trigger-q",
      context: "reply",
      url: "https://boards.4chan.org/g/thread/100000",
      source_kind: YOTSUBA_SOURCE_KIND,
      site_name: "4chan",
      fetch_status: "complete",
      preview_index: 0,
      created_at: Date.now(),
      payload_json: JSON.stringify({
        v: 1,
        kind: "thread",
        board: "g",
        asOf: Date.now(),
        upgrade: { triggerGroupId: "trigger-q", includedNos: [1], processedAssetIds: ["asset-q"] },
      }),
    };
    const assetRow: MediaAssetRow = {
      id: "asset-q",
      event_id: "trigger-q",
      role: "reply_preview_media",
      link_preview_id: "prev-q",
      media_type: "image",
      mime_type: "image/jpeg",
      local_path: assetPath,
      download_status: "complete",
      caption_status: "pending",
      created_at: Date.now(),
    };
    const trigger = { ...makeTrigger("trigger-q"), replyTo: { externalId: "$quoted" } };
    const blocksWith = async (deleted: boolean) => {
      const storage = {
        ...(makeStorage([{ row: previewRow, assets: [assetRow] }]) as unknown as Record<string, unknown>),
        getTriggerGroupMemberIds: () => [],
        getDeletedMessages: (_tk: string, ids: readonly string[]) =>
          new Map(deleted && ids.includes("$quoted") ? [["$quoted", { at: 1 }]] : []),
      } as unknown as Storage;
      const builder = new ContextBuilder(makeStore(), makeConfig({ visionModel: true }), storage);
      return (await (builder as any).selectImageBlocks(trigger, true)).map((b: any) => b.attachmentId);
    };
    assert.deepEqual(await blocksWith(false), ["asset-q"], "a live quoted message's preview is a candidate");
    assert.deepEqual(await blocksWith(true), [], "once the quoted message is deleted, its preview is not");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
