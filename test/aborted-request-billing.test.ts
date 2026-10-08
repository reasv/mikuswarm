/**
 * Billing of aborted requests (ARCHITECTURE.md §8b "Aborted requests"): a request
 * the run aborts on the wire is billed by the provider, so Layer 0 hands it to
 * `onRequestAborted` once, the estimate keeps every reported count and estimates
 * the rest, and the factory writes one `estimated` ledger row through the normal
 * commit path. Also: the `estimated` ledger column and its console wire shape.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { AgentSessionFactory } from "../src/agent/factory.js";
import { getRequestAttemptState, withRequestRetry, type AbortedRequestInfo } from "../src/agent/request-retry.js";
import { LlmRequestRing } from "../src/agent/request-ring.js";
import { LlmScheduler, withSchedulerAdmission } from "../src/agent/scheduler.js";
import { ABORTED_OUTPUT_TOKENS_PER_SECOND, estimateAbortedRequestUsage } from "../src/agent/usage.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";
import type { AppConfig } from "../src/config/index.js";
import type { BuiltContext, ContextBuilder } from "../src/context/builder.js";
import { estimateTokens } from "../src/context/tokens.js";
import { usageToolCalls } from "../src/observability/server/handlers.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// Layer 0
// ---------------------------------------------------------------------------

const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

const startEvent = (): AssistantMessageEvent => ({ type: "start", partial: message() });
const textDelta = (delta: string): AssistantMessageEvent => ({ type: "text_delta", contentIndex: 0, delta, partial: message() });
const thinkingDelta = (delta: string): AssistantMessageEvent => ({ type: "thinking_delta", contentIndex: 0, delta, partial: message() });
const toolcallDelta = (delta: string): AssistantMessageEvent => ({ type: "toolcall_delta", contentIndex: 1, delta, partial: message() });
const doneEvent = (usage?: Partial<Usage>): AssistantMessageEvent => ({
  type: "done",
  reason: "stop",
  message: message({ usage: { ...ZERO_USAGE, ...usage, cost: { ...ZERO_USAGE.cost, total: 0.5 } } }),
});

const FAST = { backoffBaseMs: 0, backoffMaxMs: 0 } as const;
const MODEL = message() as never;
const CONTEXT = { messages: [] } as never;

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/**
 * One attempt that yields `events` (after `delayMs`, or not at all when `silent`),
 * then stays open until its signal aborts, ending in pi-ai's shape: a terminal
 * `aborted` error event carrying `reported` usage.
 */
function hangingAttempt(opts: { events?: AssistantMessageEvent[]; silent?: boolean; reported?: Partial<Usage>; admission?: boolean }): StreamFn {
  return (_model, _context, streamOptions) => {
    const signal = (streamOptions as { signal?: AbortSignal } | undefined)?.signal;
    const state = getRequestAttemptState(streamOptions);
    const out = createAssistantMessageEventStream();
    void (async () => {
      if (opts.admission && state) state.awaitingAdmission = true;
      if (!opts.silent) for (const e of opts.events ?? []) out.push(e);
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      out.push({
        type: "error",
        reason: "aborted",
        error: message({
          stopReason: "aborted",
          errorMessage: "Request was aborted",
          usage: { ...ZERO_USAGE, ...opts.reported, cost: { ...ZERO_USAGE.cost } },
        }),
      });
    })();
    return out;
  };
}

/** Play `fns` one per attempt. */
function sequence(fns: StreamFn[]): StreamFn {
  let n = 0;
  return (m, c, o) => fns[Math.min(n++, fns.length - 1)]!(m, c, o);
}

function capture() {
  const committed: AssistantMessage[] = [];
  const aborted: AbortedRequestInfo[] = [];
  const estimate: Usage = { input: 7, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
  return {
    committed,
    aborted,
    estimate,
    ctx: {
      onRequestCommitted: (m: AssistantMessage) => committed.push(m),
      onRequestAborted: (info: AbortedRequestInfo) => {
        aborted.push(info);
        return estimate;
      },
    },
  };
}

test("Layer 0: a mid-stream abort fires onRequestAborted once with the streamed deltas, not onRequestCommitted", async () => {
  const c = capture();
  const ring = new LlmRequestRing();
  const base = hangingAttempt({
    events: [startEvent(), thinkingDelta("let me think. "), textDelta("Hello wor"), toolcallDelta('{"text":"hi"')],
    reported: { input: 40, cacheRead: 100 },
  });
  const controller = new AbortController();
  const wrapped = withRequestRetry(base, { ...FAST }, { ...c.ctx, ring });
  const out = wrapped(MODEL, CONTEXT, { signal: controller.signal } as never);
  setTimeout(() => controller.abort(), 20);
  const events = await drain(out);
  assert.deepEqual(events.map((e) => e.type), ["error"]);
  assert.equal(c.aborted.length, 1);
  assert.equal(c.committed.length, 0, "the reported usage is not captured a second time");
  const info = c.aborted[0]!;
  assert.equal(info.firstEventSeen, true);
  assert.equal(info.streamedText, 'let me think. Hello wor{"text":"hi"');
  assert.equal(info.attempt, 1);
  assert.equal(info.message.usage.input, 40, "the hook sees the stream's reported usage");
  const [rec] = ring.list();
  assert.equal(rec!.outcome, "aborted");
  assert.equal(rec!.estimated, true);
  assert.deepEqual(rec!.usage, { input: 7, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: 0.25 });
});

test("Layer 0: an abort before the first stream event is recorded too (firstEventSeen false, no deltas)", async () => {
  const c = capture();
  const controller = new AbortController();
  const wrapped = withRequestRetry(hangingAttempt({ silent: true }), { ...FAST }, c.ctx);
  const out = wrapped(MODEL, CONTEXT, { signal: controller.signal } as never);
  setTimeout(() => controller.abort(), 10);
  await drain(out);
  assert.equal(c.aborted.length, 1);
  assert.equal(c.aborted[0]!.firstEventSeen, false);
  assert.equal(c.aborted[0]!.streamedText, "");
  assert.equal(c.committed.length, 0);
});

test("Layer 0: no aborted request for an attempt still waiting for admission, or already aborted at its start", async () => {
  const waiting = capture();
  const controller = new AbortController();
  const ring = new LlmRequestRing();
  const out = withRequestRetry(hangingAttempt({ silent: true, admission: true }), { ...FAST }, { ...waiting.ctx, ring })(
    MODEL, CONTEXT, { signal: controller.signal } as never,
  );
  setTimeout(() => controller.abort(), 10);
  await drain(out);
  assert.equal(waiting.aborted.length, 0, "never reached the wire");
  assert.equal(ring.list()[0]!.usage, undefined);

  const pre = capture();
  const preCtrl = new AbortController();
  preCtrl.abort();
  await drain(withRequestRetry(hangingAttempt({ events: [startEvent()] }), { ...FAST }, pre.ctx)(MODEL, CONTEXT, { signal: preCtrl.signal } as never));
  assert.equal(pre.aborted.length, 0);
});

test("Layer 0 + scheduler: an abort in the admission queue records nothing; one after admission is recorded", async () => {
  const scheduler = new LlmScheduler({ groups: { default: { max_in_flight: 1 } } });
  const held = await scheduler.acquire({ priority: "interactive" });
  const c = capture();
  const admitted = withSchedulerAdmission(hangingAttempt({ silent: true }), scheduler, { group: "default", priority: "interactive" });
  const controller = new AbortController();
  const out = withRequestRetry(admitted, { ...FAST }, c.ctx)(MODEL, CONTEXT, { signal: controller.signal } as never);
  setTimeout(() => controller.abort(), 15);
  await drain(out);
  assert.equal(c.aborted.length, 0, "aborted while queued behind the held slot");
  held();

  const c2 = capture();
  const ctrl2 = new AbortController();
  const out2 = withRequestRetry(admitted, { ...FAST }, c2.ctx)(MODEL, CONTEXT, { signal: ctrl2.signal } as never);
  setTimeout(() => ctrl2.abort(), 15);
  await drain(out2);
  assert.equal(c2.aborted.length, 1, "admitted, then aborted: billed");
  scheduler.stop?.();
});

test("Layer 0: a retried environmental failure and the aborted retry are each counted once", async () => {
  const c = capture();
  const failing: StreamFn = () => {
    const s = createAssistantMessageEventStream();
    s.push({
      type: "error",
      reason: "error",
      error: message({ stopReason: "error", errorMessage: "500 internal", usage: { ...ZERO_USAGE, input: 10, totalTokens: 10, cost: { ...ZERO_USAGE.cost, total: 0.01 } } }),
    });
    return s;
  };
  const controller = new AbortController();
  const base = sequence([failing, hangingAttempt({ events: [startEvent(), textDelta("partial")] })]);
  const out = withRequestRetry(base, { ...FAST }, c.ctx)(MODEL, CONTEXT, { signal: controller.signal } as never);
  setTimeout(() => controller.abort(), 30);
  await drain(out);
  assert.equal(c.committed.length, 1, "the failed attempt's reported usage, once");
  assert.equal(c.committed[0]!.usage.input, 10);
  assert.equal(c.aborted.length, 1, "the aborted retry, once");
  assert.equal(c.aborted[0]!.attempt, 2);
  assert.equal(c.aborted[0]!.streamedText, "partial");
});

test("Layer 0: a stall abort (wall-clock budget) is environmental, never an aborted request", async () => {
  const c = capture();
  const out = withRequestRetry(hangingAttempt({ events: [startEvent()] }), { maxWaitMs: 20, ...FAST }, c.ctx)(MODEL, CONTEXT, undefined);
  const events = await drain(out);
  assert.equal(events[0]!.type, "error");
  assert.equal(c.aborted.length, 0);
});

test("Layer 0: without the hook, an aborted attempt's reported usage is captured as before", async () => {
  const committed: AssistantMessage[] = [];
  const controller = new AbortController();
  const out = withRequestRetry(hangingAttempt({ events: [startEvent()], reported: { input: 40, totalTokens: 40 } }), { ...FAST }, {
    onRequestCommitted: (m) => committed.push(m),
  })(MODEL, CONTEXT, { signal: controller.signal } as never);
  setTimeout(() => controller.abort(), 10);
  await drain(out);
  assert.equal(committed.length, 1);
  assert.equal(committed[0]!.stopReason, "aborted");
});

test("Layer 0: the normal done path is unchanged (one commit, no aborted hook, no estimated flag)", async () => {
  const c = capture();
  const ring = new LlmRequestRing();
  const base: StreamFn = () => {
    const s = createAssistantMessageEventStream();
    for (const e of [startEvent(), textDelta("hi"), doneEvent({ input: 5, output: 2, totalTokens: 7 })]) s.push(e);
    return s;
  };
  await drain(withRequestRetry(base, { ...FAST }, { ...c.ctx, ring })(MODEL, CONTEXT, undefined));
  assert.equal(c.committed.length, 1);
  assert.equal(c.aborted.length, 0);
  const [rec] = ring.list();
  assert.equal(rec!.outcome, "done");
  assert.equal(rec!.estimated, undefined);
  assert.deepEqual(rec!.usage, { input: 5, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: 0.5 });
});

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

const RATES = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };
const aborted = (usage: Partial<Usage> = {}) => message({ stopReason: "aborted", usage: { ...ZERO_USAGE, ...usage, cost: { ...ZERO_USAGE.cost } } });

test("estimate: reported input is kept, output estimated from the deltas, priced on the served member's rates", () => {
  const text = "Hello there, this is a partial answer";
  const est = estimateAbortedRequestUsage(
    { message: aborted({ input: 40, output: 1, cacheRead: 1000, cacheWrite: 20 }), streamedText: text, firstEventSeen: true },
    { costRates: RATES, healthKey: "h", promptEstimate: 99_999, now: 0 },
  );
  const out = estimateTokens(text);
  assert.ok(out > 1);
  assert.equal(est.inputReported, true);
  assert.deepEqual(
    [est.usage.input, est.usage.cacheRead, est.usage.cacheWrite, est.usage.output, est.usage.totalTokens],
    [40, 1000, 20, out, 1060 + out],
  );
  assert.equal(est.promptTokens, 1060);
  const expected = (40 * 3 + out * 15 + 1000 * 0.3 + 20 * 3.75) / 1e6;
  assert.ok(Math.abs(est.usage.cost.total - expected) < 1e-12);
});

test("estimate: a larger reported output wins over the delta estimate", () => {
  const est = estimateAbortedRequestUsage(
    { message: aborted({ input: 5, output: 500 }), streamedText: "short", firstEventSeen: true },
    { costRates: RATES, healthKey: "h", promptEstimate: 0, now: 0 },
  );
  assert.equal(est.usage.output, 500);
});

test("estimate: without reported usage the prompt estimate is input, minus a fresh same-domain cache read", () => {
  const info = { message: aborted(), streamedText: "", firstEventSeen: false };
  const baseline = { tokens: 800, atMs: 1_000, healthKey: "h" };
  const fresh = estimateAbortedRequestUsage(info, { costRates: RATES, healthKey: "h", promptEstimate: 1000, cacheBaseline: baseline, now: 2_000 });
  assert.equal(fresh.inputReported, false);
  assert.deepEqual([fresh.usage.input, fresh.usage.cacheRead, fresh.usage.cacheWrite, fresh.usage.output], [200, 800, 0, 0]);
  assert.ok(Math.abs(fresh.usage.cost.total - (200 * 3 + 800 * 0.3) / 1e6) < 1e-12);

  const otherDomain = estimateAbortedRequestUsage(info, { costRates: RATES, healthKey: "other", promptEstimate: 1000, cacheBaseline: baseline, now: 2_000 });
  assert.deepEqual([otherDomain.usage.input, otherDomain.usage.cacheRead], [1000, 0]);
  const stale = estimateAbortedRequestUsage(info, { costRates: RATES, healthKey: "h", promptEstimate: 1000, cacheBaseline: baseline, now: 1_000 + 300_000 });
  assert.deepEqual([stale.usage.input, stale.usage.cacheRead], [1000, 0]);
  const unpriced = estimateAbortedRequestUsage(info, { healthKey: "h", promptEstimate: 1000, now: 0 });
  assert.equal(unpriced.usage.cost.total, 0);
});

// ---------------------------------------------------------------------------
// Factory: one estimated ledger row through the normal commit path
// ---------------------------------------------------------------------------

type Mode = "anthropic" | "openai" | "silent";

async function hangingServer(mode: Mode, text: string): Promise<{ port: number; sent: Promise<void>; close: () => Promise<void> }> {
  let markSent!: () => void;
  const sent = new Promise<void>((resolve) => (markSent = resolve));
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (mode === "silent") {
        markSent();
        return; // never answers
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (mode === "anthropic") {
        const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send("message_start", {
          type: "message_start",
          message: {
            id: "msg_1", type: "message", role: "assistant", model: "anth-wire", content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 40, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
          },
        });
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
      } else {
        res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      }
      markSent();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    sent,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function modelBlock(mode: Mode, port: number) {
  return mode === "anthropic"
    ? { id: "anth-wire", provider: "anthropic", api: "anthropic-messages", endpoint: `http://127.0.0.1:${port}`, reasoning: false }
    : { id: "oai-wire", provider: "test", api: "openai-completions", endpoint: `http://127.0.0.1:${port}/v1` };
}

/** The most an aborted run may bill as output: its streamed deltas, or the per-second floor for the wall time it took. */
function floorBound(streamed: number, elapsedMs: number): number {
  return Math.max(streamed, Math.ceil((elapsedMs / 1000) * ABORTED_OUTPUT_TOKENS_PER_SECOND));
}

async function runAborted(mode: Mode, text: string) {
  const server = await hangingServer(mode, text);
  const root = await mkdtemp(path.join(os.tmpdir(), "miku-abort-"));
  await writeFile(path.join(root, "AGENTS.md"), "Be nice.\n");
  const recorded: any[] = [];
  const logs: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const logger: any = {
    debug() {},
    info: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }),
    warn() {},
    error() {},
    child: () => logger,
  };
  try {
    const built = {
      messages: [
        { type: "system", role: "system", content: "SYSTEM", tier: "system", tokenEstimate: 1 },
        { type: "triggerGroup", role: "user", content: "<message>hi</message>", tier: "trigger", tokenEstimate: 1, timestamp: 1 },
      ],
      tokenEstimate: 2,
      compactTokens: 0,
      richTokens: 0,
      imageBlocks: [],
    } as unknown as BuiltContext;
    const config = {
      app: { name: "t", data_dir: "/tmp", log_level: "error", context_dump_dir: "" },
      agent: { sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 }, system: {} },
      recovery: { llm_request_max_wait_ms: 60_000, llm_request_backoff_base_ms: 1, llm_request_backoff_max_ms: 1 },
      models: {
        default: {
          ...modelBlock(mode, server.port),
          api_key: "k",
          input_modalities: ["text"],
          max_tokens: 256,
          context_window: 128_000,
          cost: RATES,
        },
      },
      context: { tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 } },
      storage: { database_path: ":memory:" },
      workspace: { root_dir: root },
      matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    } as unknown as AppConfig;
    const factory = new AgentSessionFactory({
      config,
      contextBuilder: { build: async () => built } as unknown as ContextBuilder,
      getActiveSessions: () => [],
      budget: { record: (event: unknown) => recorded.push(event) } as any,
      logger,
    });
    const session = {
      id: `s-${mode}`,
      timelineKey: "matrix:a:room:!r",
      sessionType: "default",
      status: "running",
      trigger: {
        provider: "matrix",
        timelineKey: "matrix:a:room:!r",
        event: { id: "e", timelineKey: "matrix:a:room:!r", provider: "matrix", role: "user", sender: { id: "@u:hs" }, body: "hi", timestamp: 1, receivedAt: 1 },
      },
      createdAt: 0,
    } as unknown as AgentSessionRecord;
    const created = await factory.create(session, []);
    // Wall time around the whole run: the stream ran no longer, so it bounds the per-second floor.
    const startedAt = performance.now();
    const run = created.agent.prompt(created.finalTurn as any);
    await server.sent;
    await new Promise((r) => setTimeout(r, 60));
    created.agent.abort();
    await run;
    const elapsedMs = performance.now() - startedAt;
    return { recorded: recorded.filter((r) => r.class === "agent_loop"), logs, usage: created.usage.snapshot(), elapsedMs };
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("factory: an Anthropic stream aborted mid-way records one estimated row (reported input, estimated output)", async () => {
  const text = "Hello there, this is the beginning of a long answer";
  const { recorded, logs, usage, elapsedMs } = await runAborted("anthropic", text);
  assert.equal(recorded.length, 1);
  const row = recorded[0];
  const out = estimateTokens(text);
  assert.equal(row.estimated, true);
  assert.equal(row.logicalModelId, "default");
  assert.deepEqual([row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens], [40, 1000, 0]);
  // At least the streamed deltas; the per-second floor can win on a loaded host (the test aborts
  // after real wall time), so the exact count is not pinned here, but it never exceeds the floor
  // for the wall time the run took.
  assert.ok(row.outputTokens >= out);
  assert.ok(row.outputTokens <= floorBound(out, elapsedMs), `${row.outputTokens} output tokens in ${Math.round(elapsedMs)} ms`);
  assert.ok(Math.abs(row.costUsd - (40 * 3 + row.outputTokens * 15 + 1000 * 0.3) / 1e6) < 1e-12);
  // The session tracker (cost ceiling) counted it too.
  assert.equal(usage.llmRequests, 1);
  assert.ok(Math.abs(usage.cost - row.costUsd) < 1e-12);
  const line = logs.find((l) => l.msg === "llm_request_aborted");
  assert.ok(line, "llm_request_aborted is logged");
  assert.deepEqual(
    [line!.fields!.sessionId, line!.fields!.model, line!.fields!.inputTokens, line!.fields!.outputTokens, line!.fields!.estimated, line!.fields!.firstEventSeen],
    ["s-anthropic", "default", 1040, row.outputTokens, true, true],
  );
});

test("factory: an OpenAI stream without usage is billed on the estimated context and the streamed output", async () => {
  const text = "partial answer text";
  const { recorded, elapsedMs } = await runAborted("openai", text);
  assert.equal(recorded.length, 1);
  const row = recorded[0];
  assert.equal(row.estimated, true);
  assert.ok(row.inputTokens > 0, "input estimated from the running context");
  assert.equal(row.cacheReadTokens, 0, "no prior request: no cache credit");
  assert.ok(row.outputTokens >= estimateTokens(text), "at least the streamed deltas (the time floor can win under load)");
  assert.ok(row.outputTokens <= floorBound(estimateTokens(text), elapsedMs), `${row.outputTokens} output tokens in ${Math.round(elapsedMs)} ms`);
  assert.ok(row.costUsd > 0);
});

test("factory: a request aborted before any response is billed on its input alone", async () => {
  const { recorded, logs } = await runAborted("silent", "");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].estimated, true);
  assert.equal(recorded[0].outputTokens, 0);
  assert.ok(recorded[0].inputTokens > 0);
  assert.equal(logs.find((l) => l.msg === "llm_request_aborted")!.fields!.firstEventSeen, false);
});

// ---------------------------------------------------------------------------
// Storage + console wire
// ---------------------------------------------------------------------------

test("usage_events.estimated: 1 when flagged, null otherwise; the tool-calls API exposes a boolean", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await storage.insertUsageEvent({ ts: 1, class: "agent_loop", agentSessionId: "s", modelId: "m", costUsd: 0.1, estimated: true });
    await storage.insertUsageEvent({ ts: 2, class: "agent_loop", agentSessionId: "s", modelId: "m", costUsd: 0.1 });
    await storage.insertUsageEvent({ ts: 3, class: "tool", toolName: "t", modelId: "m", costUsd: 0.1, estimated: true });
    await storage.insertUsageEvent({ ts: 4, class: "tool", toolName: "t", modelId: "m", costUsd: 0.1 });
    await storage.waitForIdle();
    const flags = storage.read((db) => db.prepare(`select estimated from usage_events order by ts`).all() as Array<{ estimated: number | null }>);
    assert.deepEqual(flags.map((r) => r.estimated), [1, null, 1, null]);

    let body = "";
    const res = { writeHead() {}, end: (b: string) => (body = b) } as any;
    usageToolCalls({} as any, res, { deps: { storage }, url: new URL("http://x/api/usage/tool-calls"), params: {} } as any);
    const calls = (JSON.parse(body) as { toolCalls: Array<{ ts: number; estimated: unknown }> }).toolCalls;
    assert.deepEqual(calls.map((c) => [c.ts, c.estimated]), [[4, false], [3, true]]);
  } finally {
    storage.close();
  }
});

test("estimate: hidden reasoning (no deltas) is billed at a per-second floor of the time it streamed", () => {
  const info = { message: aborted({ input: 100 }), streamedText: "", firstEventSeen: true, streamingMs: 5_000 };
  const est = estimateAbortedRequestUsage(info, { costRates: RATES, healthKey: "h", promptEstimate: 0, now: 0 });
  assert.equal(est.usage.output, 5 * ABORTED_OUTPUT_TOKENS_PER_SECOND);
  // Streamed deltas larger than the floor win; no first event, no floor.
  const long = "word ".repeat(400);
  assert.equal(estimateAbortedRequestUsage({ ...info, streamedText: long }, { healthKey: "h", promptEstimate: 0, now: 0 }).usage.output, estimateTokens(long));
  assert.equal(estimateAbortedRequestUsage({ ...info, firstEventSeen: false }, { healthKey: "h", promptEstimate: 0, now: 0 }).usage.output, 0);
});
