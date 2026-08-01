/**
 * Phase 3 multi-agent support tests (spec MULTI-AGENT-SUPPORT §7.4).
 *
 * Covers:
 *   - saveMediaToWorkspace: agents mode writes to msg-attach/<subdir>/filename
 *   - saveMediaToWorkspace: legacy mode flat layout (msg-attach/filename), byte-identical
 *   - moveFileToWorkspace: agents mode account-scoped subdir
 *   - moveFileToWorkspace: legacy flat layout unchanged
 *   - stored local_path includes the subdir in agents mode
 *   - stored local_path is flat in legacy mode
 *   - EnrichmentWorkerPool: per-event resolver routes to correct agent workspace
 *   - EnrichmentWorkerPool: §4.3 skip on unresolvable account (no file writes, DB ops proceed)
 *   - EnrichmentWorkerPool: legacy mode (no resolver) flat layout, byte-identical
 *   - CaptionWorker.process: workspaceRootOverride resolves pre-existing flat paths
 *   - CaptionWorkerPool: per-asset resolver routes to correct agent workspace
 *   - CaptionWorkerPool: §4.3 unresolvable → asset marked failed without retry
 *
 * Review-finding fixes (spec §3 / §4.3):
 *   - validateAgentConfig: path-unsafe account key → hard error in agents mode, warn-only in legacy
 *   - EnrichmentWorkerPool: defense-in-depth subdir guard skips download (§4.3) when subdir is unsafe
 *   - CaptionWorkerPool: missing timeline_key in agents mode → fail without retry, no fallback root
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  saveMediaToWorkspace,
  moveFileToWorkspace,
  generateTempDownloadPath,
} from "../src/enrichment/media.js";
import { EnrichmentWorker } from "../src/enrichment/worker.js";
import { EnrichmentWorkerPool } from "../src/enrichment/worker-pool.js";
import { CaptionWorker } from "../src/captioning/worker.js";
import { CaptionWorkerPool } from "../src/captioning/worker-pool.js";
import { validateAgentConfig } from "../src/app.ts";
import type { AppConfig } from "../src/config/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "../src/enrichment/types.js";
import type { MediaAssetRow, Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { EnrichmentConfig } from "../src/enrichment/types.js";
import type { FetchClient } from "../src/enrichment/fetch-client.js";
import type { CaptionConfig } from "../src/captioning/worker-pool.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "p3-test-"));
}

/** Create a workspace dir with msg-attach/ pre-created (matches pool.start() behaviour). */
async function makeWorkspace(baseDir?: string): Promise<string> {
  const root = baseDir ? path.join(baseDir, `ws-${Math.random().toString(36).slice(2)}`) : await makeTempDir();
  await mkdir(path.join(root, "msg-attach"), { recursive: true });
  return root;
}

function noopLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

type WarnCapture = { msg: string; data?: Record<string, unknown> };

function capturingLogger(warns: WarnCapture[]) {
  return {
    info: () => {},
    warn: (msg: string, data?: Record<string, unknown>) => { warns.push({ msg, data }); },
    error: () => {},
  };
}

function makeChatEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: "matrix:miku:$evt",
    externalId: "$evt",
    timelineKey: "matrix:miku:room:!room:example.org",
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "hello",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Minimal Storage stub for enrichment tests. */
function makeEnrichmentStorage(opts: { ingestUrls?: string[] } = {}): Storage & {
  _persisted: Array<{ eventId: string; result: EnrichmentResult }>;
  _events: Map<string, CanonicalChatEvent>;
} {
  const persisted: Array<{ eventId: string; result: EnrichmentResult }> = [];
  const events = new Map<string, CanonicalChatEvent>();
  const storage = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => {
      persisted.push({ eventId, result });
    },
    isBackfetchEvent: () => false,
    getIngestLinkPreviewUrls: (_eventId: string) => opts.ingestUrls ?? [],
    getTimelineEventById: (id: string) => events.get(id),
    _persisted: persisted,
    _events: events,
  };
  return storage as unknown as Storage & {
    _persisted: Array<{ eventId: string; result: EnrichmentResult }>;
    _events: Map<string, CanonicalChatEvent>;
  };
}

/** Minimal Storage stub for captioning tests. */
function makeCaptionStorage(opts: {
  assets?: MediaAssetRow[];
  timelineEventForId?: (id: string) => CanonicalChatEvent | undefined;
} = {}): Storage & { _updates: Array<{ id: string; status: string }>; _sets: Array<{ id: string; status: string }> } {
  const updates: Array<{ id: string; status: string }> = [];
  const sets: Array<{ id: string; status: string }> = [];
  const claimed = [...(opts.assets ?? [])];
  let claimCalled = 0;
  const storage = {
    claimPendingCaptions: async (_limit: number, _captionAll: boolean, _captionAssistant: boolean) => {
      if (claimCalled++ > 0) return [];
      return claimed.splice(0);
    },
    updateCaptionResult: async (id: string, _caption: string, _model: string) => {
      updates.push({ id, status: "complete" });
    },
    setCaptionStatus: async (id: string, status: string) => {
      sets.push({ id, status });
    },
    resetStaleCaptions: async () => 0,
    _updates: updates,
    _sets: sets,
  };
  return storage as unknown as Storage & { _updates: Array<{ id: string; status: string }>; _sets: Array<{ id: string; status: string }> };
}

/** Minimal FetchClient stub. */
function makeFetchClient(responses: Map<string, Buffer>): FetchClient {
  const client = {
    downloadUrl: async (params: { url: string; outputPath: string; sizeLimit?: number }) => {
      const data = responses.get(params.url);
      if (!data) throw new Error(`No stub for ${params.url}`);
      await writeFile(params.outputPath, data);
      return { sizeBytes: data.length, contentType: "image/png" };
    },
    stop: () => {},
    guardedFetch: async () => { throw new Error("not implemented"); },
  };
  return client as unknown as FetchClient;
}

/** Minimal EnrichmentCapabilities stub that never downloads. */
function makeCapabilities(): EnrichmentCapabilities {
  return {
    downloadMedia: async () => { throw new Error("downloadMedia not stubbed"); },
    messageSummary: async () => null,
    memberInfo: async () => ({ displayName: undefined }),
  };
}

// ---------------------------------------------------------------------------
// §7.4 saveMediaToWorkspace — account-scoped subdir layout
// ---------------------------------------------------------------------------

test("saveMediaToWorkspace: agents mode writes to msg-attach/<subdir>/filename", async () => {
  const root = await makeWorkspace();
  try {
    const data = Buffer.from("agents-mode-bytes");
    const subdir = "matrix.miku";
    const result = await saveMediaToWorkspace({
      data,
      workspaceRoot: root,
      originalFilename: "photo.png",
      contentType: "image/png",
      attachSubdir: subdir,
    });

    // local_path includes the subdir
    assert.match(result.localPath, /^msg-attach\/matrix\.miku\//);
    // file actually exists
    assert.ok(existsSync(result.absolutePath), "file should exist on disk");
    // absolute path is under the expected subdir
    const expectedDir = path.join(root, "msg-attach", subdir);
    assert.ok(result.absolutePath.startsWith(expectedDir), "absolutePath is inside the account subdir");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveMediaToWorkspace: legacy mode — flat layout, no subdir", async () => {
  const root = await makeWorkspace();
  try {
    const data = Buffer.from("legacy-flat-bytes");
    const result = await saveMediaToWorkspace({
      data,
      workspaceRoot: root,
      originalFilename: "photo.png",
      contentType: "image/png",
      // no attachSubdir
    });

    assert.match(result.localPath, /^msg-attach\/[^/]+$/);
    assert.ok(existsSync(result.absolutePath));
    // must NOT contain a subdir segment after msg-attach/
    const rel = path.relative(path.join(root, "msg-attach"), result.absolutePath);
    assert.ok(!rel.includes(path.sep), "legacy localPath must be flat (no subdirectory)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveMediaToWorkspace: stored localPath includes subdir, not just filename", async () => {
  const root = await makeWorkspace();
  try {
    const data = Buffer.from("stored-local-path-bytes");
    const subdir = "discord.bot";
    const { localPath } = await saveMediaToWorkspace({
      data,
      workspaceRoot: root,
      attachSubdir: subdir,
    });

    // localPath must be "msg-attach/<subdir>/<filename>"
    const parts = localPath.split("/");
    assert.equal(parts.length, 3, `expected 3 segments, got "${localPath}"`);
    assert.equal(parts[0], "msg-attach");
    assert.equal(parts[1], subdir);
    assert.ok(parts[2]!.length > 0, "filename segment must be non-empty");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7.4 moveFileToWorkspace — account-scoped subdir layout
// ---------------------------------------------------------------------------

test("moveFileToWorkspace: agents mode moves temp file into msg-attach/<subdir>/filename", async () => {
  const root = await makeWorkspace();
  try {
    const data = Buffer.from("move-agents-mode");
    const tempPath = generateTempDownloadPath(root);
    await mkdir(path.dirname(tempPath), { recursive: true });
    await writeFile(tempPath, data);

    const subdir = "matrix.alice";
    const result = await moveFileToWorkspace({
      sourcePath: tempPath,
      workspaceRoot: root,
      originalFilename: "image.jpg",
      attachSubdir: subdir,
    });

    assert.match(result.localPath, /^msg-attach\/matrix\.alice\//);
    assert.ok(existsSync(result.absolutePath));
    // temp file should be gone
    assert.ok(!existsSync(tempPath), "temp file should have been moved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moveFileToWorkspace: legacy mode — flat layout, byte-identical", async () => {
  const root = await makeWorkspace();
  try {
    const data = Buffer.from("move-legacy-flat");
    const tempPath = generateTempDownloadPath(root);
    await writeFile(tempPath, data);

    const result = await moveFileToWorkspace({
      sourcePath: tempPath,
      workspaceRoot: root,
      originalFilename: "image.jpg",
      // no attachSubdir
    });

    assert.match(result.localPath, /^msg-attach\/[^/]+$/);
    assert.ok(existsSync(result.absolutePath));
    const rel = path.relative(path.join(root, "msg-attach"), result.absolutePath);
    assert.ok(!rel.includes(path.sep), "legacy layout must be flat");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7.4 EnrichmentWorkerPool — per-event resolver
// ---------------------------------------------------------------------------

test("EnrichmentWorkerPool: agents mode routes downloads to correct agent workspace", async () => {
  const base = await makeTempDir();
  try {
    const wsAlice = await makeWorkspace(base);
    const wsBob = await makeWorkspace(base);

    // Two agent workspaces mapped by timeline key prefix
    function resolveWorkspaceRoot(timelineKey: string): string | undefined {
      if (timelineKey.startsWith("matrix:alice:")) return wsAlice;
      if (timelineKey.startsWith("matrix:bob:")) return wsBob;
      return undefined;
    }

    const aliceEventId = "matrix:alice:$evt1";
    const bobEventId = "matrix:bob:$evt2";

    const aliceEvent = makeChatEvent({
      id: aliceEventId,
      timelineKey: "matrix:alice:room:!room:example.org",
      attachments: [{
        id: `${aliceEventId}:attach:0`,
        filename: "alice.png",
        mimeType: "image/png",
        mediaType: "image",
        remoteUrl: "https://cdn.example.com/alice.png",
      }],
    });
    const bobEvent = makeChatEvent({
      id: bobEventId,
      timelineKey: "matrix:bob:room:!room:example.org",
      attachments: [{
        id: `${bobEventId}:attach:0`,
        filename: "bob.png",
        mimeType: "image/png",
        mediaType: "image",
        remoteUrl: "https://cdn.example.com/bob.png",
      }],
    });

    const storage = makeEnrichmentStorage();
    storage._events.set(aliceEventId, aliceEvent);
    storage._events.set(bobEventId, bobEvent);

    // Pool-level storage needs claimPendingEnrichment, resetStaleEnrichment, etc.
    const poolEvents = [aliceEventId, bobEventId];
    let claimCalled = 0;
    const poolStorage = {
      ...storage,
      resetStaleEnrichment: async () => 0,
      claimPendingEnrichment: async (limit: number) => {
        if (claimCalled++ > 0) return [];
        return poolEvents.splice(0, limit);
      },
      getEnrichmentRetries: () => 0,
      setEnrichmentStatus: async () => {},
      getTimelineEventById: (id: string) => storage._events.get(id),
      persistEnrichmentResults: storage.persistEnrichmentResults.bind(storage),
      isBackfetchEvent: () => false,
      getIngestLinkPreviewUrls: () => [],
    } as unknown as Storage;

    const aliceData = Buffer.from("alice-image-bytes");
    const bobData = Buffer.from("bob-image-bytes");
    const fetchResponses = new Map([
      ["https://cdn.example.com/alice.png", aliceData],
      ["https://cdn.example.com/bob.png", bobData],
    ]);

    const pool = new EnrichmentWorkerPool({
      storage: poolStorage,
      timeline: undefined as never,
      providerCapabilities: new Map([
        ["matrix:alice", makeCapabilities()],
        ["matrix:bob", makeCapabilities()],
      ]),
      fetchClient: makeFetchClient(fetchResponses),
      workspaceRoot: wsAlice, // legacy fallback root (not used in agents mode)
      resolveWorkspaceRoot,
      config: {} as EnrichmentConfig,
      logger: noopLogger(),
    });

    await pool.start();
    // Wait for both events to be processed
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await pool.stop();

    // Alice's file should be in wsAlice/msg-attach/matrix.alice/
    const aliceDir = path.join(wsAlice, "msg-attach", "matrix.alice");
    const aliceFiles = await readdir(aliceDir).catch(() => []);
    assert.ok(aliceFiles.length > 0, `alice's workspace (${aliceDir}) should have a downloaded file`);

    // Bob's file should be in wsBob/msg-attach/matrix.bob/
    const bobDir = path.join(wsBob, "msg-attach", "matrix.bob");
    const bobFiles = await readdir(bobDir).catch(() => []);
    assert.ok(bobFiles.length > 0, `bob's workspace (${bobDir}) should have a downloaded file`);

    // Cross-contamination check: no unexpected files in each other's root msg-attach/
    const aliceRootFiles = (await readdir(path.join(wsAlice, "msg-attach"))).filter(f => !f.startsWith(".tmp-") && f !== "matrix.alice");
    assert.equal(aliceRootFiles.length, 0, "alice workspace root msg-attach should not have bob's files");
    const bobRootFiles = (await readdir(path.join(wsBob, "msg-attach"))).filter(f => !f.startsWith(".tmp-") && f !== "matrix.bob");
    assert.equal(bobRootFiles.length, 0, "bob workspace root msg-attach should not have alice's files");

    // Stored local_paths should include the account subdir
    for (const { result } of storage._persisted) {
      for (const asset of result.mediaAssets) {
        if (asset.local_path) {
          const parts = asset.local_path.split("/");
          assert.equal(parts.length, 3, `local_path "${asset.local_path}" should have 3 segments`);
          assert.equal(parts[0], "msg-attach");
          assert.ok(
            parts[1] === "matrix.alice" || parts[1] === "matrix.bob",
            `subdir should be an account-scoped dir, got "${parts[1]}"`,
          );
        }
      }
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("EnrichmentWorkerPool §4.3: unresolvable account skips file downloads, DB-only ops proceed", async () => {
  const root = await makeWorkspace();
  const warns: WarnCapture[] = [];
  try {
    // Resolver never resolves (all accounts unresolvable)
    const resolveWorkspaceRoot = (_timelineKey: string): string | undefined => undefined;

    const eventId = "matrix:orphan:$evt";
    const event = makeChatEvent({
      id: eventId,
      timelineKey: "matrix:orphan:room:!room:example.org",
      attachments: [{
        id: `${eventId}:attach:0`,
        filename: "file.png",
        mimeType: "image/png",
        mediaType: "image",
        remoteUrl: "https://cdn.example.com/file.png",
      }],
    });

    const storage = makeEnrichmentStorage();
    storage._events.set(eventId, event);

    let claimCalled = 0;
    const poolStorage = {
      ...storage,
      resetStaleEnrichment: async () => 0,
      claimPendingEnrichment: async (limit: number) => {
        if (claimCalled++ > 0) return [];
        return [eventId].splice(0, limit);
      },
      getEnrichmentRetries: () => 0,
      setEnrichmentStatus: async () => {},
      getTimelineEventById: (id: string) => storage._events.get(id),
      persistEnrichmentResults: storage.persistEnrichmentResults.bind(storage),
      isBackfetchEvent: () => false,
      getIngestLinkPreviewUrls: () => [],
    } as unknown as Storage;

    const pool = new EnrichmentWorkerPool({
      storage: poolStorage,
      timeline: undefined as never,
      providerCapabilities: new Map([
        ["matrix:orphan", makeCapabilities()],
      ]),
      fetchClient: makeFetchClient(new Map()),
      workspaceRoot: root,
      resolveWorkspaceRoot,
      config: {} as EnrichmentConfig,
      logger: capturingLogger(warns),
    });

    await pool.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await pool.stop();

    // §4.3: warn must have been emitted
    const unresolvableWarn = warns.find(w => w.msg === "enrichment_workspace_unresolvable");
    assert.ok(unresolvableWarn, "should warn enrichment_workspace_unresolvable");
    assert.equal(unresolvableWarn.data?.timelineKey, "matrix:orphan:room:!room:example.org");

    // No files downloaded into root
    const msgAttachFiles = await readdir(path.join(root, "msg-attach")).catch(() => []);
    const nonTmp = msgAttachFiles.filter(f => !f.startsWith(".tmp-"));
    assert.equal(nonTmp.length, 0, "no files should be downloaded for an unresolvable account");

    // persistEnrichmentResults was still called (DB-only ops proceed)
    assert.equal(storage._persisted.length, 1, "enrichment results should still be persisted");
    // The persisted result should have no media assets with local_path (no downloads)
    const persisted = storage._persisted[0]!;
    for (const asset of persisted.result.mediaAssets) {
      assert.ok(!asset.local_path, "no local_path should be set when workspace is unresolvable");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EnrichmentWorkerPool: legacy mode (no resolver) flat layout, byte-identical", async () => {
  const root = await makeWorkspace();
  try {
    const eventId = "matrix:miku:$evt";
    const event = makeChatEvent({
      id: eventId,
      attachments: [{
        id: `${eventId}:attach:0`,
        filename: "legacy.png",
        mimeType: "image/png",
        mediaType: "image",
        remoteUrl: "https://cdn.example.com/legacy.png",
      }],
    });

    const storage = makeEnrichmentStorage();
    storage._events.set(eventId, event);
    let claimCalled = 0;
    const poolStorage = {
      ...storage,
      resetStaleEnrichment: async () => 0,
      claimPendingEnrichment: async (limit: number) => {
        if (claimCalled++ > 0) return [];
        return [eventId].splice(0, limit);
      },
      getEnrichmentRetries: () => 0,
      setEnrichmentStatus: async () => {},
      getTimelineEventById: (id: string) => storage._events.get(id),
      persistEnrichmentResults: storage.persistEnrichmentResults.bind(storage),
      isBackfetchEvent: () => false,
      getIngestLinkPreviewUrls: () => [],
    } as unknown as Storage;

    const imageData = Buffer.from("legacy-flat-image");
    const pool = new EnrichmentWorkerPool({
      storage: poolStorage,
      timeline: undefined as never,
      providerCapabilities: new Map([["matrix:miku", makeCapabilities()]]),
      fetchClient: makeFetchClient(new Map([["https://cdn.example.com/legacy.png", imageData]])),
      workspaceRoot: root,
      // No resolveWorkspaceRoot → legacy mode
      config: {} as EnrichmentConfig,
      logger: noopLogger(),
    });

    await pool.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await pool.stop();

    // File must be in flat msg-attach/, not in a subdir
    const msgAttachEntries = await readdir(path.join(root, "msg-attach"));
    const nonTmp = msgAttachEntries.filter(f => !f.startsWith(".tmp-"));
    assert.equal(nonTmp.length, 1, "exactly one file in flat msg-attach/");
    // The single entry must be a file, not a directory
    const entry = nonTmp[0]!;
    assert.ok(!entry.includes("/"), "entry should not contain a path separator");

    // Stored local_path is flat
    assert.equal(storage._persisted.length, 1);
    const asset = storage._persisted[0]!.result.mediaAssets[0]!;
    assert.ok(asset.local_path, "local_path should be set");
    const parts = asset.local_path!.split("/");
    assert.equal(parts.length, 2, `legacy local_path "${asset.local_path}" should be "msg-attach/<filename>"`);
    assert.equal(parts[0], "msg-attach");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Minimal valid PNG (1×1 black pixel) for captioning tests. sharp can parse it
// without throwing, which avoids the isAnimatedImage probe erroring on bad bytes.
// ---------------------------------------------------------------------------

// 1×1 black PNG, base64-encoded
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// ---------------------------------------------------------------------------
// CaptionWorker.process — workspaceRootOverride resolves pre-existing flat paths
// ---------------------------------------------------------------------------

test("CaptionWorker.process: workspaceRootOverride resolves a pre-existing flat-layout local_path", async () => {
  const root = await makeWorkspace();
  try {
    const flatFilename = "ABCDEFGHIJK.png";
    const flatPath = path.join(root, "msg-attach", flatFilename);
    await writeFile(flatPath, TINY_PNG);

    const asset: MediaAssetRow = {
      id: "asset-flat",
      event_id: "matrix:miku:$evt",
      role: "attachment",
      source_index: 0,
      media_type: "image",
      mime_type: "image/png",
      size_bytes: TINY_PNG.length,
      original_filename: flatFilename,
      download_status: "complete",
      caption_status: "pending",
      // Flat local_path (pre-Phase-3 layout, as written before Phase 3)
      local_path: `msg-attach/${flatFilename}`,
      created_at: Date.now(),
    };

    let captionedPath: string | undefined;
    const mockStorage = {
      updateCaptionResult: async () => {},
    } as unknown as Storage;

    // InferenceClient uses .caption({filePath, mimeType, filename, context})
    const mockClient = {
      caption: async (params: { filePath: string }) => {
        captionedPath = params.filePath;
        return { caption: "a small image", model: "test-model", logicalModelId: "test-model", provider: null, usage: null, cost: null };
      },
    };

    const worker = new CaptionWorker({
      storage: mockStorage,
      clients: new Map([["image" as const, mockClient as never]]),
      workspaceRoot: "/nonexistent/wrong-root",
    });

    // workspaceRootOverride should be used instead of options.workspaceRoot
    await worker.process(asset, root);

    assert.equal(
      captionedPath,
      flatPath,
      "CaptionWorker should resolve local_path under workspaceRootOverride",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CaptionWorkerPool — per-asset resolver
// ---------------------------------------------------------------------------

test("CaptionWorkerPool: per-asset resolver routes to correct agent workspace", async () => {
  const base = await makeTempDir();
  try {
    const wsAlice = await makeWorkspace(base);
    const wsBob = await makeWorkspace(base);

    // Write pre-existing subdir-layout files for each agent
    const aliceSubdir = path.join(wsAlice, "msg-attach", "matrix.alice");
    const bobSubdir = path.join(wsBob, "msg-attach", "matrix.bob");
    await mkdir(aliceSubdir, { recursive: true });
    await mkdir(bobSubdir, { recursive: true });

    const aliceFile = path.join(aliceSubdir, "ALICE0001.png");
    const bobFile = path.join(bobSubdir, "BOB00001.png");
    await writeFile(aliceFile, TINY_PNG);
    await writeFile(bobFile, TINY_PNG);

    const aliceAsset: MediaAssetRow = {
      id: "asset-alice",
      event_id: "matrix:alice:$evt1",
      role: "attachment",
      source_index: 0,
      media_type: "image",
      mime_type: "image/png",
      size_bytes: TINY_PNG.length,
      original_filename: "ALICE0001.png",
      download_status: "complete",
      caption_status: "pending",
      local_path: "msg-attach/matrix.alice/ALICE0001.png",
      timeline_key: "matrix:alice:room:!room:example.org",
      created_at: Date.now(),
    };
    const bobAsset: MediaAssetRow = {
      id: "asset-bob",
      event_id: "matrix:bob:$evt2",
      role: "attachment",
      source_index: 0,
      media_type: "image",
      mime_type: "image/png",
      size_bytes: TINY_PNG.length,
      original_filename: "BOB00001.png",
      download_status: "complete",
      caption_status: "pending",
      local_path: "msg-attach/matrix.bob/BOB00001.png",
      timeline_key: "matrix:bob:room:!room:example.org",
      created_at: Date.now(),
    };

    const captionedPaths: string[] = [];
    const mockClient = {
      // InferenceClient uses .caption({filePath, ...})
      caption: async (params: { filePath: string }) => {
        captionedPaths.push(params.filePath);
        return { caption: "an image", model: "test-model", logicalModelId: "test-model", provider: null, usage: null, cost: null };
      },
    };

    const storage = makeCaptionStorage({ assets: [aliceAsset, bobAsset] });

    const pool = new CaptionWorkerPool({
      storage: storage as unknown as Storage,
      clients: new Map([["image" as const, mockClient as never]]),
      workspaceRoot: "/nonexistent/legacy-root",
      resolveWorkspaceRoot: (timelineKey: string) => {
        if (timelineKey.startsWith("matrix:alice:")) return wsAlice;
        if (timelineKey.startsWith("matrix:bob:")) return wsBob;
        return undefined;
      },
      config: { worker_count: 1, caption_all: true } as CaptionConfig,
      logger: noopLogger(),
    });

    await pool.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    await pool.stop();

    // Both files should have been captioned
    assert.equal(captionedPaths.length, 2, "both assets should be captioned");
    assert.ok(captionedPaths.includes(aliceFile), `alice's file should be captioned at ${aliceFile}`);
    assert.ok(captionedPaths.includes(bobFile), `bob's file should be captioned at ${bobFile}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("CaptionWorkerPool §4.3: unresolvable account marks asset failed without retry", async () => {
  const root = await makeWorkspace();
  const warns: WarnCapture[] = [];
  try {
    const asset: MediaAssetRow = {
      id: "asset-orphan",
      event_id: "matrix:orphan:$evt",
      role: "attachment",
      source_index: 0,
      media_type: "image",
      mime_type: "image/png",
      size_bytes: 100,
      original_filename: "orphan.png",
      download_status: "complete",
      caption_status: "pending",
      local_path: "msg-attach/matrix.orphan/orphan.png",
      timeline_key: "matrix:orphan:room:!room:example.org",
      created_at: Date.now(),
      caption_attempts: 0,
    };

    const storage = makeCaptionStorage({ assets: [asset] });

    const pool = new CaptionWorkerPool({
      storage: storage as unknown as Storage,
      clients: new Map(),
      workspaceRoot: root,
      resolveWorkspaceRoot: (_timelineKey: string) => undefined, // always unresolvable
      config: { worker_count: 1, caption_all: true } as CaptionConfig,
      logger: capturingLogger(warns),
    });

    await pool.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await pool.stop();

    // §4.3: warn must be emitted
    const unresolvableWarn = warns.find(w => w.msg === "caption_workspace_unresolvable");
    assert.ok(unresolvableWarn, "should warn caption_workspace_unresolvable");
    assert.equal(unresolvableWarn.data?.assetId, "asset-orphan");

    // Asset should be set to failed (without retry)
    assert.equal(storage._sets.length, 1, "setCaptionStatus should be called once");
    assert.equal(storage._sets[0]!.id, "asset-orphan");
    assert.equal(storage._sets[0]!.status, "failed");

    // No caption attempt (updateCaptionResult should not be called)
    assert.equal(storage._updates.length, 0, "updateCaptionResult should not be called");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review finding 1a: validateAgentConfig — path-unsafe account keys
// ---------------------------------------------------------------------------

/** Minimal config skeleton — only the fields validateAgentConfig reads. */
function minimalAgentsConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    discord: undefined,
    agents: undefined,
    workspace: undefined,
    ...overrides,
  } as unknown as AppConfig;
}

test("validateAgentConfig: matrix account key with slash is hard error in agents mode (finding 1a)", () => {
  const config = minimalAgentsConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        // account key with a forward slash — path-unsafe in §7.4 layout
        "dev/miku": { homeserver: "h", user_id: "@x:h", store_path: "./v" },
      },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /path-unsafe|slash|backslash|filesystem path/i,
    "account key with slash must throw in agents mode",
  );
});

test("validateAgentConfig: matrix account key with backslash is hard error in agents mode (finding 1a)", () => {
  const config = minimalAgentsConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        "bad\\key": { homeserver: "h", user_id: "@x:h", store_path: "./v" },
      },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /path-unsafe|slash|backslash|filesystem path/i,
    "account key with backslash must throw in agents mode",
  );
});

test("validateAgentConfig: discord account key with .. segment is hard error in agents mode (finding 1a)", () => {
  const config = minimalAgentsConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    discord: {
      enabled: true,
      accounts: { "../../escape": { token: "tok" } },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /path-unsafe|filesystem path/i,
    "account key with .. segment must throw in agents mode",
  );
});

test("validateAgentConfig: account key with whitespace is hard error in agents mode (finding 1a)", () => {
  // Whitespace in a key can break filesystem path assumptions.
  const config = minimalAgentsConfig({
    agents: { miku: { workspace_root: "/tmp/miku" } },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        "key with space": { homeserver: "h", user_id: "@x:h", store_path: "./v" },
      },
    } as any,
  });
  assert.throws(
    () => validateAgentConfig(config),
    /path-unsafe|whitespace|filesystem path/i,
    "account key with whitespace must throw in agents mode",
  );
});

test("validateAgentConfig: path-unsafe account key in LEGACY mode does NOT throw (finding 1a — back-compat)", () => {
  // In legacy mode (no [agents] table), path-unsafe chars that are not colons
  // must remain warning-only (§3 back-compat). validateAgentConfig must NOT throw
  // for a slash-containing key when no [agents] table is present.  The same key
  // in agents mode (see tests above) IS a hard error.
  const legacyConfig = minimalAgentsConfig({
    // No agents property → legacy mode (validateAgentConfig's else branch)
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: {
        "dev/miku": { homeserver: "h", user_id: "@x:h", store_path: "./v" },
      },
    } as any,
  });
  assert.doesNotThrow(
    () => validateAgentConfig(legacyConfig),
    "path-unsafe account key must NOT throw in legacy mode (§3 back-compat: only warns)",
  );
});

// ---------------------------------------------------------------------------
// Review finding 1b: EnrichmentWorkerPool subdir guard — defense-in-depth
// ---------------------------------------------------------------------------

test("EnrichmentWorkerPool: subdir guard skips download when accountId is path-unsafe (finding 1b)", async () => {
  // Simulate an in-process attack where parseTimelineKey returns an accountId
  // that contains a path separator. validateAgentConfig prevents this at startup
  // in agents mode, but the guard provides defense-in-depth (the secondary layer).
  const root = await makeWorkspace();
  const warns: WarnCapture[] = [];
  try {
    // The event's timelineKey has a crafted accountId that would produce an
    // unsafe subdir ("matrix.dev/miku"). We simulate this by returning a
    // resolved root but having the actual parsed key be unsafe. Because
    // parseTimelineKey is called on the raw timelineKey, we use a real-looking
    // (but unusual) key and then rely on the guard detecting "/" in the subdir.
    //
    // To reliably trigger the subdir guard we need the parsed accountId to
    // contain "/". We manufacture this by patching the timeline key to use
    // a colon-split key whose accountId segment has a slash — parseTimelineKey
    // returns provider=matrix, accountId="dev/miku" for key "matrix:dev/miku:…".
    const dangerousTimelineKey = "matrix:dev/miku:room:!room:example.org";
    const eventId = "evt-dangerous";
    const dangerousEvent = makeChatEvent({
      id: eventId,
      timelineKey: dangerousTimelineKey,
      attachments: [{
        id: `${eventId}:attach:0`,
        filename: "pwned.png",
        mimeType: "image/png",
        mediaType: "image",
        remoteUrl: "https://cdn.example.com/pwned.png",
      }],
    });

    const storage = makeEnrichmentStorage();
    storage._events.set(eventId, dangerousEvent);
    let claimCalled = 0;
    const poolStorage = {
      ...storage,
      resetStaleEnrichment: async () => 0,
      claimPendingEnrichment: async (limit: number) => {
        if (claimCalled++ > 0) return [];
        return [eventId].splice(0, limit);
      },
      getEnrichmentRetries: () => 0,
      setEnrichmentStatus: async () => {},
      getTimelineEventById: (id: string) => storage._events.get(id),
      persistEnrichmentResults: storage.persistEnrichmentResults.bind(storage),
      isBackfetchEvent: () => false,
      getIngestLinkPreviewUrls: () => [],
    } as unknown as Storage;

    // Resolver returns a valid root (account is "known") but the parsed key
    // produces an unsafe subdir candidate "matrix.dev/miku".
    const pool = new EnrichmentWorkerPool({
      storage: poolStorage,
      timeline: undefined as never,
      providerCapabilities: new Map([
        ["matrix:dev/miku", makeCapabilities()],
      ]),
      fetchClient: makeFetchClient(new Map()),
      workspaceRoot: root,
      resolveWorkspaceRoot: () => root, // resolver says "resolved" — guard must still catch it
      config: {} as EnrichmentConfig,
      logger: capturingLogger(warns),
    });

    await pool.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await pool.stop();

    // The subdir guard should have fired and warned
    const guardWarn = warns.find(w => w.msg === "enrichment_subdir_path_unsafe");
    assert.ok(guardWarn, "should warn enrichment_subdir_path_unsafe when subdir contains path separator");
    assert.ok(
      String(guardWarn.data?.candidate ?? "").includes("/"),
      `candidate subdir should contain "/" — got "${guardWarn.data?.candidate}"`,
    );

    // No files should have been downloaded
    const msgAttachFiles = await readdir(path.join(root, "msg-attach")).catch(() => []);
    const nonTmp = msgAttachFiles.filter(f => !f.startsWith(".tmp-") && f !== ".");
    assert.equal(nonTmp.length, 0, "no files should be written when subdir is unsafe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review finding 2: CaptionWorkerPool — missing timeline_key in agents mode
// ---------------------------------------------------------------------------

test("CaptionWorkerPool §4.3: missing timeline_key in agents mode fails without writing to fallback root (finding 2)", async () => {
  // An asset with a NULL timeline_key in agents mode must be treated as
  // unresolvable (§4.3): no write to any workspace root, status 'failed',
  // warn 'caption_workspace_unresolvable'. The legacy fallback workspaceRoot
  // must NOT be used.
  const root = await makeWorkspace();
  const warns: WarnCapture[] = [];
  const captionedPaths: string[] = [];
  try {
    const assetNoKey: MediaAssetRow = {
      id: "asset-no-key",
      event_id: "matrix:miku:$evt",
      role: "attachment",
      source_index: 0,
      media_type: "image",
      mime_type: "image/png",
      size_bytes: TINY_PNG.length,
      original_filename: "img.png",
      download_status: "complete",
      caption_status: "pending",
      local_path: "msg-attach/img.png",
      // timeline_key intentionally absent / null
      timeline_key: undefined,
      created_at: Date.now(),
      caption_attempts: 0,
    };

    const storage = makeCaptionStorage({ assets: [assetNoKey] });

    // The resolver is present (agents mode) but timeline_key is missing.
    const mockClient = {
      caption: async (params: { filePath: string }) => {
        captionedPaths.push(params.filePath);
        return { caption: "x", model: "m", logicalModelId: "m", provider: null, usage: null, cost: null };
      },
    };

    const pool = new CaptionWorkerPool({
      storage: storage as unknown as Storage,
      clients: new Map([["image" as const, mockClient as never]]),
      workspaceRoot: root,
      // resolveWorkspaceRoot is present → agents mode; timeline_key is null → must fail
      resolveWorkspaceRoot: (key: string) => {
        if (key === "matrix:miku:room:!room:example.org") return root;
        return undefined;
      },
      config: { worker_count: 1, caption_all: true } as CaptionConfig,
      logger: capturingLogger(warns),
    });

    await pool.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    await pool.stop();

    // Must warn caption_workspace_unresolvable
    const unresolvableWarn = warns.find(w => w.msg === "caption_workspace_unresolvable");
    assert.ok(unresolvableWarn, "should warn caption_workspace_unresolvable for missing timeline_key");
    assert.equal(unresolvableWarn.data?.assetId, "asset-no-key");

    // Asset must be set to failed (without retry)
    assert.equal(storage._sets.length, 1, "setCaptionStatus should be called once");
    assert.equal(storage._sets[0]!.status, "failed", "status must be 'failed'");

    // The caption inference client must NOT have been called (no fallback to workspaceRoot)
    assert.equal(captionedPaths.length, 0, "no caption inference call should happen when timeline_key is missing");

    // No files written
    assert.equal(storage._updates.length, 0, "updateCaptionResult must not be called");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
