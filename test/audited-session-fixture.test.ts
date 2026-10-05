import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { deriveContractEvents, FORCED_COMPLETION_PROMPTS } from "../src/agent/contract.js";
import { SessionManager } from "../src/agent/index.js";
import type { AgentSessionFactory } from "../src/agent/factory.js";
import { AuditWorkerPool } from "../src/audit/index.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { DecisionClient, DecisionEngine } from "../src/decisions/index.js";
import { createObservabilityServer } from "../src/observability/server/index.js";
import type { Logger } from "../src/observability/index.js";
import { Storage } from "../src/storage/index.js";

// ---------------------------------------------------------------------------
// The console's demo of an OLD session that only the offline audit judged
// (spec REFUSAL-HANDLING §7.6, §10.2): a session from before refusal handling
// (historical nudge wording, no harness markers, no live check rows), backfilled
// by the real AuditWorkerPool over the built-in checks against a mocked decision
// endpoint, then served by the real `GET /api/sessions/:id` + `/decisions`
// handlers. The console's session view must render the audit's findings from
// exactly this (console/src/lib/components/col2/SessionView.svelte.test.ts). The
// test fails when that drifts from the committed fixture; regenerate it with
//   UPDATE_AUDITED_SESSION_FIXTURE=1 node --import tsx --test test/audited-session-fixture.test.ts
// Everything is synthetic (generic model keys, example.org).
// ---------------------------------------------------------------------------

const FIXTURE = new URL("../console/src/lib/server/api/demo/audited-session.json", import.meta.url);
const SESSION = "ses_au4d1t";
const TIMELINE = "matrix:aria:room:!general:matrix.example.org";
const T = 2_000_000;

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
  decisions: {
    enabled: true,
    model: "decider",
    checks: { enabled: true },
    audit: { enabled: true, settle_ms: 1000, backlog_pace_ms: 0 },
  },
  agents: {},
};

/** The decision endpoint: the refused send reads as a safety refusal; the text reply after the second nudge was abandoned. */
const fetchImpl = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { state: any; questions: Record<string, unknown> };
  const message = String(body.state?.message ?? "");
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(body.questions)) {
    if (id === "refusal_safety__message") answers[id] = { noul: message.startsWith("I can't help") ? 0.93 : 0.03 };
    else if (id === "a0__had_user_message") {
      // Run 1's first attempt is a note to self; run 2's is a reply written for the user.
      answers[id] = { noul: String(body.state?.attempts?.a0 ?? "").startsWith("Notes to self") ? 0.08 : 0.94 };
    } else if (id === "after_correction") {
      answers[id] = { choice: "different_substance", confidence: 0.86, probabilities: { different_substance: 0.86, rewritten_same_substance: 0.1 } };
    } else if (id.startsWith("no_reply_intent__")) {
      answers[id] = { choice: "abandoned_written_reply", confidence: 0.82, probabilities: { abandoned_written_reply: 0.82, intended_no_reply: 0.12 } };
    } else answers[id] = { noul: 0.03 };
  }
  return new Response(
    JSON.stringify({ model: "vendor/decider-1-20261001", answers, usage: { input_tokens: 1400, output_tokens: 1, cost: 0.000056 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;

const usage = { input: 5200, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 5260, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0012 } };
function assistant(ts: number, model: string, content: unknown[], stopReason = "toolUse"): any {
  return { role: "assistant", content, api: "openai-completions", provider: "example", model: `vendor/${model}`, usage, stopReason, timestamp: ts };
}
const text = (t: string) => ({ type: "text", text: t });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const result = (ts: number, id: string, name: string, t: string) => ({
  role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: t }], isError: false, timestamp: ts,
});
/** The nudge as sessions from before the explicit send contract carry it: the old wording, no harness marker. */
const oldNudge = (ts: number) => ({ role: "user", content: FORCED_COMPLETION_PROMPTS.historical[0]!.text, timestamp: ts });

async function generate(): Promise<{ detail: unknown; decisions: unknown }> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const transcript: any[] = [
      { type: "triggerGroup", role: "user", content: "<message from=\"Ada\">when is the meetup?</message>", timestamp: T },
      assistant(T + 100, "model_a", [text("Notes to self: Ada asks about the meetup; it is on Friday.")], "stop"),
      oldNudge(T + 200),
      assistant(T + 300, "model_a", [call("call_a1", "send_message", { message: "I can't help with meetup details." })]),
      result(T + 400, "call_a1", "send_message", "sent"),
      { type: "triggerGroup", role: "user", content: "<message from=\"Ada\">can you share the link at least?</message>", timestamp: T + 1_000 },
      assistant(T + 1_100, "model_b", [text("Here is the link: https://meetup.example.org/friday")], "stop"),
      oldNudge(T + 1_200),
      assistant(T + 1_300, "model_b", [call("call_n2", "no_reply", {})]),
      result(T + 1_400, "call_n2", "no_reply", "ok"),
    ];
    await storage.insertAgentSession({
      id: SESSION, timelineKey: TIMELINE, sessionType: "default", status: "completed", modelId: "model_a",
      triggerEventId: "$evt_au4d1t", triggerBody: "when is the meetup?", triggerSenderDisplayName: "Ada",
      createdAt: T, updatedAt: T,
    });
    await storage.saveAgentSessionTranscript(SESSION, JSON.stringify(transcript), T + 1_500);
    await storage.updateAgentSessionStatus(SESSION, "completed", { completedAt: T + 1_500, updatedAt: T + 1_500 });
    const derived = deriveContractEvents(transcript);
    await storage.replaceSessionContract(SESSION, {
      attempts: derived.attempts.map((a) => ({ ...a, failureTypes: [...a.failureTypes] })),
      outcome: derived.outcome,
      nudges: derived.nudges,
      version: 1,
    });

    // The backlog audit, long after the session (the worker's clock): every stage.
    let clock = T + 86_400_000;
    const now = () => (clock += 500);
    const engine = new DecisionEngine({
      config,
      client: new DecisionClient({ models: config.models, fetchImpl, logger: silent }),
      record: () => {},
      onEvaluation: (row) => {
        void storage.insertDecisionEvaluation({
          ts: row.ts, decision_group: row.decisionGroup, point: row.point, agent: row.agent,
          timeline_key: row.timelineKey, agent_session_id: row.agentSessionId, source: row.source,
          reason: row.reason, verdict_json: row.verdictJson, answers_json: row.answersJson,
          served_model: row.servedModel, cost_usd: row.costUsd,
        });
      },
      logger: silent,
      now,
    });
    const catalogue = buildCheckCatalogue(config);
    const pool = new AuditWorkerPool({ storage, config, engine, catalogue, agentForTimelineKey: () => "aria", logger: silent, now });
    const statuses: Array<Record<string, string>> = [];
    for (let i = 0; i < 4; i++) {
      const step = await pool.runOnce();
      if (step.kind !== "audited") break;
      statuses.push(step.statuses);
    }
    await storage.waitForIdle();
    assert.deepEqual(statuses, [{ send_contract: "done" }, { refusal: "done" }], "the send-contract stage first, then the refusal checks");

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
      // Decision groups are random ids; name them in order (keeping the audit prefix) so the fixture is stable.
      const groups = new Map<string, string>();
      for (const row of decisions.evaluations) {
        if (!groups.has(row.decisionGroup)) groups.set(row.decisionGroup, `audit:dg-${groups.size + 1}`);
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

test("console audited old-session demo matches what the session API serves", { skip: !existsSync(FIXTURE) && process.env["UPDATE_AUDITED_SESSION_FIXTURE"] !== "1" }, async () => {
  const body = await generate();
  if (process.env["UPDATE_AUDITED_SESSION_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(body, null, "\t")}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), body);
});
