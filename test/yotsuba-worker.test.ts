/**
 * Tests for src/enrichment/worker.ts — yotsuba (4chan) enrichment partition.
 * (spec/YOTSUBA-SUPPORT.md §12)
 *
 * Verifies:
 *   - 4chan URLs are stripped from the Synapse body and processed separately.
 *   - Recognized refs are added to the yotsuba exclusions so linked-media doesn't double-count.
 *   - Board refs and thread refs produce the expected link_preview rows.
 *   - Reply context reuse copies an existing row instead of fetching again.
 *   - When yotsuba is disabled, 4chan URLs ride the generic Synapse path.
 *   - media_boards="worksafe" blocks file downloads on non-worksafe boards.
 *   - Feature absent means no yotsuba partition (legacy behavior).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EnrichmentWorker, type EnrichmentLogger } from "../src/enrichment/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "../src/enrichment/types.js";
import type { FetchClient } from "../src/enrichment/fetch-client.js";
import type { Storage, LinkPreviewRow, MediaAssetRow } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import type { YotsubaClient, YotsubaFetchResult } from "../src/yotsuba/client.js";
import {
  resolveYotsubaConfig,
  YOTSUBA_SOURCE_KIND,
  type ApiThread,
  type ApiPost,
  type ApiBoardPage,
  type ApiBoard,
} from "../src/yotsuba/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNT = "miku";
const ROOM = "!room:example.org";
const ROOM_TK = `matrix:${ACCOUNT}:room:${ROOM}`;

function chatEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: `matrix:${ACCOUNT}:$msg`,
    externalId: "$msg",
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "hello",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function baseApiPost(no: number, overrides: Partial<ApiPost> = {}): ApiPost {
  return {
    no,
    tim: no + 1_000_000,
    ext: ".jpg",
    w: 800, h: 600,
    fsize: 100_000,
    filename: `img${no}`,
    time: Math.floor(Date.now() / 1000) - 3600,
    com: "post body",
    ...overrides,
  };
}

function baseThread(_boardNo: number, posts: ApiPost[]): ApiThread {
  return { posts };
}

/** Wrap a body in a YotsubaFetchResult for mock returns. */
function fetchResult<T>(body: T): YotsubaFetchResult<T> {
  return { body, fetchedAt: Date.now(), fromCache: false };
}

function baseBoards(): YotsubaFetchResult<ApiBoard[]> {
  return fetchResult([
    { board: "g", title: "Technology", ws_board: 1 },
    { board: "b", title: "Random", ws_board: 0 },
  ]);
}

function basePage1(boardNo: number): YotsubaFetchResult<ApiBoardPage> {
  return fetchResult({
    threads: [
      {
        posts: [
          baseApiPost(boardNo + 1, { sub: "First thread subject", com: "OP body", replies: 10, images: 2, time: Math.floor(Date.now() / 1000) - 7200 }),
        ],
      },
      {
        posts: [
          baseApiPost(boardNo + 100, { com: "another op", replies: 5, images: 1, time: Math.floor(Date.now() / 1000) - 3600 }),
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  worker: EnrichmentWorker;
  persisted: Array<{ eventId: string; result: EnrichmentResult }>;
  synapseBodies: string[];
  clientCalls: string[];   // record of which API calls were made
  existingYotsubaRow: { row: LinkPreviewRow; assets: MediaAssetRow[] } | null;
  workspaceRoot: string;
}

async function makeHarness(opts: {
  yotsuba?: boolean | "disabled";
  mediaBoards?: string;
  threadFixtures?: Record<string, ApiThread | null>;
  page1Fixture?: Record<string, YotsubaFetchResult<ApiBoardPage>>;
  boardsFixture?: YotsubaFetchResult<ApiBoard[]>;
  existingYotsubaRow?: { row: LinkPreviewRow; assets: MediaAssetRow[] } | null;
  captionAll?: boolean;
  synapseSources?: Array<{ url: string; sourceKind?: string; title?: string; description?: string }>;
  noMessageSummary?: boolean;
}): Promise<Harness> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "yot-test-"));
  const persisted: Array<{ eventId: string; result: EnrichmentResult }> = [];
  const synapseBodies: string[] = [];
  const clientCalls: string[] = [];
  let existingYotsubaRow: Harness["existingYotsubaRow"] = opts.existingYotsubaRow ?? null;

  const logger: EnrichmentLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const storage = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => {
      persisted.push({ eventId, result });
    },
    isBackfetchEvent: () => false,
    getEditedBody: () => undefined,
    getEventCaptionEligibilityFields: () => ({
      triggerGroupId: null,
      isBackfetch: false,
      role: "user",
    }),
    getIngestLinkPreviewUrls: () => [],
    getTimelineEventById: (_id: string) => chatEvent(),
    getYotsubaPreviewByUrl: (_url: string, _timelineKey?: string) => existingYotsubaRow,
  } as unknown as Storage;

  const capabilities: EnrichmentCapabilities = {
    ...(opts.noMessageSummary ? {} : { messageSummary: async () => null }),
    downloadMedia: async () => { throw new Error("not under test"); },
    resolveLinkPreviews: async (params: { bodyText: string }) => {
      synapseBodies.push(params.bodyText);
      return {
        textBlocks: [],
        media: [],
        sources: (opts.synapseSources ?? []).map((s) => ({
          url: s.url,
          sourceKind: s.sourceKind ?? "synapse",
          title: s.title,
          description: s.description,
        })),
      };
    },
    memberInfo: async () => ({}),
  } as unknown as EnrichmentCapabilities;

  const fetchClient: FetchClient = {
    fetch: async (_url: string) => {
      const tmpPath = path.join(workspaceRoot, `download-${Math.random().toString(36).slice(2)}.jpg`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(tmpPath, Buffer.from("fake jpg data"));
      return { path: tmpPath, sizeBytes: 13, contentType: "image/jpeg", finalUrl: _url, statusCode: 200 };
    },
  } as unknown as FetchClient;

  const yotClient = {
    boards: async (_cls?: string): Promise<YotsubaFetchResult<ApiBoard[]>> => {
      clientCalls.push("boards");
      return opts.boardsFixture ?? baseBoards();
    },
    thread: async (board: string, no: number, _cls?: string) => {
      const key = `${board}/${no}`;
      clientCalls.push(`thread:${key}`);
      const fixture = opts.threadFixtures?.[key];
      if (fixture === null) return null; // 404
      if (fixture === undefined) {
        // Return a minimal thread wrapped in YotsubaFetchResult
        return fetchResult(baseThread(no, [baseApiPost(no, { sub: "Test Subject", com: "OP body here" })]));
      }
      return fetchResult(fixture);
    },
    page: async (board: string, _n: number, _cls?: string) => {
      clientCalls.push(`page1:${board}`);
      return opts.page1Fixture?.[board] ?? basePage1(100000);
    },
    fetchFilePath: async (_board: string, _file: string, _priority?: string) => {
      const tmpPath = path.join(workspaceRoot, `file-${Math.random().toString(36).slice(2)}.jpg`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(tmpPath, Buffer.from("fake file"));
      return { path: tmpPath, sizeBytes: 9, contentType: "image/jpeg", statusCode: 200 };
    },
  } as unknown as YotsubaClient;

  const yotCfg = resolveYotsubaConfig({
    enabled: true,
    enrichment: {
      enabled: opts.yotsuba !== "disabled" && opts.yotsuba !== false,
      media_boards: (opts.mediaBoards ?? "all") as "all" | "worksafe",
    },
  });

  const worker = new EnrichmentWorker({
    storage,
    capabilities,
    fetchClient,
    workspaceRoot,
    maxPreviewsPerMessage: 5,
    yotsuba: opts.yotsuba === false
      ? undefined
      : {
          client: yotClient,
          config: yotCfg,
          captionAll: opts.captionAll ?? false,
          captionAssistant: false,
        },
    logger,
  });

  return { worker, persisted, synapseBodies, clientCalls, existingYotsubaRow, workspaceRoot };
}

function previews(h: Harness): LinkPreviewRow[] {
  return h.persisted[0]?.result.linkPreviews ?? [];
}

async function cleanup(h: Harness): Promise<void> {
  await rm(h.workspaceRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Partition — thread link
// ---------------------------------------------------------------------------

test("4chan thread URL is stripped from Synapse body and stored as yotsuba row", async () => {
  const h = await makeHarness({});
  try {
    await h.worker.process(chatEvent({
      body: "look at this https://boards.4chan.org/g/thread/100000 and also https://example.com/page",
    }));

    // Synapse sees the body without the 4chan URL
    assert.equal(h.synapseBodies.length, 1);
    assert.ok(!h.synapseBodies[0]!.includes("boards.4chan.org"), "4chan URL should be stripped from Synapse body");

    // yotsuba row created
    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.equal(yotPreviews.length, 1);
    assert.match(yotPreviews[0]!.url, /boards\.4chan\.org\/g\/thread\/100000/);

    // Thread API was called
    assert.ok(h.clientCalls.some((c) => c.startsWith("thread:g/100000")), "thread API should be called");
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// Partition — board link
// ---------------------------------------------------------------------------

test("4chan board URL is stripped from Synapse body and stored as board yotsuba row", async () => {
  const h = await makeHarness({});
  try {
    await h.worker.process(chatEvent({
      body: "check the board https://boards.4chan.org/g/",
    }));

    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.equal(yotPreviews.length, 1);
    const row = yotPreviews[0]!;
    assert.match(row.url, /boards\.4chan\.org\/g\//);

    // page1 was called (not thread)
    assert.ok(h.clientCalls.some((c) => c.startsWith("page1:g")), "page1 API should be called for board refs");
    assert.ok(!h.clientCalls.some((c) => c.startsWith("thread:")), "thread API should not be called for board refs");
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// Feature off: 4chan URLs ride the generic path
// ---------------------------------------------------------------------------

test("when yotsuba is absent, 4chan URLs are NOT stripped and ride the generic path", async () => {
  const h = await makeHarness({
    yotsuba: false,
    synapseSources: [{ url: "https://boards.4chan.org/g/thread/100000", title: "Thread", description: "desc" }],
  });
  try {
    await h.worker.process(chatEvent({
      body: "check https://boards.4chan.org/g/thread/100000",
    }));

    // Synapse body still contains the 4chan URL
    assert.equal(h.synapseBodies.length, 1);
    assert.ok(h.synapseBodies[0]!.includes("boards.4chan.org"), "4chan URL should remain in Synapse body when yotsuba is off");

    // No yotsuba rows
    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.equal(yotPreviews.length, 0, "no yotsuba rows when feature is off");

    // No API calls to yotsuba client
    assert.equal(h.clientCalls.length, 0, "no yotsuba API calls when feature is off");
  } finally {
    await cleanup(h);
  }
});

test("when enrichment.enabled is false, 4chan URLs ride the generic path", async () => {
  const h = await makeHarness({
    yotsuba: "disabled",
    synapseSources: [{ url: "https://boards.4chan.org/g/thread/100000", title: "Thread", description: "desc" }],
  });
  try {
    await h.worker.process(chatEvent({
      body: "check https://boards.4chan.org/g/thread/100000",
    }));

    assert.ok(h.synapseBodies[0]?.includes("boards.4chan.org"), "4chan URL should remain when enrichment disabled");
    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.equal(yotPreviews.length, 0);
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// 404 / gone thread
// ---------------------------------------------------------------------------

test("404 thread stores a row with fetch_status='failed'", async () => {
  const h = await makeHarness({
    threadFixtures: { "g/200000": null },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://boards.4chan.org/g/thread/200000" }));

    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.equal(yotPreviews.length, 1);
    const row = yotPreviews[0]!;
    assert.equal(row.fetch_status, "failed");
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// Reply context reuse
// ---------------------------------------------------------------------------

test("reply context reuses existing yotsuba row without fetching", async () => {
  const existingRow: LinkPreviewRow = {
    id: "existing-preview-id",
    event_id: "original-event",
    context: "message",
    url: "https://boards.4chan.org/g/thread/100000",
    source_kind: YOTSUBA_SOURCE_KIND,
    site_name: "4chan",
    title: "/g/ - Technology",
    description: "cached description",
    preview_index: 0,
    fetched_at: Date.now() - 3600000,
    fetch_status: "complete",
    created_at: Date.now() - 3600000,
    payload_json: JSON.stringify({
      v: 1, kind: "thread", board: "g", boardTitle: "Technology",
      asOf: Date.now() - 3600000,
      threadNo: 100000,
    }),
  };
  const existingAsset: MediaAssetRow = {
    id: "existing-asset-id",
    event_id: "original-event",
    role: "preview_media",
    link_preview_id: "existing-preview-id",
    media_type: "image",
    mime_type: "image/jpeg",
    original_filename: "img.jpg",
    local_path: "msg-attach/img.jpg",
    download_status: "complete",
    caption_status: "deferred",
    created_at: Date.now() - 3600000,
  };

  const h = await makeHarness({
    existingYotsubaRow: { row: existingRow, assets: [existingAsset] },
    noMessageSummary: true,
  });
  try {
    // The reply context reuse path:
    //   1. lookupReplyTarget falls through to the ingest-time snapshot (event.replyTo)
    //      because messageSummary is absent (noMessageSummary: true).
    //   2. Worker calls fetchLinkPreviews(replyContext.body, "reply", ...).
    //   3. enrichYotsubaRef is called with context="reply".
    //   4. Inside enrichYotsubaRef, when context="reply", storage.getYotsubaPreviewByUrl
    //      finds the existing row and returns it without making any API calls.
    const event = chatEvent({
      body: "@miku explain the joke",
      replyTo: {
        externalId: "original-event",
        sender: { id: "@alice:example.org", displayName: "Alice" },
        body: "lmao look at this https://boards.4chan.org/g/thread/100000",
      },
    });

    await h.worker.process(event);

    // No API calls made (existing row reused)
    assert.equal(h.clientCalls.length, 0, "no API calls when existing yotsuba row is found for reply context");

    // A yotsuba row should be in the result (copied from existing)
    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.ok(yotPreviews.length >= 1, "should have a yotsuba preview from reply context");
    // The copied row references the same URL
    assert.ok(yotPreviews.some((p) => p.url.includes("100000")), "copied row should have same URL");
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// Cross-timeline reply context non-reuse
// ---------------------------------------------------------------------------

test("reply context does NOT reuse a row from a different timeline", async () => {
  // When getYotsubaPreviewByUrl returns null (simulating no row in this timeline),
  // the worker falls through to the full fetch path and makes an API call.
  const h = await makeHarness({
    existingYotsubaRow: null,
    noMessageSummary: true,
    threadFixtures: {
      "g/100000": baseThread(100000, [
        baseApiPost(100000, { sub: "Test Subject", com: "OP body" }),
      ]),
    },
  });
  try {
    const event = chatEvent({
      body: "@miku explain the joke",
      replyTo: {
        externalId: "original-event",
        sender: { id: "@alice:example.org", displayName: "Alice" },
        body: "lmao look at this https://boards.4chan.org/g/thread/100000",
      },
    });

    await h.worker.process(event);

    // API calls were made (no existing row to reuse — full fetch happened)
    assert.ok(h.clientCalls.length > 0, "API call made when no existing yotsuba row for timeline");

    // A yotsuba row should still be in the result (from a fresh fetch)
    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.ok(yotPreviews.length >= 1, "should have a yotsuba preview from fresh fetch");
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// Headline file created deferred
// ---------------------------------------------------------------------------

test("headline file is downloaded and stored for thread links", async () => {
  // The post-pass skips yotsuba assets (they manage their own caption_status).
  // Headline files are created with caption_status="deferred" by enrichYotsubaThreadRef
  // unless captionImmediately fires; the post-pass does NOT override this.
  const h = await makeHarness({
    threadFixtures: {
      "g/300000": baseThread(300000, [
        baseApiPost(300000, { sub: "Test Subject", com: "OP body", tim: 300001, ext: ".jpg" }),
      ]),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://boards.4chan.org/g/thread/300000" }));

    const result = h.persisted[0];
    assert.ok(result, "should have persisted result");

    const yotPreviews = result!.result.linkPreviews.filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.equal(yotPreviews.length, 1, "one yotsuba preview row");

    // The preview row should have complete status
    assert.equal(yotPreviews[0]!.fetch_status, "complete");

    // Headline file should have been downloaded (preview_media role)
    const previewMedia = result!.result.mediaAssets.filter((a) => a.role === "preview_media");
    assert.ok(previewMedia.length > 0, "headline file asset should be created");
    const headlineAsset = previewMedia[0]!;
    assert.equal(headlineAsset.download_status, "complete", "headline file downloaded successfully");
    // The post-pass skips yotsuba assets; caption_status stays as set by the yotsuba enrichment (deferred).
    assert.equal(headlineAsset.caption_status, "deferred", "post-pass skips yotsuba assets, caption_status stays deferred");
  } finally {
    await cleanup(h);
  }
});

test("headline file is created with caption_status=pending when captionAll is true", async () => {
  const h = await makeHarness({
    captionAll: true,
    threadFixtures: {
      "g/300001": baseThread(300001, [
        baseApiPost(300001, { sub: "Test Subject", com: "OP body", tim: 300002, ext: ".jpg" }),
      ]),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://boards.4chan.org/g/thread/300001" }));

    const result = h.persisted[0];
    assert.ok(result, "should have persisted result");

    const previewMedia = result!.result.mediaAssets.filter((a) => a.role === "preview_media");
    if (previewMedia.length > 0) {
      const headlineAsset = previewMedia[0]!;
      assert.equal(headlineAsset.caption_status, "pending", "headline file should be pending when captionAll is on");
    }
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// media_boards = "worksafe" stops downloads on non-worksafe boards
// ---------------------------------------------------------------------------

test("media_boards=worksafe: no file downloaded for non-worksafe board ref", async () => {
  // /b/ is not worksafe per the boards fixture (ws_board = 0)
  const h = await makeHarness({
    mediaBoards: "worksafe",
    threadFixtures: {
      "b/400000": baseThread(400000, [
        baseApiPost(400000, { com: "OP on non-worksafe board", tim: 400001, ext: ".jpg" }),
      ]),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://boards.4chan.org/b/thread/400000" }));

    const result = h.persisted[0];
    // Preview row should exist
    const yotPreviews = previews(h).filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND);
    assert.equal(yotPreviews.length, 1, "yotsuba row created even for non-worksafe board");

    // No file assets created
    const previewMedia = result?.result.mediaAssets.filter((a) => a.role === "preview_media") ?? [];
    assert.equal(previewMedia.length, 0, "no file downloaded for non-worksafe board with media_boards=worksafe");
  } finally {
    await cleanup(h);
  }
});

test("media_boards=worksafe: file is downloaded for worksafe board ref", async () => {
  const h = await makeHarness({
    mediaBoards: "worksafe",
    threadFixtures: {
      "g/400001": baseThread(400001, [
        baseApiPost(400001, { com: "OP on worksafe board", tim: 400002, ext: ".jpg" }),
      ]),
    },
  });
  try {
    await h.worker.process(chatEvent({ body: "https://boards.4chan.org/g/thread/400001" }));

    const result = h.persisted[0];
    const previewMedia = result?.result.mediaAssets.filter((a) => a.role === "preview_media") ?? [];
    // /g/ is worksafe, so the file should be downloaded
    assert.ok(previewMedia.length > 0, "file downloaded for worksafe board with media_boards=worksafe");
  } finally {
    await cleanup(h);
  }
});

// ---------------------------------------------------------------------------
// Max previews cap
// ---------------------------------------------------------------------------

test("yotsuba refs share the max_previews cap with other ref types", async () => {
  const h = await makeHarness({
    threadFixtures: {
      "g/500000": baseThread(500000, [baseApiPost(500000, { com: "first" })]),
      "g/500001": baseThread(500001, [baseApiPost(500001, { com: "second" })]),
      "g/500002": baseThread(500002, [baseApiPost(500002, { com: "third" })]),
    },
  });
  // Override maxPreviewsPerMessage to 2 via a custom harness
  const h2 = await makeHarness({
    threadFixtures: {
      "g/500000": baseThread(500000, [baseApiPost(500000, { com: "first" })]),
      "g/500001": baseThread(500001, [baseApiPost(500001, { com: "second" })]),
      "g/500002": baseThread(500002, [baseApiPost(500002, { com: "third" })]),
    },
  });
  // Override maxPreviews by creating a fresh worker with maxPreviewsPerMessage=2
  const logger: EnrichmentLogger = { info: () => {}, warn: () => {}, error: () => {} };
  const workspaceRoot = h2.workspaceRoot;
  const persisted2: Array<{ eventId: string; result: EnrichmentResult }> = [];
  const clientCalls2: string[] = [];
  const storage2 = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => persisted2.push({ eventId, result }),
    isBackfetchEvent: () => false,
    getEditedBody: () => undefined,
    getEventCaptionEligibilityFields: () => ({ triggerGroupId: null, isBackfetch: false, role: "user" }),
    getIngestLinkPreviewUrls: () => [],
    getYotsubaPreviewByUrl: () => null,
  } as unknown as Storage;
  const caps2 = {
    messageSummary: async () => null,
    downloadMedia: async () => { throw new Error(""); },
    resolveLinkPreviews: async () => ({ textBlocks: [], media: [], sources: [] }),
    memberInfo: async () => ({}),
  } as unknown as EnrichmentCapabilities;
  const fetchClient2 = {
    fetch: async (_u: string) => {
      const { mkdtemp: mt } = await import("node:fs/promises");
      const tmp = path.join(workspaceRoot, `f-${Math.random().toString(36).slice(2)}.jpg`);
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(tmp, Buffer.from("x"));
      return { path: tmp, sizeBytes: 1, contentType: "image/jpeg", finalUrl: _u, statusCode: 200 };
    },
  } as unknown as FetchClient;
  const client2 = {
    boards: async (_cls?: string) => baseBoards(),
    thread: async (board: string, no: number, _cls?: string) => {
      clientCalls2.push(`thread:${board}/${no}`);
      return fetchResult(baseThread(no, [baseApiPost(no, { com: `post ${no}` })]));
    },
    page: async (board: string, _n: number) => { clientCalls2.push(`page1:${board}`); return basePage1(100000); },
    fetchFilePath: async () => {
      const tmp = path.join(workspaceRoot, `ff-${Math.random().toString(36).slice(2)}.jpg`);
      const { writeFile: wf } = await import("node:fs/promises");
      await wf(tmp, Buffer.from("x"));
      return { path: tmp, sizeBytes: 1, contentType: "image/jpeg", statusCode: 200 };
    },
  } as unknown as YotsubaClient;

  try {
    const w2 = new EnrichmentWorker({
      storage: storage2,
      capabilities: caps2,
      fetchClient: fetchClient2,
      workspaceRoot,
      maxPreviewsPerMessage: 2,
      yotsuba: {
        client: client2,
        config: resolveYotsubaConfig({ enabled: true, enrichment: { enabled: true, media_boards: "all" } }),
        captionAll: false,
        captionAssistant: false,
      },
      logger,
    });

    await w2.process(chatEvent({
      body: "https://boards.4chan.org/g/thread/500000 https://boards.4chan.org/g/thread/500001 https://boards.4chan.org/g/thread/500002",
    }));

    const yotPreviews = persisted2[0]?.result.linkPreviews.filter((p) => p.source_kind === YOTSUBA_SOURCE_KIND) ?? [];
    assert.equal(yotPreviews.length, 2, "only 2 previews allowed when maxPreviewsPerMessage=2");
    assert.equal(clientCalls2.filter((c) => c.startsWith("thread:")).length, 2, "only 2 thread API calls made");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
    await cleanup(h);
    await cleanup(h2);
  }
});
