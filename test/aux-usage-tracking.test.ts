import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { computeUsageCost, type CostRates } from "../src/agent/usage.js";
import { parseOpenAiUsage } from "../src/captioning/describe.js";
import { parseGeminiUsage } from "../src/tools/image-gen.js";
import { LATEST_SCHEMA_VERSION, Storage, type MediaAssetRow } from "../src/storage/index.js";

// =============================================================================
// Auxiliary (out-of-loop) usage & cost tracking (spec AUXILIARY-USAGE-TRACKING).
// Covers the §5 cost helper, the §6 provider-usage parsers, and the §8 storage
// lane (caption usage columns + the tool_invocations ledger), including the §4
// invariant that auxiliary spend never touches agent_sessions.usage_*.
// =============================================================================

const RATES: CostRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

// ── §5 computeUsageCost ─────────────────────────────────────────────────────

test("computeUsageCost: rate/1e6 * tokens per component, summed", () => {
  const c = computeUsageCost(RATES, { input: 1_000_000, output: 2_000_000, cacheRead: 1_000_000, cacheWrite: 0 });
  assert.equal(c.input, 3);
  assert.equal(c.output, 30);
  assert.equal(c.cacheRead, 0.3);
  assert.equal(c.cacheWrite, 0);
  assert.equal(c.image, 0);
  assert.equal(c.total, 33.3);
});

test("computeUsageCost: flat per_image charge added per generated image", () => {
  const rates: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, perImage: 0.039 };
  const c = computeUsageCost(rates, { input: 100, output: 1290, cacheRead: 0, cacheWrite: 0, images: 2 });
  assert.equal(c.image, 0.078);
  assert.equal(c.total, 0.078);
});

test("computeUsageCost: zero rates yield total 0 (untracked)", () => {
  const zero: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const c = computeUsageCost(zero, { input: 5000, output: 5000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(c.total, 0);
});

test("computeUsageCost: absent rate fields coalesce to 0, never NaN", () => {
  // Defensive: a partially-populated rates object must not let NaN reach the DB.
  const partial = { input: 3 } as unknown as CostRates;
  const c = computeUsageCost(partial, { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, images: 1 });
  assert.equal(c.input, 3);
  assert.equal(c.output, 0);
  assert.equal(c.cacheRead, 0);
  assert.equal(c.cacheWrite, 0);
  assert.equal(c.image, 0);
  assert.equal(c.total, 3);
  assert.ok(!Number.isNaN(c.total));
});

// ── §6.1 OpenAI/OpenRouter usage parser ─────────────────────────────────────

test("parseOpenAiUsage: cached tokens subtracted from input, mapped to cacheRead", () => {
  const u = parseOpenAiUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 300 },
  });
  assert.deepEqual(u, { input: 700, output: 200, cacheRead: 300, cacheWrite: 0 });
});

test("parseOpenAiUsage: no cached details → all prompt tokens are input", () => {
  const u = parseOpenAiUsage({ prompt_tokens: 800, completion_tokens: 100, total_tokens: 900 });
  assert.deepEqual(u, { input: 800, output: 100, cacheRead: 0, cacheWrite: 0 });
});

test("parseOpenAiUsage: absent usage block → null (unknown, not zero)", () => {
  assert.equal(parseOpenAiUsage(undefined), null);
  assert.equal(parseOpenAiUsage(null), null);
});

// ── §6.2 Gemini usageMetadata parser ────────────────────────────────────────

test("parseGeminiUsage: cached subtracted, candidates → output, images carried", () => {
  const u = parseGeminiUsage(
    { promptTokenCount: 500, candidatesTokenCount: 1290, cachedContentTokenCount: 100, totalTokenCount: 1790 },
    1,
  );
  assert.deepEqual(u, { input: 400, output: 1290, cacheRead: 100, cacheWrite: 0, images: 1 });
});

test("parseGeminiUsage: absent usageMetadata → null", () => {
  assert.equal(parseGeminiUsage(undefined, 1), null);
  assert.equal(parseGeminiUsage(null, 1), null);
});

// ── §8 storage lane ─────────────────────────────────────────────────────────

async function withStorage(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

function mediaAssetInsert(id: string): MediaAssetRow {
  return {
    id,
    event_id: "evt-cap-1",
    role: "user",
    media_type: "image",
    local_path: "media/x.png",
    caption_status: "processing",
    download_status: "complete",
    created_at: 1000,
    updated_at: 1000,
  };
}

async function seedEvent(storage: Storage): Promise<void> {
  // media_assets.event_id FK-references timeline_events; persist a minimal event.
  await storage.appendTimelineEvent({
    id: "evt-cap-1",
    timelineKey: "matrix:miku:room:!room",
    provider: "matrix",
    role: "user",
    sender: { id: "@a:x", displayName: "A" },
    body: "img",
    timestamp: 1000,
    receivedAt: 1000,
  } as never);
}

test("updateCaptionResult: persists caption usage columns + cost (§8.1)", async () => {
  await withStorage(async (storage) => {
    await seedEvent(storage);
    await storage.insertMediaAsset(mediaAssetInsert("ma-1"));

    await storage.updateCaptionResult(
      "ma-1",
      "a caption",
      "google/gemini-flash",
      { input: 700, output: 200, cacheRead: 300, cacheWrite: 0 },
      0.0123,
    );

    const row = storage.getMediaAssetById("ma-1");
    assert.ok(row);
    assert.equal(row.caption, "a caption");
    assert.equal(row.caption_input_tokens, 700);
    assert.equal(row.caption_output_tokens, 200);
    assert.equal(row.caption_cache_read_tokens, 300);
    assert.equal(row.caption_total_tokens, 1200); // input + output + cacheRead
    assert.equal(row.caption_cost, 0.0123);
  });
});

test("updateCaptionResult: null usage leaves usage columns null (unknown, not 0)", async () => {
  await withStorage(async (storage) => {
    await seedEvent(storage);
    await storage.insertMediaAsset(mediaAssetInsert("ma-2"));

    await storage.updateCaptionResult("ma-2", "cap", "m", null, null);

    const row = storage.getMediaAssetById("ma-2");
    assert.ok(row);
    assert.equal(row.caption_total_tokens, null);
    assert.equal(row.caption_cost, null);
  });
});

test("getCaptioningUsageAggregate: SUMs only rows with recorded usage (§10.2)", async () => {
  await withStorage(async (storage) => {
    await seedEvent(storage);
    await storage.insertMediaAsset(mediaAssetInsert("ma-a"));
    await storage.insertMediaAsset(mediaAssetInsert("ma-b"));
    await storage.insertMediaAsset(mediaAssetInsert("ma-c"));
    await storage.updateCaptionResult("ma-a", "x", "m", { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, 0.01);
    await storage.updateCaptionResult("ma-b", "y", "m", { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, 0.02);
    await storage.updateCaptionResult("ma-c", "z", "m", null, null); // unknown — excluded

    const agg = storage.getCaptioningUsageAggregate();
    assert.equal(agg.captionedCount, 2);
    assert.equal(agg.totalInputTokens, 300);
    assert.equal(agg.totalOutputTokens, 30);
    assert.ok(Math.abs(agg.totalCost - 0.03) < 1e-9);
  });
});

test("tool_invocations: insert + per-session SUM + newest-first list (§8.2)", async () => {
  await withStorage(async (storage) => {
    await storage.insertToolInvocation({
      agentSessionId: "s-1",
      toolName: "image_generate",
      toolCallId: "call-1",
      modelId: "gemini-3-pro-image",
      provider: "gemini",
      inputTokens: 100,
      outputTokens: 1290,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      images: 1,
      cost: 0.04,
      ref: "./generated-images/a.png",
    });
    await storage.insertToolInvocation({
      agentSessionId: "s-1",
      toolName: "image_generate",
      toolCallId: "call-2",
      modelId: "gemini-3.1-flash-image",
      provider: "gemini",
      inputTokens: 50,
      outputTokens: 1290,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      images: 1,
      cost: 0.01,
      ref: "./generated-images/b.png",
    });

    const rollup = storage.getSessionToolUsage("s-1");
    assert.equal(rollup.calls, 2);
    assert.equal(rollup.inputTokens, 150);
    assert.equal(rollup.outputTokens, 2580);
    assert.ok(Math.abs(rollup.cost - 0.05) < 1e-9);

    const rows = storage.getToolInvocationsBySession("s-1");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].tool_call_id, "call-2"); // newest-first (created_at desc)

    // A session with no tool spend returns a zeroed shape, never null.
    const empty = storage.getSessionToolUsage("s-none");
    assert.deepEqual(empty, {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    });
  });
});

test("§4 invariant: a tool invocation never mutates agent_sessions.usage_* ", async () => {
  await withStorage(async (storage) => {
    await storage.insertAgentSession({
      id: "s-inv",
      timelineKey: "matrix:miku:room:!room",
      sessionType: "default",
      status: "running",
      modelId: "anthropic/claude",
      triggerEventId: "evt-1",
      triggerExternalId: "$1",
      triggerBody: "hi",
      triggerSenderId: "@a:x",
      triggerSenderDisplayName: "A",
      createdAt: 1000,
      updatedAt: 1000,
    });
    // Establish the §8b agent-loop actuals.
    await storage.updateAgentSessionUsage("s-inv", {
      llmRequests: 3,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.5,
      contextTokens: 1500,
    });

    // An auxiliary image-gen call for the same session.
    await storage.insertToolInvocation({
      agentSessionId: "s-inv",
      toolName: "image_generate",
      modelId: "gemini-3-pro-image",
      provider: "gemini",
      inputTokens: 100,
      outputTokens: 1290,
      images: 1,
      cost: 0.04,
    });

    const row = storage.getAgentSession("s-inv");
    assert.ok(row);
    // Lane separation: the §8b counters are unchanged by the tool spend.
    assert.equal(row.usage_input_tokens, 1000);
    assert.equal(row.usage_output_tokens, 500);
    assert.equal(row.usage_cost, 0.5);
    assert.equal(row.context_tokens, 1500);
    // The auxiliary spend is visible only via the separate ledger lane.
    assert.equal(storage.getSessionToolUsage("s-inv").cost, 0.04);
  });
});

test("getCostOverview: three lanes summed independently (§10.4)", async () => {
  await withStorage(async (storage) => {
    await seedEvent(storage);
    await storage.insertAgentSession({
      id: "s-cost",
      timelineKey: "matrix:miku:room:!room",
      sessionType: "default",
      status: "completed",
      modelId: "anthropic/claude",
      triggerEventId: "evt-1",
      triggerExternalId: "$1",
      triggerBody: "hi",
      triggerSenderId: "@a:x",
      triggerSenderDisplayName: "A",
      createdAt: 1000,
      updatedAt: 1000,
    });
    await storage.updateAgentSessionUsage("s-cost", {
      llmRequests: 1,
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 1.25,
      contextTokens: 20,
    });
    await storage.insertMediaAsset(mediaAssetInsert("ma-cost"));
    await storage.updateCaptionResult("ma-cost", "c", "m", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, 0.5);
    await storage.insertToolInvocation({
      agentSessionId: "s-cost",
      toolName: "image_generate",
      cost: 0.75,
    });

    const o = storage.getCostOverview();
    assert.ok(Math.abs(o.agentLoopCost - 1.25) < 1e-9);
    assert.ok(Math.abs(o.toolCost - 0.75) < 1e-9);
    assert.ok(Math.abs(o.captioningCost - 0.5) < 1e-9);
  });
});

test("v21 migration: re-running the step on a current DB (rewound user_version) is a no-op", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-aux-migrate-"));
  const dbPath = path.join(dir, "db.sqlite");
  try {
    // First open builds the DB at v21 (caption usage columns + tool_invocations).
    const first = await Storage.open({ databasePath: dbPath });
    await first.insertToolInvocation({ agentSessionId: "s", toolName: "image_generate", cost: 0.1 });
    // Simulate a fixture that rewound user_version on an already-v21 DB.
    first.write((db) => db.pragma("user_version = 20"));
    await first.waitForIdle();
    first.close();

    // Re-opening runs the v20→v21 step again (then any later steps); its existence
    // guards must make it a no-op (no "duplicate column" / "table already exists")
    // and preserve data, landing at the current latest version.
    const second = await Storage.open({ databasePath: dbPath });
    try {
      const version = second.read((db) => db.pragma("user_version", { simple: true }) as number);
      assert.equal(version, LATEST_SCHEMA_VERSION);
      const cols = second.read(
        (db) => (db.pragma("table_info(media_assets)") as Array<{ name: string }>).map((c) => c.name),
      );
      assert.ok(cols.includes("caption_cost"), "caption_cost column survives");
      // No data lost; ledger row still present.
      assert.equal(second.getSessionToolUsage("s").calls, 1);
    } finally {
      await second.waitForIdle();
      second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
