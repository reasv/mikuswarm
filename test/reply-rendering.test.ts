import assert from "node:assert/strict";
import test from "node:test";
import { renderRichMessage } from "../src/context/renderer.js";
import { EnrichmentWorker, type EnrichmentLogger } from "../src/enrichment/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "../src/enrichment/types.js";
import type { FetchClient } from "../src/enrichment/fetch-client.js";
import type { Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const ACCOUNT = "miku";
const ROOM = "!elYlikKvtcCupsYUEB:example.com";
const ROOM_TK = `matrix:${ACCOUNT}:room:${ROOM}`;

function chatEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: `matrix:${ACCOUNT}:$msg`,
    externalId: "$msg",
    timelineKey: ROOM_TK,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body: "Thanks darling",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ── Renderer: unresolved reply context ──────────────────────────────────────

test("renderRichMessage marks an unresolved reply instead of an empty block", () => {
  // Enrichment hasn't run (or the target couldn't be fetched): replyTo carries
  // only the external id. The model must see "unavailable", not a blank quote.
  const event = chatEvent({ replyTo: { externalId: "$orig" } });
  const out = renderRichMessage(event);
  assert.match(out, /<reply_to external_id="\$orig">/);
  assert.match(out, /\[original message unavailable\]/);
  assert.ok(!out.includes("<reply_to external_id=\"$orig\">\n\n</reply_to>"), "no empty quote block");
});

test("renderRichMessage renders a resolved reply body without the placeholder", () => {
  const event = chatEvent({
    replyTo: {
      externalId: "$orig",
      sender: { id: "@mongo:example.org", displayName: "Mongo" },
      body: "https://example.org/ check this out",
      timestamp: 1_699_999_000_000,
    },
  });
  const out = renderRichMessage(event);
  assert.match(out, /<reply_to sender="@mongo:example\.org"/);
  assert.match(out, /check this out/);
  assert.ok(!out.includes("[original message unavailable]"));
});

test("renderRichMessage shows a reply attachment without the placeholder even when the body is empty", () => {
  const event = chatEvent({
    replyTo: {
      externalId: "$orig",
      sender: { id: "@mongo:example.org" },
      attachments: [
        {
          id: "$orig:reply_attach:0",
          filename: "cat.png",
          mediaType: "image",
          processing: { downloaded: true, captioned: false },
        },
      ],
    },
  });
  const out = renderRichMessage(event);
  assert.match(out, /cat\.png/);
  assert.ok(!out.includes("[original message unavailable]"));
});

// ── Enrichment worker: room id parsing + reply resolution logging ───────────

function collectLogger(): { logger: EnrichmentLogger; entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> } {
  const entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = [];
  return {
    entries,
    logger: {
      info: (msg, data) => entries.push({ level: "info", msg, data }),
      warn: (msg, data) => entries.push({ level: "warn", msg, data }),
      error: (msg, data) => entries.push({ level: "error", msg, data }),
    },
  };
}

interface WorkerHarness {
  worker: EnrichmentWorker;
  persisted: Array<{ eventId: string; result: EnrichmentResult }>;
  summaryCalls: Array<{ roomId: string; eventId: string }>;
  entries: Array<{ level: string; msg: string; data?: Record<string, unknown> }>;
}

function makeWorker(
  messageSummary: EnrichmentCapabilities["messageSummary"],
): WorkerHarness {
  const persisted: Array<{ eventId: string; result: EnrichmentResult }> = [];
  const summaryCalls: Array<{ roomId: string; eventId: string }> = [];
  const storage = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => {
      persisted.push({ eventId, result });
    },
    // Backfetch provenance lookup (caption deferral, MESSAGE-BACKFETCH §7.3); the
    // fixtures here are all live events.
    isBackfetchEvent: () => false,
  } as unknown as Storage;
  const capabilities = {
    messageSummary: async (params: { roomId: string; eventId: string }) => {
      summaryCalls.push(params);
      return messageSummary(params);
    },
    downloadMedia: async () => {
      throw new Error("not under test");
    },
    resolveLinkPreviews: async () => ({ textBlocks: [], media: [], sources: [] }),
    memberInfo: async () => ({}),
  } as unknown as EnrichmentCapabilities;
  const { logger, entries } = collectLogger();
  const worker = new EnrichmentWorker({
    storage,
    capabilities,
    fetchClient: {} as FetchClient,
    workspaceRoot: "/nonexistent",
    maxPreviewsPerMessage: 3,
    logger,
  });
  return { worker, persisted, summaryCalls, entries };
}

test("enrichment passes the full room id (server part included) to messageSummary", async () => {
  // Regression: a split(":") parser truncated `!local:server` room ids at the
  // server colon, so every reply lookup hit an unknown room and degraded to a
  // bodyless stub.
  const h = makeWorker(async () => ({
    eventId: "$orig",
    sender: "@mongo:example.org",
    senderName: "Mongo",
    body: "original text",
    msgtype: "m.text",
    timestamp: "2023-11-14T22:13:20Z",
  }));
  await h.worker.process(chatEvent({ replyTo: { externalId: "$orig" } }));

  assert.equal(h.summaryCalls.length, 1);
  assert.equal(h.summaryCalls[0].roomId, ROOM, "room id must keep its server part");
  assert.equal(h.persisted.length, 1);
  const replyContext = h.persisted[0].result.replyContext;
  assert.ok(replyContext, "reply context persisted");
  assert.equal(replyContext.body, "original text");
  assert.equal(replyContext.sender_id, "@mongo:example.org");
});

test("enrichment logs a reply resolution failure instead of swallowing it", async () => {
  const h = makeWorker(async () => {
    throw new Error("room !x is not known to the client");
  });
  await h.worker.process(chatEvent({ replyTo: { externalId: "$orig" } }));

  const failure = h.entries.find((entry) => entry.msg === "enrichment_reply_resolution_failed");
  assert.ok(failure, "failure is logged");
  assert.equal(failure.level, "error");
  assert.match(String(failure.data?.error), /not known to the client/);
  // Still degrades to a stub row so the renderer can mark it unavailable.
  const replyContext = h.persisted[0]?.result.replyContext;
  assert.ok(replyContext, "stub reply context persisted");
  assert.equal(replyContext.body, undefined);
  assert.equal(replyContext.reply_external_id, "$orig");
});

test("enrichment logs a missing reply target (null summary)", async () => {
  const h = makeWorker(async () => null);
  await h.worker.process(chatEvent({ replyTo: { externalId: "$orig" } }));

  const missing = h.entries.find((entry) => entry.msg === "enrichment_reply_target_missing");
  assert.ok(missing, "missing target is logged");
  assert.equal(missing.level, "warn");
  assert.ok(h.persisted[0]?.result.replyContext, "stub reply context persisted");
});

test("enrichment warns and skips room-bound work when the room id cannot be parsed", async () => {
  const h = makeWorker(async () => null);
  await h.worker.process(
    chatEvent({ timelineKey: "bogus-key", replyTo: { externalId: "$orig" } }),
  );

  assert.equal(h.summaryCalls.length, 0, "no capability call without a room id");
  // Event name changed from "enrichment_room_id_unresolved" to the consistent
  // cross-site "timeline_key.malformed" (spec DISCORD-SUPPORT-DESIGN §4.2).
  const warned = h.entries.find((entry) => entry.msg === "timeline_key.malformed");
  assert.ok(warned, "malformed timeline key is logged");
});
