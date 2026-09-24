/**
 * Reply-context resolution without a provider `messageSummary` lookup
 * (ARCHITECTURE.md §7a, step 2).
 *
 * Regression: the Discord provider shipped `messageSummary` as a stub that
 * always returned null, so EVERY Discord reply logged
 * `enrichment_reply_target_missing` and persisted a body-less `reply_contexts`
 * row — which the hydrator then applied over the ingest-time `replyTo` the
 * event already carried, rendering `[original message unavailable]` for a
 * message that was quoted in the payload and stored in `timeline_events`.
 *
 * The worker now treats `messageSummary` as optional. When the provider omits
 * it, the target resolves from (1) the event's own `replyTo` snapshot when it
 * carries a body or attachments, then (2) the stored timeline event; only when
 * both are empty does it warn and stub. When the provider implements the
 * lookup (Matrix), its answer stays authoritative and no fallback runs.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EnrichmentWorker, FetchClient, type EnrichmentLogger } from "../src/enrichment/index.js";
import type { EnrichmentCapabilities, EnrichmentResult } from "../src/enrichment/types.js";
import type { Storage } from "../src/storage/index.js";
import type { CanonicalChatEvent } from "../src/types.js";

const PUBLIC_IP = "93.184.216.34"; // example.com's documented address

const ACCOUNT = "main";
const CHANNEL = "200000000000000001";
const CHANNEL_TK = `discord:${ACCOUNT}:room:${CHANNEL}`;
const TARGET_ID = "100000000000000001";

function discordEvent(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: `discord:${ACCOUNT}:reply-1`,
    externalId: "100000000000000002",
    timelineKey: CHANNEL_TK,
    provider: "discord",
    role: "user",
    sender: { id: "222", username: "bob", displayName: "Bob" },
    body: "replying",
    timestamp: 1_700_000_100_000,
    receivedAt: 1_700_000_100_000,
    ...overrides,
  };
}

/** The target as the timeline store holds it (event_json of an earlier ingest). */
function storedTarget(overrides: Partial<CanonicalChatEvent> = {}): CanonicalChatEvent {
  return {
    id: `discord:${ACCOUNT}:${TARGET_ID}`,
    externalId: TARGET_ID,
    timelineKey: CHANNEL_TK,
    provider: "discord",
    role: "user",
    sender: { id: "111", username: "alice", displayName: "Alice" },
    body: "the original message",
    timestamp: 1_700_000_000_000,
    receivedAt: 1_700_000_000_000,
    ...overrides,
  };
}

type Persisted = Array<{ eventId: string; result: EnrichmentResult }>;
type Lookup = { provider: string; externalId: string; timelineKey: string };

function makeStorage(
  stored?: CanonicalChatEvent,
  editedBodies: Record<string, string> = {},
): Storage & { _persisted: Persisted; _lookups: Lookup[] } {
  const persisted: Persisted = [];
  const lookups: Lookup[] = [];
  const storage = {
    persistEnrichmentResults: async (eventId: string, result: EnrichmentResult) => {
      persisted.push({ eventId, result });
    },
    isBackfetchEvent: () => false,
    getEditedBody: (_timelineKey: string, externalId: string) => editedBodies[externalId],
    getIngestLinkPreviewUrls: () => [],
    getTimelineEventByExternalId: (provider: string, externalId: string, timelineKey: string) => {
      lookups.push({ provider, externalId, timelineKey });
      return stored && stored.externalId === externalId && stored.timelineKey === timelineKey ? stored : undefined;
    },
    _persisted: persisted,
    _lookups: lookups,
  };
  return storage as unknown as Storage & { _persisted: Persisted; _lookups: Lookup[] };
}

function recordingLogger(): EnrichmentLogger & { warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  return {
    info: () => {},
    warn: (msg) => void warns.push(msg),
    error: (msg) => void errors.push(msg),
    warns,
    errors,
  };
}

/** Discord-shaped capabilities: no messageSummary at all. */
function discordCapabilities(): EnrichmentCapabilities {
  return {
    downloadMedia: async () => {
      throw new Error("Discord attachments always carry remoteUrl");
    },
    memberInfo: async () => ({}),
  };
}

function makeWorker(opts: {
  storage: Storage;
  capabilities: EnrichmentCapabilities;
  logger: EnrichmentLogger;
  workspaceRoot?: string;
  fetchClient?: FetchClient;
}): EnrichmentWorker {
  return new EnrichmentWorker({
    storage: opts.storage,
    capabilities: opts.capabilities,
    fetchClient: opts.fetchClient ?? (new FetchClient({ timeoutMs: 1_000, maxResponseBytes: 1_000 })),
    workspaceRoot: opts.workspaceRoot ?? null,
    maxPreviewsPerMessage: 3,
    logger: opts.logger,
  });
}

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
// No provider lookup: ingest snapshot first
// ---------------------------------------------------------------------------

test("no messageSummary: ingest-time replyTo with a body resolves the reply context, no warning, no DB lookup", async () => {
  const storage = makeStorage(storedTarget({ body: "STALE stored copy" }));
  const logger = recordingLogger();
  const worker = makeWorker({ storage, capabilities: discordCapabilities(), logger });

  await worker.process(
    discordEvent({
      replyTo: {
        externalId: TARGET_ID,
        sender: { id: "111", username: "alice", displayName: "Alice" },
        body: "the original message (edited)",
        timestamp: 1_700_000_000_000,
      },
    }),
  );

  assert.equal(storage._persisted.length, 1);
  const rc = storage._persisted[0].result.replyContext;
  assert.ok(rc, "reply context row persisted");
  assert.equal(rc.reply_external_id, TARGET_ID);
  assert.equal(rc.sender_id, "111");
  assert.equal(rc.sender_display_name, "Alice");
  assert.equal(rc.body, "the original message (edited)", "snapshot wins over the stored copy");
  assert.equal(rc.timestamp, 1_700_000_000_000);
  assert.deepEqual(logger.warns, [], "no enrichment_reply_target_missing");
  assert.deepEqual(logger.errors, []);
  assert.equal(storage._lookups.length, 0, "stored copy not consulted when the snapshot is usable");
});

test("no messageSummary: snapshot sender falls back to username when displayName is absent", async () => {
  const storage = makeStorage();
  const logger = recordingLogger();
  const worker = makeWorker({ storage, capabilities: discordCapabilities(), logger });

  await worker.process(
    discordEvent({
      replyTo: { externalId: TARGET_ID, sender: { id: "111", username: "alice" }, body: "hi" },
    }),
  );

  const rc = storage._persisted[0].result.replyContext;
  assert.ok(rc);
  assert.equal(rc.sender_display_name, "alice");
  assert.equal(rc.timestamp, null, "no snapshot timestamp → null, not NaN");
  assert.deepEqual(logger.warns, []);
});

test("no messageSummary: attachment-only snapshot (empty body) counts as resolved and downloads reply attachments", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "reply-fallback-"));
  await mkdir(path.join(workspaceRoot, "msg-attach"), { recursive: true });
  const payload = Buffer.from("png-bytes");
  const stub = stubFetch((url) =>
    url.startsWith(`http://${PUBLIC_IP}/cdn/`) ? { status: 200, body: payload, contentType: "image/png" } : null,
  );
  const fetchClient = new FetchClient({ timeoutMs: 5_000, maxResponseBytes: 10_000_000 });
  const storage = makeStorage();
  const logger = recordingLogger();
  const worker = makeWorker({ storage, capabilities: discordCapabilities(), logger, workspaceRoot, fetchClient });

  try {
    await worker.process(
      discordEvent({
        replyTo: {
          externalId: TARGET_ID,
          sender: { id: "111", username: "alice" },
          body: "",
          attachments: [
            {
              id: `discord:reply:${TARGET_ID}:attach:0`,
              filename: "cat.png",
              mimeType: "image/png",
              mediaType: "image",
              remoteUrl: `http://${PUBLIC_IP}/cdn/cat.png`,
            },
          ],
        },
      }),
    );

    const { result } = storage._persisted[0];
    assert.ok(result.replyContext);
    assert.equal(result.replyContext.body, "");
    assert.deepEqual(logger.warns, [], "an image-only target is not 'missing'");
    const replyAttachments = result.mediaAssets.filter((a) => a.role === "reply_attachment");
    assert.equal(replyAttachments.length, 1);
    assert.equal(replyAttachments[0].download_status, "complete");
    assert.equal(replyAttachments[0].original_filename, "cat.png");
    assert.ok(replyAttachments[0].id.endsWith(":reply_attach:0"));
  } finally {
    stub.restore();
    fetchClient.stop();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// No provider lookup: stored timeline event second
// ---------------------------------------------------------------------------

test("no messageSummary: sender-only snapshot (message-cache miss) falls through to the stored timeline event", async () => {
  const storage = makeStorage(storedTarget());
  const logger = recordingLogger();
  const worker = makeWorker({ storage, capabilities: discordCapabilities(), logger });

  await worker.process(
    discordEvent({
      // What the Discord normalizer builds from mentions.repliedUser on a cache
      // miss: author only, empty body, zero timestamp.
      replyTo: { externalId: TARGET_ID, sender: { id: "111", username: "alice" }, body: "", timestamp: 0 },
    }),
  );

  const rc = storage._persisted[0].result.replyContext;
  assert.ok(rc);
  assert.equal(rc.body, "the original message");
  assert.equal(rc.sender_id, "111");
  assert.equal(rc.sender_display_name, "Alice");
  assert.equal(rc.timestamp, 1_700_000_000_000);
  assert.deepEqual(logger.warns, []);
  assert.deepEqual(storage._lookups, [{ provider: "discord", externalId: TARGET_ID, timelineKey: CHANNEL_TK }]);
});

test("no messageSummary: bare externalId snapshot resolves from the stored timeline event, incl. its attachments", async () => {
  const storage = makeStorage(
    storedTarget({
      body: "look",
      attachments: [
        {
          id: `discord:${ACCOUNT}:${TARGET_ID}:attach:0`,
          filename: "dog.png",
          mimeType: "image/png",
          mediaType: "image",
          remoteUrl: `http://${PUBLIC_IP}/cdn/dog.png`,
        },
      ],
    }),
  );
  const logger = recordingLogger();
  // workspaceRoot null (§4.3): reply text still resolves; the attachment download is skipped.
  const worker = makeWorker({ storage, capabilities: discordCapabilities(), logger });

  await worker.process(discordEvent({ replyTo: { externalId: TARGET_ID } }));

  const { result } = storage._persisted[0];
  assert.ok(result.replyContext);
  assert.equal(result.replyContext.body, "look");
  assert.deepEqual(logger.warns, []);
  assert.equal(result.mediaAssets.filter((a) => a.role === "reply_attachment").length, 0);
});

// ---------------------------------------------------------------------------
// No provider lookup: nothing known → warn + stub (unchanged contract)
// ---------------------------------------------------------------------------

test("no messageSummary: unknown target (no snapshot body, not stored) warns enrichment_reply_target_missing and stubs", async () => {
  const storage = makeStorage();
  const logger = recordingLogger();
  const worker = makeWorker({ storage, capabilities: discordCapabilities(), logger });

  await worker.process(
    discordEvent({ replyTo: { externalId: TARGET_ID, sender: { id: "111", username: "alice" }, body: "" } }),
  );

  const rc = storage._persisted[0].result.replyContext;
  assert.ok(rc, "stub row still written");
  assert.equal(rc.reply_external_id, TARGET_ID);
  assert.equal(rc.body, undefined);
  assert.equal(rc.sender_id, undefined);
  assert.deepEqual(logger.warns, ["enrichment_reply_target_missing"]);
  assert.deepEqual(logger.errors, []);
  assert.equal(storage._lookups.length, 1, "stored copy was consulted before giving up");
});

// ---------------------------------------------------------------------------
// Provider lookup present (Matrix): authoritative, fallbacks never run
// ---------------------------------------------------------------------------

test("messageSummary present and null: stub + warning even though the snapshot and the stored copy could answer", async () => {
  const stored = storedTarget({ provider: "matrix", timelineKey: "matrix:miku:room:!r:example.org", externalId: "$orig" });
  const storage = makeStorage(stored);
  const logger = recordingLogger();
  let calls = 0;
  const capabilities: EnrichmentCapabilities = {
    ...discordCapabilities(),
    messageSummary: async () => {
      calls += 1;
      return null; // redacted / non-message
    },
  };
  const worker = makeWorker({ storage, capabilities, logger });

  await worker.process(
    discordEvent({
      provider: "matrix",
      timelineKey: "matrix:miku:room:!r:example.org",
      replyTo: { externalId: "$orig", sender: { id: "@alice:example.org" }, body: "would-be quote" },
    }),
  );

  assert.equal(calls, 1);
  const rc = storage._persisted[0].result.replyContext;
  assert.ok(rc);
  assert.equal(rc.body, undefined, "provider's null is final: no resurrection from snapshot or DB");
  assert.deepEqual(logger.warns, ["enrichment_reply_target_missing"]);
  assert.equal(storage._lookups.length, 0, "stored copy never consulted when the provider answers");
});

test("messageSummary present: its summary is used verbatim and receives the full room id", async () => {
  const storage = makeStorage();
  const logger = recordingLogger();
  const seen: Array<{ roomId: string; eventId: string }> = [];
  const capabilities: EnrichmentCapabilities = {
    ...discordCapabilities(),
    messageSummary: async (params) => {
      seen.push(params);
      return {
        eventId: "$orig",
        sender: "@alice:example.org",
        senderName: "Alice",
        body: "native summary",
        timestamp: "2024-01-01T00:00:00.000Z",
      };
    },
  };
  const worker = makeWorker({ storage, capabilities, logger });

  await worker.process(
    discordEvent({
      provider: "matrix",
      timelineKey: "matrix:miku:room:!r:example.org",
      replyTo: { externalId: "$orig", body: "snapshot that must lose" },
    }),
  );

  assert.deepEqual(seen, [{ roomId: "!r:example.org", eventId: "$orig" }]);
  const rc = storage._persisted[0].result.replyContext;
  assert.ok(rc);
  assert.equal(rc.body, "native summary");
  assert.equal(rc.timestamp, Date.parse("2024-01-01T00:00:00.000Z"));
  assert.deepEqual(logger.warns, []);
  assert.equal(storage._lookups.length, 0);
});

test("messageSummary present, target edited: the stored post-edit body replaces the original", async () => {
  // A Matrix by-id fetch returns the original event (an edit is a separate
  // m.replace event); the stored row carries the latest applied edit.
  const storage = makeStorage(undefined, { $orig: "the full edited message" });
  const logger = recordingLogger();
  const capabilities: EnrichmentCapabilities = {
    ...discordCapabilities(),
    messageSummary: async () => ({
      eventId: "$orig",
      sender: "@alice:example.org",
      senderName: "Alice",
      body: "the ful",
      timestamp: "2024-01-01T00:00:00.000Z",
    }),
  };
  const worker = makeWorker({ storage, capabilities, logger });

  await worker.process(
    discordEvent({
      provider: "matrix",
      timelineKey: "matrix:miku:room:!r:example.org",
      replyTo: { externalId: "$orig" },
    }),
  );

  const rc = storage._persisted[0].result.replyContext;
  assert.ok(rc);
  assert.equal(rc.body, "the full edited message");
  assert.equal(rc.sender_id, "@alice:example.org", "the rest of the provider summary is kept");
  assert.equal(rc.timestamp, Date.parse("2024-01-01T00:00:00.000Z"));
  assert.deepEqual(logger.warns, []);
});
