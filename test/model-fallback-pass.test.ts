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

test("one pass per request: every member twice, answered by the first working member", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3, probeBackoffBaseMs: 60_000 } });
  const calls: string[] = [];
  const down = new Set(["wire-X", "wire-L"]);
  const last = await run(composite([X, L, Y], calls, down, scheduler));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-X", "wire-L", "wire-L", "wire-Y"], "no member is re-hit past its attempts within the request");
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
        if (calls.length >= 4) down.delete("wire-Y");
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
    ["wire-X", "wire-X", "wire-Y", "wire-Y", "wire-X", "wire-X", "wire-Y"],
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

// ---------------------------------------------------------------------------
// Stalls fall over (§8a): a member that hangs with zero tokens never ends a
// request another chain member can serve.
// ---------------------------------------------------------------------------

/** makeBase where wire ids in `hung` never answer until aborted; the rest answer `done`. */
function hangingBase(calls: string[], hung: Set<string>): (cfg: any) => StreamFn {
  return () => ((model, _ctx, opts) => {
    calls.push(model.id);
    const stream = createAssistantMessageEventStream();
    const signal = (opts as { signal?: AbortSignal }).signal;
    if (hung.has(model.id)) {
      const fail = () => {
        const err = message(model, "aborted", "Request aborted");
        stream.push({ type: "error", reason: "aborted", error: err });
        stream.end(err);
      };
      if (signal?.aborted) queueMicrotask(fail);
      else signal?.addEventListener("abort", fail, { once: true });
    } else {
      queueMicrotask(() => {
        const done = message(model, "stop");
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      });
    }
    return stream;
  }) as StreamFn;
}

function stallComposite(
  chain: ModelChainEntry[],
  calls: string[],
  hung: Set<string>,
  scheduler: LlmScheduler,
  retry: { maxWaitMs?: number; firstTokenTimeoutMs?: number },
): StreamFn {
  const fb = buildModelFallback(chain, {
    consumer: "test",
    makeBase: hangingBase(calls, hung),
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
  });
  return withRequestRetry(fb.streamFn, { backoffBaseMs: 10, backoffMaxMs: 10, ...retry });
}

test("a head that hangs past the wall-clock budget falls over instead of parking", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const calls: string[] = [];
  const last = await run(stallComposite([X, Y], calls, new Set(["wire-X"]), scheduler, { maxWaitMs: 50 }));
  assert.equal(last.type, "done", "the fallback answered");
  assert.deepEqual(calls, ["wire-X", "wire-Y"], "the stalled head is not re-hit, the fallback is tried");
  scheduler.stop();
});

test("the first-token deadline cuts a stall short and falls over without retrying the head", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const calls: string[] = [];
  const started = Date.now();
  const last = await run(
    stallComposite([X, Y], calls, new Set(["wire-X"]), scheduler, { maxWaitMs: 60_000, firstTokenTimeoutMs: 30 }),
  );
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-Y"], "a stall exhausts the head for this request (no second head attempt)");
  assert.ok(Date.now() - started < 5_000, "fell over at the first-token deadline, not the wall-clock budget");
  const snap = scheduler.snapshot().models.find((m) => m.key === X_KEY);
  assert.equal(snap?.consecutiveFailures, 1, "the stall is a strike against the head");
  scheduler.stop();
});

test("every member stalling still ends the request (bounded), after each was tried once", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const calls: string[] = [];
  const last = await run(
    stallComposite([X, Y], calls, new Set(["wire-X", "wire-Y"]), scheduler, { maxWaitMs: 200, firstTokenTimeoutMs: 20 }),
  );
  assert.equal(last.type, "error");
  assert.deepEqual(calls.slice(0, 2), ["wire-X", "wire-Y"], "both members were tried before giving up");
  scheduler.stop();
});

/** makeBase answering per wire id: a terminal error message after `delayMs`, or `done`. */
function failingBase(calls: string[], fail: Map<string, { error: string; delayMs: number }>): (cfg: any) => StreamFn {
  return () => ((model) => {
    calls.push(model.id);
    const stream = createAssistantMessageEventStream();
    const f = fail.get(model.id);
    setTimeout(() => {
      if (f) {
        const err = message(model, "error", f.error);
        stream.push({ type: "error", reason: "error", error: err });
        stream.end(err);
      } else {
        const done = message(model, "stop");
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      }
    }, f?.delayMs ?? 0);
    return stream;
  }) as StreamFn;
}

function failingComposite(
  chain: ModelChainEntry[],
  calls: string[],
  fail: Map<string, { error: string; delayMs: number }>,
  scheduler: LlmScheduler,
  maxWaitMs: number,
): StreamFn {
  const fb = buildModelFallback(chain, {
    consumer: "test",
    makeBase: failingBase(calls, fail),
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
  });
  return withRequestRetry(fb.streamFn, { maxWaitMs, backoffBaseMs: 10, backoffMaxMs: 10 });
}

const NO_KEYS = '400 {"type":"error","error":{"type":"proxy_no_keys_available","message":"No AWS Bedrock keys available"}}';

test("a content-class 4xx from the head falls over to the next member (no strike)", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const calls: string[] = [];
  const fail = new Map([["wire-X", { error: NO_KEYS, delayMs: 0 }]]);
  const last = await run(failingComposite([X, Y], calls, fail, scheduler, 60_000));
  assert.equal(last.type, "done", "the fallback answered");
  assert.deepEqual(calls, ["wire-X", "wire-Y"], "the head is not re-sent the request");
  const snap = scheduler.snapshot().models.find((m) => m.key === X_KEY);
  assert.ok(!snap || snap.consecutiveFailures === 0, "a content error is not a health strike");
  scheduler.stop();
});

test("a content-class error with no other member left still surfaces", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const calls: string[] = [];
  const fail = new Map([["wire-X", { error: NO_KEYS, delayMs: 0 }], ["wire-Y", { error: NO_KEYS, delayMs: 0 }]]);
  const last = await run(failingComposite([X, Y], calls, fail, scheduler, 60_000));
  assert.equal(last.type, "error");
  assert.deepEqual(calls, ["wire-X", "wire-Y"], "each member tried once");
  scheduler.stop();
});

test("an environmental error that lands after the budget is spent falls over instead of parking", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const calls: string[] = [];
  // The head answers 502 only after the whole budget has elapsed.
  const fail = new Map([["wire-X", { error: "OpenAI API error (502): 502 status code (no body)", delayMs: 80 }]]);
  const last = await run(failingComposite([X, Y], calls, fail, scheduler, 50));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-Y"]);
  scheduler.stop();
});

test("moving to another member gives it a fresh wall-clock budget (never the leftovers)", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 3 } });
  const calls: string[] = [];
  // The head burns most of the 100 ms budget before its 502; the fallback hangs 60 ms before answering.
  const fb = buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: () => ((model, _ctx, opts) => {
      calls.push(model.id);
      const stream = createAssistantMessageEventStream();
      let settled = false;
      (opts as { signal?: AbortSignal }).signal?.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        const err = message(model, "aborted", "Request aborted");
        stream.push({ type: "error", reason: "aborted", error: err });
        stream.end(err);
      }, { once: true });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        if (model.id === "wire-X") {
          const err = message(model, "error", "OpenAI API error (502): 502 status code (no body)");
          stream.push({ type: "error", reason: "error", error: err });
          stream.end(err);
        } else {
          const done = message(model, "stop");
          stream.push({ type: "done", reason: "stop", message: done });
          stream.end(done);
        }
      }, model.id === "wire-X" ? 80 : 60);
      return stream;
    }) as StreamFn,
    makeModel,
    scheduler,
    admission: { priority: "interactive" },
    primaryAttemptsPerRequest: 1,
  });
  const last = await run(withRequestRetry(fb.streamFn, { maxWaitMs: 100, backoffBaseMs: 1, backoffMaxMs: 1 }));
  assert.equal(last.type, "done", "the fallback was not cut off by the head's spent time");
  assert.deepEqual(calls, ["wire-X", "wire-Y"]);
  scheduler.stop();
});

// ---------------------------------------------------------------------------
// Failure groups (§8a): once a member of a group fails the request, the rest of
// the group is skipped on the fallback path, and tried only as a last resort.
// ---------------------------------------------------------------------------

const grouped = (entry: ModelChainEntry, group: string): ModelChainEntry => ({
  ...entry,
  config: { ...entry.config, failure_group: group },
});

test("failure group (chain): the head's failures skip its group-mates, the next group answers", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 10 } });
  const calls: string[] = [];
  const down = new Set(["wire-X", "wire-L"]);
  const last = await run(composite([grouped(X, "up"), grouped(L, "up"), Y], calls, down, scheduler));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-X", "wire-Y"], "L shares X's group and is skipped");
  scheduler.stop();
});

test("failure group (chain): a stall fails the group at once", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 10 } });
  const calls: string[] = [];
  const last = await run(
    stallComposite([grouped(X, "up"), grouped(L, "up"), Y], calls, new Set(["wire-X", "wire-L"]), scheduler, {
      maxWaitMs: 60_000,
      firstTokenTimeoutMs: 30,
    }),
  );
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-Y"]);
  scheduler.stop();
});

test("failure group (chain): a listed status fails the group; an unlisted one excludes only the member", async () => {
  const mk = (statuses?: number[]) => {
    const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 10 } });
    const calls: string[] = [];
    const fb = buildModelFallback([grouped(X, "up"), grouped(L, "up"), Y], {
      consumer: "test",
      makeBase: failingBase(calls, new Map([["wire-X", { error: NO_KEYS, delayMs: 0 }]])),
      makeModel,
      scheduler,
      admission: { priority: "interactive" },
      failureGroupStatuses: (g) => (g === "up" ? statuses : undefined),
    });
    return { calls, scheduler, streamFn: withRequestRetry(fb.streamFn, { maxWaitMs: 60_000, backoffBaseMs: 1, backoffMaxMs: 1 }) };
  };
  const listed = mk([400]);
  assert.equal((await run(listed.streamFn)).type, "done");
  assert.deepEqual(listed.calls, ["wire-X", "wire-Y"], "400 is listed: L is skipped");
  listed.scheduler.stop();
  const unlisted = mk(undefined);
  assert.equal((await run(unlisted.streamFn)).type, "done");
  assert.deepEqual(unlisted.calls, ["wire-X", "wire-L"], "400 is not listed: only X is excluded, L answers");
  unlisted.scheduler.stop();
});

test("failure group (chain): the group-mate is the last resort when nothing else is left", async () => {
  const scheduler = new LlmScheduler({ health: { unhealthyThreshold: 10 } });
  const calls: string[] = [];
  const last = await run(composite([grouped(X, "up"), grouped(L, "up")], calls, new Set(["wire-X"]), scheduler));
  assert.equal(last.type, "done");
  assert.deepEqual(calls, ["wire-X", "wire-X", "wire-L"]);
  scheduler.stop();
});
