/**
 * Repetition guard (ARCHITECTURE.md §8a "Repetition guard"): the detector trips
 * only on an exact back-to-back loop, and Layer 0 turns a trip into an aborted,
 * billed, health-neutral attempt that is retried with a fresh wall-clock budget.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { RepetitionDetector } from "../src/agent/repetition-guard.js";
import {
  LLM_DEGENERATE_ABORT_REASON,
  MAX_DEGENERATE_TRIPS_PER_REQUEST,
  withRequestRetry,
  type AbortedRequestInfo,
} from "../src/agent/request-retry.js";
import { LlmRequestRing } from "../src/agent/request-ring.js";

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random prose (no exact loops). */
function prose(chars: number, seed = 1): string {
  const words = ["the", "card", "describes", "a", "quiet", "girl", "who", "keeps", "bees", "near", "an", "old", "shrine", "and", "laughs", "often", "at", "small", "things", "."];
  let x = seed;
  let out = "";
  while (out.length < chars) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += words[x % words.length] + (x % 7 === 0 ? "\n" : " ");
  }
  return out.slice(0, chars);
}

function feed(text: string, chunk = 37, cfg?: ConstructorParameters<typeof RepetitionDetector>[0]) {
  const d = new RepetitionDetector(cfg);
  for (let i = 0; i < text.length; i += chunk) {
    const trip = d.push(0, text.slice(i, i + chunk));
    if (trip) return trip;
  }
  return undefined;
}

test("detector: a single character looping trips once the run reaches min_chars", () => {
  const trip = feed(prose(3000) + "@ ".repeat(20_000));
  assert.ok(trip);
  assert.equal(trip.period, 2);
  assert.equal(trip.runChars, 4000);
  assert.equal(trip.blockChars, 3000 + 2 + 4000, "trips as soon as the threshold is reached, not at the end");
});

test("detector: a sentence-length unit looping trips; a paragraph needs min_repeats copies", () => {
  const unit = prose(129, 7);
  assert.equal(feed(prose(500) + unit.repeat(40))?.period, 129);
  const para = prose(1000, 3);
  assert.equal(feed(prose(200) + para.repeat(4) + prose(500, 9)), undefined, "4 copies of a 1000-char block is under min_chars");
  assert.equal(feed(prose(200) + para.repeat(5))?.runChars, 4000, "the 5th copy reaches min_chars");
  const block = prose(1024, 4);
  const trip = feed(prose(200) + block.repeat(5), 37, { min_chars: 1000 });
  assert.equal(trip?.period, 1024);
  assert.equal(trip?.runChars, 3 * 1024, "with a low min_chars, min_repeats (4 copies) binds");
});

test("detector: legitimate repetitive-looking output does not trip", () => {
  const cases: Record<string, string> = {
    prose: prose(60_000),
    separator: "─".repeat(1500) + "\n" + prose(500),
    laughter: "ha".repeat(900),
    table: Array.from({ length: 400 }, (_, i) => `| ${i} | item ${i % 13} | ${(i * 7) % 100} |`).join("\n"),
    json: JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, name: `n${i}`, tags: ["a", "b"] }))),
    zeros: "[" + Array.from({ length: 1200 }, () => "0").join(", ") + "]",
    emoji: "🎉".repeat(900),
    code: Array.from({ length: 300 }, (_, i) => `  const v${i} = compute(${i}, ${i * 3});`).join("\n"),
  };
  for (const [name, text] of Object.entries(cases)) {
    assert.equal(feed(text), undefined, `${name} must not trip`);
  }
});

test("detector: an exact repetition longer than min_chars trips even when it was asked for (the documented limit)", () => {
  assert.ok(feed("[" + Array.from({ length: 1500 }, () => "0").join(", ") + "]"), "1500 zeros: 4500 repeated chars");
});

test("detector: chunking does not matter, and blocks are independent", () => {
  const text = prose(1000) + "ab".repeat(3000);
  assert.deepEqual(feed(text, 1), feed(text, 5000));
  const d = new RepetitionDetector();
  // Interleave two blocks: each alone loops for only 3500 chars.
  for (let i = 0; i < 3500; i++) {
    assert.equal(d.push(0, "x"), undefined);
    assert.equal(d.push(1, "y"), undefined);
  }
});

test("detector: config overrides apply", () => {
  assert.ok(feed("z".repeat(300), 37, { min_chars: 200 }));
  assert.equal(feed(prose(100) + prose(50, 5).repeat(10), 37, { max_period: 20 }), undefined);
});

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
    api: "openai-completions",
    provider: "served-provider",
    model: "served-wire-model",
    usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  };
}

const FAST = { backoffBaseMs: 0, backoffMaxMs: 0 } as const;
const MODEL = message({ model: "head-model" }) as never;
const CONTEXT = { messages: [] } as never;

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** An attempt that streams prose, then loops on "@ " until aborted (or `loopChars` run out). */
function loopingAttempt(signals: AbortSignal[], opts: { delayMs?: number } = {}): StreamFn {
  return (_model, _context, streamOptions) => {
    const signal = (streamOptions as { signal?: AbortSignal }).signal!;
    signals.push(signal);
    const out = createAssistantMessageEventStream();
    void (async () => {
      out.push({ type: "start", partial: message() });
      out.push({ type: "toolcall_delta", contentIndex: 1, delta: prose(800), partial: message() });
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      for (let i = 0; i < 500 && !signal.aborted; i++) {
        out.push({ type: "toolcall_delta", contentIndex: 1, delta: "@ ".repeat(50), partial: message() });
        await new Promise((r) => setImmediate(r));
      }
      out.push({ type: "error", reason: "aborted", error: message({ stopReason: "aborted", errorMessage: "Request was aborted" }) });
    })();
    return out;
  };
}

function cleanAttempt(): StreamFn {
  return () => {
    const out = createAssistantMessageEventStream();
    queueMicrotask(() => {
      out.push({ type: "start", partial: message() });
      out.push({ type: "text_delta", contentIndex: 0, delta: "fine", partial: message() });
      out.push({ type: "done", reason: "stop", message: message({ usage: { ...ZERO_USAGE, output: 1, totalTokens: 1, cost: { ...ZERO_USAGE.cost, total: 0.01 } } }) });
    });
    return out;
  };
}

function sequence(fns: StreamFn[]): StreamFn {
  let n = 0;
  return (m, c, o) => fns[Math.min(n++, fns.length - 1)]!(m, c, o);
}

function harness() {
  const aborted: AbortedRequestInfo[] = [];
  const committed: AssistantMessage[] = [];
  const logs: Array<{ msg: string; data: Record<string, unknown> }> = [];
  const logger = {
    warn: (msg: string, data: Record<string, unknown>) => logs.push({ msg, data }),
    info: () => {},
    error: () => {},
    debug: () => {},
  };
  return {
    aborted,
    committed,
    logs,
    ctx: {
      logger: logger as never,
      repetitionGuard: () => ({}),
      onRequestCommitted: (m: AssistantMessage) => committed.push(m),
      onRequestAborted: (info: AbortedRequestInfo) => {
        aborted.push(info);
        return { ...ZERO_USAGE, output: 1000, totalTokens: 1000, cost: { ...ZERO_USAGE.cost, total: 0.02 } };
      },
    },
  };
}

test("Layer 0: a looping attempt is aborted on the wire, billed once, and retried", async () => {
  const h = harness();
  const ring = new LlmRequestRing();
  const signals: AbortSignal[] = [];
  const wrapped = withRequestRetry(sequence([loopingAttempt(signals), cleanAttempt()]), { ...FAST }, { ...h.ctx, ring });
  const events = await drain(wrapped(MODEL, CONTEXT, {} as never));
  assert.equal(events.at(-1)!.type, "done", "the retry's clean turn is delivered");
  assert.ok(!events.some((e) => e.type === "toolcall_delta" && e.delta.includes("@")), "the looping partial is discarded");
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[0]!.reason, LLM_DEGENERATE_ABORT_REASON, "the abort carries the degenerate marker, not the stall marker");
  assert.equal(h.aborted.length, 1, "billed through the aborted-request hook");
  assert.equal(h.aborted[0]!.message.model, "served-wire-model", "billed to the member that served it");
  assert.ok(h.aborted[0]!.streamedText.length < 6000, "stopped near the threshold, not at the end of the loop");
  const log = h.logs.find((l) => l.msg === "llm_degenerate_output");
  assert.ok(log);
  assert.equal(log.data.period, 2);
  const [second, first] = ring.list(); // newest first
  assert.equal(first!.class, "environmental");
  assert.match(first!.errorMessage!, /degenerate output/);
  assert.equal(first!.estimated, true);
  assert.equal(second!.outcome, "done");
});

test("Layer 0: the retry after a trip gets a fresh wall-clock budget", async () => {
  const h = harness();
  const signals: AbortSignal[] = [];
  // The looping attempt outlives the 40 ms budget before it trips.
  const wrapped = withRequestRetry(
    sequence([loopingAttempt(signals, { delayMs: 80 }), cleanAttempt()]),
    { ...FAST, maxWaitMs: 40 },
    h.ctx,
  );
  const events = await drain(wrapped(MODEL, CONTEXT, {} as never));
  assert.equal(events.at(-1)!.type, "done");
});

test("Layer 0: a request that keeps looping gives up after the trip cap", async () => {
  const h = harness();
  const signals: AbortSignal[] = [];
  const wrapped = withRequestRetry(loopingAttempt(signals), { ...FAST }, h.ctx);
  const events = await drain(wrapped(MODEL, CONTEXT, {} as never));
  const last = events.at(-1)!;
  assert.equal(last.type, "error");
  assert.match((last as { error: AssistantMessage }).error.errorMessage!, /degenerate output/);
  assert.equal(signals.length, MAX_DEGENERATE_TRIPS_PER_REQUEST + 1);
  assert.equal(h.aborted.length, MAX_DEGENERATE_TRIPS_PER_REQUEST + 1, "every tripped attempt is billed");
});

test("Layer 0: no guard configured means no detection", async () => {
  const h = harness();
  const signals: AbortSignal[] = [];
  const controller = new AbortController();
  const wrapped = withRequestRetry(loopingAttempt(signals), { ...FAST }, { ...h.ctx, repetitionGuard: () => undefined });
  const out = wrapped(MODEL, CONTEXT, { signal: controller.signal } as never);
  setTimeout(() => controller.abort(), 200);
  await drain(out);
  assert.equal(signals.length, 1);
  assert.notEqual(signals[0]!.reason, LLM_DEGENERATE_ABORT_REASON);
  assert.equal(h.logs.some((l) => l.msg === "llm_degenerate_output"), false);
});
