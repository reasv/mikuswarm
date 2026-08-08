import assert from "node:assert/strict";
import test from "node:test";

import { createAssistantMessageEventStream, type Model, type Api } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { LlmScheduler } from "../src/agent/scheduler.js";
import {
  buildModelFallback,
  chooseChainMember,
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
    input_modalities: ["text", "image"],
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
    input: cfg.input_modalities.includes("image") ? ["text", "image"] : ["text"],
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

test("head unhealthy + probe-due but OVER BUDGET → NOT canaried, falls to a viable Y", async () => {
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
    isModelAvailable: (id) => id !== "X", // X over budget — a probe can't lead to use
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-Y"], "an over-budget probe-due head is not canaried — Y serves");
  assert.deepEqual(resolved, ["Y"]);
});

test("head unhealthy + probe-due + over budget, no viable fallback → all-unhealthy (still no wasted probe)", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 1, probeBackoffMaxMs: 1 } });
  scheduler.noteOutcome("default", HEAD_KEY, "environmental");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scheduler.isProbeDue(HEAD_KEY), true);
  const calls: string[] = [];
  const resolved: string[] = [];
  const fb = buildModelFallback([HEAD, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    isModelAvailable: () => false, // whole chain over budget
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"], "routes to head as all-unhealthy, not as a budget-blocked canary");
  assert.deepEqual(resolved, ["X"]);
});

test("head unhealthy + probe-due AND in budget → still canaried", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 1, probeBackoffMaxMs: 1 } });
  scheduler.noteOutcome("default", HEAD_KEY, "environmental");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scheduler.isProbeDue(HEAD_KEY), true);
  const calls: string[] = [];
  const resolved: string[] = [];
  const fb = buildModelFallback([HEAD, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    isModelAvailable: () => true, // head in budget — the probe can lead to use
    onResolve: (id) => resolved.push(id),
  });
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"], "an in-budget probe-due head is still canaried");
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

test("buildModelFallback throws when NO chain member declares a context_window", () => {
  const noWindowHead: ModelChainEntry = {
    logicalId: "X",
    config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: undefined }),
  };
  const noWindowY: ModelChainEntry = {
    logicalId: "Y",
    config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: undefined }),
  };
  assert.throws(
    () => buildModelFallback([noWindowHead, noWindowY], { consumer: "test", makeBase: recordingBase([]), makeModel }),
    /no chain member declares a context_window/,
  );
});

test("capability pre-filter drops an incapable member but never the head", async () => {
  const textOnlyY: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", input_modalities: ["text"] }) };
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 } });
  scheduler.noteOutcome("default", HEAD_KEY, "environmental"); // head unhealthy → would want a fallback
  const calls: string[] = [];
  const fb = buildModelFallback([HEAD, textOnlyY, Z], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    scheduler,
    capability: (cfg) => cfg.input_modalities.includes("image"), // needs an image-capable member
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

// The fetch-path canary/budget/all-unhealthy routing reuses §8a health via a real
// LlmScheduler (same key derivation as buildFetchChain). healthKeys for chainOf:
const FX_HEAD_KEY = "https://gw/X::wire-X";
const FX_Y_KEY = "https://gw/Y::wire-Y";

test("#19b runFetchWithFallback CANARY: probe-due unhealthy head → head canaried, fails, Y serves", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 1, probeBackoffMaxMs: 1 } });
  scheduler.noteOutcome("default", FX_HEAD_KEY, "environmental"); // head unhealthy, ~1ms window
  await new Promise((r) => setTimeout(r, 10)); // let the probe window open
  assert.equal(scheduler.isProbeDue(FX_HEAD_KEY), true);

  const calls: string[] = [];
  const value = await runFetchWithFallback<string>(
    chainOf("X", "Y"),
    { consumer: "test", priority: "background", scheduler },
    async (m) => {
      calls.push(m.logicalId);
      // The probe-due head is routed as the canary; it fails environmental, so the
      // attempt falls over to the next member within the same members.length bound.
      if (m.logicalId === "X") return { ok: false, kind: "environmental", error: new Error("X canary failed") };
      return { ok: true, value: `served-by-${m.logicalId}` };
    },
  );
  assert.equal(value, "served-by-Y");
  assert.deepEqual(calls, ["X", "Y"], "head canaried first, then fell over to Y");
});

test("#19b runFetchWithFallback BUDGET: head over budget (isModelAvailable) → Y serves", async () => {
  const scheduler = new LlmScheduler();
  const calls: string[] = [];
  const value = await runFetchWithFallback<string>(
    chainOf("X", "Y"),
    { consumer: "test", priority: "background", scheduler, isModelAvailable: (id) => id !== "X" },
    async (m) => {
      calls.push(m.logicalId);
      return { ok: true, value: `served-by-${m.logicalId}` };
    },
  );
  assert.equal(value, "served-by-Y");
  assert.deepEqual(calls, ["Y"], "the over-budget head is skipped; Y serves directly");
});

test("#19b runFetchWithFallback ALL-UNHEALTHY: nothing healthy + in-budget → routes to the head", async () => {
  // Both members unhealthy and NOT probe-due at the resolver's choice instant → the
  // resolution is "all-unhealthy" and routes to the head. A short probe-backoff keeps
  // the head's scheduler acquire (which then waits for that head's probe window) fast.
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 80, probeBackoffMaxMs: 80 } });
  scheduler.noteOutcome("default", FX_HEAD_KEY, "environmental");
  scheduler.noteOutcome("default", FX_Y_KEY, "environmental");
  assert.equal(scheduler.isProbeDue(FX_HEAD_KEY), false, "the head is NOT probe-due at dispatch (window still closed)");
  const calls: string[] = [];
  const value = await runFetchWithFallback<string>(
    chainOf("X", "Y"),
    { consumer: "test", priority: "background", scheduler },
    async (m) => {
      calls.push(m.logicalId);
      return { ok: true, value: `served-by-${m.logicalId}` };
    },
  );
  // The head is routed to (it serves here, or would fail so Layer-0 budgets the composite).
  assert.equal(value, "served-by-X");
  assert.deepEqual(calls, ["X"], "all-unhealthy routes to the head");
});

test("#19b runFetchWithFallback: model_fallback_resolved logs for a NON-primary resolution + is rate-limit gated", async () => {
  // A budget-fallback to Y is a non-primary resolution → the resolution log fires.
  const infos: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const logger: any = {
    info: (event: string, data?: Record<string, unknown>) => infos.push({ event, data }),
    warn: () => {},
  };
  // rateLimitLog returns true once, then false — proving the log is gated.
  let allowed = 1;
  const rateLimitLog = () => (allowed-- > 0);

  // First call: head over budget → resolves to Y (non-primary), gate ALLOWS → logs.
  await runFetchWithFallback<string>(
    chainOf("X", "Y"),
    { consumer: "captioning", priority: "background", isModelAvailable: (id) => id !== "X", logger, rateLimitLog },
    async (m) => ({ ok: true, value: m.logicalId }),
  );
  // Second call: same non-primary resolution, gate DENIES → no log.
  await runFetchWithFallback<string>(
    chainOf("X", "Y"),
    { consumer: "captioning", priority: "background", isModelAvailable: (id) => id !== "X", logger, rateLimitLog },
    async (m) => ({ ok: true, value: m.logicalId }),
  );

  const resolved = infos.filter((i) => i.event === "model_fallback_resolved");
  assert.equal(resolved.length, 1, "the resolution log fires once and is suppressed when the rate-limit gate denies");
  assert.equal(resolved[0]?.data?.chosen, "Y");
  assert.equal(resolved[0]?.data?.reason, "budget-fallback");
  assert.equal(resolved[0]?.data?.consumer, "captioning");
});

// =============================================================================
// PER-MEMBER-CONTEXT-FITS §2.1–§2.3: per-member fits predicate + new fields
// =============================================================================

// ─── chooseChainMember: direct unit tests ────────────────────────────────────

/**
 * Helper: a bare ChooseMember object (no scheduler needed for the simple cases).
 * TypeScript structural typing lets us pass these directly to chooseChainMember.
 */
function member(logicalId: string, operativeWindow: number, healthKey = `ep::${logicalId}`) {
  return { logicalId, healthKey, operativeWindow };
}

test("fits §2.1: undefined observed → fits is skipped (regression — identical to before)", () => {
  // Head window = 128k, Y window = 256k. No observed → primary (head always chosen when healthy).
  const m = [member("X", 128_000), member("Y", 256_000)];
  assert.deepEqual(chooseChainMember(m, {}), { index: 0, reason: "primary" });
});

test("fits §2.1: observed <= head window → primary", () => {
  const m = [member("X", 128_000), member("Y", 256_000)];
  assert.deepEqual(chooseChainMember(m, { observedContextTokens: 100_000 }), { index: 0, reason: "primary" });
  // Exact boundary: observed === window → fits (<=)
  assert.deepEqual(chooseChainMember(m, { observedContextTokens: 128_000 }), { index: 0, reason: "primary" });
});

test("fits §2.1: context-fallback — head healthy+in-budget but observed > head window, Y is larger", () => {
  // X window = 128k, Y window = 256k, observed = 150k → X doesn't fit, Y does.
  const m = [member("X", 128_000), member("Y", 256_000)];
  const result = chooseChainMember(m, { observedContextTokens: 150_000 });
  assert.equal(result.index, 1, "falls to Y (the larger member)");
  assert.equal(result.reason, "context-fallback");
});

test("fits §2.1: context-fallback — upgrade path, downstream member has larger window", () => {
  // X = 64k, Y = 512k, Z = 128k. Observed = 100k → X and Z don't fit; Y is the first that does.
  const m = [member("X", 64_000), member("Y", 512_000), member("Z", 128_000)];
  const result = chooseChainMember(m, { observedContextTokens: 100_000 });
  assert.equal(result.index, 1, "Y is the first member whose window fits");
  assert.equal(result.reason, "context-fallback");
});

test("fits §2.1: all members too small → all-unhealthy (no viable member)", () => {
  // Observed = 300k; all windows smaller → all skipped → falls to head as "all-unhealthy".
  const m = [member("X", 128_000), member("Y", 256_000)];
  const result = chooseChainMember(m, { observedContextTokens: 300_000 });
  assert.equal(result.index, 0, "routes to head when no member fits");
  assert.equal(result.reason, "all-unhealthy");
});

test("fits §2.2: canary NOT fired when observed > head window (context doesn't fit the probe)", async () => {
  // Head unhealthy + probe-due + in-budget, but observed > head.operativeWindow.
  // Spec §2.2: probing with an oversized context wastes the probe slot.
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 1, probeBackoffMaxMs: 1 } });
  scheduler.noteOutcome("default", "ep::X", "environmental");
  await new Promise((r) => setTimeout(r, 10)); // let the probe window open
  assert.equal(scheduler.isProbeDue("ep::X"), true);

  // X window = 64k, Y window = 256k, observed = 100k → X doesn't fit (no canary), Y fits.
  const m = [member("X", 64_000), member("Y", 256_000)];
  const result = chooseChainMember(m, {
    scheduler,
    observedContextTokens: 100_000,
  });
  // Head is unhealthy so the reason is health-fallback (even though context also doesn't fit).
  assert.equal(result.index, 1, "Y serves; no wasted canary probe on a context the head can't serve");
  assert.equal(result.reason, "health-fallback");
});

test("fits §2.2: canary IS fired when observed fits the head (normal canary path)", async () => {
  // Head unhealthy + probe-due + in-budget AND context fits → canary proceeds.
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 1, probeBackoffMaxMs: 1 } });
  scheduler.noteOutcome("default", "ep::X", "environmental");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(scheduler.isProbeDue("ep::X"), true);

  // X window = 256k, observed = 100k → head fits → canary fires.
  const m = [member("X", 256_000), member("Y", 256_000)];
  const result = chooseChainMember(m, {
    scheduler,
    observedContextTokens: 100_000,
  });
  assert.equal(result.index, 0, "head is canaried when context fits");
  assert.equal(result.reason, "canary");
});

test("fits §2.1: health-fallback reason when head unhealthy (fits is a secondary concern)", () => {
  // Head unhealthy, NOT probe-due, Y fits: reason is health-fallback regardless of fits.
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 50_000, probeBackoffMaxMs: 50_000 } });
  scheduler.noteOutcome("default", "ep::X", "environmental");
  // X window = 256k — context FITS the head, but head is unhealthy → health-fallback.
  const m = [member("X", 256_000), member("Y", 256_000)];
  const result = chooseChainMember(m, {
    scheduler,
    observedContextTokens: 100_000,
  });
  assert.equal(result.index, 1);
  assert.equal(result.reason, "health-fallback");
});

test("fits §2.1: budget-fallback reason when head healthy but over budget", () => {
  // Head healthy + in-budget false (budget exhausted) + context fits → budget-fallback.
  const m = [member("X", 256_000), member("Y", 256_000)];
  const result = chooseChainMember(m, {
    isModelAvailable: (id) => id !== "X",
    observedContextTokens: 100_000,
  });
  assert.equal(result.index, 1);
  assert.equal(result.reason, "budget-fallback");
});

// ─── buildModelFallback: memberWindows / maxOperativeContextWindow ────────────

test("memberWindows §2.3: per-survivor operative windows, no contextOverride", () => {
  const X: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 128_000 }) };
  const Y: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 256_000 }) };
  const fb = buildModelFallback([X, Y], { consumer: "test", makeBase: recordingBase([]), makeModel });
  assert.deepEqual(fb.memberWindows, { X: 128_000, Y: 256_000 });
  assert.equal(fb.maxOperativeContextWindow, 256_000);
  // Backward compat: operativeContextWindow still = min.
  assert.equal(fb.operativeContextWindow, 128_000);
});

test("memberWindows §2.3: contextOverride mins each member's window", () => {
  const X: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 128_000 }) };
  const Y: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 256_000 }) };
  const fb = buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: recordingBase([]),
    makeModel,
    contextOverride: 100_000,
  });
  assert.deepEqual(fb.memberWindows, { X: 100_000, Y: 100_000 });
  assert.equal(fb.maxOperativeContextWindow, 100_000);
  assert.equal(fb.operativeContextWindow, 100_000);
});

test("memberWindows §2.3: contextOverride larger than all windows → member's window wins", () => {
  const X: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 64_000 }) };
  const Y: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 128_000 }) };
  const fb = buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: recordingBase([]),
    makeModel,
    contextOverride: 200_000, // larger than all windows — member windows govern
  });
  assert.deepEqual(fb.memberWindows, { X: 64_000, Y: 128_000 });
  assert.equal(fb.maxOperativeContextWindow, 128_000);
  assert.equal(fb.operativeContextWindow, 64_000);
});

test("memberWindows §2.3: capability filter drops a member — only survivors in memberWindows", () => {
  const X: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 128_000 }) };
  const textOnlyY: ModelChainEntry = {
    logicalId: "Y",
    config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 256_000, input_modalities: ["text"] }),
  };
  const Z: ModelChainEntry = { logicalId: "Z", config: modelCfg({ id: "wire-Z", endpoint: "https://gw/z", context_window: 512_000 }) };
  const fb = buildModelFallback([X, textOnlyY, Z], {
    consumer: "test",
    makeBase: recordingBase([]),
    makeModel,
    capability: (cfg) => cfg.input_modalities.includes("image"),
  });
  // Y is dropped (no image capability); X and Z survive.
  assert.deepEqual(fb.memberWindows, { X: 128_000, Z: 512_000 });
  assert.equal(fb.maxOperativeContextWindow, 512_000);
  assert.equal(fb.operativeContextWindow, 128_000); // min over survivors X + Z
});

test("memberWindows §2.3: single-member chain also exposes memberWindows / maxOperativeContextWindow", () => {
  const X: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 200_000 }) };
  const fb = buildModelFallback([X], { consumer: "test", makeBase: recordingBase([]), makeModel });
  assert.deepEqual(fb.memberWindows, { X: 200_000 });
  assert.equal(fb.maxOperativeContextWindow, 200_000);
  assert.equal(fb.operativeContextWindow, 200_000);
});

test("fits §2.2: canary fires on absurdly-small-window head when observed is undefined (fits skipped entirely)", async () => {
  // Spec §2.2 canary gate: when observedContextTokens is undefined the fits predicate
  // is skipped entirely. A head with window=1 (would never fit any real context) must
  // still be canaried when its probe window is open and observed is undefined.
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 1, probeBackoffBaseMs: 1, probeBackoffMaxMs: 1 } });
  scheduler.noteOutcome("default", "ep::X", "environmental");
  await new Promise((r) => setTimeout(r, 10)); // let the probe window open
  assert.equal(scheduler.isProbeDue("ep::X"), true);

  // window=1: absurdly small — no real context would fit. But observed is undefined.
  const m = [member("X", 1), member("Y", 256_000)];
  const result = chooseChainMember(m, { scheduler }); // no observedContextTokens
  assert.equal(result.index, 0, "canary fires on head even with window=1 when observed is undefined");
  assert.equal(result.reason, "canary");
});

test("Fix 1: tried-exclusion yields budget-fallback (not context-fallback) when head is healthy + in-budget + fits", () => {
  // Head healthy, in-budget, context fits the head — BUT already in `tried`.
  // Before Fix 1, the else-arm of the reason ternary emitted "context-fallback" spuriously.
  // After Fix 1, the !headFits arm is explicit; the tried-only case falls to "budget-fallback".
  const tried = new Set(["X"]);
  const m = [member("X", 256_000), member("Y", 256_000)];
  const result = chooseChainMember(m, {
    tried,
    observedContextTokens: 100_000, // fits both X and Y
  });
  assert.equal(result.index, 1, "Y is chosen since X is in tried");
  assert.equal(result.reason, "budget-fallback", "tried-exclusion must not emit context-fallback");
});

test("survivorMembers §2.3: each entry carries operativeWindow", () => {
  const X: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 128_000 }) };
  const Y: ModelChainEntry = { logicalId: "Y", config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 256_000 }) };
  const fb = buildModelFallback([X, Y], { consumer: "test", makeBase: recordingBase([]), makeModel });
  assert.equal(fb.survivorMembers.length, 2);
  assert.equal(fb.survivorMembers[0]!.logicalId, "X");
  assert.equal(fb.survivorMembers[0]!.operativeWindow, 128_000);
  assert.equal(fb.survivorMembers[1]!.logicalId, "Y");
  assert.equal(fb.survivorMembers[1]!.operativeWindow, 256_000);
});

test("survivorMembers §2.3: contextOverride is applied to the operativeWindow", () => {
  const X: ModelChainEntry = { logicalId: "X", config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 256_000 }) };
  const fb = buildModelFallback([X], {
    consumer: "test",
    makeBase: recordingBase([]),
    makeModel,
    contextOverride: 100_000,
  });
  assert.equal(fb.survivorMembers[0]!.operativeWindow, 100_000);
});

test("context-fallback via streamFn E2E: getObservedContextTokens wires fits into per-attempt selection", async () => {
  // X window = 128k, Y window = 256k. observed = 150k → X skipped, Y serves (context-fallback).
  const smallX: ModelChainEntry = {
    logicalId: "X",
    config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 128_000 }),
  };
  const largeY: ModelChainEntry = {
    logicalId: "Y",
    config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 256_000 }),
  };

  const calls: string[] = [];
  const resolved: string[] = [];
  const reasons: string[] = [];
  let observedTokens = 150_000; // over X's window

  const fb = buildModelFallback([smallX, largeY], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    getObservedContextTokens: () => observedTokens,
    onResolve: (id, reason) => {
      resolved.push(id);
      reasons.push(reason);
    },
  });

  // First drive: observed = 150k → X doesn't fit → Y serves.
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-Y"], "Y serves when observed > X.window");
  assert.deepEqual(resolved, ["Y"]);
  assert.deepEqual(reasons, ["context-fallback"]);

  // Second drive with observed = 100k → X fits again → primary.
  observedTokens = 100_000;
  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-Y", "wire-X"], "X is primary again when context fits");
  assert.equal(reasons[1], "primary");
});

test("context-fallback via streamFn: all members too small → all-unhealthy routes to head", async () => {
  const X: ModelChainEntry = {
    logicalId: "X",
    config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 64_000 }),
  };
  const Y: ModelChainEntry = {
    logicalId: "Y",
    config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 128_000 }),
  };
  const calls: string[] = [];
  const reasons: string[] = [];

  const fb = buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    getObservedContextTokens: () => 200_000, // exceeds both windows
    onResolve: (_id, reason) => reasons.push(reason),
  });

  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"], "routes to head as all-unhealthy when no member fits");
  assert.deepEqual(reasons, ["all-unhealthy"]);
});

test("context-fallback: undefined getObservedContextTokens → no fits check, behavior identical to today", async () => {
  // No getObservedContextTokens → fits always skipped → primary regardless of any window relationship.
  const X: ModelChainEntry = {
    logicalId: "X",
    config: modelCfg({ id: "wire-X", endpoint: "https://gw/x", context_window: 1_000 }),
  };
  const Y: ModelChainEntry = {
    logicalId: "Y",
    config: modelCfg({ id: "wire-Y", endpoint: "https://gw/y", context_window: 256_000 }),
  };
  const calls: string[] = [];
  const reasons: string[] = [];

  const fb = buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: recordingBase(calls),
    makeModel,
    // no getObservedContextTokens — current callers don't set this
    onResolve: (_id, reason) => reasons.push(reason),
  });

  await drive(fb.streamFn);
  assert.deepEqual(calls, ["wire-X"], "head serves (primary) even though its window is tiny");
  assert.deepEqual(reasons, ["primary"]);
});
