/**
 * The calibration tool's judged memory-filter mode (`--point filter`): diary
 * blocks rebuilt from memory_chunks (sub-split windows stitched, the live
 * block hash), time scope and pre-gate exclusions, stratified sampling
 * (every enriched block plus a seeded sample of the rest), the population
 * reweighting maths, the live filter question as the judge asks it (head
 * only, or the chain), the side-file filter definition, and the privacy
 * guarantee: no block text in any report.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";
import { endpointOverrideVars, openReadOnly, type Labeller, type LabelRequest } from "../src/audit/calibration.js";
import {
  calibrationFilters,
  createFilterJudge,
  filterLabelRequest,
  filterReportJson,
  formatFilterReport,
  hiddenTable,
  joinWindows,
  loadDiaryBlocks,
  newJudgeUsage,
  populationThresholds,
  runFilterCalibration,
  sampleFilterBlocks,
  stratumSummaries,
  type FilterJudge,
  type FilterRow,
} from "../src/audit/filter-calibration.js";
import { DecisionClient } from "../src/decisions/index.js";
import { resolveMemoryFilters } from "../src/retrieval/filters/config.js";
import { cleanBlockText } from "../src/retrieval/excerpt.js";
import { Storage } from "../src/storage/index.js";

const SECRET = "ZQX-PRIVATE-MARKER";
const header = (day: string) => `## ${day} 10:00 → ${day} 11:00 · UTC · general`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const FILTER = resolveMemoryFilters({
  refusals: {
    description: "The entry describes the assistant declining a request.",
    examples: { hide: ["I said no to writing that"], keep: ["I helped with the essay"] },
    threshold: 0.8,
    after: "2026-01-01",
  },
}).filters[0]!;

/** The oversized block, indexed as two overlapping windows. */
const OVERSIZED = `${header("2026-01-03")}\n${SECRET} line one, refused politely ZZYES p90\n${SECRET} line two, more text\n${SECRET} line three\n`;

/** Markers: ZZYES = matches, ZZNO = does not, ZZUNS = unsure; pNN = the judge's probability. */
async function withDb(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "filter-calibration-test-"));
  const dbPath = path.join(dir, "history.db");
  try {
    const storage = await Storage.open({ databasePath: dbPath });
    storage.close();
    const db = new Database(dbPath);
    const insert = db.prepare(
      `insert into memory_chunks (agent, id, path, ordinal, start_line, end_line, room, entry_ts, text, token_count, content_hash, indexed_at)
       values (?, ?, ?, ?, 1, 3, 'general', 0, ?, 10, ?, 1)`,
    );
    let n = 0;
    const chunk = (agent: string, file: string, ordinal: number, text: string) =>
      insert.run(agent, `c${n++}`, file, ordinal, text, sha(text));
    // Two blocks of one file: one enriched ("declined"), one not.
    chunk("miku", "memory/2026-01-02.md", 0, `${header("2026-01-02")}\n${SECRET} I declined the request ZZYES p85\n`);
    chunk("miku", "memory/2026-01-02.md", 1, `${header("2026-01-02")}\n${SECRET} we talked about trains ZZNO p10\n\n`);
    // The oversized block: windows overlapping by 20 characters.
    chunk("miku", "memory/2026-01-03.md", 0, OVERSIZED.slice(0, 80));
    chunk("miku", "memory/2026-01-03.md", 1, OVERSIZED.slice(60));
    // Ten plain blocks.
    for (let i = 0; i < 10; i++) {
      const day = `2026-01-${String(10 + i).padStart(2, "0")}`;
      chunk("miku", `memory/${day}.md`, 0, `${header(day)}\n${SECRET} plain note ${i} ${i === 3 ? "ZZUNS" : "ZZNO"} p${i === 5 ? 92 : 20}\n`);
    }
    // Before the filter's time scope (matches the enrichment): never judged.
    chunk("miku", "memory/2025-12-01.md", 0, `${header("2025-12-01")}\n${SECRET} refused something old ZZYES p99\n`);
    // Another agent's block.
    chunk("chen", "memory/2026-01-02.md", 0, `${header("2026-01-02")}\n${SECRET} chen declined ZZYES p99\n`);
    db.close();
    await fn(dbPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ENRICH = { keywords: ["DECLIN"], patterns: [/refus/i] };

test("joinWindows: drops the overlap of consecutive windows", () => {
  assert.equal(joinWindows("abcdef", "defgh"), "abcdefgh");
  assert.equal(joinWindows("abc", "xyz"), "abcxyz");
  assert.equal(joinWindows(OVERSIZED.slice(0, 80), OVERSIZED.slice(60)), OVERSIZED);
});

test("loadDiaryBlocks: the agent's blocks, sub-split windows stitched to the live block hash", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const loaded = loadDiaryBlocks(db, "miku");
      assert.equal(loaded.chunks, 15);
      assert.equal(loaded.stitched, 1);
      assert.equal(loaded.blocks.length, 14);
      const big = loaded.blocks.find((b) => b.path === "memory/2026-01-03.md")!;
      assert.equal(big.text, OVERSIZED);
      assert.equal(big.contentHash, sha(OVERSIZED), "the hash the filter surfaces compute for the whole block");
      assert.equal(big.room, "general");
      assert.equal(big.entryTs, Date.parse("2026-01-03T11:00:00Z"), "the header's end time");
      assert.ok(loaded.blocks.every((b) => !b.text.includes("chen declined")), "only the agent's blocks");
    } finally {
      db.close();
    }
  });
});

test("sampleFilterBlocks: every enriched block, a seeded sample of the rest, scope and pre-gate excluded", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const loaded = loadDiaryBlocks(db, "miku");
      const s = sampleFilterBlocks(loaded, FILTER, { enrich: ENRICH, sample: 5, seed: 7 });
      assert.equal(s.outOfScope, 1, "the 2025 block is before `after`");
      assert.equal(s.preGateMiss, 0);
      assert.equal(s.eligible, 13);
      assert.deepEqual(s.population, { enriched: 2, rest: 11 });
      assert.deepEqual(s.sampled, { enriched: 2, rest: 5 });
      const enriched = s.items.filter((i) => i.stratum === "enriched").map((i) => i.block.text);
      assert.ok(enriched.some((t) => t.includes("declined")) && enriched.some((t) => t.includes("refused")));
      assert.ok(s.items.filter((i) => i.stratum === "rest").every((i) => !/declin|refus/i.test(i.block.text)));
      assert.ok(s.items.every((i) => /^block:[0-9a-f]{16}$/.test(i.id)));
      // Seeded: the same seed draws the same rest sample.
      const again = sampleFilterBlocks(loaded, FILTER, { enrich: ENRICH, sample: 5, seed: 7 });
      assert.deepEqual(again.items.map((i) => i.id), s.items.map((i) => i.id));
      // A rest sample larger than the stratum takes all of it; enrichMax caps the enriched stratum.
      const all = sampleFilterBlocks(loaded, FILTER, { enrich: ENRICH, sample: 500, seed: 1, enrichMax: 1 });
      assert.deepEqual(all.sampled, { enriched: 1, rest: 11 });
      assert.deepEqual(all.population, { enriched: 2, rest: 11 });
      // No enrichment: everything is "rest".
      const none = sampleFilterBlocks(loaded, FILTER, { enrich: { keywords: [], patterns: [] }, sample: 3, seed: 1 });
      assert.deepEqual(none.population, { enriched: 0, rest: 13 });
      // A judged filter with a keyword pre-gate judges only the blocks that match it.
      const gated = resolveMemoryFilters({ g: { description: "d", keywords: ["plain note"] } }).filters[0]!;
      const g = sampleFilterBlocks(loaded, gated, { enrich: ENRICH, sample: 50, seed: 1 });
      assert.equal(g.eligible, 10);
      assert.equal(g.preGateMiss, 4);
      assert.equal(g.outOfScope, 0);
    } finally {
      db.close();
    }
  });
});

test("population reweighting: stratum weights, weighted precision/recall/F1, hidden estimates", () => {
  const row = (stratum: "enriched" | "rest", label: FilterRow["label"], probability: number | null): FilterRow => ({
    id: `block:${Math.random().toString(16).slice(2, 10)}`, stratum, label, reason: null, probability,
  });
  const rows: FilterRow[] = [
    row("enriched", "true", 0.9), row("enriched", "true", 0.7), row("enriched", "false", 0.85), row("enriched", "unsure", 0.95),
    row("rest", "true", 0.95), row("rest", "false", 0.1), row("rest", "false", 0.2), row("rest", "false", 0.9), row("rest", "invalid", 0.3),
  ];
  const strata = stratumSummaries(rows, { enriched: 4, rest: 100 });
  assert.equal(strata.enriched.weight, 4 / 3, "population / usable (true or false, scored)");
  assert.equal(strata.rest.weight, 25);
  assert.equal(strata.enriched.hiddenWeight, 1, "population / scored (any label)");
  assert.equal(strata.rest.hiddenWeight, 20);
  assert.equal(strata.enriched.unsure, 1);
  assert.equal(strata.rest.invalid, 1);

  const [t] = populationThresholds(rows, strata, [0.8]);
  // enriched: tp 0.9, fn 0.7, fp 0.85 (x 4/3); rest: tp 0.95, fp 0.9, tn 2 (x 25).
  assert.deepEqual([t!.tp, t!.fp, t!.fn, t!.tn], [2, 2, 1, 2]);
  const wtp = 4 / 3 + 25;
  const wfp = 4 / 3 + 25;
  const wfn = 4 / 3;
  assert.equal(t!.precision, Math.round((wtp / (wtp + wfp)) * 1000) / 1000);
  assert.equal(t!.recall, Math.round((wtp / (wtp + wfn)) * 1000) / 1000);
  assert.equal(t!.f1, Math.round(((2 * wtp) / (2 * wtp + wfp + wfn)) * 1000) / 1000);
  // Unweighted, the enriched stratum alone would give recall 0.5: the estimate is not that.
  assert.notEqual(t!.recall, 0.5);

  const [h] = hiddenTable(rows, strata, [0.8]);
  assert.deepEqual(h!.sampled, { enriched: 3, rest: 2 });
  assert.deepEqual(h!.estimated, { enriched: 3, rest: 40 });
  assert.equal(h!.population, 43);
  assert.equal(h!.share, Math.round((43 / 104) * 1000) / 1000);
});

test("filterLabelRequest: the live question's wording and examples, the enums, the cleaned entry", () => {
  const block = {
    contentHash: "a".repeat(64), text: `${header("2026-01-02")}\nbody text`, path: "memory/2026-01-02.md",
    startLine: 1, endLine: 2, room: "general", entryTs: Date.parse("2026-01-02T11:00:00Z"),
  };
  const req = filterLabelRequest("block:1", FILTER, block);
  assert.match(req.prompt, /`entry` matches: The entry describes the assistant declining a request\./);
  assert.ok(req.prompt.includes(JSON.stringify("I said no to writing that")));
  assert.ok(req.prompt.includes(JSON.stringify("I helped with the essay")));
  assert.ok(req.prompt.includes(JSON.stringify({ entry: { date: "2026-01-02", room: "general", text: "body text" } })));
  assert.deepEqual(req.tool.parameters.properties.label.enum, ["true", "false", "unsure"]);
  assert.deepEqual([...req.reasons], ["matches_definition", "near_miss", "does_not_match", "insufficient_context"]);
});

function member(id: string): any {
  return {
    id, provider: "openrouter", api: "system-one", endpoint: `https://${id}.example/decisions`, api_key: "k",
    input_modalities: ["text"], max_tokens: 1, context_window: 32000,
    cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    ...(id === "decider" ? { fallback: ["backup"] } : {}),
  };
}

test("createFilterJudge: the live filter question, head only by default, the chain with --chain", async () => {
  const bodies: any[] = [];
  const urls: string[] = [];
  let headDown = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(String(url));
    if (headDown && String(url).includes("decider")) return new Response("down", { status: 503 });
    const body = JSON.parse(String(init.body));
    bodies.push(body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { noul: 0.83 };
    return new Response(JSON.stringify({ model: "vendor/decider-1", answers, usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new DecisionClient({ models: { decider: member("decider"), backup: member("backup") } as any, fetchImpl });
  const block = {
    contentHash: "b".repeat(64), text: `${header("2026-01-02")}\n${SECRET} body`, path: "memory/2026-01-02.md",
    startLine: 1, endLine: 2, room: "general", entryTs: Date.parse("2026-01-02T11:00:00Z"),
  };
  const settings = { timeoutMs: 5000, stateMaxTokens: 8000, minStateTokens: 1 };
  const usage = newJudgeUsage();
  const judge = createFilterJudge({ client, chainHead: "decider", filter: FILTER, settings, usage });
  assert.equal(await judge(block), 0.83);
  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(bodies[0].questions), ["filter__refusals"]);
  assert.equal(bodies[0].questions.filter__refusals.instructions, "`entry` matches: The entry describes the assistant declining a request.");
  assert.deepEqual(bodies[0].state, { entry: { date: "2026-01-02", room: "general", text: cleanBlockText(block.text).lines.join("\n") } });
  assert.equal(usage.calls, 1);
  assert.equal(usage.billedAttempts, 1);
  assert.equal(usage.inputTokens, 10);
  assert.deepEqual(usage.servedBy, { decider: 1 });

  // Head down: head only never reaches the fallback; --chain lets it answer.
  headDown = true;
  urls.length = 0;
  const p = await judge(block).catch(() => undefined);
  assert.equal(p, undefined);
  assert.ok(urls.every((u) => u.includes("decider")), "head only: no fallback request");
  const chained = createFilterJudge({ client, chainHead: "decider", filter: FILTER, settings, chain: true, usage });
  assert.equal(await chained(block), 0.83);
  assert.ok(urls.some((u) => u.includes("backup")));
  assert.equal(usage.servedBy["backup"], 1);
});

test("runFilterCalibration: strata, population estimates, usage; no block text in text or JSON output", async () => {
  await withDb(async (dbPath) => {
    const db = openReadOnly(dbPath);
    try {
      const sample = sampleFilterBlocks(loadDiaryBlocks(db, "miku"), FILTER, { enrich: ENRICH, sample: 11, seed: 3 });
      const requests: LabelRequest[] = [];
      const labeller: Labeller = async (req) => {
        requests.push(req);
        const label = req.prompt.includes("ZZYES") ? "true" : req.prompt.includes("ZZUNS") ? "unsure" : "false";
        const reason = label === "true" ? "matches_definition" : label === "unsure" ? "insufficient_context" : "does_not_match";
        return {
          content: [{ type: "toolCall", name: "submit_label", arguments: { label, reason } }],
          usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
        };
      };
      const judgeUsage = newJudgeUsage();
      const judge: FilterJudge = async (block) => {
        judgeUsage.calls += 1;
        judgeUsage.costUsd += 0.0005;
        const m = /p(\d\d)/.exec(block.text);
        return m ? Number(m[1]) / 100 : undefined;
      };
      const report = await runFilterCalibration({
        sample,
        filter: FILTER,
        agent: "miku",
        enrichment: { keywords: 1, patterns: 1, max: null },
        labeller,
        judge,
        judgeUsage,
        labellerInfo: { model: "labeller", host: "labeller.example" },
        judgeInfo: { head: "decider", host: "decider.example", chain: false, members: ["decider"] },
      });
      assert.equal(requests.length, 13, "one labeller call per block");
      assert.equal(report.counts.items, 13);
      assert.deepEqual([report.strata.enriched.population, report.strata.rest.population], [2, 11]);
      assert.equal(report.strata.enriched.true, 2);
      assert.equal(report.strata.rest.unsure, 1);
      assert.equal(report.configuredThreshold, 0.8);
      assert.equal(report.calibrationKey.key, "memory.filter.refusals");
      assert.equal(report.usage.labeller.calls, 13);
      assert.equal(report.usage.labeller.inputTokens, 1300);
      assert.equal(report.usage.labeller.costUsd, 0.013);
      assert.equal(report.usage.judge.calls, 13);
      // The rest is sampled fully: its weight is population / usable (the unsure row is unusable),
      // and the hidden estimate (population / scored) equals the count.
      assert.equal(report.strata.rest.weight, 1.1);
      assert.equal(report.strata.rest.hiddenWeight, 1);
      const at08 = report.hidden.find((h) => h.threshold === 0.8)!;
      assert.deepEqual(at08.sampled, { enriched: 2, rest: 1 });
      assert.equal(at08.population, 3);
      const t08 = report.thresholds.find((t) => t.threshold === 0.8)!;
      assert.equal(t08.precision, 0.645, "p92 is labelled false (weight 1.1): 2 / 3.1");
      assert.equal(t08.recall, 1);
      // p92 (labelled false) is above every true item: precision never reaches 0.9; best F1 4 / 5.1 up to 0.85.
      assert.equal(report.suggested.atPrecisionTarget, null);
      assert.equal(report.suggested.bestF1!.f1, 0.784);
      assert.equal(report.suggested.bestF1!.threshold, 0.85);

      const text = formatFilterReport(report);
      const json = filterReportJson(report);
      for (const out of [text, json]) {
        assert.ok(!out.includes(SECRET), "no block text");
        assert.ok(!/declined|refused|plain note|trains/.test(out), "no block text");
      }
      assert.match(text, /population-weighted/);
      assert.match(text, /hidden blocks/);
      assert.match(text, /set: \[retrieval\.filters\.refusals\] threshold = /);
      assert.match(text, /labeller: calls 13 {2}input 1300 {2}output 65 {2}cost \$0\.0130/);
      assert.ok(!/block:[0-9a-f]{16}/.test(text), "the text report has no per-item lines");
      const parsed = JSON.parse(json);
      assert.equal(parsed.rows.length, 13);
      for (const r of parsed.rows) assert.deepEqual(Object.keys(r).sort(), ["id", "label", "probability", "stratum"]);
    } finally {
      db.close();
    }
  });
});

test("calibrationFilters: a filter defined only in a side TOML, merged over the agent's effective filters", () => {
  const config = {
    retrieval: { filters: { model: "decider", existing: { keywords: ["x"] }, shared: { description: "global", threshold: 0.6 } } },
    agents: { miku: { retrieval: { filters: { shared: { threshold: 0.7 } } } } },
  } as any;
  const side = `[retrieval.filters.refusals]\ndescription = "declines"\nthreshold = 0.75\nexamples = { hide = ["no"] }\n\n[retrieval.filters.shared]\nthreshold = 0.9\n`;
  const r = calibrationFilters(config, "miku", { text: side, name: "side.toml" });
  assert.equal(r.model, "decider");
  const byKey = new Map(r.filters.map((f) => [f.key, f]));
  assert.equal(byKey.get("refusals")!.description, "declines");
  assert.equal(byKey.get("refusals")!.threshold, 0.75);
  assert.deepEqual(byKey.get("refusals")!.examplesHide, ["no"]);
  assert.equal(byKey.get("shared")!.threshold, 0.9, "the side file wins over the agent override");
  assert.equal(byKey.get("shared")!.description, "global");
  assert.ok(byKey.has("existing"));
  // Without the side file: the agent's override; the side filter is absent.
  const plain = calibrationFilters(config, "miku");
  assert.equal(plain.filters.find((f) => f.key === "shared")!.threshold, 0.7);
  assert.ok(!plain.filters.some((f) => f.key === "refusals"));
  // A bare top-level table works too.
  const bare = calibrationFilters({} as any, null, { text: `[refusals]\ndescription = "declines"\n`, name: "bare.toml" });
  assert.equal(bare.filters[0]!.key, "refusals");
  // Malformed: invalid TOML, and a filter that fails the live validation.
  assert.throws(() => calibrationFilters({} as any, null, { text: "[[[", name: "bad.toml" }), /bad\.toml is not valid TOML/);
  assert.throws(
    () => calibrationFilters({} as any, null, { text: `[retrieval.filters.f]\nexamples = { hide = ["a"] }\nkeywords = ["k"]\n`, name: "f.toml" }),
    /examples need a description/,
  );
});

test("CLI: --point filter flag validation", () => {
  const env = { ...process.env };
  for (const name of endpointOverrideVars(env)) delete env[name];
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/calibrate-checks.ts", "--db", "x.db", "--labeller", "l", ...args], {
      env, encoding: "utf8",
    });
  const noKey = run("--point", "filter");
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /--point filter needs --filter <key>/);
  const chainElsewhere = run("--point", "memory", "--chain");
  assert.equal(chainElsewhere.status, 2);
  assert.match(chainElsewhere.stderr, /--chain applies only to --point filter/);
  const enrichElsewhere = run("--check", "c", "--enrich-keywords", "a");
  assert.equal(enrichElsewhere.status, 2);
  assert.match(enrichElsewhere.stderr, /--enrich-keywords applies only to --point filter/);
  const badPoint = run("--point", "nope");
  assert.match(badPoint.stderr, /--point must be memory or filter/);
});
