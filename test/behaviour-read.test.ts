/**
 * Model behaviour read API (spec REFUSAL-HANDLING §12.3, §12.4): scorecard rates and
 * previous-window change, family/group-by/filters, series buckets, breakdown,
 * change markers (filtering and same-deploy collapsing), the incident log with
 * cursor pagination, and the HTTP routes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../src/agent/index.js";
import { ModelBehaviourService, behaviourFamilyOf } from "../src/behaviour/index.js";
import { recordBehaviourChanges } from "../src/behaviour/changes.js";
import {
  INCIDENT_SCAN_CAP,
  collapseMarkers,
  readBehaviourIncidents,
  readModelBehaviour,
  type ModelBehaviourQuery,
} from "../src/behaviour/read.js";
import { MODEL_BEHAVIOUR_ROLLUP_VERSION, ModelBehaviourRollups, ensureRollupVersion } from "../src/behaviour/rollups.js";
import type { BehaviourChangeEvent } from "../src/behaviour/types.js";
import type { Logger } from "../src/observability/index.js";
import { createObservabilityServer } from "../src/observability/server/index.js";
import { parseModelBehaviourQuery } from "../src/observability/server/model-behaviour-handlers.js";
import { Storage } from "../src/storage/index.js";
import { H, HOUR, KEY_A, addRequest, addSession, agentFor, seedScenario } from "./behaviour-fixtures.js";

const FAMILY: Record<string, string> = { model_a: "fam_a", model_b: "fam_a" };
const ctxFor = (storage: Storage) => ({
  storage,
  agentForTimelineKey: agentFor,
  familyOf: (m: string) => FAMILY[m] ?? m,
  checkKind: (code: string) => (code.startsWith("style_") ? "style" : undefined),
});

async function withData(fn: (storage: Storage) => Promise<void>): Promise<void> {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await seedScenario(storage);
    await new ModelBehaviourRollups({ storage, agentForTimelineKey: agentFor, countTokens: (t) => t.split(" ").length }).flush();
    await fn(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
}

const q = (over: Partial<ModelBehaviourQuery> = {}): ModelBehaviourQuery => ({
  window: "24h",
  groupBy: "model",
  family: false,
  now: H + 2 * HOUR,
  ...over,
});

test("scorecard: one row per model, rates with raw counts, min-sample flag", async () => {
  await withData(async (storage) => {
    const r = readModelBehaviour(ctxFor(storage), q());
    assert.deepEqual(r.scorecard.map((row) => row.group), ["model_a", "model_b", "cap_model"]);
    const a = r.scorecard.find((row) => row.group === "model_a")!;
    assert.deepEqual(a.volume, { requests: 2, sessions: 2, messages: 0 });
    assert.deepEqual(a.cells.refusals_hard_per_request, {
      rate: 0.5, count: 1, denominator: 2, previousRate: null, change: null, lowSample: true,
    });
    assert.equal(a.cells.contract_exhaustions_per_session!.rate, 0.5);
    assert.equal(a.cells.contract_redos_per_session!.count, 1);
    const b = r.scorecard.find((row) => row.group === "model_b")!;
    assert.equal(b.cells.recovered_per_nudged!.rate, 1);
    assert.equal(b.cells.messages_with_style_hit!.rate, 0.5);
    assert.equal(b.cells.style_hits_per_1k_tokens!.rate, (1 / 7) * 1000);
    assert.equal(b.cells.refusals_judged_per_request!.rate, 0);
    assert.equal(r.rates.length, 12);
    assert.equal(b.cells.failed_attempts_per_session!.count, 1);
    assert.equal(a.cells.failed_attempts_per_session!.count, 4);
    assert.deepEqual(r.facets, {
      agents: ["agent_a", "agent_b"],
      sites: ["caption", "default", "proactive"],
      models: ["cap_model", "model_a", "model_b"],
      tasks: ["coding"],
    });
    assert.equal(r.pendingHours, 0);
  });
});

test("change against the previous window of the same length", async () => {
  await withData(async (storage) => {
    // A clean model_a session a day later: current window 0/1, previous 1/2.
    await addSession(storage, "s3", { key: KEY_A, type: "default", createdAt: H + 24 * HOUR + 10 });
    await addRequest(storage, "s3", H + 24 * HOUR + 20, "model_a", { key: KEY_A, type: "default" });
    await new ModelBehaviourRollups({ storage, agentForTimelineKey: agentFor }).flush();
    const r = readModelBehaviour(ctxFor(storage), q({ now: H + 25 * HOUR + 5 }));
    const cell = r.scorecard.find((row) => row.group === "model_a")!.cells.refusals_hard_per_request!;
    assert.equal(cell.rate, 0);
    assert.equal(cell.previousRate, 0.5);
    assert.equal(cell.change, -0.5);
    // "all" has no previous window.
    const all = readModelBehaviour(ctxFor(storage), q({ window: "all", now: H + 25 * HOUR + 5 }));
    assert.equal(all.scorecard.find((row) => row.group === "model_a")!.cells.refusals_hard_per_request!.previousRate, null);
  });
});

test("family toggle, group-by, filters and the selected group", async () => {
  await withData(async (storage) => {
    const fam = readModelBehaviour(ctxFor(storage), q({ family: true }));
    const famRow = fam.scorecard.find((row) => row.group === "fam_a")!;
    assert.deepEqual(famRow.members, ["model_a", "model_b"]);
    assert.equal(famRow.volume.requests, 3);

    const byAgent = readModelBehaviour(ctxFor(storage), q({ groupBy: "agent" }));
    assert.deepEqual(byAgent.scorecard.map((row) => [row.group, row.volume.requests]), [["agent_a", 3], ["agent_b", 1]]);

    const byTask = readModelBehaviour(ctxFor(storage), q({ groupBy: "task" }));
    assert.deepEqual(byTask.scorecard.map((row) => [row.group, row.volume.requests]), [["coding", 2]]);

    const agentB = readModelBehaviour(ctxFor(storage), q({ agent: "agent_b" }));
    assert.deepEqual(agentB.scorecard.map((row) => [row.group, row.volume.requests]), [["model_a", 1]]);

    const site = readModelBehaviour(ctxFor(storage), q({ site: "caption" }));
    assert.deepEqual(site.scorecard.map((row) => row.group), ["cap_model"]);

    const task = readModelBehaviour(ctxFor(storage), q({ task: "coding" }));
    assert.deepEqual(task.scorecard.map((row) => row.group), ["model_a", "model_b"]);

    // Selecting model_a scopes the breakdown (not the scorecard).
    const sel = readModelBehaviour(ctxFor(storage), q({ selected: "model_a" }));
    assert.equal(sel.scorecard.length, 3);
    assert.equal(sel.breakdown.refusals.hard, 1);
    assert.deepEqual(sel.breakdown.refusals.byReason, [{ key: "distillation", count: 1 }]);
    assert.deepEqual(sel.breakdown.refusals.bySite, [{ key: "default", count: 1 }]);
    assert.deepEqual(sel.breakdown.refusals.outcomes, [{ key: "redo", count: 1 }]);
    assert.equal(sel.breakdown.refusals.discardedBranchCostUsd, 0.05);
    assert.deepEqual(sel.breakdown.contract.failureTypes, [{ key: "empty", count: 4 }]);
    assert.equal(sel.breakdown.contract.untilRecovery.find((c) => c.key === "exhausted")!.count, 1);
    assert.equal(sel.breakdown.contract.redos, 1);

    const selFam = readModelBehaviour(ctxFor(storage), q({ family: true, selected: "fam_a" }));
    assert.equal(selFam.breakdown.style.hits, 1);
    assert.deepEqual(selFam.breakdown.style.perCheck, [{ code: "style_x", hits: 1, revisions: 1, overrides: 0 }]);
    assert.equal(selFam.breakdown.refusals.hard, 1);
  });
});

test("series: the selected rate per bucket and group; bucket width by window", async () => {
  await withData(async (storage) => {
    const r = readModelBehaviour(ctxFor(storage), q({ metric: "nudged_per_session" }));
    assert.equal(r.metric, "nudged_per_session");
    assert.equal(r.series.bucketMs, HOUR);
    assert.deepEqual(
      r.series.points.map((p) => [p.bucket, p.group, p.count, p.denominator, p.rate]),
      [[H, "model_a", 1, 2, 0.5], [H, "model_b", 1, 1, 1]],
    );
    const week = readModelBehaviour(ctxFor(storage), q({ window: "7d", metric: "nudged_per_session" }));
    assert.equal(week.series.bucketMs, 24 * HOUR);
    // Points land on the day's start, not the hour's (H is not day-aligned).
    const day = Math.floor(H / (24 * HOUR)) * 24 * HOUR;
    assert.notEqual(day, H);
    assert.deepEqual([...new Set(week.series.points.map((p) => p.bucket))], [day]);
    assert.ok(week.overview.metrics.every((m) => m.points.every((p) => p.bucket === day)));
    assert.equal(readModelBehaviour(ctxFor(storage), q({ window: "all" })).series.bucketMs, 7 * 24 * HOUR);
    // An unknown metric (or none) is the overview: no per-group series.
    const overview = readModelBehaviour(ctxFor(storage), q({ metric: "nope" }));
    assert.equal(overview.metric, null);
    assert.deepEqual(overview.series.points, []);
  });
});

test("markers: filtered to displayed models/agents/sites, same-deploy changes collapse", async () => {
  await withData(async (storage) => {
    await recordBehaviourChanges(storage, [
      { kind: "head_model_changed", sentence: "a", agents: ["agent_a"], sites: ["default"], models: ["model_a"] },
    ], H + 10 * 60_000);
    await recordBehaviourChanges(storage, [
      { kind: "code_changed", sentence: "deploy", agents: [], sites: [], models: [] },
    ], H + 13 * 60_000);
    await recordBehaviourChanges(storage, [
      { kind: "rule_changed", sentence: "other model", agents: [], sites: [], models: ["model_z"] },
    ], H + 14 * 60_000);
    await recordBehaviourChanges(storage, [
      { kind: "prompt_changed", sentence: "p", agents: ["agent_b"], sites: ["proactive"], models: ["model_a"] },
    ], H + 60 * 60_000);
    const r = readModelBehaviour(ctxFor(storage), q());
    assert.equal(r.markers.length, 2);
    assert.deepEqual(r.markers[0]!.kinds, ["head_model_changed", "code_changed"]);
    assert.equal(r.markers[0]!.ts, H + 10 * 60_000);
    assert.equal(r.markers[0]!.until, H + 13 * 60_000);
    assert.deepEqual(r.markers[1]!.kinds, ["prompt_changed"]);
    // Filtered to agent_a: agent_b's prompt change disappears.
    const a = readModelBehaviour(ctxFor(storage), q({ agent: "agent_a" }));
    assert.deepEqual(a.markers.flatMap((m) => m.kinds), ["head_model_changed", "code_changed"]);
    // Family grouping maps the touched models.
    const fam = readModelBehaviour(ctxFor(storage), q({ family: true }));
    assert.equal(fam.markers.length, 2);
  });
});

test("collapseMarkers chains events within the gap", () => {
  const e = (id: number, ts: number): BehaviourChangeEvent => ({
    id, ts, kind: "config_changed", sentence: "", path: null, old: null, new: null, agents: [], sites: [], models: [], detail: null,
  });
  const m = collapseMarkers([e(1, 0), e(2, 240_000), e(3, 480_000), e(4, 2_000_000)], 300_000);
  assert.deepEqual(m.map((x) => x.events.map((y) => y.id)), [[1, 2, 3], [4]]);
});

test("incident log: one row per session with chips, outcome and link; cursor pagination; filters", async () => {
  await withData(async (storage) => {
    const page = readModelBehaviour(ctxFor(storage), q({ window: "all" })).incidents;
    assert.deepEqual(page.rows.map((r) => r.sessionId), ["s2", "s1"]);
    assert.equal(page.nextCursor, null);
    const [s2, s1] = page.rows;
    assert.deepEqual(s2!.types, ["nudge", "redo"]);
    assert.deepEqual(s2!.chips, { refused: 0, redone: 1, nudged: 3, revised: 0, overridden: 0, endings: 0 });
    assert.equal(s2!.outcome, "nudged 3×, exhausted; send-contract redo");
    assert.equal(s2!.agent, "agent_b");
    assert.equal(s2!.roomLabel, "matrix:acc_b:room:!r2:x");
    assert.deepEqual(s1!.types, ["refusal", "nudge", "redo", "revision"]);
    assert.deepEqual(s1!.models, ["model_a", "model_b"]);
    assert.equal(s1!.outcome, "refused (distillation) by model_a, redone on model_b; nudged 1×, recovered; revised 1×");
    assert.deepEqual(s1!.link, { sessionId: "s1", branchNo: 0, toolCallId: null, attemptNo: null });

    const ctx = ctxFor(storage);
    const p1 = readBehaviourIncidents(ctx, q({ window: "all", limit: 1 }));
    assert.deepEqual(p1.rows.map((r) => r.sessionId), ["s2"]);
    assert.ok(p1.nextCursor);
    const p2 = readBehaviourIncidents(ctx, q({ window: "all", limit: 1, cursor: p1.nextCursor }));
    assert.deepEqual(p2.rows.map((r) => r.sessionId), ["s1"]);
    const p3 = readBehaviourIncidents(ctx, q({ window: "all", limit: 1, cursor: p2.nextCursor }));
    assert.deepEqual(p3.rows, []);
    assert.equal(p3.nextCursor, null);

    const refusalsOnly = readBehaviourIncidents(ctx, q({ window: "all", incidentType: "refusal" }));
    assert.deepEqual(refusalsOnly.rows.map((r) => r.sessionId), ["s1"]);
    const modelB = readBehaviourIncidents(ctx, q({ window: "all", selected: "model_b" }));
    assert.deepEqual(modelB.rows.map((r) => r.sessionId), ["s1"]);
    const famA = readBehaviourIncidents(ctx, q({ window: "all", family: true, selected: "fam_a" }));
    assert.deepEqual(famA.rows.map((r) => r.sessionId), ["s2", "s1"]);
    const agentB = readBehaviourIncidents(ctx, q({ window: "all", agent: "agent_b" }));
    assert.deepEqual(agentB.rows.map((r) => r.sessionId), ["s2"]);
    const task = readBehaviourIncidents(ctx, q({ window: "all", groupBy: "task", selected: "coding" }));
    assert.deepEqual(task.rows.map((r) => r.sessionId), ["s1"]);
    const site = readBehaviourIncidents(ctx, q({ window: "all", site: "proactive" }));
    assert.deepEqual(site.rows.map((r) => r.sessionId), ["s2"]);
    // Outside the window: none.
    assert.deepEqual(readBehaviourIncidents(ctx, q({ window: "24h", now: H + 48 * HOUR })).rows, []);
  });
});

test("parseModelBehaviourQuery: defaults and validation", () => {
  const d = parseModelBehaviourQuery(new URL("http://x/api/models/behaviour"));
  assert.deepEqual(d, {
    window: "24h", groupBy: "model", family: false, agent: null, site: null, task: null,
    selected: null, metric: null, incidentType: null, cursor: null,
  });
  const p = parseModelBehaviourQuery(
    new URL("http://x/api/models/behaviour?window=7d&groupBy=site&family=1&agent=a&site=&type=nudge&limit=10&cursor=5:s"),
  );
  assert.equal(p.window, "7d");
  assert.equal(p.groupBy, "site");
  assert.equal(p.family, true);
  assert.equal(p.agent, "a");
  assert.equal(p.site, null);
  assert.equal(p.incidentType, "nudge");
  assert.equal(p.limit, 10);
  assert.equal(p.cursor, "5:s");
  assert.equal(parseModelBehaviourQuery(new URL("http://x/?window=bogus&groupBy=bogus&type=bogus")).window, "24h");
});

const silentLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() {
    return silentLogger;
  },
};

test("HTTP: GET /api/models/behaviour and /incidents; 503 when not wired", async () => {
  await withData(async (storage) => {
    const service = new ModelBehaviourService({
      storage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { models: { model_a: { family: "fam_a" }, model_b: { family: "fam_a" } } } as any,
      catalogue: { all: () => [], get: () => undefined, enabledFor: () => [] },
      agentForTimelineKey: agentFor,
    });
    for (const modelBehaviour of [service, undefined]) {
      const server = createObservabilityServer({
        config: { enabled: true, bind: "127.0.0.1", port: 0 },
        storage,
        factory: {} as never,
        sessions: new SessionManager(),
        workspaceRoot: "/tmp",
        logger: silentLogger,
        modelBehaviour,
      });
      await server.start();
      try {
        const base = `http://127.0.0.1:${server.address()}`;
        const res = await fetch(`${base}/api/models/behaviour?window=all&family=1`);
        if (!modelBehaviour) {
          assert.equal(res.status, 503);
          continue;
        }
        assert.equal(res.status, 200);
        const body = (await res.json()) as { scorecard: Array<{ group: string }>; incidents: { rows: unknown[] }; family: boolean };
        assert.equal(body.family, true);
        assert.ok(body.scorecard.some((r) => r.group === "fam_a"));
        assert.equal(body.incidents.rows.length, 2);
        const inc = await fetch(`${base}/api/models/behaviour/incidents?window=all&limit=1`);
        const page = (await inc.json()) as { rows: Array<{ sessionId: string }>; nextCursor: string | null };
        assert.deepEqual(page.rows.map((r) => r.sessionId), ["s2"]);
        assert.ok(page.nextCursor);
      } finally {
        await server.stop();
      }
    }
  });
});

test("reads never recompute: pending hours are served later by the drain", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    await addRequest(storage, null, Date.now() - 1_000, "cap_model", { key: KEY_A, cls: "caption" });
    const service = new ModelBehaviourService({
      storage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { models: {} } as any,
      catalogue: { all: () => [], get: () => undefined, enabledFor: () => [] },
      agentForTimelineKey: agentFor,
    });
    const before = await service.read(q({ now: Date.now() }));
    assert.deepEqual(before.scorecard, []);
    assert.equal(before.pendingHours, 1);
    await service.rollups.flush();
    const r = await service.read(q({ now: Date.now() }));
    assert.deepEqual(r.scorecard.map((row) => [row.group, row.volume.requests]), [["cap_model", 1]]);
    assert.equal(r.pendingHours, 0);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

/** Judged rows on s1 as the live gate and the offline audit write them (no chat text). */
async function addJudgedRows(storage: Storage): Promise<void> {
  // A judged refusal the offline audit found on model_b (group prefix `audit:`), and
  // one the live gate found; the no_reply intent of a judged ending after a nudge.
  for (const [group, reason] of [["audit:g7", "safety"], ["g8", "distillation"]] as const) {
    const id = await storage.insertDecisionEvaluation({
      ts: H + 6_000, decision_group: group, point: "checks", agent_session_id: "s1", source: "model",
      verdict_json: JSON.stringify({ fired: [{ code: "op_refusal", kind: "refusal" }], results: [] }),
      checkpoint: "send", branch_no: 0, tool_call_id: `tc-${group}`, consequence: "observed",
    });
    await storage.insertRefusalEvent({
      ts: H + 6_100, agentSessionId: "s1", site: "default", servedModel: "model_b", kind: "soft", checkCode: "op_refusal",
      reason, method: "judged", source: "message", probability: 0.9, checkpoint: "send", outcome: "observed",
      decisionEvaluationId: id,
    });
  }
  await storage.insertDecisionEvaluation({
    ts: H + 6_200, decision_group: "audit:g9", point: "checks", agent_session_id: "s1", source: "model",
    verdict_json: JSON.stringify({
      fired: [{ code: "no_reply_intent", kind: "contract" }],
      results: [{ id: "no_reply_intent__text", code: "no_reply_intent", choice: "abandoned_written_reply", fired: true }],
    }),
    checkpoint: "ending", branch_no: 0, tool_call_id: "nr1", consequence: "observed",
  });
  await new ModelBehaviourRollups({ storage, agentForTimelineKey: agentFor }).flush();
}

test("chart: the overview by default, every metric selectable with its total, keyed families per key", async () => {
  await withData(async (storage) => {
    const r = readModelBehaviour(ctxFor(storage), q());
    assert.equal(r.metric, null);
    assert.equal(r.overview.bucketMs, HOUR);
    assert.equal(r.overview.metrics.length, r.rates.length);
    const nudged = r.overview.metrics.find((m) => m.id === "nudged_per_session")!;
    assert.deepEqual([nudged.count, nudged.denominator], [2, 3]);
    assert.deepEqual(nudged.points, [{ bucket: H, count: 2, denominator: 3, rate: 2 / 3 }]);
    // An empty metric is explicit: a zero count over a real denominator.
    const judged = r.charts.find((c) => c.id === "refusals_judged_per_request")!;
    assert.deepEqual([judged.kind, judged.count, judged.denominator], ["rate", 0, 4]);
    assert.deepEqual(
      r.charts.filter((c) => c.kind === "count").map((c) => [c.id, c.count]),
      [["mix:failure_type", 5], ["mix:after_correction", 0], ["mix:no_reply_intent", 0], ["mix:judged_refusal_reason", 0]],
    );

    const types = readModelBehaviour(ctxFor(storage), q({ metric: "mix:failure_type" }));
    assert.equal(types.metric, "mix:failure_type");
    assert.equal(types.series.kind, "count");
    assert.deepEqual(types.series.points.map((p) => [p.bucket, p.group, p.count]), [[H, "empty", 4], [H, "text_only", 1]]);
    // A family's series follows the selected group.
    const typesB = readModelBehaviour(ctxFor(storage), q({ metric: "mix:failure_type", selected: "model_b" }));
    assert.deepEqual(typesB.series.points.map((p) => [p.group, p.count]), [["text_only", 1]]);
    assert.equal(typesB.charts.find((c) => c.id === "mix:failure_type")!.count, 1);
  });
});

test("judged refusals from the live gate and the offline audit; mix tables per group", async () => {
  await withData(async (storage) => {
    await addJudgedRows(storage);
    const r = readModelBehaviour(ctxFor(storage), q());
    const b = r.scorecard.find((row) => row.group === "model_b")!;
    assert.equal(b.cells.refusals_judged_per_request!.count, 2);
    assert.equal(b.cells.no_reply_abandoned_per_judged!.rate, 1);
    const mix = Object.fromEntries(r.mix.map((t) => [t.id, t]));
    assert.deepEqual(Object.keys(mix), ["failure_type", "after_correction", "no_reply_intent", "judged_refusal_reason"]);
    assert.deepEqual(mix.judged_refusal_reason!.keys, ["distillation", "safety"]);
    assert.deepEqual(
      mix.judged_refusal_reason!.rows.map((row) => [row.group, row.total, row.counts]),
      [["model_a", 0, {}], ["model_b", 2, { distillation: 1, safety: 1 }], ["cap_model", 0, {}]],
    );
    assert.deepEqual(mix.failure_type!.rows.find((row) => row.group === "model_a")!.counts, { empty: 4 });
    assert.deepEqual(mix.no_reply_intent!.rows.find((row) => row.group === "model_b")!.counts, { abandoned_written_reply: 1 });
    // The hard refusal reason stays out of the judged family.
    assert.deepEqual(r.breakdown.refusals.byReason, [{ key: "distillation", count: 2 }, { key: "safety", count: 2 }]);
    const series = readModelBehaviour(ctxFor(storage), q({ metric: "mix:judged_refusal_reason" }));
    assert.deepEqual(series.series.points.map((p) => [p.group, p.count]), [["distillation", 1], ["safety", 1]]);
  });
});

test("family: the configured family, else the wire model id; labels carry both", async () => {
  const models = { model_a: { id: "vendor/one" }, model_b: { id: "vendor/one" }, cap_model: { id: "vendor/cap", family: "captioners" } };
  assert.equal(behaviourFamilyOf(models, "model_a"), "vendor/one");
  assert.equal(behaviourFamilyOf(models, "cap_model"), "captioners");
  assert.equal(behaviourFamilyOf(models, "gone"), "gone");
  await withData(async (storage) => {
    const service = new ModelBehaviourService({
      storage,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { models } as any,
      catalogue: { all: () => [], get: () => undefined, enabledFor: () => [] },
      agentForTimelineKey: agentFor,
    });
    const fam = await service.read(q({ family: true }));
    assert.deepEqual(fam.scorecard.map((row) => [row.group, row.members]), [
      ["vendor/one", ["model_a", "model_b"]],
      ["captioners", ["cap_model"]],
    ]);
    const plain = await service.read(q());
    assert.deepEqual(plain.models, {
      cap_model: { id: "vendor/cap", family: "captioners" },
      model_a: { id: "vendor/one", family: null },
      model_b: { id: "vendor/one", family: null },
    });
    const sel = await service.incidents(q({ family: true, selected: "vendor/one", window: "all" }));
    assert.deepEqual(sel.rows.map((row) => row.sessionId), ["s2", "s1"]);
  });
});

test("incident type filter narrows the walk itself: sparse types are found past many other sessions", async () => {
  await withData(async (storage) => {
    // Newer than s1/s2: sessions the audit judged with nothing fired (an unfired
    // ending row each), and nudged-only sessions, together past the scan cap.
    const n = INCIDENT_SCAN_CAP + 50;
    for (let i = 0; i < n; i++) {
      const id = `x${String(i).padStart(4, "0")}`;
      await addSession(storage, id, { key: KEY_A, type: "default", createdAt: H + 10_000 + i });
      await storage.insertDecisionEvaluation({
        ts: H + 10_000 + i, decision_group: `audit:e${i}`, point: "checks", agent_session_id: id, source: "model",
        verdict_json: JSON.stringify({ fired: [], results: [] }), checkpoint: "ending", branch_no: 0, tool_call_id: `nr${i}`,
        consequence: "observed",
      });
      if (i % 10 === 0) await storage.setAgentSessionContract(id, { outcome: "recovered", nudges: 1, version: 1 });
    }
    const ctx = ctxFor(storage);
    const refusals = readBehaviourIncidents(ctx, q({ window: "all", incidentType: "refusal" }));
    assert.deepEqual(refusals.rows.map((r) => r.sessionId), ["s1"]);
    assert.equal(refusals.nextCursor, null);
    const redos = readBehaviourIncidents(ctx, q({ window: "all", incidentType: "redo" }));
    assert.deepEqual(redos.rows.map((r) => r.sessionId), ["s2", "s1"]);
    const nudges = readBehaviourIncidents(ctx, q({ window: "all", incidentType: "nudge", limit: 100 }));
    assert.equal(nudges.rows.length, Math.ceil(n / 10) + 2);
    assert.ok(nudges.rows.every((r) => r.types.includes("nudge")));
    // Unfiltered: the unfired endings are not incidents, so the list is the same sessions.
    const all = readBehaviourIncidents(ctx, q({ window: "all", limit: 100 }));
    assert.deepEqual(all.rows.map((r) => r.sessionId), nudges.rows.map((r) => r.sessionId));
    assert.equal(readBehaviourIncidents(ctx, q({ window: "all", incidentType: "ending" })).rows.length, 0);
    await addJudgedRows(storage);
    const endings = readBehaviourIncidents(ctx, q({ window: "all", incidentType: "ending" }));
    assert.deepEqual(endings.rows.map((r) => [r.sessionId, r.types.includes("ending")]), [["s1", true]]);
    // The same filter over HTTP (the console's query string).
    const server = createObservabilityServer({
      config: { enabled: true, bind: "127.0.0.1", port: 0 },
      storage,
      factory: {} as never,
      sessions: new SessionManager(),
      workspaceRoot: "/tmp",
      logger: silentLogger,
      modelBehaviour: { read: async (query) => readModelBehaviour(ctx, query), incidents: async (query) => readBehaviourIncidents(ctx, query) },
    });
    await server.start();
    try {
      const base = `http://127.0.0.1:${server.address()}`;
      const body = (await (await fetch(`${base}/api/models/behaviour?window=all&type=refusal`)).json()) as { incidents: { rows: Array<{ sessionId: string }> } };
      assert.deepEqual(body.incidents.rows.map((r) => r.sessionId), ["s1"]);
      const unfiltered = (await (await fetch(`${base}/api/models/behaviour?window=all`)).json()) as { incidents: { rows: unknown[] } };
      assert.equal(unfiltered.incidents.rows.length, 25);
    } finally {
      await server.stop();
    }
  });
});

test("rollup version: a bump re-marks computed hours once", async () => {
  await withData(async (storage) => {
    const pending = () => storage.read((db) => db.prepare(`select count(*) as n from model_behaviour_dirty_hours`).get() as { n: number }).n;
    assert.equal(pending(), 0);
    assert.equal(await storage.write((db) => ensureRollupVersion(db)), true);
    assert.equal(pending(), 1);
    assert.equal(await storage.write((db) => ensureRollupVersion(db)), false);
    const stored = storage.read((db) => db.prepare(`select value from metadata where key = 'model_behaviour_rollup_version'`).get() as { value: string });
    assert.equal(stored.value, String(MODEL_BEHAVIOUR_ROLLUP_VERSION));
  });
});
