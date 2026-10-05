/**
 * The calibration tool's core (spec REFUSAL-HANDLING §15.1): sampling from a
 * read-only database, known positives from hard refusals, the labeller's
 * constrained answer, the decision member's score, the aggregates, and the
 * privacy guarantees: the report never contains message text (even when the
 * labeller misbehaves and echoes it), the labeller is told never to reproduce
 * content, the database cannot be written, endpoint overrides in the
 * environment are refused, and requests can only reach configured endpoints.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoEndpointOverrides,
  CalibrationAbortError,
  createDecisionScorer,
  endpointOverrideVars,
  formatReport,
  guardFetch,
  isUnderEndpoint,
  labelRequest,
  LABELLER_SYSTEM_PROMPT,
  openReadOnly,
  parseLabelResponse,
  reportJson,
  requireGuardedTransport,
  runCalibration,
  sampleCalibrationItems,
  scoreHistogram,
  thresholdTable,
  type CalibrationRow,
  type Labeller,
  type LabelRequest,
  type Scorer,
} from "../src/audit/calibration.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { DecisionClient } from "../src/decisions/index.js";
import { Storage } from "../src/storage/index.js";
import { asst, kick, sent, text } from "./audit-fixtures.js";

const SECRET = "ZQX-PRIVATE-MARKER";

async function withDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "calibration-test-"));
  const dbPath = path.join(dir, "history.db");
  try {
    const storage = await Storage.open({ databasePath: dbPath });
    const add = async (id: string, createdAt: number, transcript: unknown[]) => {
      await storage.insertAgentSession({
        id, timelineKey: "matrix:acct:room:!r:example.org", sessionType: "default", status: "completed",
        triggerBody: `${SECRET} trigger ${id}`, createdAt, updatedAt: createdAt,
      });
      await storage.saveAgentSessionTranscript(id, JSON.stringify(transcript));
    };
    for (let i = 0; i < 12; i++) {
      const refusing = i % 3 === 0;
      await add(`s${i}`, 1_000 + i, [
        kick(`${SECRET} please ${i}`),
        ...sent(`c${i}`, refusing ? `${SECRET} I cannot help with that ${i}` : `${SECRET} here you go ${i}`),
      ]);
    }
    // A hard refusal with an API signal (category cyber) and text: a known positive.
    await add("hard", 5_000, [
      kick(`${SECRET} do the risky thing`),
      asst([text(`${SECRET} I won't do that`)], {
        stopReason: "error", rawStopReason: "refusal", stopCategory: "cyber", api: "anthropic-messages",
      }),
    ]);
    // A generation session is never sampled.
    await storage.insertAgentSession({
      id: "gen", timelineKey: "matrix:acct:room:!r:example.org", sessionType: "summarize", status: "completed",
      createdAt: 6_000, updatedAt: 6_000,
    });
    await storage.saveAgentSessionTranscript("gen", JSON.stringify([kick(), ...sent("g1", `${SECRET} summary`)]));
    await storage.waitForIdle();
    storage.close();
    await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const config: any = { models: {}, checks: {}, agents: {} };
const catalogue = buildCheckCatalogue(config);
const check = catalogue.get("refusal_safety")!;
const question = check.questions.find((q) => q.source === "message")!;

/** A misbehaving labeller: answers through the tool, but also echoes the whole prompt as text. */
const echoingLabeller: Labeller = async (request: LabelRequest) => ({
  role: "assistant",
  content: [
    { type: "text", text: `Echo: ${request.prompt}` },
    {
      type: "toolCall",
      id: "t1",
      name: "submit_label",
      arguments: request.prompt.includes("cannot")
        ? { label: "true", reason: "safety" }
        : request.prompt.includes("here you go 4")
          ? { label: "unsure", reason: "insufficient_context" }
          : { label: "false", reason: "complies" },
    },
  ],
});

/** The member: high for the refusing texts, with one confident miss. */
const scorer: Scorer = async (item, state) => {
  const message = String((state(4000) as Record<string, unknown>)["message"] ?? "");
  if (item.id.endsWith(":c9")) return 0.4; // a refusal the member misses
  if (message.includes("here you go 2")) return 0.85; // a false positive
  return message.includes("cannot") || message.includes("won't") ? 0.9 : 0.1;
};

test("runCalibration: sampling, known positives, labels, scores, aggregates; never message text", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const prompts: LabelRequest[] = [];
      const report = await runCalibration({
        db,
        catalogue,
        check,
        question,
        checkpoint: "send",
        sample: 50,
        seed: 7,
        labeller: async (request) => {
          prompts.push(request);
          return echoingLabeller(request);
        },
        scorer,
        labellerInfo: { model: "labeller_a", host: "labeller.example" },
        memberInfo: { model: "decider", host: "gw.example" },
      });
      assert.equal(report.sessions, 13, "the generation session is not sampled");
      assert.equal(report.eligible, 12);
      assert.equal(report.counts.knownPositives, 1);
      assert.equal(report.counts.items, 13);
      assert.equal(report.counts.true, 5); // 4 labelled + 1 known positive
      assert.equal(report.counts.unsure, 1);
      assert.equal(report.counts.false, 7);
      assert.equal(prompts.length, 12, "known positives are never sent to the labeller");
      const known = report.rows.find((r) => r.labelSource === "api_signal")!;
      assert.equal(known.label, "true");
      assert.equal(known.reason, "safety");
      assert.equal(known.probability, 0.9);

      // At the configured 0.8: tp 4 (one miss), fp 1, fn 1.
      const at = report.suggested.configured;
      assert.equal(at.threshold, 0.8);
      assert.deepEqual([at.tp, at.fp, at.fn], [4, 1, 1]);
      assert.equal(at.precision, 0.8);
      assert.equal(at.recall, 0.8);
      assert.ok(report.suggested.bestF1);
      assert.equal(report.suggested.atPrecisionTarget!.threshold, 0.9);
      const hist = report.histogram;
      assert.equal(hist.reduce((n, b) => n + b.positive + b.negative + b.unsure, 0), 13);

      // Privacy: the report holds ids, enums and numbers only.
      for (const out of [formatReport(report), reportJson(report)]) {
        assert.ok(!out.includes(SECRET), "no message text in the output");
        assert.ok(!out.includes("Echo"), "nothing of the labeller's free text");
        assert.ok(!out.includes("cannot") && !out.includes("here you go"));
      }
      // The labeller saw the definition and the instruction never to reproduce content.
      assert.equal(prompts[0]!.systemPrompt, LABELLER_SYSTEM_PROMPT);
      assert.match(LABELLER_SYSTEM_PROMPT, /Never reproduce, quote, paraphrase/);
      assert.match(prompts[0]!.prompt, /Do not reproduce any of the item's content/);
      assert.deepEqual(prompts[0]!.tool.parameters.properties.label.enum, ["true", "false", "unsure"]);
      assert.ok(prompts[0]!.tool.parameters.properties.reason.enum.includes("complies"));
    } finally {
      db.close();
    }
  });
});

test("sampling: a check's prefilter limits the eligible outputs to those it matches", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const gatedCatalogue = buildCheckCatalogue({ ...config, checks: { refusal_safety: { prefilter: ["cannot"] } } });
      const gated = gatedCatalogue.get("refusal_safety")!;
      const sampled = sampleCalibrationItems(db, {
        catalogue: gatedCatalogue, check: gated, checkpoint: "send", source: "message", sample: 50, seed: 1,
      });
      assert.equal(sampled.eligible, 4, "only the refusing messages (every third of twelve) match");
      assert.deepEqual(sampled.items.map((i) => i.id).sort(), ["s0:c0", "s3:c3", "s6:c6", "s9:c9"]);
    } finally {
      db.close();
    }
  });
});

test("openReadOnly: the database cannot be written", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      assert.throws(() => db.exec(`delete from agent_sessions`));
      assert.throws(() => db.prepare(`insert into session_audits (session_id, audit, status, version, created_at) values ('s0','x','done',1,1)`).run());
      assert.equal((db.prepare(`select count(*) as n from agent_sessions`).get() as { n: number }).n, 14);
    } finally {
      db.close();
    }
  });
});

test("parseLabelResponse: only the enums survive", () => {
  const reasons = ["safety", "complies"];
  const tool = (args: unknown) => ({ content: [{ type: "toolCall", name: "submit_label", arguments: args }] });
  assert.deepEqual(parseLabelResponse(tool({ label: "true", reason: "safety" }), reasons), { label: "true", reason: "safety" });
  assert.deepEqual(parseLabelResponse(tool({ label: "false", reason: `${SECRET}` }), reasons), { label: "false", reason: null });
  assert.deepEqual(parseLabelResponse(tool({ label: "true", reason: "safety", note: SECRET }), reasons), { label: "invalid", reason: null });
  assert.deepEqual(parseLabelResponse(tool({ label: SECRET, reason: "safety" }), reasons), { label: "invalid", reason: null });
  assert.deepEqual(
    parseLabelResponse({ content: [{ type: "text", text: '{"label":"unsure","reason":"complies"}' }] }, reasons),
    { label: "unsure", reason: "complies" },
  );
  assert.deepEqual(parseLabelResponse({ content: [{ type: "text", text: `true because ${SECRET}` }] }, reasons), { label: "invalid", reason: null });
  assert.deepEqual(parseLabelResponse(undefined, reasons), { label: "invalid", reason: null });
});

test("labelRequest: the definition, the state, the constrained tool", () => {
  const request = labelRequest(
    { id: "s1:c1", sessionId: "s1", checkpoint: "send", context: { action: "send_message" }, sources: { message: "x" } },
    catalogue.get("refusal_persona")!,
    catalogue.get("refusal_persona")!.questions[0]!,
    { message: "x" },
    "a cheerful regular",
  );
  assert.match(request.prompt, /the persona: a cheerful regular/);
  assert.match(request.prompt, /"message":"x"/);
  assert.equal(request.tool.name, "submit_label");
  assert.ok(request.reasons.includes("persona"));
  assert.deepEqual(request.tool.parameters.required, ["label", "reason"]);
});

test("aggregates: threshold table and histogram", () => {
  const rows: CalibrationRow[] = [
    { id: "a", label: "true", labelSource: "labeller", reason: null, probability: 0.95 },
    { id: "b", label: "true", labelSource: "labeller", reason: null, probability: 0.55 },
    { id: "c", label: "false", labelSource: "labeller", reason: null, probability: 0.6 },
    { id: "d", label: "false", labelSource: "labeller", reason: null, probability: 0.05 },
    { id: "e", label: "unsure", labelSource: "labeller", reason: null, probability: 0.5 },
    { id: "f", label: "invalid", labelSource: "labeller", reason: null, probability: 0.99 },
    { id: "g", label: "true", labelSource: "labeller", reason: null, probability: null },
  ];
  const table = thresholdTable(rows, [0.5, 0.7]);
  assert.deepEqual(table[0], { threshold: 0.5, tp: 2, fp: 1, fn: 0, tn: 1, precision: 0.667, recall: 1, f1: 0.8 });
  assert.deepEqual(table[1], { threshold: 0.7, tp: 1, fp: 0, fn: 1, tn: 2, precision: 1, recall: 0.5, f1: 0.667 });
  const hist = scoreHistogram(rows);
  assert.equal(hist.length, 10);
  assert.equal(hist[9]!.positive, 1);
  assert.equal(hist[5]!.positive, 1);
  assert.equal(hist[6]!.negative, 1);
  assert.equal(hist[5]!.unsure, 1);
  assert.equal(hist[0]!.negative, 1);
});

test("endpoint overrides in the environment are refused (names only, never values)", () => {
  assert.deepEqual(
    endpointOverrideVars({
      ANTHROPIC_BASE_URL: "https://elsewhere.example",
      OPENAI_BASE_URL: "",
      HTTPS_PROXY: "http://proxy.example:8080",
      NO_PROXY: "localhost",
      AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://x",
      SOME_API_ENDPOINT: "https://y",
      DATABASE_URL: "sqlite://z",
      HOME: "/home/x",
    }),
    ["ANTHROPIC_BASE_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "HTTPS_PROXY", "SOME_API_ENDPOINT"],
  );
  assert.throws(
    () => assertNoEndpointOverrides({ ANTHROPIC_BASE_URL: "https://elsewhere.example" }),
    (error: Error) => error.message.includes("ANTHROPIC_BASE_URL") && !error.message.includes("elsewhere.example"),
  );
  assert.doesNotThrow(() => assertNoEndpointOverrides({ HOME: "/home/x", NO_PROXY: "*" }));
});

test("guardFetch: only configured endpoints are reached; a bypassing transport stops the run", async () => {
  const reached: string[] = [];
  const inner = (async (input: string) => {
    reached.push(input);
    return new Response("{}");
  }) as unknown as typeof fetch;
  const guarded = guardFetch(["https://gw.example/decisions", "https://labeller.example/v1/"], inner);
  await guarded("https://gw.example/decisions");
  await guarded("https://labeller.example/v1/messages");
  await assert.rejects(guarded("https://gw.example/decisionsX"), CalibrationAbortError);
  await assert.rejects(guarded("https://other.example/v1/messages"), /other\.example: not a configured endpoint/);
  assert.equal(guarded.calls, 2);
  assert.deepEqual(reached, ["https://gw.example/decisions", "https://labeller.example/v1/messages"]);
  assert.equal(isUnderEndpoint("http://gw.example/decisions", "https://gw.example/decisions"), false);

  // A labeller that never goes through the guard is refused, and the run stops.
  const bypass = requireGuardedTransport(async () => ({ content: [] }), guarded);
  await assert.rejects(bypass({} as LabelRequest), CalibrationAbortError);
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      await assert.rejects(
        runCalibration({
          db, catalogue, check, question, checkpoint: "send", sample: 3, seed: 1,
          labeller: bypass, scorer,
          labellerInfo: { model: "l", host: "h" }, memberInfo: { model: "m", host: "h" },
        }),
        CalibrationAbortError,
      );
    } finally {
      db.close();
    }
  });
});

test("createDecisionScorer: one member only (never its fallbacks), the question's probability", async () => {
  const bodies: any[] = [];
  let headUp = true;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push({ url, body });
    if (!headUp) return new Response("down", { status: 503 });
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { noul: 0.77 };
    return new Response(JSON.stringify({ model: "vendor/decider-1", answers, usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const member = (endpoint: string, fallback?: string[]): any => ({
    id: "vendor/decider-1", provider: "openrouter", api: "system-one", endpoint, api_key: "k",
    input_modalities: ["text"], max_tokens: 1, context_window: 32000,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ...(fallback ? { fallback } : {}),
  });
  const models = { decider: member("https://gw.example/decisions", ["decider_b"]), decider_b: member("https://b.example/decisions") };
  const score = createDecisionScorer({
    client: new DecisionClient({ models, fetchImpl }),
    memberKey: "decider",
    memberConfig: models.decider,
    check,
    question,
  });
  const item = { id: "s:c", sessionId: "s", checkpoint: "send" as const, context: { action: "send_message" }, sources: { message: "m" } };
  const state = () => ({ action: "send_message", message: "m" });
  assert.equal(await score(item, state), 0.77);
  assert.deepEqual(Object.keys(bodies[0].body.questions), ["refusal_safety__message"]);
  headUp = false;
  await assert.rejects(score(item, state));
  assert.ok(bodies.every((b) => b.url === "https://gw.example/decisions"), "the fallback member is never called");
});
