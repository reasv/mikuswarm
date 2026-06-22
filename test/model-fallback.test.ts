import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream, type Model, type Api } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { LlmScheduler } from "../src/agent/scheduler.js";
import {
  buildModelFallback,
  resolveModelChain,
  runFetchWithFallback,
  type ModelChainEntry,
} from "../src/agent/model-fallback.js";

// ---------------------------------------------------------------------------
// Transparent model fallback (spec MODEL-FALLBACK §3/§9). Per-attempt resolution
// over a chain, consuming §8a health (modelHealth / isProbeDue) + the budget
// availability hook, with the canary routing the probe.
// ---------------------------------------------------------------------------

function modelCfg(over: Record<string, unknown> = {}): any {
  return {
    id: "wire-id",
    provider: "test",
    endpoint: "https://gw.example",
    api_key: "k",
    multimodal: true,
    max_tokens: 1000,
    context_window: 100_000,
    ...over,
  };
}

/** A makeBase that records the wire id it was dispatched to and emits a clean done. */
function recordingBase(calls: string[]): (cfg: any) => StreamFn {
  return (cfg) => ((model, _context, _opts) => {
    calls.push(model.id);
    const stream = createAssistantMessageEventStream();
    const message: any = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider ?? "test",
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: 0,
    };
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  }) as StreamFn;
}

function makeModel(cfg: any, cw: number): Model<Api> {
  return {
    id: cfg.id,
    name: cfg.id,
    api: "anthropic-messages",
    provider: cfg.provider,
    baseUrl: cfg.endpoint,
    reasoning: cfg.reasoning ?? true,
    input: cfg.multimodal ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cw,
    maxTokens: cfg.max_tokens,
  } as Model<Api>;
}

const HEAD: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x" }) };
const Y: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y" }) };
const Z: ModelChainEntry = { logicalId: "Z", config: modelCfg({ id: "wire-Z", endpoint: "https://gw/z" }) };

const HEAD_KEY = "https://gw/x::wire-X";
const Y_KEY = "https://gw/y::wire-Y";

async function drive(streamFn: StreamFn): Promise<void> {
  const model = makeModel(HEAD.config, 100_000);
  const stream = streamFn(model, {} as never, {} as never);
  for await (const _ of stream) { /* drain to completion */ }
}

test("resolveModelChain: head + named fallbacks, deduped, unknown throws", () => {
  const models = { X: HEAD.config, Y: Y.config, Z: Z.config } as never;
  const chain = resolveModelChain("X", { ...models, X: { ...HEAD.config, fallback: ["Y", "Z", "Y"] } } as never);
  assert.deepEqual(chain.map((c) => c.logicalId), ["X", "Y", "Z"]);

  const noFb = resolveModelChain("Y", models);
  assert.deepEqual(noFb.map((c) => c.logicalId), ["Y"]);

  assert.throws(
    () => resolveModelChain("X", { X: { ...HEAD.config, fallback: ["missing"] } } as never),
    /unknown model "missing"/,
  );
});

test("single-member chain dispatches the head with no resolution", async () => {
  const calls: string[] = [];
  const fb = buildModelFallback([HEAD], { consumer: "test", makeBase: recordingBase(calls), makeModel });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"]);
  assert.equal(fb.headLogicalId, "X");
  assert.deepEqual(fb.survivorLogicalIds, ["X"]);
});

test("head healthy → primary (the head serves)", async () => {
  const scheduler = new LlmScheduler();
  const calls: string[] = [];
  const resolved: string[] = [];
  const fb = buildModelFallback([HEAD, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"]);
  assert.deepEqual(resolved, ["X"]);
});

test("head unhealthy, not probe-due → health-fallback to Y", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 } });
  scheduler.noteOutcome("default", HEAD_KEY, "environmental"); // → unhealthy, window 50s out
  const calls: string[] = [];
  const resolved: string[] = [];
  const fb = buildModelFallback([HEAD, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-Y"], "the healthy fallback serves while the head is unhealthy");
  assert.deepEqual(resolved, ["Y"]);
});

test("head unhealthy AND probe-due → canary (the head serves the probe)", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 1, probeBackoffMaxMs: 1 } });
  scheduler.noteOutcome("default", HEAD_KEY, "environmental"); // → unhealthy, window ~1ms out
  await new Promise((r) => setTimeout(r, 10)); // let the probe window open
  assert.equal(scheduler.isProbeDue(HEAD_KEY), true);
  const calls: string[] = [];
  const resolved: string[] = [];
  const fb = buildModelFallback([HEAD, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"], "the probe-due head is canaried even though Y is up");
  assert.deepEqual(resolved, ["X"]);
});

test("head healthy but over budget → budget-fallback to Y", async () => {
  const calls: string[] = [];
  const resolved: string[] = [];
  const fb = buildModelFallback([HEAD, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    isModelAvailable: (id) => id !== "X", // X exhausted, Y available
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-Y"]);
  assert.deepEqual(resolved, ["Y"]);
});

test("nothing healthy + in-budget → all-unhealthy routes to the head", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 } });
  scheduler.noteOutcome("default", HEAD_KEY, "environmental");
  scheduler.noteOutcome("default", Y_KEY, "environmental");
  const calls: string[] = [];
  const resolved: string[] = [];
  const fb = buildModelFallback([HEAD, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"], "the head is routed to so it fails and Layer-0 budgets the composite");
  assert.deepEqual(resolved, ["X"]);
});

test("operative context window is the min over the surviving chain (min'd with override)", () => {
  const small: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 32_000 }) };
  const fb = buildModelFallback([HEAD, small], { consumer: "test", makeBase: recordingBase([]), makeModel });
  assert.equal(fb.operativeContextWindow, 32_000);

  const withOverride = buildModelFallback([HEAD, small], {
    consumer: "test",
    makeBase: recordingBase([]),
    makeModel,
    contextOverride: 16_000,
  });
  assert.equal(withOverride.operativeContextWindow, 16_000);
});

test("capability pre-filter drops an incapable member but never the head", async () => {
  const textOnlyY: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", multimodal: false }) };
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 } });
  scheduler.noteOutcome("default", HEAD_KEY, "environmental"); // head unhealthy → would want a fallback
  const calls: string[] = [];
  const fb = buildModelFallback([HEAD, textOnlyY, Z], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    capability: (cfg) => cfg.multimodal === true, // needs an image-capable member
  });
  assert.deepEqual(fb.survivorLogicalIds, ["X", "Z"], "the text-only Y is filtered out; head retained");
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-Z"], "falls past the dropped Y to the capable Z");
});

test("thinking-degrade: chosen member without reasoning clears `reasoning` + warns ONCE", async () => {
  // Head is healthy → always chosen (primary), and declares `reasoning: false`.
  const textHead: ModelChainEntry = {
    logicalId: "X",
    config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", reasoning: false }),
  };
  // Capture the streamOptions the base actually receives so we can assert the
  // resolver cleared `reasoning` for the no-thinking member.
  const seen: Array<Record<string, unknown> | undefined> = [];
  const capturingBase: (cfg: any) => StreamFn = () =>
    ((model, _context, opts) => {
      seen.push(opts as Record<string, unknown> | undefined);
      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider ?? "test",
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 0,
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    }) as StreamFn;

  const warnings: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const logger: any = {
    warn: (event: string, data?: Record<string, unknown>) => warnings.push({ event, data }),
    info: () => {},
  };

  // Two-member chain (Y healthy) so the resolver path — not the single-candidate
  // fast path — runs; the head stays primary so the no-thinking member is chosen.
  const fb = buildModelFallback([textHead, Y], {
    consumer: "test",
    makeBase: capturingBase,
    makeModel,
    logger,
  });

  const model = makeModel(textHead.config, 100_000);
  // Drive TWICE with `reasoning` set, to prove the once-only `warnedThinking` guard.
  for (let i = 0; i < 2; i++) {
    const stream = fb.streamFn(model, {} as never, { reasoning: "high" } as never);
    for await (const _ of stream) { /* drain */ }
  }

  assert.equal(seen.length, 2);
  for (const opts of seen) {
    assert.equal((opts as { reasoning?: unknown }).reasoning, undefined, "reasoning cleared for the no-thinking member");
  }
  const degraded = warnings.filter((w) => w.event === "model_fallback_thinking_degraded");
  assert.equal(degraded.length, 1, "the thinking-degrade warn fires exactly once across both attempts");
  assert.equal(degraded[0]?.data?.model, "X");
});

// --- Fetch-shaped fallback (spec MODEL-FALLBACK §6 rows 3-5) ---

function chainOf(...logicalIds: string[]): ModelChainEntry[] {
  return logicalIds.map((id) => ({
    logicalId: id,
    config: modelCfg({ id: `wire-${id}`, endpoint: `https://gw/${id}` }),
  }));
}

test("runFetchWithFallback: single-member chain makes exactly one attempt", async () => {
  const calls: string[] = [];
  const value = await runFetchWithFallback<string>(
    chainOf("X"),
    { consumer: "test", priority: "background" },
    async (m) => {
      calls.push(m.logicalId);
      return { ok: true, value: "ok" };
    },
  );
  assert.equal(value, "ok");
  assert.deepEqual(calls, ["X"], "exactly one attempt, no retry of a single member");
});

test("runFetchWithFallback: an environmental failure falls over to the next member, each tried once", async () => {
  const calls: string[] = [];
  const value = await runFetchWithFallback<string>(
    chainOf("X", "Y"),
    { consumer: "test", priority: "background" },
    async (m) => {
      calls.push(m.logicalId);
      if (m.logicalId === "X") return { ok: false, kind: "environmental", error: new Error("X down") };
      return { ok: true, value: `served-by-${m.logicalId}` };
    },
  );
  assert.equal(value, "served-by-Y");
  assert.deepEqual(calls, ["X", "Y"], "X tried once, then fell over to Y");
});

test("runFetchWithFallback: a content failure does NOT fall over and is rethrown", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      runFetchWithFallback<string>(
        chainOf("X", "Y"),
        { consumer: "test", priority: "background" },
        async (m) => {
          calls.push(m.logicalId);
          return { ok: false, kind: "content", error: new Error("bad input") };
        },
      ),
    /bad input/,
  );
  assert.deepEqual(calls, ["X"], "content failure never falls over to Y (§9)");
});

test("runFetchWithFallback: all members environmental → throws the last error", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      runFetchWithFallback<string>(
        chainOf("X", "Y"),
        { consumer: "test", priority: "background" },
        async (m) => {
          calls.push(m.logicalId);
          return { ok: false, kind: "environmental", error: new Error(`${m.logicalId} down`) };
        },
      ),
    /Y down/,
  );
  assert.deepEqual(calls, ["X", "Y"], "both tried once, then gave up");
});
