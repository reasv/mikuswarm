/**
 * Phase 5 enrichment tests — downloadUrl, messageSummary reshape,
 * reply-attachment loop, DirectLinkPreviewClient, discord_embed precedence.
 *
 * All tests use the Node built-in test runner via tsx, matching the project
 * test style. No live network requests — fetch is stubbed throughout.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FetchClient } from "../src/enrichment/fetch-client.js";
import {
  DirectLinkPreviewClient,
  DIRECT_SCRAPE_SOURCE_KIND,
  DISCORD_EMBED_SOURCE_KIND,
} from "../src/enrichment/index.js";
import { EnrichmentWorker, type EnrichmentLogger } from "../src/enrichment/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "../src/enrichment/types.js";
import type { Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";
import { convertMatrixMessageSummary } from "../src/matrix/provider.js";
import type { MatrixMessageSummary } from "../src/matrix/native-types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PUBLIC_IP = "93.184.216.34"; // example.com's documented address

const ROOM = "!room:example.org";
const ACCOUNT = "miku";
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

function noopLogger(): EnrichmentLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Create a workspace root with the msg-attach subdirectory that the media
 * helpers require (EnrichmentWorkerPool.start() normally creates this).
 */
async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "p5-test-"));
  await mkdir(path.join(root, "msg-attach"), { recursive: true });
  return root;
}

function makeStorage(opts: { ingestUrls?: string[] } = {}): Storage & {
  _persisted: Array<{ eventId: string; result: EnrichmentResult }>;
} {
  const persisted: Array<{ eventId: string; result: EnrichmentResult }> = [];
  const storage = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => {
      persisted.push({ eventId, result });
    },
    isBackfetchEvent: () => false,
    getIngestLinkPreviewUrls: (_eventId: string) => opts.ingestUrls ?? [],
    _persisted: persisted,
  };
  return storage as unknown as Storage & {
    _persisted: Array<{ eventId: string; result: EnrichmentResult }>;
  };
}

/** Stub globalThis.fetch with a router function. Restores original on cleanup. */
function stubFetch(
  routes: (url: string) => { status: number; body?: Buffer; contentType?: string } | null,
): { restore: () => void } {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === "string" ? input : String(input);
    const r = routes(url);
    if (!r) throw new Error(`stubFetch: no route for ${url}`);
    const headers = new Headers();
    if (r.contentType) headers.set("content-type", r.contentType);
    return new Response(r.body ?? Buffer.alloc(0), { status: r.status, headers });
  }) as typeof globalThis.fetch;
  return { restore: () => void (globalThis.fetch = original) };
}

// ---------------------------------------------------------------------------
// §9.2 FetchClient.downloadUrl
// ---------------------------------------------------------------------------

test("FetchClient.downloadUrl: downloads to caller-supplied path and returns sizeBytes + contentType", async () => {
  const workspaceRoot = await makeWorkspace();
  const outputPath = path.join(workspaceRoot, "out.png");
  const payload = Buffer.from("fake-image-data");
  const stub = stubFetch(() => ({ status: 200, body: payload, contentType: "image/png" }));
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 1_000_000 });
  try {
    const result = await client.downloadUrl({
      url: `http://${PUBLIC_IP}/asset.png`,
      outputPath,
    });
    assert.equal(result.sizeBytes, payload.length);
    assert.equal(result.contentType, "image/png");
  } finally {
    stub.restore();
    client.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("FetchClient.downloadUrl: throws on non-2xx status", async () => {
  const workspaceRoot = await makeWorkspace();
  const outputPath = path.join(workspaceRoot, "out.bin");
  const stub = stubFetch(() => ({ status: 404, body: Buffer.from("not found") }));
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 1_000_000 });
  try {
    await assert.rejects(
      client.downloadUrl({ url: `http://${PUBLIC_IP}/missing`, outputPath }),
      /HTTP 404/,
    );
  } finally {
    stub.restore();
    client.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("FetchClient.downloadUrl: respects sizeLimit", async () => {
  const workspaceRoot = await makeWorkspace();
  const outputPath = path.join(workspaceRoot, "out.bin");
  const stub = stubFetch(() => ({
    status: 200,
    body: Buffer.alloc(200),
    contentType: "application/octet-stream",
  }));
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 1_000_000 });
  try {
    await assert.rejects(
      client.downloadUrl({ url: `http://${PUBLIC_IP}/big`, outputPath, sizeLimit: 10 }),
      /exceeded/i,
    );
  } finally {
    stub.restore();
    client.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §9.3 messageSummary reshape: Matrix single-attachment path byte-identical
// ---------------------------------------------------------------------------

test("messageSummary reshape: Matrix single-attachment reply downloads byte-identically to old msgtype path", async () => {
  // A Matrix m.image reply — the worker should produce exactly one reply_attachment
  // MediaAssetRow with role 'reply_attachment', source_index 0, and id ending in
  // ':reply_attach:0', matching what the old single-attachment path produced.
  const workspaceRoot = await makeWorkspace();
  const payload = Buffer.from("image-bytes");

  const storage = makeStorage();

  const capabilities: Partial<EnrichmentCapabilities> = {
    downloadMedia: async (params) => {
      await writeFile(params.outputPath, payload);
      return { sizeBytes: payload.length, contentType: "image/png", filename: "cat.png", kind: "image" };
    },
    messageSummary: async () => ({
      eventId: "$orig",
      sender: "@bob:example.org",
      body: "cat.png",
      timestamp: "2024-01-01T00:00:00Z",
      // New shape: attachments array (no msgtype)
      attachments: [{ mediaType: "image", filename: "cat.png", mimeType: "image/png" }],
    }),
    resolveLinkPreviews: async () => ({ textBlocks: [], media: [], sources: [] }),
    memberInfo: async () => ({}),
  };

  const worker = new EnrichmentWorker({
    storage,
    capabilities: capabilities as EnrichmentCapabilities,
    fetchClient: {} as any,
    workspaceRoot,
    maxPreviewsPerMessage: 3,
    logger: noopLogger(),
  });

  try {
    await worker.process(chatEvent({ replyTo: { externalId: "$orig" } }));

    assert.equal(storage._persisted.length, 1);
    const { result } = storage._persisted[0];

    const replyAttachments = result.mediaAssets.filter((a) => a.role === "reply_attachment");
    assert.equal(replyAttachments.length, 1, "exactly one reply attachment row");

    const ra = replyAttachments[0];
    assert.equal(ra.id, `matrix:${ACCOUNT}:$msg:reply_attach:0`, "asset id ends in :reply_attach:0");
    assert.equal(ra.source_index, 0);
    assert.equal(ra.media_type, "image");
    assert.equal(ra.download_status, "complete");
    assert.ok(ra.local_path, "local_path is set");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("messageSummary reshape: summary with no attachments produces no reply_attachment rows", async () => {
  const workspaceRoot = await makeWorkspace();
  const storage = makeStorage();

  const capabilities: Partial<EnrichmentCapabilities> = {
    downloadMedia: async () => { throw new Error("should not be called"); },
    messageSummary: async () => ({
      eventId: "$orig",
      sender: "@bob:example.org",
      body: "text message",
      timestamp: "2024-01-01T00:00:00Z",
      // No attachments → old m.text behaviour
    }),
    resolveLinkPreviews: async () => ({ textBlocks: [], media: [], sources: [] }),
    memberInfo: async () => ({}),
  };

  const worker = new EnrichmentWorker({
    storage,
    capabilities: capabilities as EnrichmentCapabilities,
    fetchClient: {} as any,
    workspaceRoot,
    maxPreviewsPerMessage: 3,
    logger: noopLogger(),
  });

  try {
    await worker.process(chatEvent({ replyTo: { externalId: "$orig" } }));

    assert.equal(storage._persisted.length, 1);
    const replyAttachments = storage._persisted[0].result.mediaAssets.filter((a) => a.role === "reply_attachment");
    assert.equal(replyAttachments.length, 0, "no reply attachment rows for a text-only reply");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §9.3 reply-attachment loop: multi-attachment Discord-shaped summary
// ---------------------------------------------------------------------------

test("reply-attachment loop: downloads ALL attachments (not just index 0) for multi-attachment summary", async () => {
  // Synthetic Discord-shaped reply with 2 attachments carrying remoteUrl.
  // Verifies that both indices are downloaded and produce separate MediaAssetRows.
  const workspaceRoot = await makeWorkspace();
  const payload = Buffer.from("media-content");

  // Use the SSRF guard disabled so test URLs (not real public IPs) work.
  const stub = stubFetch((url) => {
    if (url.startsWith(`http://${PUBLIC_IP}/cdn/`)) {
      return { status: 200, body: payload, contentType: "image/png" };
    }
    return null;
  });

  const storage = makeStorage();

  const capabilities: Partial<EnrichmentCapabilities> = {
    downloadMedia: async () => {
      throw new Error("should not be called — all attachments have remoteUrl");
    },
    messageSummary: async () => ({
      eventId: "$orig",
      sender: "@discord-user:discord",
      body: "",
      timestamp: "2024-01-01T00:00:00Z",
      attachments: [
        {
          mediaType: "image",
          filename: "a.png",
          mimeType: "image/png",
          remoteUrl: `http://${PUBLIC_IP}/cdn/a.png`,
        },
        {
          mediaType: "image",
          filename: "b.png",
          mimeType: "image/png",
          remoteUrl: `http://${PUBLIC_IP}/cdn/b.png`,
        },
      ],
    }),
    resolveLinkPreviews: async () => ({ textBlocks: [], media: [], sources: [] }),
    memberInfo: async () => ({}),
  };

  const fetchClient = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 10_000_000 });
  const worker = new EnrichmentWorker({
    storage,
    capabilities: capabilities as EnrichmentCapabilities,
    fetchClient,
    workspaceRoot,
    maxPreviewsPerMessage: 3,
    logger: noopLogger(),
  });

  try {
    await worker.process(chatEvent({ replyTo: { externalId: "$orig" } }));

    assert.equal(storage._persisted.length, 1);
    const replyAttachments = storage._persisted[0].result.mediaAssets
      .filter((a) => a.role === "reply_attachment")
      .sort((a, b) => (a.source_index ?? 0) - (b.source_index ?? 0));

    assert.equal(replyAttachments.length, 2, "both reply attachments downloaded");
    assert.equal(replyAttachments[0].source_index, 0);
    assert.ok(replyAttachments[0].id.endsWith(":reply_attach:0"));
    assert.equal(replyAttachments[0].download_status, "complete");
    assert.equal(replyAttachments[1].source_index, 1);
    assert.ok(replyAttachments[1].id.endsWith(":reply_attach:1"));
    assert.equal(replyAttachments[1].download_status, "complete");
  } finally {
    stub.restore();
    fetchClient.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §9.2 downloadAttachments: remoteUrl path (Discord main-message attachment)
// ---------------------------------------------------------------------------

test("downloadAttachments: attachment with remoteUrl uses FetchClient.downloadUrl, not downloadMedia RPC", async () => {
  const workspaceRoot = await makeWorkspace();
  const payload = Buffer.from("discord-cdn-bytes");
  const downloadMediaCalled: string[] = [];
  const cdnUrl = `http://${PUBLIC_IP}/cdn/attach.png`;

  const stub = stubFetch((url) => {
    if (url === cdnUrl) {
      return { status: 200, body: payload, contentType: "image/png" };
    }
    return null;
  });

  const storage = makeStorage();

  const capabilities: Partial<EnrichmentCapabilities> = {
    downloadMedia: async (params) => {
      downloadMediaCalled.push(params.eventId);
      throw new Error("Matrix RPC must not be called for remoteUrl attachments");
    },
    messageSummary: async () => null,
    resolveLinkPreviews: async () => ({ textBlocks: [], media: [], sources: [] }),
    memberInfo: async () => ({}),
  };

  const fetchClient = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 10_000_000 });
  const worker = new EnrichmentWorker({
    storage,
    capabilities: capabilities as EnrichmentCapabilities,
    fetchClient,
    workspaceRoot,
    maxPreviewsPerMessage: 3,
    logger: noopLogger(),
  });

  try {
    await worker.process(chatEvent({
      attachments: [{
        id: "attach-0",
        mediaType: "image",
        mimeType: "image/png",
        filename: "attach.png",
        remoteUrl: cdnUrl,
      }],
    }));

    assert.equal(storage._persisted.length, 1);
    const attachments = storage._persisted[0].result.mediaAssets.filter((a) => a.role === "attachment");
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].download_status, "complete");
    assert.equal(attachments[0].media_type, "image");
    assert.equal(downloadMediaCalled.length, 0, "Matrix RPC must NOT have been called");
  } finally {
    stub.restore();
    fetchClient.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("downloadAttachments: no remoteUrl + no roomId → attachment silently skipped (no row created)", async () => {
  // Simulates a malformed timeline key scenario (roomId=null) with no remoteUrl.
  const workspaceRoot = await makeWorkspace();
  const storage = makeStorage();

  const capabilities: Partial<EnrichmentCapabilities> = {
    downloadMedia: async () => { throw new Error("must not be called"); },
    messageSummary: async () => null,
    resolveLinkPreviews: async () => ({ textBlocks: [], media: [], sources: [] }),
    memberInfo: async () => ({}),
  };

  const worker = new EnrichmentWorker({
    storage,
    capabilities: capabilities as EnrichmentCapabilities,
    fetchClient: {} as any,
    workspaceRoot,
    maxPreviewsPerMessage: 3,
    logger: noopLogger(),
  });

  // malformed key → channelIdFromTimelineKey returns undefined
  try {
    await worker.process(chatEvent({
      timelineKey: "malformed-key",
      attachments: [{ id: "a", mediaType: "image" }],
    }));

    assert.equal(storage._persisted.length, 1);
    const attachments = storage._persisted[0].result.mediaAssets.filter((a) => a.role === "attachment");
    assert.equal(attachments.length, 0, "no row created — skipped as before");
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §9.3 DirectLinkPreviewClient — meta scrape with fixture HTML
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html><head>
<title>Page Title</title>
<meta property="og:title" content="Open Graph Title">
<meta property="og:description" content="An og description with &amp; entities">
<meta property="og:site_name" content="Example Site">
<meta name="twitter:title" content="Twitter Title">
<meta name="twitter:description" content="Twitter description">
</head><body><p>content</p></body></html>`;

const TWITTER_ONLY_HTML = `<!DOCTYPE html>
<html><head>
<meta name="twitter:title" content="Twitter Only Title">
<meta name="twitter:description" content="Twitter only description">
</head><body></body></html>`;

const NO_META_HTML = `<!DOCTYPE html>
<html><head><title>No OG</title></head><body><p>no meta</p></body></html>`;

test("DirectLinkPreviewClient: scrapes og: meta from fixture HTML (og: wins over twitter:)", async () => {
  const stub = stubFetch((url) => {
    if (url === `http://${PUBLIC_IP}/page`) {
      return { status: 200, body: Buffer.from(FIXTURE_HTML), contentType: "text/html; charset=utf-8" };
    }
    return null;
  });
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 500_000 });
  try {
    const dlpClient = new DirectLinkPreviewClient(client);
    const results = await dlpClient.resolve({
      bodyText: `check out http://${PUBLIC_IP}/page`,
      maxPreviews: 3,
    });
    assert.equal(results.length, 1);
    const [r] = results;
    assert.equal(r.url, `http://${PUBLIC_IP}/page`);
    assert.equal(r.title, "Open Graph Title");
    assert.equal(r.description, "An og description with & entities"); // entity decoded
    assert.equal(r.siteName, "Example Site");
    assert.equal(r.sourceKind, DIRECT_SCRAPE_SOURCE_KIND);
  } finally {
    stub.restore();
    client.stop();
  }
});

test("DirectLinkPreviewClient: falls back to twitter: when og: is absent", async () => {
  // Route /no-og-page to twitter-only HTML (no og: tags, has twitter: tags).
  const targetUrl = `http://${PUBLIC_IP}/no-og-page`;
  const stub = stubFetch((url) => {
    if (url === targetUrl) {
      return { status: 200, body: Buffer.from(TWITTER_ONLY_HTML), contentType: "text/html" };
    }
    return null;
  });
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 500_000 });
  try {
    const dlpClient = new DirectLinkPreviewClient(client);
    const results = await dlpClient.resolve({
      bodyText: `check out ${targetUrl}`,
      maxPreviews: 3,
    });
    // twitter: tags are present and provide title+description, so 1 result expected
    assert.equal(results.length, 1);
    assert.equal(results[0].url, targetUrl);
    assert.equal(results[0].title, "Twitter Only Title");
    assert.equal(results[0].description, "Twitter only description");
    assert.equal(results[0].sourceKind, DIRECT_SCRAPE_SOURCE_KIND);
  } finally {
    stub.restore();
    client.stop();
  }
});

test("DirectLinkPreviewClient: returns empty array when no title or description found", async () => {
  const stub = stubFetch(() => ({
    status: 200,
    body: Buffer.from(NO_META_HTML),
    contentType: "text/html",
  }));
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 500_000 });
  try {
    const dlpClient = new DirectLinkPreviewClient(client);
    const results = await dlpClient.resolve({
      bodyText: `http://${PUBLIC_IP}/no-og`,
      maxPreviews: 3,
    });
    assert.equal(results.length, 0, "no result when og/twitter meta is absent");
  } finally {
    stub.restore();
    client.stop();
  }
});

test("DirectLinkPreviewClient: skips non-HTML content types", async () => {
  const stub = stubFetch(() => ({
    status: 200,
    body: Buffer.alloc(100),
    contentType: "image/png",
  }));
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 500_000 });
  try {
    const dlpClient = new DirectLinkPreviewClient(client);
    const results = await dlpClient.resolve({
      bodyText: `http://${PUBLIC_IP}/image.png`,
      maxPreviews: 3,
    });
    assert.equal(results.length, 0, "no result for non-HTML responses");
  } finally {
    stub.restore();
    client.stop();
  }
});

test("DirectLinkPreviewClient: swallows per-URL errors non-fatally", async () => {
  const goodUrl = `http://${PUBLIC_IP}/good`;
  const badUrl = `http://${PUBLIC_IP}/bad`;
  const stub = stubFetch((url) => {
    if (url === goodUrl) {
      return { status: 200, body: Buffer.from(FIXTURE_HTML), contentType: "text/html" };
    }
    if (url === badUrl) throw new Error("network failure");
    return null;
  });
  const client = new FetchClient({
    timeoutMs: 5_000,
    maxResponseBytes: 500_000,
    maxRetries: 0, // don't retry so test is fast
  });
  try {
    const dlpClient = new DirectLinkPreviewClient(client);
    const results = await dlpClient.resolve({
      bodyText: `${badUrl} ${goodUrl}`,
      maxPreviews: 3,
    });
    // bad URL throws → swallowed; good URL scrapes successfully
    assert.equal(results.length, 1);
    assert.equal(results[0].url, goodUrl);
  } finally {
    stub.restore();
    client.stop();
  }
});

// ---------------------------------------------------------------------------
// §9.3 DirectLinkPreviewClient: discord_embed precedence
// ---------------------------------------------------------------------------

test("discord_embed precedence: DirectLinkPreviewClient excludes URLs in excludeUrls", async () => {
  const alreadyUrl = `http://${PUBLIC_IP}/already-previewed`;
  const newUrl = `http://${PUBLIC_IP}/new-url`;
  const scrapedUrls: string[] = [];
  const stub = stubFetch((url) => {
    scrapedUrls.push(url);
    return { status: 200, body: Buffer.from(FIXTURE_HTML), contentType: "text/html" };
  });
  const client = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 500_000 });
  try {
    const dlpClient = new DirectLinkPreviewClient(client);
    const results = await dlpClient.resolve({
      bodyText: `${alreadyUrl} ${newUrl}`,
      maxPreviews: 3,
      excludeUrls: new Set([alreadyUrl]),
    });
    assert.equal(
      scrapedUrls.filter((u) => u === alreadyUrl).length,
      0,
      "excluded URL must not be fetched",
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].url, newUrl);
  } finally {
    stub.restore();
    client.stop();
  }
});

test("DirectLinkPreviewClient used as fallback when resolveLinkPreviews is absent", async () => {
  // When capabilities.resolveLinkPreviews is absent, the worker uses
  // DirectLinkPreviewClient. This test exercises the integration path.
  const workspaceRoot = await makeWorkspace();
  const previewUrl = `http://${PUBLIC_IP}/some-page`;

  const stub = stubFetch((url) => {
    if (url === previewUrl) {
      return { status: 200, body: Buffer.from(FIXTURE_HTML), contentType: "text/html" };
    }
    return null;
  });

  const storage = makeStorage(); // no ingest URLs

  // NO resolveLinkPreviews method → triggers DirectLinkPreviewClient path
  const capabilities: Partial<EnrichmentCapabilities> = {
    downloadMedia: async () => { throw new Error("not under test"); },
    messageSummary: async () => null,
    // resolveLinkPreviews intentionally absent
    memberInfo: async () => ({}),
  };

  const fetchClient = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 500_000 });
  const worker = new EnrichmentWorker({
    storage,
    capabilities: capabilities as EnrichmentCapabilities,
    fetchClient,
    workspaceRoot,
    maxPreviewsPerMessage: 3,
    logger: noopLogger(),
  });

  try {
    await worker.process(chatEvent({ body: `check out ${previewUrl}` }));

    assert.equal(storage._persisted.length, 1);
    const previews = storage._persisted[0].result.linkPreviews;
    assert.equal(previews.length, 1, "one link preview produced via DirectLinkPreviewClient");
    assert.equal(previews[0].url, previewUrl);
    assert.equal(previews[0].title, "Open Graph Title");
    assert.equal(previews[0].source_kind, DIRECT_SCRAPE_SOURCE_KIND);
  } finally {
    stub.restore();
    fetchClient.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// source_kind constants
// ---------------------------------------------------------------------------

test("DISCORD_EMBED_SOURCE_KIND and DIRECT_SCRAPE_SOURCE_KIND are the expected strings", () => {
  assert.equal(DISCORD_EMBED_SOURCE_KIND, "discord_embed");
  assert.equal(DIRECT_SCRAPE_SOURCE_KIND, "direct_scrape");
});

// ---------------------------------------------------------------------------
// convertMatrixMessageSummary
// ---------------------------------------------------------------------------

test("convertMatrixMessageSummary: m.image with media array → one attachment with mediaType 'image' and filename/mime", () => {
  const summary: MatrixMessageSummary = {
    eventId: "$img",
    sender: "@alice:example.org",
    body: "cat.png",
    msgtype: "m.image",
    timestamp: "2024-01-01T00:00:00Z",
    media: [{ index: 0, kind: "image", filename: "cat.png", contentType: "image/png", sizeBytes: 1234 }],
  };
  const result = convertMatrixMessageSummary(summary);
  assert.ok(Array.isArray(result.attachments), "attachments must be an array");
  assert.equal(result.attachments!.length, 1);
  assert.equal(result.attachments![0].mediaType, "image");
  assert.equal(result.attachments![0].filename, "cat.png");
  assert.equal(result.attachments![0].mimeType, "image/png");
});

test("convertMatrixMessageSummary: m.text → no attachments field (undefined, not empty array)", () => {
  const summary: MatrixMessageSummary = {
    eventId: "$txt",
    sender: "@alice:example.org",
    body: "hello world",
    msgtype: "m.text",
    timestamp: "2024-01-01T00:00:00Z",
  };
  const result = convertMatrixMessageSummary(summary);
  assert.equal(result.attachments, undefined, "attachments must be undefined for m.text");
});

test("convertMatrixMessageSummary: m.notice → no attachments field (undefined, not empty array)", () => {
  const summary: MatrixMessageSummary = {
    eventId: "$ntc",
    sender: "@alice:example.org",
    body: "notice text",
    msgtype: "m.notice",
    timestamp: "2024-01-01T00:00:00Z",
  };
  const result = convertMatrixMessageSummary(summary);
  assert.equal(result.attachments, undefined, "attachments must be undefined for m.notice");
});

test("convertMatrixMessageSummary: m.image with media array absent → fallback produces one attachment with mediaType 'image', no filename/mime", () => {
  // Defensive fallback: msgtype is 'm.image' but media array is absent (e.g. older Rust payload).
  const summary: MatrixMessageSummary = {
    eventId: "$img-fallback",
    sender: "@alice:example.org",
    body: "cat.png",
    msgtype: "m.image",
    timestamp: "2024-01-01T00:00:00Z",
    // media intentionally absent
  };
  const result = convertMatrixMessageSummary(summary);
  assert.ok(Array.isArray(result.attachments), "attachments must be an array even without media");
  assert.equal(result.attachments!.length, 1, "exactly one attachment from fallback");
  assert.equal(result.attachments![0].mediaType, "image");
  assert.equal(result.attachments![0].filename, undefined, "filename undefined in fallback path");
  assert.equal(result.attachments![0].mimeType, undefined, "mimeType undefined in fallback path");
});
