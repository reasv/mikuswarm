import assert from "node:assert/strict";
import test from "node:test";
import { Storage } from "../../src/storage/index.js";
import type { PipelineId } from "../../src/storage/index.js";
import { SessionManager } from "../../src/agent/index.js";
import type { AgentSessionFactory } from "../../src/agent/factory.js";
import type { Logger } from "../../src/observability/index.js";
import type { PipelineRegistry, PipelineStats } from "../../src/observability/pipelines.js";
import { PipelineActivityBus } from "../../src/observability/pipelines.js";
import {
  createObservabilityServer,
  type ConsoleServer,
  type ConsoleServerDeps,
} from "../../src/observability/server/index.js";
import type { CanonicalChatEvent } from "../../src/types.js";

const TK = "matrix:miku:room:!room:example.org";
const TK2 = "matrix:miku:room:!other:example.org";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

const throwingFactory = {
  buildPreview: () => {
    throw new Error("buildPreview should not be called in pipeline tests");
  },
} as unknown as AgentSessionFactory;

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

/** A stat seam stub whose inFlight returns a fixed number. */
function stubStats(pool: PipelineId, overrides: Partial<PipelineStats> = {}): PipelineStats {
  return {
    pool,
    workerCount: 2,
    maxRetries: 3,
    inFlight: () => 0,
    ...overrides,
  };
}

function fullRegistry(overrides: Partial<PipelineRegistry> = {}): PipelineRegistry {
  return {
    enrichment: stubStats("enrichment"),
    captioning: stubStats("captioning", { concurrency: { image: 4, audio: 1 } }),
    summarization: stubStats("summarization"),
    diary: stubStats("diary"),
    ...overrides,
  };
}

async function withServer(
  deps: Partial<ConsoleServerDeps> & { storage: Storage },
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const full: ConsoleServerDeps = {
    config: { enabled: true, bind: "127.0.0.1", port: 0, ...deps.config },
    storage: deps.storage,
    factory: deps.factory ?? throwingFactory,
    sessions: deps.sessions ?? new SessionManager(),
    pipelines: deps.pipelines,
    activityBus: deps.activityBus,
    workspaceRoot: deps.workspaceRoot ?? "/tmp",
    logger: deps.logger ?? silentLogger,
  };
  const server: ConsoleServer = createObservabilityServer(full);
  await server.start();
  try {
    await fn(`http://127.0.0.1:${server.address()}`);
  } finally {
    await server.stop();
  }
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

function userEvent(id: string, timelineKey = TK, body = `body ${id}`): CanonicalChatEvent {
  return {
    id,
    timelineKey,
    provider: "matrix",
    role: "user",
    sender: { id: "@alice:example.org", displayName: "Alice" },
    body,
    timestamp: 1_000,
    receivedAt: 1_000,
  };
}

/** Append an enrichment event and force its status/retries/updated_at for the monitor. */
async function enrichEvent(
  storage: Storage,
  id: string,
  status: string,
  opts: { retries?: number; updatedAt?: number; timelineKey?: string; body?: string } = {},
): Promise<void> {
  await storage.appendTimelineEvent(userEvent(id, opts.timelineKey ?? TK, opts.body));
  await storage.write((db) =>
    db
      .prepare(
        `update timeline_events set enrichment_status = ?, enrichment_retries = ?, updated_at = ? where id = ?`,
      )
      .run(status, opts.retries ?? 0, opts.updatedAt ?? 1_000, id),
  );
}

/** Insert a media asset (parent event must already exist). */
async function mediaAsset(
  storage: Storage,
  id: string,
  eventId: string,
  status: string,
  opts: { mediaType?: string; attempts?: number; updatedAt?: number; filename?: string } = {},
): Promise<void> {
  await storage.insertMediaAsset({
    id,
    event_id: eventId,
    role: "attachment",
    media_type: opts.mediaType ?? "image",
    original_filename: opts.filename ?? `${id}.png`,
    caption_status: status,
    caption_attempts: opts.attempts ?? 0,
    download_status: "complete",
    created_at: 1_000,
    updated_at: opts.updatedAt ?? 1_000,
  });
}

async function summarizationJob(
  storage: Storage,
  id: string,
  status: string,
  opts: { attempts?: number; updatedAt?: number; timelineKey?: string } = {},
): Promise<void> {
  await storage.insertSummarizationJob({
    id,
    timelineKey: opts.timelineKey ?? TK,
    level: 1,
    inputStartId: "evt-a",
    inputEndId: "evt-b",
    inputTokenCount: 100,
    targetTokenCount: 50,
    maxRetries: 2,
  });
  await storage.write((db) =>
    db
      .prepare(`update summarization_jobs set status = ?, attempts = ?, updated_at = ? where id = ?`)
      .run(status, opts.attempts ?? 0, opts.updatedAt ?? 1_000, id),
  );
}

/**
 * Insert a summary row directly with a chosen `diary_status` (the monitor reads
 * this column as the diary queue). Bypasses `insertSummaryWithLineage` so the test
 * can set level / diary_status / attempts / latest_timestamp freely without the
 * lineage-shape constraints.
 */
async function diarySummary(
  storage: Storage,
  id: string,
  diaryStatus: string | null,
  opts: { attempts?: number; latestTimestamp?: number; level?: number } = {},
): Promise<void> {
  const latest = opts.latestTimestamp ?? 1_000;
  await storage.write((db) =>
    db
      .prepare(
        `insert into summaries (
          id, timeline_key, level, content, earliest_timestamp, latest_timestamp,
          latest_event_id, event_count, token_count, model_id, status,
          backfill_job_id, generated_at, created_at, diary_status, diary_attempts
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'complete', null, ?, ?, ?, ?)`,
      )
      .run(
        id,
        TK,
        opts.level ?? 1,
        `summary ${id}`,
        latest - 100,
        latest,
        "evt-b",
        3,
        10,
        "m",
        latest,
        latest,
        diaryStatus,
        opts.attempts ?? 0,
      ),
  );
}

// ── getPipelineCounts ────────────────────────────────────────────────────────

test("getPipelineCounts buckets enrichment statuses; excludes inactive", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "e-pending", "pending");
    await enrichEvent(storage, "e-retry", "pending", { retries: 2 });
    await enrichEvent(storage, "e-proc", "processing");
    await enrichEvent(storage, "e-done", "complete");
    await enrichEvent(storage, "e-fail", "failed");
    await enrichEvent(storage, "e-skip", "skipped");
    await enrichEvent(storage, "e-inactive", "inactive");

    const counts = storage.getPipelineCounts("enrichment");
    assert.deepEqual(counts, {
      pending: 1,
      retrying: 1,
      processing: 1,
      done: 1,
      failed: 1,
      skipped: 1,
    });
  });
});

test("getPipelineCounts for captioning scopes to image/video/audio", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-1"));
    await mediaAsset(storage, "m-pending", "evt-1", "pending");
    await mediaAsset(storage, "m-retry", "evt-1", "pending", { attempts: 1 });
    await mediaAsset(storage, "m-done", "evt-1", "complete");
    await mediaAsset(storage, "m-file", "evt-1", "pending", { mediaType: "file" }); // excluded

    const counts = storage.getPipelineCounts("captioning");
    assert.equal(counts.pending, 1, "the 'file' asset is not in the captioning track");
    assert.equal(counts.retrying, 1);
    assert.equal(counts.done, 1);
  });
});

test("getPipelineCounts for summarization + diary", async () => {
  await withStorage(async (storage) => {
    await summarizationJob(storage, "j-pending", "pending");
    await summarizationJob(storage, "j-retry", "pending", { attempts: 1 });
    await summarizationJob(storage, "j-done", "complete");
    await summarizationJob(storage, "j-fail", "failed");
    const sc = storage.getPipelineCounts("summarization");
    assert.deepEqual(sc, { pending: 1, retrying: 1, processing: 0, done: 1, failed: 1, skipped: 0 });

    await diarySummary(storage, "d-pending", "pending");
    await diarySummary(storage, "d-done", "done");
    await diarySummary(storage, "d-skip", "skipped");
    await diarySummary(storage, "d-fail", "failed");
    await diarySummary(storage, "d-l2", null, { level: 2 }); // level-2: not a diary item
    const dc = storage.getPipelineCounts("diary");
    assert.deepEqual(dc, { pending: 1, retrying: 0, processing: 0, done: 1, failed: 1, skipped: 1 });
  });
});

// ── listPipelineItems ────────────────────────────────────────────────────────

test("listPipelineItems projects enrichment items and derives retrying", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "e1", "pending", { retries: 2, updatedAt: 5_000, body: "hello world" });
    const { items, nextCursor } = storage.listPipelineItems("enrichment", {}, 3);
    assert.equal(nextCursor, null);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.pool, "enrichment");
    assert.equal(item.id, "e1");
    assert.equal(item.status, "pending");
    assert.equal(item.attempts, 2);
    assert.equal(item.maxRetries, 3);
    assert.equal(item.retrying, true);
    assert.equal(item.room, TK);
    assert.equal(item.updatedAt, 5_000);
    assert.match(item.inputSummary, /Alice: hello world/);
    assert.equal(item.sessionId, null);
  });
});

test("listPipelineItems keyset-paginates reverse-chron without overlap", async () => {
  await withStorage(async (storage) => {
    for (let i = 1; i <= 5; i++) {
      await enrichEvent(storage, `e${i}`, "complete", { updatedAt: i * 1_000 });
    }
    const page1 = storage.listPipelineItems("enrichment", { limit: 2 }, 3);
    assert.deepEqual(
      page1.items.map((i) => i.id),
      ["e5", "e4"],
    );
    assert.ok(page1.nextCursor);

    const page2 = storage.listPipelineItems("enrichment", { limit: 2, cursor: page1.nextCursor }, 3);
    assert.deepEqual(
      page2.items.map((i) => i.id),
      ["e3", "e2"],
    );
    assert.ok(page2.nextCursor);

    const page3 = storage.listPipelineItems("enrichment", { limit: 2, cursor: page2.nextCursor }, 3);
    assert.deepEqual(
      page3.items.map((i) => i.id),
      ["e1"],
    );
    assert.equal(page3.nextCursor, null, "last page has no further cursor");
  });
});

test("listPipelineItems honors status and room filters", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "ok1", "complete", { updatedAt: 1_000 });
    await enrichEvent(storage, "bad1", "failed", { updatedAt: 2_000 });
    await enrichEvent(storage, "other", "failed", { updatedAt: 3_000, timelineKey: TK2 });

    const failed = storage.listPipelineItems("enrichment", { status: "failed" }, 3);
    assert.deepEqual(failed.items.map((i) => i.id).sort(), ["bad1", "other"]);

    const room = storage.listPipelineItems("enrichment", { status: "failed", room: TK }, 3);
    assert.deepEqual(
      room.items.map((i) => i.id),
      ["bad1"],
    );
  });
});

test("listPipelineItems captioning projection: filename, media_type, caption, error", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-1"));
    await storage.insertMediaAsset({
      id: "cap-1",
      event_id: "evt-1",
      role: "attachment",
      media_type: "audio",
      original_filename: "voice.ogg",
      caption: "a transcript of speech",
      caption_status: "complete",
      caption_attempts: 1,
      download_status: "complete",
      created_at: 1_000,
      updated_at: 7_000,
    });

    const { items } = storage.listPipelineItems("captioning", {}, 2);
    const item = items[0]!;
    assert.equal(item.pool, "captioning");
    assert.equal(item.id, "cap-1");
    assert.equal(item.room, TK);
    assert.equal(item.updatedAt, 7_000);
    assert.match(item.inputSummary, /voice\.ogg · audio/);
    assert.equal(item.outputSummary, "a transcript of speech");
  });
});

test("listPipelineItems diary sorts on latest_timestamp and links the session", async () => {
  await withStorage(async (storage) => {
    await diarySummary(storage, "sum-1", "done", { latestTimestamp: 9_000 });
    // A diary session for sum-1 (trigger_event_id = diary:sum-1).
    await storage.insertAgentSession({
      id: "s-diary111111",
      timelineKey: TK,
      sessionType: "diary",
      status: "completed",
      triggerEventId: "diary:sum-1",
      createdAt: 9_100,
      updatedAt: 9_100,
    });

    const { items } = storage.listPipelineItems("diary", {}, 3);
    const item = items[0]!;
    assert.equal(item.pool, "diary");
    assert.equal(item.id, "sum-1");
    assert.equal(item.updatedAt, 9_000, "diary uses latest_timestamp as the sort key");
    assert.equal(item.sessionId, "s-diary111111");
    assert.equal(item.outputSummary, "entry written");
  });
});

test("listPipelineItems summarization links the latest attempt's session", async () => {
  await withStorage(async (storage) => {
    await summarizationJob(storage, "job-1", "complete", { updatedAt: 4_000 });
    await storage.insertAgentSession({
      id: "s-sum-old1111",
      timelineKey: TK,
      sessionType: "summarize",
      status: "discarded",
      triggerEventId: "summarize:job-1",
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await storage.insertAgentSession({
      id: "s-sum-new1111",
      timelineKey: TK,
      sessionType: "summarize",
      status: "completed",
      triggerEventId: "summarize:job-1",
      createdAt: 2_000,
      updatedAt: 2_000,
    });

    const { items } = storage.listPipelineItems("summarization", {}, 2);
    assert.equal(items[0]!.sessionId, "s-sum-new1111", "links the most recent attempt session");
    assert.match(items[0]!.inputSummary, /L1 · 100→50 tok/);
  });
});

// ── Durable captioning retry counter ─────────────────────────────────────────

test("claimPendingCaptions increments the durable caption_attempts at claim", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent({
      ...userEvent("evt-1"),
      // trigger_group makes the asset claim-eligible regardless of caption_all.
    });
    await storage.write((db) =>
      db.prepare(`update timeline_events set trigger_group_id = 'g1' where id = 'evt-1'`).run(),
    );
    await mediaAsset(storage, "cap-1", "evt-1", "pending");

    const claimed = await storage.claimPendingCaptions(5, false, false);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.caption_attempts, 1, "claim returns the post-increment count");

    const row = storage.getMediaAssetById("cap-1")!;
    assert.equal(row.caption_status, "processing");
    assert.equal(row.caption_attempts, 1, "the increment is durable in the DB");
    assert.ok((row.updated_at ?? 0) >= 1_000, "claim bumps updated_at");
  });
});

test("media_assets carry caption_attempts + updated_at columns and keyset index", async () => {
  await withStorage(async (storage) => {
    const cols = storage.read((db) =>
      (db.prepare(`pragma table_info(media_assets)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    assert.ok(cols.includes("caption_attempts"));
    assert.ok(cols.includes("updated_at"));

    const idx = storage.read((db) =>
      (db.prepare(`pragma index_list(media_assets)`).all() as Array<{ name: string }>).map(
        (i) => i.name,
      ),
    );
    assert.ok(idx.includes("idx_media_assets_updated"));
  });
});

// ── HTTP endpoints ───────────────────────────────────────────────────────────

test("GET /api/pipelines returns one row per pool with counts + live inFlight", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "e-done", "complete");
    const pipelines = fullRegistry({
      enrichment: stubStats("enrichment", { workerCount: 3, maxRetries: 5, inFlight: () => 2 }),
      diary: null,
    });

    await withServer({ storage, pipelines }, async (base) => {
      const res = await fetch(`${base}/api/pipelines`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { pipelines: any[] };
      assert.equal(body.pipelines.length, 4);

      const enr = body.pipelines.find((p) => p.pool === "enrichment");
      assert.equal(enr.enabled, true);
      assert.equal(enr.workerCount, 3);
      assert.equal(enr.maxRetries, 5);
      assert.equal(enr.inFlight, 2);
      assert.equal(enr.counts.done, 1);

      const cap = body.pipelines.find((p) => p.pool === "captioning");
      assert.deepEqual(cap.concurrency, { image: 4, audio: 1 });

      // A disabled (null) pool still appears, with history but not running.
      const diary = body.pipelines.find((p) => p.pool === "diary");
      assert.equal(diary.enabled, false);
      assert.equal(diary.inFlight, 0);
      assert.equal(diary.workerCount, 0);
      assert.equal(diary.maxRetries, 3, "falls back to the diary default");
    });
  });
});

test("GET /api/pipelines/:pool/items paginates and filters; unknown pool 404", async () => {
  await withStorage(async (storage) => {
    for (let i = 1; i <= 3; i++) {
      await enrichEvent(storage, `e${i}`, i === 2 ? "failed" : "complete", { updatedAt: i * 1_000 });
    }

    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const page = await fetch(`${base}/api/pipelines/enrichment/items?limit=2`);
      assert.equal(page.status, 200);
      const body = (await page.json()) as { items: any[]; nextCursor: string | null };
      assert.deepEqual(
        body.items.map((i) => i.id),
        ["e3", "e2"],
      );
      assert.ok(body.nextCursor);

      const filtered = await fetch(`${base}/api/pipelines/enrichment/items?status=failed`);
      const fb = (await filtered.json()) as { items: any[] };
      assert.deepEqual(
        fb.items.map((i) => i.id),
        ["e2"],
      );

      const unknown = await fetch(`${base}/api/pipelines/nope/items`);
      assert.equal(unknown.status, 404);
    });
  });
});

test("GET /api/pipelines/:pool/items works without a registry (default maxRetries)", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "e1", "failed");
    await withServer({ storage }, async (base) => {
      const res = await fetch(`${base}/api/pipelines/enrichment/items`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: any[] };
      assert.equal(body.items[0]!.maxRetries, 3, "enrichment default when no registry");
    });
  });
});

// ── Item detail (Phase 2) ────────────────────────────────────────────────────

test("GET enrichment item detail returns produced media/previews/replyContext", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-1"));
    await storage.persistEnrichmentResults("evt-1", {
      replyContext: { event_id: "evt-1", body: "the quoted message", created_at: 1_000 },
      linkPreviews: [
        {
          id: "lp-1",
          event_id: "evt-1",
          context: "body",
          url: "https://example.org",
          title: "Example",
          preview_index: 0,
          fetch_status: "complete",
          created_at: 1_000,
        },
      ],
      mediaAssets: [
        {
          id: "evt-1:attach:0",
          event_id: "evt-1",
          role: "attachment",
          media_type: "image",
          original_filename: "pic.png",
          caption_status: "complete",
          caption: "a cat",
          download_status: "complete",
          created_at: 1_000,
        },
      ],
    });

    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const res = await fetch(`${base}/api/pipelines/enrichment/items/evt-1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.pool, "enrichment");
      assert.equal(body.item.id, "evt-1");
      assert.equal(body.item.status, "complete");
      assert.equal(body.mediaAssets.length, 1);
      assert.equal(body.mediaAssets[0].ref, "evt-1:attach:0");
      assert.equal(body.mediaAssets[0].caption, "a cat");
      assert.equal(body.linkPreviews.length, 1);
      assert.equal(body.linkPreviews[0].url, "https://example.org");
      assert.equal(body.replyContext.body, "the quoted message");
    });
  });
});

test("GET captioning item detail returns the source media + caption", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-1"));
    await storage.insertMediaAsset({
      id: "cap-1",
      event_id: "evt-1",
      role: "attachment",
      media_type: "audio",
      mime_type: "audio/ogg",
      original_filename: "voice.ogg",
      local_path: "media/voice.ogg",
      caption: "transcript text",
      caption_model: "whisper",
      caption_status: "complete",
      download_status: "complete",
      created_at: 1_000,
    });

    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const res = await fetch(`${base}/api/pipelines/captioning/items/cap-1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.pool, "captioning");
      assert.equal(body.media.ref, "cap-1");
      assert.equal(body.media.mediaType, "audio");
      assert.equal(body.media.caption, "transcript text");
      assert.equal(body.media.captionModel, "whisper");
      assert.equal(body.media.hasBytes, true);
    });
  });
});

test("GET summarization item detail returns the summary, lineage and session", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-a"));
    await storage.insertSummarizationJob({
      id: "job-1",
      timelineKey: TK,
      level: 1,
      inputStartId: "evt-a",
      inputEndId: "evt-a",
      inputTokenCount: 100,
      targetTokenCount: 50,
      maxRetries: 2,
    });
    await storage.insertSummaryWithLineage({
      id: "sum-1",
      timelineKey: TK,
      level: 1,
      content: "the summary text",
      earliestTimestamp: 900,
      latestTimestamp: 1_000,
      latestEventId: "evt-a",
      eventCount: 1,
      tokenCount: 5,
      modelId: "m",
      status: "complete",
      generatedAt: 1_000,
      eventIds: ["evt-a"],
      jobId: "job-1",
    });
    await storage.insertAgentSession({
      id: "s-sum1111111",
      timelineKey: TK,
      sessionType: "summarize",
      status: "completed",
      triggerEventId: "summarize:job-1",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const res = await fetch(`${base}/api/pipelines/summarization/items/job-1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.pool, "summarization");
      assert.equal(body.sessionId, "s-sum1111111");
      assert.equal(body.summary.id, "sum-1");
      assert.equal(body.summary.content, "the summary text");
      assert.equal(body.lineage.events.length, 1);
    });
  });
});

test("GET diary item detail returns the source summary + session", async () => {
  await withStorage(async (storage) => {
    await diarySummary(storage, "sum-1", "done", { latestTimestamp: 9_000 });
    await storage.insertAgentSession({
      id: "s-diary111111",
      timelineKey: TK,
      sessionType: "diary",
      status: "completed",
      triggerEventId: "diary:sum-1",
      createdAt: 9_100,
      updatedAt: 9_100,
    });

    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const res = await fetch(`${base}/api/pipelines/diary/items/sum-1`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.equal(body.pool, "diary");
      assert.equal(body.sessionId, "s-diary111111");
      assert.equal(body.summary.id, "sum-1");
      assert.equal(body.item.outputSummary, "entry written");
    });
  });
});

test("item detail 404s for unknown pool, unknown id, and out-of-track id", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-1"));
    // A non image/video/audio asset is not in the captioning track → 404.
    await storage.insertMediaAsset({
      id: "doc-1",
      event_id: "evt-1",
      role: "attachment",
      media_type: "file",
      caption_status: "pending",
      download_status: "complete",
      created_at: 1_000,
    });

    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      assert.equal((await fetch(`${base}/api/pipelines/nope/items/x`)).status, 404);
      assert.equal((await fetch(`${base}/api/pipelines/enrichment/items/missing`)).status, 404);
      assert.equal((await fetch(`${base}/api/pipelines/captioning/items/doc-1`)).status, 404);
    });
  });
});

// ── Activity bus + SSE (Phase 4) ─────────────────────────────────────────────

test("PipelineActivityBus delivers to subscribers, isolates throwers, unsubscribes", () => {
  const bus = new PipelineActivityBus();
  const got: string[] = [];
  const unsub = bus.subscribe((e) => got.push(e.id));
  bus.subscribe(() => {
    throw new Error("a dead SSE socket must not break publish()");
  });

  const sample = {
    pool: "enrichment" as const,
    id: "e1",
    kind: "completed" as const,
    status: "complete",
    attempts: 0,
    room: null,
    ts: 1,
  };
  bus.publish(sample);
  assert.deepEqual(got, ["e1"], "the throwing listener did not block delivery to the good one");

  unsub();
  bus.publish({ ...sample, id: "e2" });
  assert.deepEqual(got, ["e1"], "unsubscribed listener receives nothing further");
});

test("GET /api/pipelines/stream forwards bus activity as SSE 'activity' events", async () => {
  await withStorage(async (storage) => {
    const bus = new PipelineActivityBus();
    await withServer({ storage, pipelines: fullRegistry(), activityBus: bus }, async (base) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/pipelines/stream`, { signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

      // Subscription is registered synchronously when the request is handled; a
      // tiny yield ensures the server tick completed before we publish.
      await new Promise((r) => setTimeout(r, 20));
      bus.publish({
        pool: "captioning",
        id: "cap-1",
        kind: "failed",
        status: "failed",
        attempts: 2,
        room: "matrix:miku:room:!r",
        ts: 123,
      });

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!buf.includes("event: activity")) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      ac.abort();

      assert.match(buf, /event: activity/);
      assert.match(buf, /"pool":"captioning"/);
      assert.match(buf, /"kind":"failed"/);
      assert.match(buf, /"id":"cap-1"/);
    });
  });
});

test("GET /api/pipelines/stream opens and idles when no activity bus is wired", async () => {
  await withStorage(async (storage) => {
    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const ac = new AbortController();
      const res = await fetch(`${base}/api/pipelines/stream`, { signal: ac.signal });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
      ac.abort();
    });
  });
});

// ── Manual retry (Phase 5) ───────────────────────────────────────────────────

const POST = (base: string, path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "x-console-request": "1", ...headers } });

test("retryPipelineItem resets a failed enrichment item and pokes the pool", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "e1", "failed", { retries: 3 });
    let notified = false;
    const pipelines = fullRegistry({
      enrichment: stubStats("enrichment", { notify: () => (notified = true) }),
    });

    await withServer({ storage, pipelines }, async (base) => {
      const res = await POST(base, "/api/pipelines/enrichment/items/e1/retry");
      assert.equal(res.status, 200);
      const body = (await res.json()) as any;
      assert.deepEqual(body, { pool: "enrichment", id: "e1", status: "pending" });
      assert.ok(notified, "the pool's notify seam was poked");

      const item = storage.getPipelineItem("enrichment", "e1", 3)!;
      assert.equal(item.status, "pending");
      assert.equal(item.attempts, 0, "attempts zeroed");
      assert.equal(item.retrying, false);
    });
  });
});

test("retryPipelineItem allows re-captioning a complete item (idempotent overwrite)", async () => {
  await withStorage(async (storage) => {
    await storage.appendTimelineEvent(userEvent("evt-1"));
    await mediaAsset(storage, "cap-1", "evt-1", "complete", { attempts: 2 });
    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const res = await POST(base, "/api/pipelines/captioning/items/cap-1/retry");
      assert.equal(res.status, 200);
      const row = storage.getMediaAssetById("cap-1")!;
      assert.equal(row.caption_status, "pending");
      assert.equal(row.caption_attempts, 0);
    });
  });
});

test("retryPipelineItem 409s on a processing (in-flight) item", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "e1", "processing");
    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const res = await POST(base, "/api/pipelines/enrichment/items/e1/retry");
      assert.equal(res.status, 409);
      const body = (await res.json()) as any;
      assert.equal(body.error.status, 409);
      assert.equal(body.error.pool, "enrichment");
      assert.equal(body.error.id, "e1");
      assert.equal(body.error.itemStatus, "processing");
      assert.match(body.error.message, /processing/);
    });
  });
});

test("retryPipelineItem 409s on the deferred-unsafe states (summary complete, diary done)", async () => {
  await withStorage(async (storage) => {
    await summarizationJob(storage, "job-1", "complete");
    await diarySummary(storage, "sum-1", "done");
    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      const sum = await POST(base, "/api/pipelines/summarization/items/job-1/retry");
      assert.equal(sum.status, 409);
      assert.match((await sum.json()).error.message, /consumed summary/i);

      const diary = await POST(base, "/api/pipelines/diary/items/sum-1/retry");
      assert.equal(diary.status, 409);
      assert.match((await diary.json()).error.message, /diary entry/i);
    });
  });
});

test("retryPipelineItem 404s for unknown item/pool; 403 without CSRF header", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "e1", "failed");
    await withServer({ storage, pipelines: fullRegistry() }, async (base) => {
      assert.equal((await POST(base, "/api/pipelines/enrichment/items/missing/retry")).status, 404);
      assert.equal((await POST(base, "/api/pipelines/nope/items/x/retry")).status, 404);
      // No CSRF marker → 403 (mutating-route guard), abort never runs.
      const noCsrf = await fetch(`${base}/api/pipelines/enrichment/items/e1/retry`, { method: "POST" });
      assert.equal(noCsrf.status, 403);
      // Item untouched.
      assert.equal(storage.getPipelineItem("enrichment", "e1", 3)!.status, "failed");
    });
  });
});

test("retry-failed bulk-resets only failed items and returns the count", async () => {
  await withStorage(async (storage) => {
    await enrichEvent(storage, "f1", "failed");
    await enrichEvent(storage, "f2", "failed");
    await enrichEvent(storage, "ok", "complete");
    let notified = false;
    const pipelines = fullRegistry({
      enrichment: stubStats("enrichment", { notify: () => (notified = true) }),
    });

    await withServer({ storage, pipelines }, async (base) => {
      const res = await POST(base, "/api/pipelines/enrichment/retry-failed");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { pool: "enrichment", retried: 2 });
      assert.ok(notified);

      assert.equal(storage.getPipelineItem("enrichment", "f1", 3)!.status, "pending");
      assert.equal(storage.getPipelineItem("enrichment", "f2", 3)!.status, "pending");
      // The already-complete item is left alone.
      assert.equal(storage.getPipelineItem("enrichment", "ok", 3)!.status, "complete");
    });
  });
});
