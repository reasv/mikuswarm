/**
 * The calibration tool's memory point (`--point memory`): sampling memory
 * decision rows with a passage state (filter-only and unreadable rows skipped
 * and counted, agent filter), the labelling call (the point's statement, the
 * fixed reason enum), the member scorer (one request with the point's
 * questions), the threshold table and the calibration key, the recall ceiling
 * over retrieval builds (state from the build's decision group, block text from
 * memory_chunks, per-stage counts, judged and kept shares), and the privacy
 * guarantee: no state, passage or block text in any report.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { openReadOnly, reportJson, type Labeller, type LabelRequest } from "../src/audit/calibration.js";
import {
  createMemoryScorer,
  formatMemoryReport,
  formatRecallCeilingReport,
  memoryLabelRequest,
  MEMORY_LABEL_REASONS,
  parseMemoryState,
  recallItemsOf,
  runMemoryCalibration,
  runRecallCeiling,
  sampleMemoryDecisions,
  sampleRecallBuilds,
  type MemoryScorer,
  type MemoryState,
} from "../src/audit/memory-calibration.js";
import { DecisionClient } from "../src/decisions/index.js";
import { Storage } from "../src/storage/index.js";

const SECRET = "ZQX-PRIVATE-MARKER";

function passageState(passageText: string, opts: { request?: boolean; participants?: string[] } = {}): MemoryState {
  return {
    conversation: [
      { from: "alice", text: `${SECRET} earlier chat` },
      { from: "bot", text: `${SECRET} reply`, self: true },
    ],
    ...(opts.request === false ? {} : { request: { from: "alice", text: `${SECRET} the request` } }),
    participants: opts.participants ?? ["alice"],
    entry: { date: "2026-01-02", room: "general", text: passageText },
  };
}

/** Passage markers: ZZREL = relevant, ZZNO = not, ZZUNS = unsure; pNN = the member's probability. */
const THRESHOLD_ITEMS = [
  `${SECRET} ZZREL p90`,
  `${SECRET} ZZREL p75`,
  `${SECRET} ZZREL p40`,
  `${SECRET} ZZNO p80`,
  `${SECRET} ZZNO p20`,
  `${SECRET} ZZNO p10`,
];

/** A recall-ceiling build: items as [hash, stage, judged relevant?, text marker or null (text gone)]. */
type BuildSpec = { id: string; group: string | null; session: string; items: Array<[string, string, number | undefined, string | null]> };
const BUILDS: BuildSpec[] = [
  // Relevant items dropped by the judge and cut by the re-ranker; the kept one is not relevant.
  { id: "b1", group: "g1", session: "s1", items: [
    ["h1", "kept", 0.9, "ZZNO"], ["h2", "dropped", 0.3, "ZZREL"], ["h3", "cut_rerank", undefined, "ZZREL"],
    ["h4", "not_selected", undefined, "ZZNO"], ["hx", "cut_late", undefined, null],
  ] },
  // Nothing relevant.
  { id: "b2", group: "g2", session: "s2", items: [["h5", "dropped", 0.2, "ZZNO"], ["h6", "cut_late", undefined, "ZZNO"]] },
  // A relevant kept item; a hidden unsure one.
  { id: "b3", group: "g3", session: "s3", items: [["h7", "kept", 0.95, "ZZREL"], ["h8", "hidden", 0.8, "ZZUNS"]] },
  // Relevant only below the judge (cut by late interaction).
  { id: "b4", group: "g4", session: "s4", items: [["h9", "cut_late", undefined, "ZZREL"], ["h10", "dropped", 0.1, "ZZNO"]] },
  // No decision group (unjudged build): no state.
  { id: "b5", group: null, session: "s5", items: [["h11", "kept", undefined, "ZZREL"]] },
  // A report with no items.
  { id: "b6", group: "g6", session: "s6", items: [] },
  // A group with only a filter-only row: no state.
  { id: "b7", group: "g7", session: "s7", items: [["h12", "kept", 0.9, "ZZREL"]] },
];

async function withDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-calibration-test-"));
  const dbPath = path.join(dir, "history.db");
  try {
    const storage = await Storage.open({ databasePath: dbPath });
    let ts = 1_000;
    const row = (over: Record<string, unknown>) =>
      storage.insertDecisionEvaluation({ ts: ts++, decision_group: "gx", point: "memory", source: "model", agent: "miku", ...over } as never);
    // Threshold population: six passage rows with recorded answers.
    for (const [i, text] of THRESHOLD_ITEMS.entries()) {
      await row({
        decision_group: `t${i}`, agent_session_id: `ts${i}`,
        state_json: JSON.stringify(passageState(text)),
        answers_json: JSON.stringify({ relevant: { type: "noul", noul: 0.5 + i * 0.01 }, about_participant: { type: "noul", noul: 0.1 } }),
      });
    }
    // Skipped: two filter-only rows, a state cut by the row cap, another point, a row without a state.
    await row({ state_json: JSON.stringify({ entry: { date: "2026-01-01", text: `${SECRET} filter entry` } }) });
    await row({ state_json: JSON.stringify({ entry: { date: "2026-01-01", text: `${SECRET} filter entry 2` } }) });
    await row({ state_json: `{"conversation":[{"from":"a","text":"${SECRET}…[truncated]` });
    await row({ point: "checks", state_json: JSON.stringify(passageState(`${SECRET} other point`)) });
    await row({ state_json: null, source: "heuristic", reason: "disabled" });
    // Another agent's row (excluded by the agent filter).
    await row({ agent: "chen", state_json: JSON.stringify(passageState(`${SECRET} ZZREL p99`)) });
    // The builds' decision rows: the state's passage is one of the judged items; the conversation is the build's.
    for (const b of BUILDS) {
      if (!b.group) continue;
      if (b.group === "g7") {
        await row({ decision_group: b.group, agent_session_id: b.session, state_json: JSON.stringify({ entry: { date: "2026-01-01", text: SECRET } }) });
        continue;
      }
      // A filter-only row first in the group: the passage row after it is the one used.
      await row({ decision_group: b.group, agent_session_id: b.session, state_json: JSON.stringify({ entry: { date: "2026-01-01", text: SECRET } }) });
      await row({ decision_group: b.group, agent_session_id: b.session, state_json: JSON.stringify(passageState(`${SECRET} judged passage`, { request: b.id !== "b2" })) });
    }
    await storage.waitForIdle();
    storage.close();

    // Builds and chunks, written directly (the store's own writers are tested elsewhere).
    const db = new Database(dbPath);
    const insertBuild = db.prepare(
      `insert into memory_retrievals (id, agent_session_id, agent, timeline_key, ts, source, decision_group,
         candidates, judged, kept, hidden, tokens, ms, report_json)
       values (?, ?, 'miku', 'tl', ?, ?, ?, ?, 0, 0, 0, 0, 1, ?)`,
    );
    const insertChunk = db.prepare(
      `insert into memory_chunks (agent, id, path, ordinal, start_line, end_line, room, entry_ts, text, token_count, content_hash, indexed_at)
       values ('miku', ?, 'memory/2026-01-02.md', 0, 1, 3, 'general', 1767312000000, ?, 10, ?, 1)`,
    );
    for (const [n, b] of BUILDS.entries()) {
      const items = b.items.map(([hash, stage, relevant]) => ({
        contentHash: hash, citation: `memory/2026-01-02.md#L1-3`, lanes: ["trigger"], hybrid: 0.5, presence: false, stage,
        ...(relevant !== undefined ? { relevant, aboutParticipant: 0.1 } : {}),
      }));
      insertBuild.run(b.id, b.session, 5_000 + n, b.group ? "model" : "unjudged", b.group, items.length, JSON.stringify({ source: "model", items }));
      for (const [hash, , , marker] of b.items) {
        if (marker !== null) insertChunk.run(`c-${hash}`, `${SECRET} block ${marker}`, hash);
      }
    }
    // A build without a report.
    db.prepare(
      `insert into memory_retrievals (id, agent_session_id, agent, timeline_key, ts, source, candidates, judged, kept, hidden, tokens, ms)
       values ('b8', 's8', 'miku', 'tl', 9000, 'none', 0, 0, 0, 0, 0, 1)`,
    ).run();
    db.close();
    await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fake labeller: the label from the marker in the item's passage text. */
function fakeLabeller(prompts: LabelRequest[]): Labeller {
  return async (request) => {
    prompts.push(request);
    const passage = /"entry":\{[^}]*"text":"([^"]*)"/.exec(request.prompt)?.[1] ?? "";
    const [label, reason] = passage.includes("ZZREL")
      ? ["true", "same_topic_history"]
      : passage.includes("ZZUNS")
        ? ["unsure", "unsure"]
        : ["false", "unrelated"];
    return { role: "assistant", content: [{ type: "toolCall", id: "t", name: "submit_label", arguments: { label, reason } }] };
  };
}

/** A fake scorer: the probability from the passage's pNN marker. */
const fakeScorer: MemoryScorer = async (state) => {
  const m = /p(\d\d)/.exec(state.entry.text);
  return m ? Number(m[1]) / 100 : undefined;
};

test("parseMemoryState: passage, filter-only, unreadable", () => {
  const state = passageState("x");
  assert.deepEqual(parseMemoryState(JSON.stringify(state)), { kind: "passage", state });
  assert.deepEqual(parseMemoryState(JSON.stringify({ entry: { date: "d", text: "t" } })), { kind: "filter" });
  assert.equal(parseMemoryState(`{"passage":{"text":"…[truncated]`).kind, "unreadable");
  assert.equal(parseMemoryState(null).kind, "unreadable");
  assert.equal(parseMemoryState(JSON.stringify({ conversation: [], passage: { text: "t" } })).kind, "unreadable", "no date");
  // Rows written before the state named the block `entry` still parse.
  const { entry, ...rest } = state;
  assert.deepEqual(parseMemoryState(JSON.stringify({ ...rest, passage: entry })), { kind: "passage", state });
  const proactive = passageState("x", { request: false, participants: [] });
  assert.deepEqual(parseMemoryState(JSON.stringify(proactive)), { kind: "passage", state: proactive });
});

test("sampleMemoryDecisions: passage rows only, filter-only and unreadable rows counted, agent filter, seeded", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const all = sampleMemoryDecisions(db, { sample: 100, seed: 1 });
      // 6 threshold rows + 1 other-agent row + 5 build passage rows (g1-g4, g6); 2 + 6 filter-only rows; 1 unreadable.
      assert.equal(all.eligible, 12);
      assert.equal(all.filterOnly, 8);
      assert.equal(all.unreadable, 1);
      assert.equal(all.rows, 21);
      assert.ok(all.items.every((i) => /^memory:\d+$/.test(i.id)));
      const miku = sampleMemoryDecisions(db, { sample: 100, seed: 1, agent: "miku" });
      assert.equal(miku.eligible, 11);
      const chen = sampleMemoryDecisions(db, { sample: 100, seed: 1, agent: "chen" });
      assert.equal(chen.eligible, 1);
      // Reservoir: seeded, bounded.
      const a = sampleMemoryDecisions(db, { sample: 3, seed: 7 });
      const b = sampleMemoryDecisions(db, { sample: 3, seed: 7 });
      assert.equal(a.items.length, 3);
      assert.deepEqual(a.items.map((i) => i.id), b.items.map((i) => i.id));
      assert.equal(a.eligible, 12);
      // The recorded probability is the row's `relevant` answer.
      assert.equal(all.items[0]!.recorded, 0.5);
    } finally {
      db.close();
    }
  });
});

test("memoryLabelRequest: the point's statement, the fixed reasons, the state as JSON", () => {
  const req = memoryLabelRequest("memory:1", passageState("passage text"));
  assert.equal(req.tool.name, "submit_label");
  assert.deepEqual(req.reasons, MEMORY_LABEL_REASONS);
  assert.deepEqual(req.tool.parameters.properties.reason.enum, [...MEMORY_LABEL_REASONS]);
  assert.match(req.prompt, /would help respond to `request` in this `conversation`/);
  assert.match(req.prompt, /Do not reproduce/);
  assert.match(req.systemPrompt, /Never reproduce/);
  assert.ok(req.prompt.includes(JSON.stringify(passageState("passage text"))));
  // Proactive: the conversation stands in for the request.
  const proactive = memoryLabelRequest("memory:2", passageState("p", { request: false }));
  assert.match(proactive.prompt, /would help respond in this `conversation`/);
});

test("createMemoryScorer: one request to the member with the point's questions over the stored state", async () => {
  const bodies: any[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { noul: id === "relevant" ? 0.66 : 0.2 };
    return new Response(JSON.stringify({ model: "vendor/decider-1", answers, usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const member = (id: string): any => ({
    id, provider: "openrouter", api: "system-one", endpoint: `https://${id}.example/decisions`, api_key: "k",
    input_modalities: ["text"], max_tokens: 1, context_window: 32000,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    ...(id === "decider" ? { fallback: ["backup"] } : {}),
  });
  const client = new DecisionClient({ models: { decider: member("decider"), backup: member("backup") } as any, fetchImpl });
  const score = createMemoryScorer({ client, memberKey: "decider" });
  const state = passageState("passage");
  assert.equal(await score(state), 0.66);
  assert.equal(bodies.length, 1, "exactly one request");
  assert.ok(urls[0]!.startsWith("https://decider.example/"));
  assert.deepEqual(Object.keys(bodies[0].questions), ["relevant", "about_participant"]);
  assert.deepEqual(bodies[0].state, state, "the stored state, as is");
  // Without participants: only `relevant`.
  bodies.length = 0;
  await score(passageState("p", { participants: [] }));
  assert.deepEqual(Object.keys(bodies[0].questions), ["relevant"]);
});

test("runMemoryCalibration: threshold table, suggestion, calibration key; never state text", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const prompts: LabelRequest[] = [];
      const sampled = sampleMemoryDecisions(db, { sample: 100, seed: 1, agent: "miku" });
      // Only the six threshold items (the build rows carry no probability marker: unscored).
      const report = await runMemoryCalibration({
        db, sample: 100, seed: 1,
        sampled: { ...sampled, items: sampled.items.filter((i) => /p\d\d/.test(i.state.entry.text)) },
        configuredThreshold: 0.7,
        thresholds: [0.5, 0.85],
        targetPrecision: 0.9,
        labeller: fakeLabeller(prompts),
        scorer: fakeScorer,
        labellerInfo: { model: "labeller", host: "labeller.example" },
        memberInfo: { model: "decider", host: "decider.example" },
      });
      assert.equal(prompts.length, 6);
      assert.ok(prompts.every((p) => p.prompt.includes(SECRET)), "the labeller sees the state");
      assert.deepEqual(report.counts, { items: 6, true: 3, false: 3, unsure: 0, invalid: 0, unscored: 0 });
      assert.deepEqual(report.population, { rows: 20, eligible: 11, filterOnly: 8, unreadable: 1 });
      const at = (t: number) => report.thresholds.find((r) => r.threshold === t)!;
      assert.deepEqual([at(0.5).tp, at(0.5).fp, at(0.5).fn, at(0.5).tn], [2, 1, 1, 2]);
      assert.deepEqual([at(0.7).tp, at(0.7).fp, at(0.7).fn, at(0.7).tn], [2, 1, 1, 2]);
      assert.deepEqual([at(0.85).tp, at(0.85).fp, at(0.85).fn, at(0.85).tn], [1, 0, 2, 3]);
      assert.equal(at(0.85).precision, 1);
      assert.equal(report.suggested.atPrecisionTarget?.threshold, 0.85);
      assert.equal(report.suggested.configured.threshold, 0.7);
      assert.equal(report.histogram.reduce((n, b) => n + b.positive + b.negative, 0), 6);
      const text = formatMemoryReport(report);
      assert.match(text, /set: \[decisions\.calibration\.decider\] "memory\.relevance_threshold" = 0\.850/);
      assert.ok(!text.includes(SECRET) && !text.includes("ZZREL") && !text.includes("ZZNO"), "no state text in the report");
      const json = reportJson(report);
      assert.ok(!json.includes(SECRET) && !json.includes("ZZREL"), "no state text in the JSON report");
    } finally {
      db.close();
    }
  });
});

test("sampleRecallBuilds: builds with items and a recoverable state", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const s = sampleRecallBuilds(db, { sample: 100, seed: 1 });
      assert.equal(s.scanned, 7, "b8 has no report");
      assert.equal(s.noItems, 1, "b6");
      assert.equal(s.noState, 2, "b5 (no group), b7 (filter-only group)");
      assert.equal(s.eligible, 4);
      assert.deepEqual(s.builds.map((b) => b.id).sort(), ["b1", "b2", "b3", "b4"]);
      const b2 = s.builds.find((b) => b.id === "b2")!;
      assert.equal(b2.state.request, undefined, "the build's own conversation state");
      assert.equal(sampleRecallBuilds(db, { sample: 100, seed: 1, agent: "other" }).scanned, 0);
      // The per-build cap keeps judged and kept items first.
      const b1 = s.builds.find((b) => b.id === "b1")!;
      const capped = recallItemsOf(b1, 2);
      assert.deepEqual(capped.items.map((i) => i.contentHash), ["h1", "h2"]);
      assert.equal(capped.capped, 3);
    } finally {
      db.close();
    }
  });
});

test("runRecallCeiling: ceiling, judged and kept shares, per-stage counts; never block text", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const prompts: LabelRequest[] = [];
      const report = await runRecallCeiling({
        db, sample: 100, seed: 1,
        labeller: fakeLabeller(prompts),
        labellerInfo: { model: "labeller", host: "labeller.example" },
      });
      assert.equal(report.builds, 4);
      assert.equal(report.usableBuilds, 4);
      // b1: 5 items, one with its text gone; b2: 2; b3: 2; b4: 2.
      assert.deepEqual(report.items, { listed: 11, capped: 0, missingText: 1, labelled: 10, true: 4, false: 5, unsure: 1, invalid: 0 });
      assert.equal(prompts.length, 10);
      // Labelled against the build's conversation, with the block's text as the passage.
      assert.ok(prompts.every((p) => p.prompt.includes(`${SECRET} earlier chat`) && /"entry":\{"date":"2026-01-02","room":"general","text":"ZQX-PRIVATE-MARKER block ZZ/.test(p.prompt)));
      // Ceiling: b1, b3, b4; reached the judge: b1 (h2), b3 (h7); kept: b3.
      assert.deepEqual(report.ceiling, { builds: 3, share: 0.75 });
      assert.deepEqual(report.judged, { builds: 2, share: 0.5 });
      assert.deepEqual(report.kept, { builds: 1, share: 0.25 });
      const stage = (s: string) => report.stages.find((x) => x.stage === s);
      assert.deepEqual(stage("cut_late"), { stage: "cut_late", items: 2, true: 1, false: 1, unsure: 0, invalid: 0 });
      assert.deepEqual(stage("cut_rerank"), { stage: "cut_rerank", items: 1, true: 1, false: 0, unsure: 0, invalid: 0 });
      assert.deepEqual(stage("dropped"), { stage: "dropped", items: 3, true: 1, false: 2, unsure: 0, invalid: 0 });
      assert.deepEqual(stage("hidden"), { stage: "hidden", items: 1, true: 0, false: 0, unsure: 1, invalid: 0 });
      assert.deepEqual(stage("kept"), { stage: "kept", items: 2, true: 1, false: 1, unsure: 0, invalid: 0 });
      assert.deepEqual(stage("not_selected"), { stage: "not_selected", items: 1, true: 0, false: 1, unsure: 0, invalid: 0 });
      assert.deepEqual(report.stages.map((s) => s.stage), ["cut_late", "cut_rerank", "hidden", "dropped", "not_selected", "kept"]);
      const b1 = report.buildRows.find((b) => b.id === "b1")!;
      assert.deepEqual(
        { labelled: b1.labelled, missingText: b1.missingText, relevant: b1.relevant, relevantJudged: b1.relevantJudged, relevantKept: b1.relevantKept },
        { labelled: 4, missingText: 1, relevant: 2, relevantJudged: 1, relevantKept: 0 },
      );
      const text = formatRecallCeilingReport(report);
      assert.match(text, /ceiling \(a relevant item anywhere in the recall set\): 3\/4 75\.0%/);
      assert.match(text, /kept \(a relevant item in the memory block\): +1\/4 25\.0%/);
      for (const out of [text, reportJson(report)]) {
        assert.ok(!out.includes(SECRET) && !out.includes("ZZREL") && !out.includes("ZZNO"), "no state or block text");
      }
      // The per-build cap applies.
      const capped = await runRecallCeiling({
        db, sample: 100, seed: 1, perBuild: 1,
        labeller: fakeLabeller([]),
        labellerInfo: { model: "labeller", host: "labeller.example" },
      });
      assert.equal(capped.items.listed, 4);
      assert.equal(capped.items.capped, 7);
    } finally {
      db.close();
    }
  });
});
