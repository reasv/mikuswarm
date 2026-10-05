import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { withRequestRetry, type RefusalAttemptInfo } from "../src/agent/request-retry.js";
import type { ModelChainEntry } from "../src/agent/model-fallback.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { InferenceClient, type RefusedCaptionAttempt } from "../src/captioning/inference-client.js";
import { CaptionContentError, CaptionRefusalError } from "../src/captioning/describe.js";
import { normalizeRefusalRules } from "../src/refusals/rules.js";
import { isRefusalExhausted } from "../src/refusals/fetch.js";
import {
  classifyHardRefusal,
  createSessionRefusalController,
  refusalRuleModels,
  type SessionRefusalDeps,
} from "../src/refusals/session.js";
import { MemoryFileWriter, Storage } from "../src/storage/index.js";
import { SummarizationWorkerPool } from "../src/summarization/index.js";
import { DiaryWorkerPool } from "../src/diary/index.js";
import { configureAgentTimezone } from "../src/time/index.js";
import type { Logger } from "../src/observability/index.js";
import type { AppConfig } from "../src/config/index.js";
import type { RefusalEventInsert, RefusalPin } from "../src/storage/database.js";

configureAgentTimezone("UTC");

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };

const catalogue = buildCheckCatalogue({} as Pick<AppConfig, "checks" | "agents">);

function rules(raw: Array<Record<string, unknown>>) {
  return normalizeRefusalRules({ refusal_fallback: raw } as never);
}

function controller(over: Partial<SessionRefusalDeps> & { rules: SessionRefusalDeps["rules"] }) {
  const events: RefusalEventInsert[] = [];
  const pins: RefusalPin[] = [];
  const c = createSessionRefusalController({
    sessionType: "default",
    agent: "agent_a",
    sessionId: "s",
    timelineKey: "tk",
    catalogue,
    headModel: "model_a",
    knownModel: () => true,
    chainOf: (id) => (id === "open_x" ? ["open_x", "open_x_backup"] : [id]),
    isUsable: () => true,
    insertEvent: async (row) => {
      events.push(row);
      return events.length;
    },
    persistPin: async (pin) => {
      pins.push(pin);
    },
    logger: silentLogger,
    ...over,
  });
  return { c, events, pins };
}

function refusalInfo(over: Partial<RefusalAttemptInfo> & { servedModel: string }): RefusalAttemptInfo {
  return {
    message: {
      role: "assistant", content: [], api: "anthropic-messages", provider: "anthropic", model: "wire",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error", rawStopReason: "refusal", stopCategory: "reasoning_extraction",
      errorMessage: "No. [llm-request] [llm-request:refusal]", timestamp: 0,
    } as AssistantMessage,
    attempt: 1,
    refusedKeys: new Set(),
    implicitFallover: true,
    canReissue: true,
    ...over,
  };
}

// ── Classification ───────────────────────────────────────────────────────────

test("classifyHardRefusal: category, category-less stop reasons, text-only refusals", () => {
  assert.deepEqual(classifyHardRefusal(catalogue, { api: "anthropic-messages", rawStopReason: "refusal", category: "cyber" }), {
    checkCode: "refusal_safety", reason: "safety", subReason: "cyber", method: "provider_category",
  });
  assert.equal(classifyHardRefusal(catalogue, { rawStopReason: "SPII" }).checkCode, "refusal_privacy");
  assert.deepEqual(classifyHardRefusal(catalogue, { api: "anthropic-messages", rawStopReason: "refusal", category: "brand_new" }), {
    checkCode: "refusal_uncategorized", reason: "unclear", subReason: "brand_new", method: "stop_reason",
  });
  // Recognized from pi-ai's error text alone (no raw stop reason survived).
  assert.deepEqual(classifyHardRefusal(catalogue, {}), {
    checkCode: "refusal_uncategorized", reason: "unclear", subReason: null, method: "stop_reason",
  });
  // No catalogue wired: uncategorized, raw values kept.
  assert.equal(classifyHardRefusal(undefined, { rawStopReason: "refusal", category: "bio" }).subReason, "bio");
});

// ── The handle ───────────────────────────────────────────────────────────────

test("handle: rule match by site/agent/reason/from_models; advance walks forward, skips unusable, exhausts", () => {
  const usable = new Set(["open_x", "open_z"]);
  const { c, pins } = controller({
    rules: rules([
      { name: "jobs", sites: ["summarize"], models: ["open_y"] },
      { name: "distill", reasons: ["distillation"], from_models: ["model_a"], models: ["open_x", "open_y", "open_z"] },
    ]),
    isUsable: (id) => usable.has(id),
  });
  assert.equal(c.matchRule({ reason: "safety", kind: "hard", fromModel: "model_a" }), undefined);
  assert.equal(c.matchRule({ reason: "distillation", kind: "hard", fromModel: "model_b" }), undefined, "from_models");
  const rule = c.matchRule({ reason: "distillation", kind: "hard", fromModel: "model_a" })!;
  assert.equal(rule.name, "distill");
  assert.equal(c.advance(rule, "model_a"), "open_x");
  assert.equal(c.pinnedModel(), "open_x");
  assert.deepEqual(pins.map((p) => [p.rule, p.model]), [["distill", "open_x"]]);
  // The pinned entry refuses: the same rule continues although from_models named model_a,
  // also when a member of the entry's own fallback chain served for it.
  assert.equal(c.matchRule({ reason: "distillation", kind: "hard", fromModel: "open_x_backup" })?.name, "distill");
  assert.equal(c.advance(rule, "open_x_backup"), "open_z", "open_y is unusable");
  assert.equal(c.advance(rule, "open_z"), undefined, "nothing after the last entry");
  assert.equal(c.pinnedModel(), "open_z", "exhaustion keeps the last pin");
});

test("handle: softRuleCouldMatch follows the site, the serving model and the soft mode", () => {
  const { c } = controller({
    rules: rules([
      { name: "observe_only", soft: "observe", models: ["open_x"] },
      { name: "records", sites: ["record_turn"], from_models: ["model_a"], models: ["open_x"] },
    ]),
  });
  assert.equal(c.softRuleCouldMatch(), false, "only an observe rule applies to site default");
  c.setSite("record_turn");
  assert.equal(c.site, "record_turn");
  assert.equal(c.softRuleCouldMatch(), true, "head model_a is listed in from_models");
  c.noteServing("model_b");
  assert.equal(c.softRuleCouldMatch(), false, "model_b is not");
  c.setSite(undefined);
  assert.equal(c.site, "default");
  assert.equal(c.tasks(), null);
});

test("handle: onHardRefusal decisions and event rows for every outcome", async () => {
  const cases: Array<[Record<string, unknown> | undefined, string, Partial<RefusalAttemptInfo>, string, string]> = [
    [undefined, "default", {}, "fallover", "fallover"],
    [undefined, "default", { implicitFallover: false }, "fail", "failed"],
    [{ name: "r", models: ["open_x"] }, "default", {}, "redo", "redo"],
    [{ name: "r", models: ["open_x"] }, "default", { canReissue: false }, "fail", "failed"],
  ];
  for (const [rule, site, over, action, outcome] of cases) {
    const { c, events } = controller({ rules: rule ? rules([rule]) : [] });
    c.setSite(site);
    const decision = c.onHardRefusal(refusalInfo({ servedModel: "model_a", ...over }));
    assert.equal(decision.action, action, `${JSON.stringify(rule)} ${JSON.stringify(over)}`);
    assert.equal(decision.log?.outcome, outcome);
    await new Promise((r) => setImmediate(r));
    assert.equal(events[0]!.outcome, outcome);
    assert.equal(events[0]!.checkCode, "refusal_distillation");
    assert.equal(events[0]!.method, "provider_category");
    assert.equal(events[0]!.category, "reasoning_extraction");
    assert.equal(events[0]!.explanation, "No.", "the layer tags are stripped");
    assert.equal(events[0]!.agentSessionId, "s");
    assert.equal(events[0]!.agent, "agent_a");
    assert.equal(c.lastHardOutcome(), outcome);
  }
  // Exhaustion per on_exhausted and per site.
  for (const [onExhausted, site, action, outcome] of [
    ["send_last", "default", "fail", "exhausted_send_last"],
    ["park", "proactive", "fail", "exhausted_parked"],
    ["withhold", "default", "withhold", "exhausted_withheld"],
    ["withhold", "diary", "fail", "exhausted_no_output"],
    ["send_last", "record_turn", "fail", "exhausted_no_output"],
  ] as const) {
    const { c } = controller({ rules: rules([{ name: "r", models: ["open_x"], on_exhausted: onExhausted }]), isUsable: () => false });
    c.setSite(site);
    const decision = c.onHardRefusal(refusalInfo({ servedModel: "model_a" }));
    assert.deepEqual([decision.action, decision.log?.outcome], [action, outcome], `${onExhausted} at ${site}`);
  }
});

test("handle: a resumed pin naming an unknown model is dropped; refusalRuleModels lists every reachable rule model", () => {
  const { c } = controller({
    rules: [],
    initialPin: { rule: "r", model: "gone", at: 1 },
    knownModel: (id) => id !== "gone",
  });
  assert.equal(c.pinnedModel(), undefined);
  const all = rules([
    { name: "a", sites: ["default"], models: ["open_x"] },
    { name: "b", sites: ["record_turn"], models: ["open_y"] },
    { name: "c", sites: ["caption"], models: ["open_z"] },
    { name: "d", agents: ["agent_b"], models: ["open_w"] },
  ]);
  assert.deepEqual(refusalRuleModels(all, { sites: ["default", "record_turn"], agent: "agent_a" }).sort(), ["open_x", "open_y"]);
});

test("handle (soft path, W4 API): tries, @same, no pin move on a same-model retry, restart after a delivery", () => {
  const { c, pins } = controller({
    rules: rules([{ name: "r", models: [{ model: "@same", tries: 2 }, "open_x"] }]),
  });
  const rule = c.matchRule({ reason: "distillation", kind: "soft", fromModel: "model_a" })!;
  assert.equal(rule.name, "r");
  assert.equal(c.advance(rule, "model_a"), "model_a", "@same try 1");
  assert.equal(c.pinnedModel(), undefined);
  assert.equal(c.dispatchModel(), "model_a", "the retry target holds for the current request");
  c.noteCommitted();
  assert.equal(c.dispatchModel(), undefined);
  // Still the same refusal point: the walk continues.
  assert.equal(c.matchRule({ reason: "distillation", kind: "soft", fromModel: "model_a" })?.name, "r");
  assert.equal(c.advance(rule, "model_a"), "model_a", "@same try 2");
  assert.equal(c.advance(rule, "model_a"), "open_x", "then the next entry");
  assert.equal(c.pinnedModel(), "open_x");
  assert.equal(c.advance(rule, "open_x"), undefined, "every try spent");
  // A delivered message ends the point: the pinned model's next refusal restarts at entry 1,
  // where @same now means the pinned model.
  c.noteDelivered();
  assert.equal(c.matchRule({ reason: "distillation", kind: "soft", fromModel: "open_x" })?.name, "r");
  assert.equal(c.advance(rule, "open_x"), "open_x");
  assert.equal(c.pinnedModel(), "open_x", "a same-model retry leaves the pin");
  assert.deepEqual(pins.map((p) => p.model), ["open_x"]);
});

test("handle: a site switch ends the walk", () => {
  const { c } = controller({ rules: rules([{ name: "r", models: [{ model: "open_x", tries: 2 }, "open_y"] }]) });
  const rule = c.matchRule({ reason: "safety", kind: "hard", fromModel: "model_a" })!;
  assert.equal(c.advance(rule, "model_a"), "open_x");
  c.setSite("record_turn");
  assert.equal(c.advance(rule, "open_x"), "open_x", "a new walk starts at entry 1 (a same-model retry here)");
});

// ── Layer 0 ──────────────────────────────────────────────────────────────────

function scripted(answers: Array<"refuse" | "ok">, calls: string[]): StreamFn {
  return ((model) => {
    const answer = answers.shift() ?? "ok";
    calls.push(answer);
    const stream = createAssistantMessageEventStream();
    const base = {
      role: "assistant", content: [], api: model.api, provider: "p", model: model.id, timestamp: 0,
      usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } },
    };
    queueMicrotask(() => {
      if (answer === "refuse") {
        const error = { ...base, stopReason: "error", rawStopReason: "refusal", stopCategory: "cyber", errorMessage: "no" } as any;
        stream.push({ type: "error", reason: "error", error });
        stream.end(error);
      } else {
        const done = { ...base, stopReason: "stop", content: [{ type: "text", text: "hi" }] } as any;
        stream.push({ type: "done", reason: "stop", message: done });
        stream.end(done);
      }
    });
    return stream;
  }) as StreamFn;
}

async function drain(fn: StreamFn): Promise<any> {
  const stream = await fn({ id: "m", api: "anthropic-messages", provider: "p" } as any, { messages: [] } as any, {} as any);
  const events: any[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

test("Layer 0: a redo decision re-issues at once; refused usage is committed; stopCategory reaches the hook", async () => {
  const calls: string[] = [];
  const committed: AssistantMessage[] = [];
  const seen: RefusalAttemptInfo[] = [];
  const fn = withRequestRetry(scripted(["refuse", "ok"], calls), { backoffBaseMs: 10_000, backoffMaxMs: 10_000 }, {
    onRequestCommitted: (m) => committed.push(m),
    onRefusal: (info) => {
      seen.push(info);
      return { action: "redo" };
    },
  });
  const events = await drain(fn);
  assert.deepEqual(calls, ["refuse", "ok"]);
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(committed.map((m) => m.stopReason), ["error", "stop"], "the refused attempt's usage is committed first");
  assert.equal((seen[0]!.message as any).stopCategory, "cyber");
  assert.equal(seen[0]!.canReissue, true);
});

test("Layer 0: withhold yields a harness NO_REPLY turn; fail surfaces the tagged refusal", async () => {
  const withheld = await drain(
    withRequestRetry(scripted(["refuse"], []), { backoffBaseMs: 1, backoffMaxMs: 1 }, { onRefusal: () => ({ action: "withhold" }) }),
  );
  assert.deepEqual(withheld.map((e: any) => e.type), ["start", "done"]);
  assert.deepEqual(withheld[1].message.content, [{ type: "text", text: "NO_REPLY" }]);
  assert.equal(withheld[1].message.harness.kind, "refusal_withheld");
  assert.equal(withheld[1].message.usage.totalTokens, 0);
  const failed = await drain(
    withRequestRetry(scripted(["refuse"], []), { backoffBaseMs: 1, backoffMaxMs: 1 }, { onRefusal: () => ({ action: "fail" }) }),
  );
  assert.equal(failed.at(-1).type, "error");
  assert.match(failed.at(-1).error.errorMessage, /\[llm-request:refusal\]/);
  assert.equal(failed.at(-1).error.stopCategory, "cyber", "the tagged error keeps the category");
});

// ── Mechanical jobs ─────────────────────────────────────────────────────────

const TK = "matrix:test:room:!room:server";

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A factory whose run ends in a tagged refusal; `outcome` is what the handle reports. */
function refusingFactory(outcome: string | undefined, runs: { count: number }) {
  return {
    resolveModelId: () => "test-model",
    resolveSessionCostCeiling: () => undefined,
    create: async (_session: unknown, _tools: AgentTool[]) => {
      const state: any = { messages: [] };
      return {
        agent: {
          prompt: async () => {
            runs.count += 1;
            state.messages = [{ role: "assistant", content: [], stopReason: "error", errorMessage: "no [llm-request] [llm-request:refusal]" }];
            state.errorMessage = "no [llm-request] [llm-request:refusal]";
          },
          waitForIdle: async () => {},
          subscribe: () => () => {},
          state,
        },
        renderedInputIds: ["ev0", "ev1"],
        refusal: { lastHardOutcome: () => outcome },
      };
    },
  } as any;
}

async function seedSummaryJob(storage: Storage, id: string, maxRetries: number): Promise<void> {
  for (const [eid, ts] of [["ev0", 1000], ["ev1", 2000]] as const) {
    await storage.appendTimelineEvent({
      id: eid, timelineKey: TK, provider: "matrix", role: "user",
      sender: { id: "@u:test", displayName: "X", isSelf: false }, body: `m ${eid}`, timestamp: ts, receivedAt: ts,
    });
  }
  await storage.insertSummarizationJob({
    id, timelineKey: TK, level: 1, inputStartId: "ev0", inputEndId: "ev1", inputTokenCount: 50, targetTokenCount: 100, maxRetries,
  });
}

for (const [outcome, expectedRuns] of [["exhausted_no_output", 1], [undefined, 3]] as const) {
  test(`summarization: a refused run ${outcome ? "with an exhausted rule fails at once" : "without a rule is retried as today"}`, async () => {
    const storage = await Storage.open({ databasePath: ":memory:" });
    try {
      await seedSummaryJob(storage, "job", 2);
      const runs = { count: 0 };
      const pool = new SummarizationWorkerPool({
        storage,
        factory: refusingFactory(outcome, runs),
        config: { worker_count: 1, max_retries: 2 },
        onComplete: () => {},
        onError: () => {},
        logger: silentLogger,
      });
      await pool.start();
      pool.notifyNewWork();
      await waitFor(() => storage.getSummarizationJobById("job")?.status === "failed", 8000);
      await pool.stop();
      assert.equal(runs.count, expectedRuns, "max_retries = 2 allows three runs without a rule");
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  });
}

// ── Captioning ───────────────────────────────────────────────────────────────

type CaptionAnswer = "ok" | "filter" | "refusal-field";

async function captionServer(answers: Record<string, CaptionAnswer | CaptionAnswer[]>) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const prefix = (req.url ?? "").split("/")[1]!;
      hits.push(prefix);
      const configured = answers[prefix] ?? "ok";
      const answer: CaptionAnswer = Array.isArray(configured) ? (configured.shift() ?? "ok") : configured;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      const usage = { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 };
      if (answer === "filter") {
        res.end(JSON.stringify({ model: `${prefix}-wire`, choices: [{ finish_reason: "content_filter", message: { content: "" } }], usage }));
      } else if (answer === "refusal-field") {
        res.end(JSON.stringify({ model: `${prefix}-wire`, choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't describe this." } }], usage }));
      } else {
        res.end(JSON.stringify({ model: `${prefix}-wire`, choices: [{ finish_reason: "stop", message: { content: `caption by ${prefix}` } }], usage }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { port, hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function captionModels(port: number) {
  const m = (id: string, prefix: string, modalities = ["text", "image"]) => ({
    id: `${prefix}-wire`, endpoint: `http://127.0.0.1:${port}/${prefix}`, api_key: "k", input_modalities: modalities,
    max_tokens: 256, context_window: 128000, cost: { input: 1, output: 1, cache_read: 0, cache_write: 0 },
  });
  return {
    cap: m("cap", "cap"),
    textonly: m("textonly", "textonly", ["text"]),
    alt1: m("alt1", "alt1"),
    alt2: m("alt2", "alt2"),
  } as Record<string, any>;
}

async function withImage(fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-rh-cap-"));
  const filePath = path.join(dir, "x.png");
  await writeFile(filePath, "not-a-real-image");
  try {
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function captionClient(port: number, ruleList: Array<Record<string, unknown>>, events: RefusalEventInsert[], billed: RefusedCaptionAttempt[]) {
  const models = captionModels(port);
  const chain: ModelChainEntry[] = [{ logicalId: "cap", config: models.cap }];
  return new InferenceClient({
    modality: "image",
    chain,
    prompt: "describe",
    maxChars: 100,
    maxTokens: 256,
    refusals: {
      site: "caption",
      agent: null,
      rules: rules(ruleList),
      catalogue,
      models,
      insertEvent: async (row) => {
        events.push(row);
        return events.length;
      },
      logger: silentLogger,
    },
    onRefusedAttempt: (a) => billed.push(a),
  });
}

test("caption: a refusal stop or a structured refusal is a CaptionRefusalError (still a content failure)", async () => {
  await withImage(async (filePath) => {
    const server = await captionServer({ cap: "filter" });
    try {
      const events: RefusalEventInsert[] = [];
      const billed: RefusedCaptionAttempt[] = [];
      const client = captionClient(server.port, [], events, billed);
      const error = await client.caption({ filePath, mimeType: "image/png", filename: "x.png" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(error instanceof CaptionRefusalError && error instanceof CaptionContentError);
      assert.equal((error as CaptionRefusalError).refusal.rawStopReason, "content_filter");
      assert.equal(isRefusalExhausted(error), false, "no rule: today's behaviour, retried by the pool");
      assert.deepEqual(server.hits, ["cap"]);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(events.map((e) => [e.site, e.checkCode, e.outcome, e.agentSessionId]), [["caption", "refusal_safety", "failed", null]]);
      assert.equal(billed[0]!.logicalModelId, "cap");
      assert.equal(billed[0]!.usage?.input, 30);
      assert.ok((billed[0]!.cost ?? 0) > 0);
    } finally {
      await server.close();
    }
  });
});

test("caption: a rule re-runs the caption on its next usable entry; exhaustion is marked so the pool never re-runs it", async () => {
  await withImage(async (filePath) => {
    const server = await captionServer({ cap: "refusal-field", alt1: "filter" });
    try {
      const events: RefusalEventInsert[] = [];
      const billed: RefusedCaptionAttempt[] = [];
      const client = captionClient(server.port, [{ name: "cap_redo", sites: ["caption"], models: ["textonly", "alt1", "alt2"] }], events, billed);
      const result = await client.caption({ filePath, mimeType: "image/png", filename: "x.png" });
      assert.equal(result.caption, "caption by alt2");
      assert.equal(result.logicalModelId, "alt2");
      assert.deepEqual(server.hits, ["cap", "alt1", "alt2"], "the text-only entry was skipped (capability)");
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(events.map((e) => [e.servedModel, e.checkCode, e.outcome, e.toModel]), [
        ["cap", "refusal_uncategorized", "redo", "alt1"],
        ["alt1", "refusal_safety", "redo", "alt2"],
      ]);
      assert.deepEqual(billed.map((b) => b.logicalModelId), ["cap", "alt1"]);

      // Every entry refuses: no caption, and the error says not to re-run it.
      server.hits.length = 0;
      events.length = 0;
      const exhausted = captionClient(server.port, [{ name: "cap_redo", models: ["alt1"] }], events, billed);
      const error = await exhausted.caption({ filePath, mimeType: "image/png", filename: "x.png" }).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(error instanceof CaptionRefusalError);
      assert.equal(isRefusalExhausted(error), true);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(events.map((e) => e.outcome), ["redo", "exhausted_no_output"]);
    } finally {
      await server.close();
    }
  });
});

for (const [outcome, expectedRuns] of [["exhausted_no_output", 1], [undefined, 3]] as const) {
  test(`diary: a refused run ${outcome ? "with an exhausted rule fails without a retry" : "without a rule is retried as today"}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "miku-rh-diary-"));
    const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
    try {
      const ev = (id: string, ts: number, role: "user" | "assistant") => ({
        id, timelineKey: TK, provider: "matrix" as const, role,
        sender: { id: role === "assistant" ? "@bot:test" : "@u:test", displayName: "X", isSelf: role === "assistant" },
        body: `m ${id}`, timestamp: ts, receivedAt: ts,
      });
      await storage.appendTimelineEvent(ev("dv0", 1000, "user"));
      await storage.appendTimelineEvent(ev("dv1", 2000, "assistant"));
      await storage.insertSummarizationJob({
        id: "job-sum_d", timelineKey: TK, level: 1, inputStartId: "dv0", inputEndId: "dv1", inputTokenCount: 10, targetTokenCount: 100, maxRetries: 0,
      });
      await storage.insertSummaryWithLineage({
        id: "sum_d", timelineKey: TK, level: 1, content: "summary", earliestTimestamp: 1000, latestTimestamp: 2000,
        latestEventId: "dv1", eventCount: 2, tokenCount: 10, modelId: "m", status: "complete", generatedAt: 2000,
        eventIds: ["dv0", "dv1"], jobId: "job-sum_d",
      });
      const runs = { count: 0 };
      const factory = refusingFactory(outcome, runs);
      factory.resolveSessionType = () => undefined;
      const pool = new DiaryWorkerPool({
        storage,
        factory,
        memoryWriter: new MemoryFileWriter(dir),
        config: { worker_count: 1, max_retries: 2, per_session_budget_tokens: 1000 },
        workspaceRoot: dir,
        resolveChannelLabel: async () => "Room",
        logger: silentLogger,
      });
      await pool.start();
      pool.notifyNewWork();
      await waitFor(() => storage.getDiaryStatus("sum_d") === "failed");
      await pool.stop();
      assert.equal(runs.count, expectedRuns, "max_retries = 2 allows three runs without a rule");
    } finally {
      await storage.waitForIdle();
      storage.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("caption: @same retries the refusing caption model (tries), then the next entry", async () => {
  await withImage(async (filePath) => {
    const server = await captionServer({ cap: ["filter", "filter", "ok"] });
    try {
      const events: RefusalEventInsert[] = [];
      const billed: RefusedCaptionAttempt[] = [];
      const client = captionClient(server.port, [{ name: "again", models: [{ model: "@same", tries: 2 }, "alt1"] }], events, billed);
      const result = await client.caption({ filePath, mimeType: "image/png", filename: "x.png" });
      assert.equal(result.logicalModelId, "cap");
      assert.deepEqual(server.hits, ["cap", "cap", "cap"]);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(events.map((e) => [e.servedModel, e.outcome, e.toModel]), [
        ["cap", "redo", "cap"],
        ["cap", "redo", "cap"],
      ]);
    } finally {
      await server.close();
    }
  });
});
