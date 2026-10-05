/**
 * The calibration tool's "any refusal" mode: recorded scores read from the
 * `checks` decision rows (max over refusal questions of the mode's sources,
 * branch 0, verdict results else answers), stratified sampling by score band
 * (seeded, all of a band when it is small, unrecorded outputs excluded and
 * counted), the generic refusal definition and reason enum, one scoring call
 * carrying every refusal question, the inverse-sampling weighting, and the
 * privacy guarantee: the report holds ids, enums and numbers only.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  anyRefusalItems,
  anyRefusalLabelRequest,
  anyRefusalReasons,
  bandOf,
  bandSummaries,
  createAnyRefusalScorer,
  directionAccuracy,
  formatAnyRefusalReport,
  normalizeBands,
  recordedRefusalScores,
  runAnyRefusalCalibration,
  sampleByScoreBand,
  weightedThresholdTable,
  type AnyRefusalRow,
} from "../src/audit/any-refusal-calibration.js";
import { openReadOnly, reportJson, type Labeller, type LabelRequest, type Scorer } from "../src/audit/calibration.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { DecisionClient } from "../src/decisions/index.js";
import { Storage } from "../src/storage/index.js";
import { kick, noReply, sent, text, asst } from "./audit-fixtures.js";

const SECRET = "ZQX-PRIVATE-MARKER";
const config: any = { models: {}, checks: {}, agents: {} };
const catalogue = buildCheckCatalogue(config);
const refusalCodes = new Set(catalogue.all().filter((c) => c.kind === "refusal").map((c) => c.code));

/** Recorded scores per session index; undefined = no recorded row. */
function recordedFor(i: number): number | undefined {
  if (i < 20) return 0.02 + i * 0.001; // band 0
  if (i < 26) return 0.2; // band 1
  if (i < 30) return 0.4; // band 2
  if (i < 32) return 0.6; // band 3
  if (i < 34) return 0.7; // band 4
  if (i < 36) return 0.9; // band 5
  return undefined; // 36..39: never judged
}

async function withDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "any-refusal-test-"));
  const dbPath = path.join(dir, "history.db");
  try {
    const storage = await Storage.open({ databasePath: dbPath });
    for (let i = 0; i < 40; i++) {
      const id = `s${i}`;
      await storage.insertAgentSession({
        id, timelineKey: "matrix:acct:room:!r:example.org", sessionType: "default", status: "completed",
        triggerBody: `${SECRET} trigger ${i}`, createdAt: 1_000 + i, updatedAt: 1_000 + i,
      });
      await storage.saveAgentSessionTranscript(id, JSON.stringify([kick(`${SECRET} ask ${i}`), ...sent(`c${i}`, `${SECRET} item ${i}`)]));
      const p = recordedFor(i);
      if (p === undefined) continue;
      const row = (over: Record<string, unknown>) => storage.insertDecisionEvaluation({
        ts: 2_000 + i, decision_group: `g${i}`, point: "checks", agent_session_id: id, source: "model",
        checkpoint: "send", branch_no: 0, tool_call_id: `c${i}`, consequence: "sent", ...over,
      });
      if (i % 5 === 1) {
        // A row whose verdict carries no results: the answers hold the score.
        await row({ verdict_json: JSON.stringify({ unjudged: true }), answers_json: JSON.stringify({
          "refusal_safety__message": { type: "noul", noul: p },
          "refusal_privacy__message_2": { type: "noul", noul: p / 2 },
        }) });
      } else {
        await row({ verdict_json: JSON.stringify({ fired: [], results: [
          { id: "refusal_safety__message", p: p / 2, t: 0.8 },
          { id: "refusal_persona__message", p, t: 0.8 },
          // Ignored: another source, a style check, an unknown code.
          { id: "refusal_safety__analysis", p: 0.99, t: 0.8 },
          { id: "style_load_bearing__message", p: 0.99, t: 0.85 },
          { id: "not_a_check__message", p: 0.99, t: 0.8 },
        ] }) });
      }
      // Ignored: another branch, a pattern row, another checkpoint.
      await row({ branch_no: 1, verdict_json: JSON.stringify({ results: [{ id: "refusal_safety__message", p: 0.99 }] }) });
      await row({ source: "pattern", verdict_json: JSON.stringify({ fired: ["refusal_safety"], results: [{ id: "refusal_safety__message", p: 1 }] }) });
      await row({ checkpoint: "ending", verdict_json: JSON.stringify({ results: [{ id: "refusal_safety__message", p: 0.99 }] }) });
    }
    // The audit judged s0 again later, higher: the max counts.
    await storage.insertDecisionEvaluation({
      ts: 9_000, decision_group: "audit:x", point: "checks", agent_session_id: "s0", source: "model",
      checkpoint: "send", branch_no: 0, tool_call_id: "c0", consequence: "observed",
      verdict_json: JSON.stringify({ results: [{ id: "refusal_capability__message", p: 0.05 }] }),
    });
    // An ending: a no_reply call judged over its text.
    await storage.insertAgentSession({
      id: "e1", timelineKey: "matrix:acct:room:!r:example.org", sessionType: "default", status: "completed",
      createdAt: 5_000, updatedAt: 5_000,
    });
    await storage.saveAgentSessionTranscript("e1", JSON.stringify([
      kick(`${SECRET} ending ask`),
      asst([text(`${SECRET} I'd rather not`)]),
      ...noReply("n1", { analysis: `${SECRET} decline` }),
    ]));
    await storage.insertDecisionEvaluation({
      ts: 5_001, decision_group: "ge", point: "checks", agent_session_id: "e1", source: "model",
      checkpoint: "ending", branch_no: 0, tool_call_id: "n1", attempt_no: 0, consequence: "observed",
      verdict_json: JSON.stringify({ results: [{ id: "refusal_safety__analysis", p: 0.85 }, { id: "refusal_safety__text", p: 0.3 }] }),
    });
    await storage.waitForIdle();
    storage.close();
    await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bands: validation and lookup", () => {
  assert.deepEqual(normalizeBands([0, 0.1, 0.3]), [0, 0.1, 0.3]);
  assert.throws(() => normalizeBands([0.1, 0.3]), /start at 0/);
  assert.throws(() => normalizeBands([0, 0.3, 0.3]), /strictly increasing/);
  assert.throws(() => normalizeBands([0, 1]), /\[0, 1\)/);
  const edges = [0, 0.1, 0.3, 0.5, 0.65, 0.8];
  assert.equal(bandOf(edges, 0), 0);
  assert.equal(bandOf(edges, 0.0999), 0);
  assert.equal(bandOf(edges, 0.1), 1);
  assert.equal(bandOf(edges, 0.64), 3);
  assert.equal(bandOf(edges, 0.8), 5);
  assert.equal(bandOf(edges, 1), 5);
});

test("recordedRefusalScores: max over refusal questions of the sources, branch 0, model rows; answers as fallback", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const scores = recordedRefusalScores(db, { checkpoint: "send", sources: ["message"], refusalCodes });
      assert.equal(scores.size, 36);
      assert.equal(scores.get("s0|c0"), 0.05, "the later audit row's higher score");
      assert.equal(scores.get("s1|c1"), 0.021, "from answers_json");
      assert.equal(scores.get("s30|c30"), 0.6, "persona beats safety; analysis, style and unknown codes ignored");
      assert.equal(scores.get("s36|c36"), undefined);
      const ending = recordedRefusalScores(db, { checkpoint: "ending", sources: ["analysis", "text", "thinking"], refusalCodes });
      assert.equal(ending.get("e1|n1"), 0.85);
      assert.equal(ending.get("s2|c2"), undefined, "message results do not count at an ending");
    } finally {
      db.close();
    }
  });
});

test("sampleByScoreBand: per-band reservoirs, populations, unrecorded outputs excluded; seeded", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const opts = {
        checkpoint: "send" as const, sources: ["message" as const], refusalCodes,
        bands: [0, 0.1, 0.3, 0.5, 0.65, 0.8], perBand: 3, seed: 7,
      };
      const sample = sampleByScoreBand(db, opts);
      assert.deepEqual(sample.population, [20, 6, 4, 2, 2, 2]);
      assert.equal(sample.eligible, 40);
      assert.equal(sample.unrecorded, 4);
      assert.equal(sample.sessions, 41);
      const perBand = [0, 1, 2, 3, 4, 5].map((b) => sample.items.filter((i) => i.band === b).length);
      assert.deepEqual(perBand, [3, 3, 3, 2, 2, 2], "perBand each, or the whole band");
      for (const s of sample.items) assert.equal(bandOf(opts.bands, s.recorded), s.band);
      const unrecorded = new Set(["s36:c36", "s37:c37", "s38:c38", "s39:c39"]);
      assert.ok(sample.items.every((s) => !unrecorded.has(s.item.id)), "outputs without a recorded score are never sampled");
      assert.deepEqual(sampleByScoreBand(db, opts).items.map((s) => s.item.id), sample.items.map((s) => s.item.id), "seeded");
      const other = sampleByScoreBand(db, { ...opts, seed: 99 }).items.filter((s) => s.band === 0).map((s) => s.item.id);
      assert.equal(other.length, 3);
      // A big perBand takes every recorded output.
      assert.equal(sampleByScoreBand(db, { ...opts, perBand: 100 }).items.length, 36);
    } finally {
      db.close();
    }
  });
});

test("weighting: population estimates from inverse-sampling weights", () => {
  const rows: AnyRefusalRow[] = [
    { id: "a", band: 0, recorded: 0.05, label: "false", reason: "not_refusal", probability: 0.05 },
    { id: "b", band: 0, recorded: 0.05, label: "true", reason: "safety", probability: 0.6 },
    { id: "c", band: 1, recorded: 0.9, label: "true", reason: "safety", probability: 0.9 },
    { id: "d", band: 1, recorded: 0.9, label: "false", reason: "not_refusal", probability: 0.7 },
    { id: "e", band: 1, recorded: 0.9, label: "unsure", reason: null, probability: 0.5 },
    { id: "f", band: 1, recorded: 0.9, label: "true", reason: null, probability: null },
  ];
  const bands = bandSummaries(rows, [0, 0.5], [100, 10]);
  assert.deepEqual(bands.map((b) => [b.from, b.to, b.population, b.sampled, b.weight]), [[0, 0.5, 100, 2, 50], [0.5, 1, 10, 4, 5]]);
  assert.deepEqual([bands[1]!.true, bands[1]!.false, bands[1]!.unsure, bands[1]!.unscored], [2, 1, 1, 1]);
  const weights = bands.map((b) => b.weight);
  const [at5, at8] = weightedThresholdTable(rows, weights, [0.8, 0.5]);
  assert.deepEqual(at5, {
    threshold: 0.5, tp: 2, fp: 1, fn: 0, tn: 1, wtp: 55, wfp: 5, wfn: 0, wtn: 50, precision: 0.917, recall: 1, f1: 0.957,
  });
  assert.deepEqual(at8, {
    threshold: 0.8, tp: 1, fp: 0, fn: 1, tn: 2, wtp: 5, wfp: 0, wfn: 50, wtn: 55, precision: 1, recall: 0.091, f1: 0.167,
  });
  assert.deepEqual(directionAccuracy(rows, weights), { items: 4, raw: 0.75, weighted: 0.955 });
  // A band with no usable row has no weight and contributes nothing.
  const none = bandSummaries([{ ...rows[4]!, band: 0 }], [0, 0.5], [7, 0]);
  assert.equal(none[0]!.weight, null);
});

test("label request: the generic refusal definition, catalogue reasons + not_refusal, no reproduction", () => {
  const reasons = anyRefusalReasons(catalogue, []);
  for (const r of ["distillation", "safety", "sexual_content", "privacy", "copyright", "persona", "capability", "unclear"]) {
    assert.ok(reasons.includes(r), r);
  }
  assert.equal(reasons.at(-1), "not_refusal");
  const item = { id: "s1:c1", sessionId: "s1", checkpoint: "send" as const, context: { action: "send_message" }, sources: { message: "x" } };
  const request = anyRefusalLabelRequest(item, "send", { message: "x" }, reasons);
  assert.match(request.prompt, /declines, deflects or quietly does less than `request` asks, for any reason/);
  assert.match(request.prompt, /Honestly stating a real limit while still helping/);
  assert.match(request.prompt, /no reply was needed/);
  assert.match(request.prompt, /Discussing, quoting or reporting a refusal/);
  assert.match(request.prompt, /Do not reproduce any of the item's content/);
  assert.deepEqual(request.tool.parameters.properties.reason.enum, reasons);
  assert.match(anyRefusalLabelRequest(item, "ending", {}, reasons).prompt, /ended its turn without sending/);
});

test("scorer: one call with every enabled refusal question over the sources; the max", async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { noul: id.startsWith("refusal_persona") ? 0.66 : 0.1 };
    return new Response(JSON.stringify({ model: "vendor/decider-1", answers, usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const member = (over: Record<string, unknown> = {}): any => ({
    id: "vendor/decider-1", provider: "openrouter", api: "system-one", endpoint: "https://gw.example/decisions", api_key: "k",
    input_modalities: ["text"], max_tokens: 1, context_window: 32000,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ...over,
  });
  const gated = buildCheckCatalogue({ ...config, checks: { refusal_copyright: { enabled: false } } });
  const checks = gated.enabledFor("send").filter((c) => c.kind === "refusal");
  const item = { id: "s:c", sessionId: "s", checkpoint: "send" as const, context: { action: "send_message" }, sources: { message: "m", analysis: "a" } };
  const score = createAnyRefusalScorer({
    client: new DecisionClient({ models: { decider: member() }, fetchImpl }),
    memberKey: "decider", memberConfig: member(), checks, checkpoint: "send", sources: ["message"],
  });
  assert.equal(await score(item, () => ({ message: "m" })), 0.66);
  assert.equal(bodies.length, 1, "one request");
  assert.deepEqual(
    Object.keys(bodies[0].questions),
    ["refusal_distillation", "refusal_safety", "refusal_sexual_content", "refusal_privacy", "refusal_persona", "refusal_capability", "refusal_uncategorized"]
      .map((c) => `${c}__message`),
    "every enabled refusal check, message only",
  );
  // A member that takes at most 3 questions gets the same questions in chunks.
  bodies.length = 0;
  const small = member({ decision: { max_questions: 3 } });
  const chunked = createAnyRefusalScorer({
    client: new DecisionClient({ models: { decider: small }, fetchImpl }),
    memberKey: "decider", memberConfig: small, checks, checkpoint: "send", sources: ["message"],
  });
  assert.equal(await chunked(item, () => ({ message: "m" })), 0.66);
  assert.deepEqual(bodies.map((b) => Object.keys(b.questions).length), [3, 3, 1]);
  // Ending sources: only the sources the item carries.
  const ending = anyRefusalItems(checks, { ...item, checkpoint: "ending", context: { action: "no_reply" }, sources: { text: "t" } }, ["analysis", "text", "thinking"]);
  assert.ok(ending.length === checks.length && ending.every((i) => i.source === "text"));
});

test("runAnyRefusalCalibration: stratified, weighted, direction accuracy, suggestions; never message text", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const prompts: LabelRequest[] = [];
      // Items 30+ are refusals; the echoing labeller also repeats the prompt as text.
      const labeller: Labeller = async (request) => {
        prompts.push(request);
        const i = Number(/item (\d+)/.exec(request.prompt)?.[1]);
        return {
          content: [
            { type: "text", text: `Echo: ${request.prompt}` },
            { type: "toolCall", name: "submit_label", arguments: i >= 30 ? { label: "true", reason: "safety" } : { label: "false", reason: "not_refusal" } },
          ],
        };
      };
      // Fresh scores: high for refusals, one confident miss (s30), one false alarm (s20).
      const scorer: Scorer = async (item) => {
        const i = Number(item.id.slice(1, item.id.indexOf(":")));
        if (i === 30) return 0.2;
        if (i === 20) return 0.95;
        return i >= 30 ? 0.9 : 0.05;
      };
      const report = await runAnyRefusalCalibration({
        db, catalogue, checkpoint: "send", perBand: 100, seed: 3, labeller, scorer,
        labellerInfo: { model: "labeller_a", host: "labeller.example" }, memberInfo: { model: "decider", host: "gw.example" },
      });
      assert.equal(report.mode, "any_refusal");
      assert.deepEqual(report.sources, ["message"]);
      assert.ok(report.checks.includes("refusal_sexual_content"));
      assert.equal(report.unrecorded, 4);
      assert.equal(report.rows.length, 36);
      assert.equal(prompts.length, 36);
      // Every item sampled: weights are 1 and the estimates equal the raw counts.
      assert.ok(report.bands.every((b) => b.weight === 1));
      const at5 = report.thresholds.find((t) => t.threshold === 0.5)!;
      assert.deepEqual([at5.tp, at5.fp, at5.fn, at5.tn], [5, 1, 1, 29]);
      assert.deepEqual([at5.wtp, at5.wfp, at5.wfn, at5.wtn], [5, 1, 1, 29]);
      assert.equal(report.direction.raw, round(34 / 36));
      assert.equal(report.suggested.bestF1!.threshold, 0.2, "the highest threshold of the best F1 (6 tp, 1 fp)");
      assert.equal(report.suggested.bestF1!.f1, 0.923);
      assert.equal(report.suggested.atPrecisionTarget, null, "the false alarm sits above every refusal");

      // Stratified: band 0 (20 outputs) sampled at 3 counts with weight 20/3.
      const strat = await runAnyRefusalCalibration({
        db, catalogue, checkpoint: "send", perBand: 3, seed: 3, labeller, scorer,
        labellerInfo: { model: "l", host: "h" }, memberInfo: { model: "m", host: "h" },
      });
      assert.equal(strat.bands[0]!.sampled, 3);
      assert.equal(Math.round(strat.bands[0]!.weight! * 1000) / 1000, 6.667);
      const t5 = strat.thresholds.find((t) => t.threshold === 0.5)!;
      assert.ok(Math.abs(t5.wtp + t5.wfp + t5.wfn + t5.wtn - 36) < 0.01, "the weights add up to the recorded population");

      for (const out of [formatAnyRefusalReport(report), reportJson(report), formatAnyRefusalReport(strat)]) {
        assert.ok(!out.includes(SECRET), "no message text in the output");
        assert.ok(!out.includes("Echo"), "nothing of the labeller's free text");
        assert.ok(!out.includes("item 3"), "no item text");
      }
      assert.match(formatAnyRefusalReport(report), /without a recorded score \(excluded\) 4/);
      assert.match(formatAnyRefusalReport(report), /direction accuracy/);
    } finally {
      db.close();
    }
  });
});

const round = (n: number) => Math.round(n * 1000) / 1000;

test("runAnyRefusalCalibration --checkpoint ending: the ending sources", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const report = await runAnyRefusalCalibration({
        db, catalogue, checkpoint: "ending", perBand: 5, seed: 1,
        labeller: async () => ({ content: [{ type: "toolCall", name: "submit_label", arguments: { label: "true", reason: "unclear" } }] }),
        scorer: async () => 0.8,
        labellerInfo: { model: "l", host: "h" }, memberInfo: { model: "m", host: "h" },
      });
      assert.deepEqual(report.sources, ["analysis", "text", "thinking"]);
      assert.deepEqual(report.rows.map((r) => [r.id, r.band, r.recorded, r.label, r.probability]), [["e1:n1", 5, 0.85, "true", 0.8]]);
      assert.equal(report.bands[5]!.population, 1);
    } finally {
      db.close();
    }
  });
});
