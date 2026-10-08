import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream, type Model, type Api } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { LlmScheduler, withSchedulerAdmission } from "../src/agent/scheduler.js";
import { buildModelFallback, type ModelChainEntry } from "../src/agent/model-fallback.js";
import { withRequestRetry } from "../src/agent/request-retry.js";

// ---------------------------------------------------------------------------
// Model fallback: one pass per request (ARCHITECTURE.md §8a), out-of-band
// recovery through background probes (§8a), and a zero-token stall cut off by
// the wall-clock budget counting as a failure of its model.
// ---------------------------------------------------------------------------

function modelCfg(id: string, endpoint: string): any {
  return {
    id,
    provider: "test",
    endpoint,
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 1000,
    context_window: 100_000,
  };
}

function makeModel(cfg: any, cw: number): Model<Api> {
  return {
    id: cfg.id,
    name: cfg.id,
    api: "openai-completions",
    provider: cfg.provider,
    baseUrl: cfg.endpoint,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cw,
    maxTokens: cfg.max_tokens,
  } as Model<Api>;
}

const X: ModelChainEntry = { logicalId: "X", config: modelCfg("wire-X", "https://gw/x") };
const L: ModelChainEntry = { logicalId: "L", config: modelCfg("wire-L", "https://gw/x") };
const Y: ModelChainEntry = { logicalId: "Y", config: modelCfg("wire-Y", "https://gw/y") };
const X_KEY = "https://gw/x::wire-X";

function message(model: { id: string; api: string; provider?: string }, stopReason: string, errorMessage?: string): any {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider ?? "test",
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 0,
  };
}

/**
 * makeBase whose behaviour per wire id comes from `down` (fails with a 502) —
 * everything else answers `done`. Records every dispatch (live AND probe).
 */
function scriptedBase(calls: string[], down: Set<string>): (cfg: any) => StreamFn {
  return () => ((model) => {
    calls.push(model.id);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (down.has(model.id)) {
        const err = message(model, "error", "OpenAI API error (502): 502 status code (no body)");
        stream.push({ type: "error", reason: "error", error: err });
        stream.end(err);
      } else {
        const done = message(model, "stop");
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      }
    });
    return stream;
  }) as StreamFn;
}

async function run(streamFn: StreamFn): Promise<{ type: string }> {
  const stream = streamFn(makeModel(X.config, 100_000), { messages: [] } as never, {} as never);
  let last: { type: string } = { type: "none" };
  for await (const event of stream) last = event;
  return last;
}

function composite(
  chain: ModelChainEntry[],
  calls: string[],
  down: Set<string>,
  scheduler: LlmScheduler,
  backoffBaseMs = 200,
  extra: Record<string, unknown> = {},
): StreamFn {
  const fb = buildModelFallback(chain, {
    consumer: "test",
    makeBase: scriptedBase(calls, down),
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
    ...extra,
  });
  return withRequestRetry(fb.streamFn, { maxWaitMs: 60_000, backoffBaseMs, backoffMaxMs: 10_000 });
}

test("one pass per request: head twice, each fallback once, answered by the first working member", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3, probeBackoffBaseMs: 60_000 } });
  const calls: string[] = [];
  const down = new Set(["wire-X", "wire-L"]);
  const last = await run(composite([X, L, Y], calls, down, scheduler));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-X", "wire-L", "wire-Y"], "no member is re-hit within the request");
});

test("failing over to another member never waits out the local backoff", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3, probeBackoffBaseMs: 60_000 } });
  const calls: string[] = [];
  // Huge backoff: only the head's own blip retry may sleep (attempt 0 ceiling = base).
  // Force the head's retry to be instant by giving it quota 1, so ANY sleep is a bug.
  const streamFn = composite([X, L, Y], calls, new Set(["wire-X", "wire-L"]), scheduler, 5_000, {
    primaryAttemptsPerRequest: 1,
  });
  const started = Date.now();
  const last = await run(streamFn);
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-L", "wire-Y"]);
  assert.ok(Date.now() - started < 1_000, `failover must not back off (took ${Date.now() - started}ms)`);
});

test("a longer chain never costs more attempts than the members actually failing", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3, probeBackoffBaseMs: 60_000 } });
  const calls: string[] = [];
  // Only the head is down: the extra members behind Y must not add any attempt.
  const Z: ModelChainEntry = { logicalId: "Z", config: modelCfg("wire-Z", "https://gw/z") };
  const last = await run(composite([X, Y, Z], calls, new Set(["wire-X"]), scheduler));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-X", "wire-Y"]);
});

test("every member failed → a new pass starts (after backoff) instead of parking early", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 10, probeBackoffBaseMs: 60_000 } });
  const calls: string[] = [];
  const down = new Set(["wire-X", "wire-Y"]);
  const base = scriptedBase(calls, down);
  const fb = buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: (cfg) => {
      const inner = base(cfg);
      return ((model, ctx, opts) => {
        // Y recovers after the first full pass.
        if (calls.length >= 3) down.delete("wire-Y");
        return inner(model, ctx, opts);
      }) as StreamFn;
    },
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
  });
  const last = await run(withRequestRetry(fb.streamFn, { maxWaitMs: 60_000, backoffBaseMs: 10, backoffMaxMs: 20 }));
  assert.equal(last.type, "done");
  assert.deepEqual(
    calls,
    ["wire-X", "wire-X", "wire-Y", "wire-X", "wire-X", "wire-Y"],
    "pass 1 fails everywhere; pass 2 walks the chain again and reaches the recovered member",
  );
});

test("background probe: an unhealthy head gets NO live canary while a fallback serves", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 60_000, probeBackoffMaxMs: 60_000 } });
  const calls: string[] = [];
  const down = new Set(["wire-X"]);
  const streamFn = composite([X, Y], calls, down, scheduler, 200, { backgroundProbe: true });
  // Request 1 trips the head (threshold 1) and falls to Y.
  assert.equal((await run(streamFn)).type, "done");
  assert.equal(scheduler.modelHealth(X_KEY), "unhealthy");
  // Open the head's probe window as far as the resolver is concerned: with a
  // prober registered, live traffic must still go straight to Y.
  (scheduler as any).health.get(X_KEY).nextProbeAt = 0;
  (scheduler as any).probeTimers.forEach((t: ReturnType<typeof setTimeout>) => clearTimeout(t));
  (scheduler as any).probeTimers.clear();
  calls.length = 0;
  assert.equal((await run(streamFn)).type, "done");
  assert.deepEqual(calls, ["wire-Y"], "the probe-due head is not canaried with a live request");
  scheduler.stop();
});

test("background probe: recovers the head out of band, and live traffic returns to it", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 30, probeBackoffMaxMs: 30 } });
  const calls: string[] = [];
  const down = new Set(["wire-X"]);
  const streamFn = composite([X, Y], calls, down, scheduler, 200, { backgroundProbe: true });
  assert.equal((await run(streamFn)).type, "done");
  assert.equal(scheduler.modelHealth(X_KEY), "unhealthy");
  // Probes keep failing while X is down (backoff re-armed each time)…
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(scheduler.modelHealth(X_KEY), "unhealthy");
  assert.ok(calls.filter((c) => c === "wire-X").length >= 2, "background probes hit the head");
  // …then X comes back: the next background probe recovers it.
  down.delete("wire-X");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(scheduler.modelHealth(X_KEY), "healthy", "a background probe success recovers the model");
  calls.length = 0;
  assert.equal((await run(streamFn)).type, "done");
  assert.deepEqual(calls, ["wire-X"], "traffic is back on the head");
  scheduler.stop();
});

test("background probe: sends the member's configured thinking level", async () => {
  // A reasoning model that rejects thinking off (effort "none") but serves
  // real traffic fine must still be recoverable by its probe.
  const R: ModelChainEntry = {
    logicalId: "R",
    config: { ...modelCfg("wire-R", "https://gw/x"), reasoning: true, thinking_level: "medium" },
  };
  const R_KEY = "https://gw/x::wire-R";
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 30, probeBackoffMaxMs: 30 } });
  const probeReasoning: unknown[] = [];
  const makeBase = () => ((model, _ctx, opts) => {
    const reasoning = (opts as { reasoning?: unknown }).reasoning;
    probeReasoning.push(reasoning);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (reasoning === undefined) {
        const err = message(model, "error", "OpenAI API error (400): Unsupported value: 'none'");
        stream.push({ type: "error", reason: "error", error: err });
        stream.end(err);
      } else {
        const done = message(model, "stop");
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      }
    });
    return stream;
  }) as StreamFn;
  buildModelFallback([R, Y], {
    consumer: "test",
    makeBase,
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
    backgroundProbe: true,
  });
  scheduler.noteOutcome("default", R_KEY, "environmental");
  assert.equal(scheduler.modelHealth(R_KEY), "unhealthy");
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(probeReasoning.slice(0, 1), ["medium"], "the probe carries the member's thinking level");
  assert.equal(scheduler.modelHealth(R_KEY), "healthy", "the probe recovers the model");
  scheduler.stop();
});

test("background probe: a 4xx answer to the synthetic request is a FAILED probe (backoff grows)", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 20, probeBackoffMaxMs: 10_000 } });
  let probes = 0;
  scheduler.registerProber(X_KEY, async () => {
    probes++;
    return { ok: false, status: 402, message: "402 upstream error" };
  });
  scheduler.noteOutcome("default", X_KEY, "environmental");
  await new Promise((r) => setTimeout(r, 100));
  const snap = scheduler.snapshot().models.find((m) => m.key === X_KEY)!;
  assert.equal(snap.health, "unhealthy");
  assert.ok(probes >= 1 && probes <= 3, `probes back off instead of looping (${probes})`);
  assert.ok(snap.probeDelayMs > 20, "each failed probe doubles the delay");
  scheduler.stop();
});

test("a zero-token attempt cut off by the wall-clock budget counts as a failure of its model", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  // A base that never answers until aborted.
  const hang: StreamFn = ((model, _ctx, opts) => {
    const stream = createAssistantMessageEventStream();
    const signal = (opts as { signal?: AbortSignal }).signal!;
    signal.addEventListener("abort", () => {
      const err = message(model, "aborted", "Request aborted");
      stream.push({ type: "error", reason: "aborted", error: err });
      stream.end(err);
    }, { once: true });
    return stream;
  }) as StreamFn;
  const admitted = withSchedulerAdmission(hang, scheduler, { group: "default", priority: "interactive" });
  const streamFn = withRequestRetry(admitted, { maxWaitMs: 50, backoffBaseMs: 10, backoffMaxMs: 10 });
  const last = await run(streamFn);
  assert.equal(last.type, "error");
  const snap = scheduler.snapshot().models.find((m) => m.key === X_KEY);
  assert.equal(snap?.consecutiveFailures, 1, "the stall fed the model's failure streak");
});

test("the caller's own abort stays neutral (no strike)", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const hang: StreamFn = ((model, _ctx, opts) => {
    const stream = createAssistantMessageEventStream();
    (opts as { signal?: AbortSignal }).signal!.addEventListener("abort", () => {
      const err = message(model, "aborted", "Request aborted");
      stream.push({ type: "error", reason: "aborted", error: err });
      stream.end(err);
    }, { once: true });
    return stream;
  }) as StreamFn;
  const admitted = withSchedulerAdmission(hang, scheduler, { group: "default", priority: "interactive" });
  const streamFn = withRequestRetry(admitted, { maxWaitMs: 60_000, backoffBaseMs: 10, backoffMaxMs: 10 });
  const ctrl = new AbortController();
  const stream = streamFn(makeModel(X.config, 100_000), { messages: [] } as never, { signal: ctrl.signal } as never);
  setTimeout(() => ctrl.abort(), 20);
  for await (const _ of stream) { /* drain */ }
  assert.equal(scheduler.snapshot().models.find((m) => m.key === X_KEY), undefined, "no health entry: nothing counted");
});
