import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { recordBehaviourChanges } from "../src/behaviour/changes.js";
import { readModelBehaviour } from "../src/behaviour/read.js";
import { ModelBehaviourRollups } from "../src/behaviour/rollups.js";
import { Storage } from "../src/storage/index.js";
import { H, HOUR, agentFor, seedScenario } from "./behaviour-fixtures.js";

// ---------------------------------------------------------------------------
// The console's `GET /api/models/behaviour` sample is generated here by the real
// read API over synthetic rows, so the console's Effect schemas decode exactly what
// the agent serves. The test fails when the response shape drifts from the
// committed fixture; regenerate it with
//   UPDATE_MODEL_BEHAVIOUR_FIXTURE=1 node --import tsx --test test/model-behaviour-fixture.test.ts
// ---------------------------------------------------------------------------

const FIXTURE = new URL("../console/src/lib/server/api/demo/model-behaviour.json", import.meta.url);

async function generate(): Promise<unknown> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedScenario(storage);
    // What the offline audit adds: a judged refusal, the no_reply intent of a judged
    // ending after a nudge, and the send-contract diagnosis of s1's nudged run.
    const judged = await storage.insertDecisionEvaluation({
      ts: H + 6_000, decision_group: "audit:g7", point: "checks", agent_session_id: "s1", source: "model",
      verdict_json: JSON.stringify({ fired: [{ code: "refusal_safety", kind: "refusal" }], results: [] }),
      checkpoint: "send", branch_no: 0, tool_call_id: "tc2", consequence: "observed",
    });
    await storage.insertRefusalEvent({
      ts: H + 6_100, agentSessionId: "s1", site: "default", servedModel: "model_b", kind: "soft", checkCode: "refusal_safety",
      reason: "safety", method: "judged", source: "message", probability: 0.9, checkpoint: "send", outcome: "observed",
      decisionEvaluationId: judged,
    });
    await storage.insertDecisionEvaluation({
      ts: H + 4_200, decision_group: "audit:g8", point: "checks", agent_session_id: "s2", source: "model",
      verdict_json: JSON.stringify({
        fired: [{ code: "no_reply_intent", kind: "contract" }],
        results: [{ id: "no_reply_intent__text", code: "no_reply_intent", choice: "abandoned_written_reply", fired: true }],
      }),
      checkpoint: "ending", branch_no: 0, attempt_no: 3, consequence: "observed",
    });
    await storage.writeSessionAudits([{
      sessionId: "s1", audit: "send_contract", status: "done", version: 1, createdAt: H + 9_000,
      verdictJson: JSON.stringify({ runs: [{ run: 1, ts: H + 6_000, servedModel: "model_b", nudges: 1, result: "sent",
        afterCorrection: { choice: "minor_rewording", source: "model", confidence: 0.8 }, attempts: [] }] }),
    }]);
    await new ModelBehaviourRollups({ storage, agentForTimelineKey: agentFor }).flush();
    await recordBehaviourChanges(storage, [{
      kind: "prompt_changed",
      sentence: "agent agent_a, default on model_a: system prompt changed (aaa → bbb)",
      agents: ["agent_a"], sites: ["default"], models: ["model_a"],
      detail: { prompt: "system", oldHash: "aaa", newHash: "bbb" },
    }], H + 60_000);
    await recordBehaviourChanges(storage, [{
      kind: "head_model_changed",
      sentence: "agent agent_a, default: head model model_a → model_b",
      path: "agents.agent_a.sites.default", old: "model_a", new: "model_b",
      agents: ["agent_a"], sites: ["default"], models: ["model_a", "model_b"],
    }], H + 90_000);
    const ctx = {
      storage,
      agentForTimelineKey: agentFor,
      familyOf: (m: string) => m,
      modelInfo: (m: string) => ({ id: `vendor/${m.replace("_", "-")}`, family: null }),
      auditProgress: () => ({
        countedAt: H + 2 * HOUR - 60_000,
        sessions: 120,
        prioritySessions: 30,
        stages: [
          { id: "contract", label: "send-contract classification (sessions with nudges or a no_reply ending)", done: 30, remaining: 0 },
          { id: "priority_checks", label: "refusal checks, sessions with nudges or a no_reply ending", done: 12, remaining: 18 },
          { id: "rest", label: "refusal checks, every other session", done: 0, remaining: 90 },
        ],
        current: "priority_checks",
      }),
      checkKind: (code: string) => (code.startsWith("style_") ? "style" : undefined),
    };
    const query = { window: "24h" as const, groupBy: "model" as const, family: false, now: H + 2 * HOUR, selected: "model_b" };
    const response = readModelBehaviour(ctx, query);
    // Demo mode answers a chart pick from these: every metric's series under the same filters.
    const demoSeries = Object.fromEntries(
      response.charts.map((c) => [c.id, readModelBehaviour(ctx, { ...query, metric: c.id }).series]),
    );
    const body = { ...response, demoSeries };
    await storage.waitForIdle();
    return JSON.parse(JSON.stringify(body));
  } finally {
    storage.close();
  }
}

test("console model behaviour sample matches what the read API serves", { skip: !existsSync(FIXTURE) && process.env["UPDATE_MODEL_BEHAVIOUR_FIXTURE"] !== "1" }, async () => {
  const body = await generate();
  if (process.env["UPDATE_MODEL_BEHAVIOUR_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(body, null, "\t")}\n`);
  }
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), body);
});
