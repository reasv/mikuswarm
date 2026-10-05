import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { CheckEvaluator } from "../src/checks/evaluator.js";
import { OBSERVE_POLICY, OutputGate, wrapToolsWithOutputGate, type GatePolicy } from "../src/checks/gate.js";
import { FORCED_COMPLETION_PROMPTS } from "../src/agent/contract.js";
import { persistSessionContract } from "../src/agent/contract-store.js";
import { SessionManager } from "../src/agent/index.js";
import type { AgentSessionFactory } from "../src/agent/factory.js";
import { DecisionClient, DecisionEngine } from "../src/decisions/index.js";
import { createObservabilityServer } from "../src/observability/server/index.js";
import type { Logger } from "../src/observability/index.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// The console's demo session with refusal handling (spec REFUSAL-HANDLING §9,
// §12.1–§12.2) is generated here: the real output gate and check evaluator
// (built-in refusal checks plus an operator style check, a mocked decision
// endpoint), the real send-contract derivation, real storage writes and the
// real `GET /api/sessions/:id` + `/decisions` handlers. So the console's
// branch switcher and cards parse exactly what the agent serves. The test
// fails when that drifts from the committed fixture; regenerate it with
//   UPDATE_REFUSAL_SESSION_FIXTURE=1 node --import tsx --test test/refusal-session-fixture.test.ts
// Everything is synthetic (generic model keys, example.org).
// ---------------------------------------------------------------------------

const FIXTURE = new URL("../console/src/lib/server/api/demo/refusal-session.json", import.meta.url);
const SESSION = "ses_rf7w3k";
const TIMELINE = "matrix:aria:room:!general:matrix.example.org";

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };

const config: any = {
  models: {
    decider: {
      id: "vendor/decider-1",
      provider: "openrouter",
      api: "system-one",
      endpoint: "https://gw.example/decisions",
      api_key: "k",
      input_modalities: ["text"],
      max_tokens: 1,
      context_window: 32000,
      cost: { input: 0.04, output: 0, cache_read: 0.04, cache_write: 0.04 },
    },
  },
  decisions: { enabled: true, model: "decider", checks: { enabled: true, timeout_ms: 60_000 } },
  checks: {
    style_vocabulary: {
      kind: "style",
      description: "Overused assistant vocabulary",
      agent_explanation: "Avoid the word {matched}.",
      words: ["delve"],
    },
  },
  agents: {},
};

/** The fixture's clock: every decision call takes 640 ms of it, so latencies are stable. */
let clock = 0;
const now = () => clock;

/** The decision endpoint: the refused send reads as a safety refusal, everything else is clean. */
const fetchImpl = (async (_url: string, init: RequestInit) => {
  clock += 640;
  const body = JSON.parse(String(init.body)) as { state: any; questions: Record<string, unknown> };
  const refused = String(body.state?.message ?? "").startsWith("I can't help");
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(body.questions)) {
    answers[id] = { noul: refused && id === "refusal_safety__message" ? 0.93 : refused && id.startsWith("refusal_safety__") ? 0.41 : 0.03 };
  }
  return new Response(
    JSON.stringify({ model: "vendor/decider-1-20261001", answers, usage: { input_tokens: 1200, output_tokens: 1, cost: 0.000048 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

const usage = (input: number, output: number, cost: number) => ({
  input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

function assistant(ts: number, model: string, content: unknown[], stopReason = "toolUse", cost = 0.0012): any {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "example",
    model: `vendor/${model}`,
    usage: usage(5200, 60, cost),
    stopReason,
    timestamp: ts,
    served: { logicalId: model },
  };
}
function toolResult(ts: number, id: string, name: string, text: string, isError = false): any {
  return { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: ts };
}
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });

function sendTool(): any {
  return {
    name: "send_message",
    label: "send",
    description: "send",
    parameters: {},
    execute: async () => ({ content: [{ type: "text", text: "sent" }], details: {} }),
  };
}

async function settle(storage: Storage, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  await storage.waitForIdle();
  assert.ok(cond(), "the gate recorded its rows");
}

async function generate(): Promise<{ detail: unknown; decisions: unknown }> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  clock = 1_000;
  try {
    await storage.insertAgentSession({
      id: SESSION, timelineKey: TIMELINE, sessionType: "default", status: "running", modelId: "model_a",
      triggerEventId: "$evt_rf7w3k", triggerBody: "can you recap the meetup thread?", createdAt: 1_000, updatedAt: 1_000,
    });
    const catalogue = buildCheckCatalogue(config);
    const engine = new DecisionEngine({
      config,
      client: new DecisionClient({ models: config.models, fetchImpl, logger: silent }),
      record: () => {},
      logger: silent,
      now,
    });
    const evaluator = new CheckEvaluator({ catalogue, engine, config, storage, logger: silent, now });
    const messages: any[] = [
      { type: "triggerGroup", role: "user", content: "<message from=\"Ada\">can you recap the meetup thread?</message>", timestamp: 1_000 },
    ];
    let serving = "model_a";
    const gate = new OutputGate({
      evaluator,
      scope: { agent: "aria", site: "default", sessionId: SESSION, sessionType: "default", timelineKey: TIMELINE, tasks: null },
      getMessages: () => messages,
      chat: () => ({ request: [{ from: "Ada", text: "can you recap the meetup thread?" }], recent: [] }),
      servingModel: () => serving,
      logger: silent,
      now,
    });
    const [send] = wrapToolsWithOutputGate([sendTool()], gate);

    // 1. A hard refusal on the first request (provider category, no rule: the
    //    chain fallback served it), recorded as Layer 0 does.
    await storage.insertRefusalEvent({
      ts: 1_500, agentSessionId: SESSION, site: "default", agent: "aria", timelineKey: TIMELINE,
      servedModel: "model_a", wireModel: "vendor/model_a", kind: "hard", checkCode: "refusal_safety",
      reason: "safety", subReason: "cyber", method: "provider_category", source: "api",
      rawStopReason: "refusal", category: "cyber", explanation: "The response was declined by the provider.",
      checkpoint: "request", outcome: "fallover",
    });
    messages.push(
      assistant(2_000, "model_c", [call("call-search", "search_messages", { query: "meetup" })]),
      toolResult(2_100, "call-search", "search_messages", "3 messages about the meetup (Saturday, venue TBD)."),
    );

    // 2. A send judged a soft refusal and redone (the acting policy W4 installs:
    //    held, consequence `redo`, the event carries the rule and target).
    const refused = assistant(3_000, "model_a", [call("call-refused", "send_message", { message: "I can't help with that one." })]);
    messages.push(refused);
    clock = 3_000;
    const redo: GatePolicy = {
      ...OBSERVE_POLICY,
      shouldHold: () => true,
      consequence: (_i, verdict) => (verdict.refusal || verdict.fired.some((f) => f.kind === "refusal") ? "redo" : "sent"),
      refusalOutcome: () => ({ outcome: "redo", ruleName: "safety_redo", toModel: "model_b" }),
      act: () => ({ kind: "block", message: "redo requested" }),
    };
    gate.policy = redo;
    await assert.rejects(send!.execute("call-refused", { message: "I can't help with that one." } as any, undefined, undefined));
    await settle(storage, () => storage.listRefusalEvents(SESSION).length === 2);
    const redoRow = storage.getDecisionEvaluationsForSession(SESSION).find((r) => r.tool_call_id === "call-refused")!;
    const span = [refused, toolResult(3_100, "call-refused", "send_message", "redo requested", true)];
    await storage.insertSessionBranch({
      sessionId: SESSION, forkIndex: 3, reason: "refusal_redo", checkCode: "refusal_safety",
      decisionEvaluationId: redoRow.id, fromModel: "model_a", toModel: "model_b",
      messagesJson: JSON.stringify(span), costUsd: 0.0012, createdAt: 3_200,
    });
    messages.splice(3);

    // 3. The redo on model_b: a text-only ending, one nudge, then the send
    //    (an operator style word fires by pattern; observe-only).
    serving = "model_b";
    gate.policy = OBSERVE_POLICY;
    const text = "Here's the recap: the meetup moved to Saturday, venue still open.";
    const sent = "Here's the recap: the meetup moved to Saturday, and Grace will delve into the venue options.";
    messages.push(
      assistant(4_000, "model_b", [{ type: "text", text }], "stop"),
      { role: "user", content: FORCED_COMPLETION_PROMPTS.current.not_sent, harness: { kind: "forced_completion", attempt: 1, variant: "not_sent" }, timestamp: 4_100 },
      assistant(4_200, "model_b", [call("call-sent", "send_message", { message: sent })]),
    );
    clock = 4_200;
    await send!.execute("call-sent", { message: sent } as any, undefined, undefined);
    await settle(storage, () => storage.getDecisionEvaluationsForSession(SESSION).some((r) => r.tool_call_id === "call-sent" && r.source === "model"));
    messages.push(toolResult(4_300, "call-sent", "send_message", "sent"));

    await storage.saveAgentSessionTranscript(SESSION, JSON.stringify(messages), 4_400);
    await storage.updateAgentSessionStatus(SESSION, "completed", { startedAt: 1_000, completedAt: 4_400, updatedAt: 4_400 });
    await persistSessionContract({ storage, sessionId: SESSION, messages });
    await storage.waitForIdle();

    const factory = {
      resolveSessionContextCeiling: () => 128_000,
      resolveSessionCostCeiling: () => undefined,
      toolBlockFor: () => undefined,
    } as unknown as AgentSessionFactory;
    const server = createObservabilityServer({
      config: { enabled: true, bind: "127.0.0.1", port: 0 },
      storage,
      factory,
      sessions: new SessionManager(),
      workspaceRoot: "/tmp",
      logger: silent,
      checks: {
        describe: (code) => {
          const check = catalogue.get(code, "aria");
          return check && { code, kind: check.kind, remedy: check.remedy, reason: check.reason ?? null, description: check.description };
        },
        maxNudges: 3,
      },
    });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.address()}`;
      const detail = await (await fetch(`${base}/api/sessions/${SESSION}`)).json();
      const decisions = (await (await fetch(`${base}/api/sessions/${SESSION}/decisions`)).json()) as {
        evaluations: Array<{ decisionGroup: string }>;
      };
      // Decision groups are random ids; name them in order so the fixture is stable.
      const groups = new Map<string, string>();
      for (const row of decisions.evaluations) {
        if (!groups.has(row.decisionGroup)) groups.set(row.decisionGroup, `dg-checks-${groups.size + 1}`);
        row.decisionGroup = groups.get(row.decisionGroup)!;
      }
      return { detail, decisions };
    } finally {
      await server.stop();
    }
  } finally {
    storage.close();
  }
}

test("console refusal-handling demo session matches what the session API serves", { skip: !existsSync(FIXTURE) && process.env["UPDATE_REFUSAL_SESSION_FIXTURE"] !== "1" }, async () => {
  const body = await generate();
  if (process.env["UPDATE_REFUSAL_SESSION_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(body, null, "\t")}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), body);
});
