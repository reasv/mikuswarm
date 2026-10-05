import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import {
  DecisionClient,
  DecisionEngine,
  routingPoint,
  selectRecordsToInject,
  type DecisionEvaluationRow,
  type RecordsCandidate,
  type RoutingInput,
} from "../src/decisions/index.js";

// ---------------------------------------------------------------------------
// The console's demo `decision_evaluations` rows are generated here, by the real
// DecisionEngine + points with a mocked decision endpoint, so the console parses
// exactly what the engine writes (verdict = the point's `describe`, answers = the
// parsed answer map keyed by question name). The test fails when the engine's
// row shapes drift from the committed fixture; regenerate it with
//   UPDATE_DECISION_FIXTURE=1 node --import tsx --test test/decision-evaluation-fixture.test.ts
// ---------------------------------------------------------------------------

const FIXTURE = new URL("../console/src/lib/server/api/demo/decision-evaluations.json", import.meta.url);

function decider(id: string): any {
  return {
    id,
    provider: "openrouter",
    api: "system-one",
    endpoint: "https://gw.example/decisions",
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 1,
    context_window: 32000,
    cost: { input: 0.04, output: 0, cache_read: 0.04, cache_write: 0.04 },
  };
}

const config: any = {
  models: { decider: decider("vendor/decider-1") },
  decisions: {
    enabled: true,
    model: "decider",
    routing: { enabled: true },
    records: { enabled: true, inject_threshold: 0.6, candidates: 3, max_injected: 2 },
  },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const usage = { input_tokens: 900, output_tokens: 4, cost: 0.000036 };

/** The mocked decision endpoint: answers by what the state is about. */
const fetchImpl = (async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body)) as { state: any; questions: Record<string, unknown> };
  const served = "vendor/decider-1-20261001";
  if ("task__image" in body.questions) {
    // Multi-label routing (DECISION-MODEL §5.1a): one noul per task and per skill.
    return json(200, {
      model: served,
      answers: {
        task__image: { noul: 0.91 },
        task__research: { noul: 0.12 },
        "skill__image-generation": { noul: 0.84 },
        "skill__web-research": { noul: 0.1 },
      },
      usage: { ...usage, input_tokens: 1840 },
    });
  }
  const record = String(body.state.record);
  if (record.startsWith("Searched for color palette")) {
    return json(200, { model: served, answers: { relevant: { noul: 0.83 } }, usage });
  }
  if (record.startsWith("Linus asked")) {
    return json(200, { model: served, answers: { relevant: { noul: 0.18 } }, usage });
  }
  return json(503, { error: "upstream unavailable" });
}) as unknown as typeof fetch;

async function generateRows(): Promise<Omit<DecisionEvaluationRow, "ts" | "latencyMs">[]> {
  const rows: DecisionEvaluationRow[] = [];
  const logger: any = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger };
  const engine = new DecisionEngine({
    config,
    client: new DecisionClient({ models: config.models, fetchImpl, logger }),
    onEvaluation: (row) => rows.push(row),
    logger,
  });
  const attribution = {
    agentSessionId: "ses_demo",
    sessionType: "default",
    timelineKey: "matrix:aria:room:!general:example.org",
  };
  const request = {
    from: "Ada",
    text: "Hey Miku, can you find where we talked about the summer meetup and make a poster for it?",
  };

  const routingInput: RoutingInput = {
    request: { from: request.from, text: request.text },
    recent: [{ from: "Grace", text: "Ada, did you ask Miku about the poster yet?" }],
    skills: [
      { name: "image-generation", description: "Make or edit images." },
      { name: "web-research", description: "Search the web and read pages." },
    ],
    tasks: {
      image: { description: "Make or edit an image.", models: ["image-chat"], skills: ["image-generation"] },
      research: { description: "Find information that needs searching.", models: ["deep-chat"] },
    },
    preloadSkills: true,
  };
  await engine.evaluate(routingPoint, routingInput, {
    agentName: "aria",
    attribution,
    triggerEventId: "$trigger:example.org",
  });

  // Non-reply trigger: three candidate sessions, each judged with the chat
  // around the request (its own bot message in place) and its record.
  const chat = (own: string) =>
    [
      { from: "Miku", text: "Here are both palette options again.", self: true as const },
      { from: "Linus", text: "lol did you see the game last night" },
      { from: "Miku", text: "3-1, what a finish.", self: true as const },
      { from: "Grace", text: "Ada, did you ask Miku about the poster yet?" },
    ].map((m) => (m.text === own ? { ...m, ofRecord: true as const } : m));
  const candidates: RecordsCandidate[] = [
    {
      sessionId: "ses_v8n2ke",
      record:
        "Searched for color palette decisions in #general. Found: warm earth tones (Ada) vs. cool pastels " +
        "(Grace); no final vote taken. Sent a summary with both options.",
      isReplyTarget: false,
      request,
      recentChat: chat("Here are both palette options again."),
    },
    {
      sessionId: "ses_k2f8ra",
      record: "Linus asked about last night's game. Replied with the score and highlights.",
      isReplyTarget: false,
      request,
      recentChat: chat("3-1, what a finish."),
    },
    {
      sessionId: "ses_q7m1td",
      record: "Looked up the community hall's opening hours for August and posted them.",
      isReplyTarget: false,
      request,
      recentChat: chat(""),
    },
  ];
  const { inject } = await selectRecordsToInject(
    engine,
    { candidates, rawDecisions: config.decisions },
    { agentName: "aria", attribution, triggerEventId: "$trigger:example.org" },
  );
  assert.deepEqual(inject, ["ses_v8n2ke"]);

  // Stable ids and order: one group per point, rows by candidate.
  const groupNames = new Map<string, string>();
  for (const row of rows) {
    if (!groupNames.has(row.decisionGroup)) groupNames.set(row.decisionGroup, `dg-${row.point}-demo`);
  }
  return rows
    .map(({ ts: _ts, latencyMs: _latency, ...row }) => ({ ...row, decisionGroup: groupNames.get(row.decisionGroup)! }))
    .sort((a, b) =>
      a.point === b.point
        ? String(a.candidateSessionId).localeCompare(String(b.candidateSessionId))
        : a.point === "routing"
          ? -1
          : 1,
    );
}

// The console is a separate app: the agent image's test stage has no console tree.
test("console demo decision rows match what the real engine writes", { skip: !existsSync(FIXTURE) && process.env["UPDATE_DECISION_FIXTURE"] !== "1" }, async () => {
  const rows = await generateRows();
  if (process.env["UPDATE_DECISION_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(rows, null, "\t")}\n`);
  }
  const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(committed, rows);

  // The shapes the console relies on (console/src/lib/decisions.ts).
  const routing = rows.find((r) => r.point === "routing")!;
  assert.deepEqual(JSON.parse(routing.verdictJson!), {
    task: "image",
    tasks: ["image"],
    models: ["image-chat"],
    skills: ["image-generation"],
  });
  assert.equal(JSON.parse(routing.answersJson!).task__image.type, "noul");
  const failed = rows.find((r) => r.candidateSessionId === "ses_q7m1td")!;
  assert.equal(failed.source, "heuristic");
  assert.equal(failed.reason, "error");
  assert.equal(JSON.parse(failed.verdictJson!).inject, false);
});
