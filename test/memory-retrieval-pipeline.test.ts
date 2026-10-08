/**
 * The auto-retrieval pipeline (ARCHITECTURE.md §9d "Judged retrieval"): wide
 * recall, exclusions, the memory decision point as the final filter (a real
 * DecisionEngine over a fake decisions endpoint), fallback, ordering, packing,
 * person-cued recall, filters riding in the relevance call, the persisted
 * report. Synthetic fixtures only.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryIndexer, MemorySearch, resolveRetrievalConfig } from "../src/retrieval/index.js";
import { GptTokenizer } from "../src/context/tokenizer/index.js";
import { buildDiaryHeader } from "../src/diary/header.js";
import { configureAgentTimezone, resetAgentTimezone, parseZonedWallClock } from "../src/time/index.js";
import { MemoryRetrievalStore } from "../src/storage/memory-retrieval-store.js";
import { MemoryRetrievalPipeline, orderJudged, JUDGED_NOTE, UNJUDGED_NOTE } from "../src/retrieval/auto/pipeline.js";
import type { PlanInput } from "../src/retrieval/auto/types.js";
import { DecisionClient, DecisionEngine, type DecisionEvaluationRow } from "../src/decisions/index.js";
import { MemoryFilterService } from "../src/retrieval/filters/index.js";
import type { AppConfig } from "../src/config/index.js";
import { ProviderChain } from "../src/retrieval/models/chain.js";
import type { RerankProvider } from "../src/retrieval/models/types.js";

const TZ = "UTC";
const DAY = 86_400_000;

function decider(): any {
  return {
    id: "vendor/decider-1",
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

/** The fake decisions endpoint: answers from the passage text (or fails). */
function decisionsFetch(opts: { fail?: boolean; hang?: RegExp; calls: any[] }) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    opts.calls.push(body);
    if (opts.fail) return new Response("upstream down", { status: 503 });
    const text: string = body.state?.passage?.text ?? body.state?.entry?.text ?? "";
    // A passage matching `hang` never gets an answer: the point's timeout ends it.
    if (opts.hang?.test(text)) {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      if (id === "relevant") answers[id] = { noul: /KEEP-HIGH/.test(text) ? 0.95 : /KEEP/.test(text) ? 0.8 : 0.1 };
      else if (id === "about_participant") answers[id] = { noul: /ABOUT/.test(text) ? 0.9 : 0.1 };
      else if (id.startsWith("filter__")) answers[id] = { noul: /HABIT/.test(text) ? 0.95 : 0.05 };
    }
    return new Response(JSON.stringify({ model: "vendor/decider-1-20261001", answers, usage: { input_tokens: 100, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

interface Stack {
  storage: Storage;
  store: MemoryRetrievalStore;
  pipeline: MemoryRetrievalPipeline;
  workspaceRoot: string;
  rows: DecisionEvaluationRow[];
  calls: any[];
  logs: Array<[string, any]>;
}

async function withStack(
  files: Record<string, string>,
  opts: {
    decisions?: boolean;
    fail?: boolean;
    hang?: RegExp;
    decisionsConfig?: Record<string, unknown>;
    filters?: Record<string, unknown>;
    auto?: Record<string, unknown>;
    rerank?: { minScore: number; score: (doc: string) => number };
  },
  run: (s: Stack) => Promise<void>,
): Promise<void> {
  configureAgentTimezone(TZ);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-pipeline-"));
  const workspaceRoot = path.join(dir, "ws");
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(workspaceRoot, "memory", name), text);
  // Unrelated filler so BM25 has a corpus to weigh terms against.
  let filler = "";
  const topics = ["weather", "train", "music", "chess", "garden", "movie", "coffee", "cats", "rain", "bikes", "books", "games"];
  topics.forEach((t, i) => (filler += block("2026-01-15", `${String(8 + i).padStart(2, "0")}`, "lobby", `Chatter about ${t} and ${t} plans.`)));
  await writeFile(path.join(workspaceRoot, "memory", "2026-01-15.md"), filler);
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  const config = resolveRetrievalConfig({
    enabled: true,
    auto: { ...(opts.auto ?? {}) },
    ...(opts.rerank
      ? { rerank: { enabled: true, chain: ["fake"], providers: { fake: { kind: "remote", endpoint: "http://rerank.invalid", zdr: true, min_score: opts.rerank.minScore } } } }
      : {}),
  } as any);
  const indexer = new MemoryIndexer({ storage, workspaceRoot, config, tokenizer: new GptTokenizer() });
  await indexer.reconcileAll();
  const search = new MemorySearch(storage, indexer, config);
  const store = new MemoryRetrievalStore(storage);
  const rows: DecisionEvaluationRow[] = [];
  const calls: any[] = [];
  const logs: Array<[string, any]> = [];
  const logger: any = {
    info: (e: string, f: any) => logs.push([e, f]),
    warn: (e: string, f: any) => logs.push([e, f]),
    error: () => {},
    debug: () => {},
    child() {
      return logger;
    },
  };
  const appConfig = {
    models: { decider: decider() },
    decisions: opts.decisions === false ? undefined : { enabled: true, model: "decider", ...(opts.decisionsConfig ?? {}) },
    retrieval: { enabled: true, ...(opts.filters ? { filters: opts.filters } : {}) },
  } as unknown as AppConfig;
  const engine =
    opts.decisions === false
      ? undefined
      : new DecisionEngine({
          config: appConfig,
          client: new DecisionClient({ models: appConfig.models, fetchImpl: decisionsFetch({ fail: opts.fail, hang: opts.hang, calls }), logger }),
          onEvaluation: (row) => rows.push(row),
          logger,
        });
  const filters = new MemoryFilterService({ config: appConfig, store, engine: () => engine, logger });
  const rerankScore = opts.rerank?.score;
  const rerank = rerankScore
    ? new ProviderChain<RerankProvider>("rerank", [
        {
          provider: { name: "fake", kind: "remote", score: async (_q: string, docs: string[]) => docs.map(rerankScore), close: async () => {} } as unknown as RerankProvider,
          enabled: true,
          timeoutMs: 1000,
        },
      ])
    : undefined;
  const pipeline = new MemoryRetrievalPipeline({ search, store, config, filters, engine: () => engine, logger, ...(rerank ? { rerank } : {}) });
  try {
    await run({ storage, store, pipeline, workspaceRoot, rows, calls, logs });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
}

function block(day: string, hh: string, room: string, body: string): string {
  const start = parseZonedWallClock(`${day} ${hh.includes(":") ? hh : `${hh}:00`}`, TZ)!;
  return `${buildDiaryHeader({ earliestTimestamp: start, latestTimestamp: start + 30 * 60_000, room, timezone: TZ })}\n${body}\n\n`;
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    agentName: null,
    timelineKey: "matrix:acc:!room",
    attribution: { agentSessionId: "s-1", timelineKey: "matrix:acc:!room", sessionType: "default" },
    proactive: false,
    now: parseZonedWallClock("2026-06-10 12:00", TZ)!,
    request: { from: "alice", text: "what did we decide about the pancake recipe" },
    conversation: [{ from: "bob", text: "we talked about breakfast" }],
    participants: [],
    ...over,
  };
}

test("judged: the decision model keeps only relevant passages; zero kept = no block", async () => {
  const files = {
    "2026-05-01.md": block("2026-05-01", "10:00", "kitchen", "KEEP The pancake recipe needs buttermilk, we decided.") +
      block("2026-05-01", "14:00", "kitchen", "Pancake chat drifted to the weather, nothing decided."),
  };
  await withStack(files, {}, async ({ pipeline, rows, store }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.source, "model");
    assert.equal(plan.report.kept, 1);
    assert.ok(plan.block?.includes(JUDGED_NOTE));
    assert.ok(plan.block?.includes("buttermilk"));
    assert.ok(!plan.block?.includes("weather"));
    // Compact citation: the date is in the file name, so it is not repeated.
    assert.match(plan.block!, /- \[memory\/2026-05-01\.md:\d+-\d+ · kitchen\] /);
    // One decision row per passage, all in one group, point memory.
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => r.point === "memory" && r.decisionGroup === plan.report.decisionGroup));
    assert.ok(rows.every((r) => r.agentSessionId === "s-1"));
    // The retrieval row is persisted with its report.
    await new Promise((r) => setTimeout(r, 20));
    const saved = store.retrievalsForSession("s-1");
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.kept, 1);
    const report = JSON.parse(saved[0]!.reportJson!);
    assert.ok(report.items.some((i: any) => i.stage === "kept"));
    assert.ok(report.items.some((i: any) => i.stage === "dropped"));
  });
  // Nothing relevant → no block at all.
  await withStack({ "2026-05-01.md": block("2026-05-01", "10:00", "kitchen", "Pancake chat, nothing kept.") }, {}, async ({ pipeline }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.block, null);
    assert.equal(plan.report.kept, 0);
  });
});

test("judged: one passage per request; state carries conversation, request, participants and passage", async () => {
  const files = {
    "2026-05-02.md": block("2026-05-02", "10:00", "kitchen", "KEEP pancake one") + block("2026-05-02", "12:00", "kitchen", "KEEP pancake two"),
  };
  await withStack(files, {}, async ({ pipeline, calls }) => {
    await pipeline.plan(input({ participants: [{ provider: "matrix", senderId: "@a:x", name: "alice", role: "requester" }] }));
    const memoryCalls = calls.filter((c) => c.state.entry && c.state.conversation);
    assert.equal(memoryCalls.length, 2);
    for (const c of memoryCalls) {
      assert.ok(c.state.conversation && c.state.request && c.state.participants);
      assert.deepEqual(c.state.participants, ["alice"]);
      assert.ok(typeof c.state.entry.text === "string" && !c.state.entry.text.includes("→"), "header line stripped");
      assert.deepEqual(Object.keys(c.questions).sort(), ["about_participant", "relevant"]);
    }
  });
});

test("fallback: chain down → hybrid ranking above fallback_min_score, at most fallback_max_results", async () => {
  const files = {
    "2026-05-03.md":
      block("2026-05-03", "10:00", "kitchen", "pancake recipe decide pancake recipe decide pancake") +
      block("2026-05-03", "11:00", "kitchen", "pancake recipe decided again pancake recipe") +
      block("2026-05-03", "12:00", "kitchen", "pancake recipe decided thrice pancake recipe") +
      block("2026-05-03", "13:00", "kitchen", "one word pancake"),
  };
  await withStack(files, { fail: true }, async ({ pipeline }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.source, "fallback");
    assert.ok(plan.report.kept <= 2);
    assert.ok(plan.block === null || plan.block.includes(UNJUDGED_NOTE));
  });
});

test("partial judgement: timed-out passages fall back (capped) after the judged keepers, never dropped", async () => {
  const files = {
    "2026-05-06.md":
      block("2026-05-06", "09:00", "kitchen", "KEEP the pancake recipe needs buttermilk, we decided.") +
      block("2026-05-06", "10:00", "kitchen", "SLOW pancake recipe decided pancake recipe one") +
      block("2026-05-06", "11:00", "kitchen", "SLOW pancake recipe decided pancake recipe two") +
      block("2026-05-06", "12:00", "kitchen", "SLOW pancake recipe decided pancake recipe three") +
      block("2026-05-06", "13:00", "kitchen", "SLOW pancake recipe decided pancake recipe four"),
  };
  const opts = { hang: /SLOW/, decisionsConfig: { timeout_ms: 150 }, auto: { fallback_min_score: 0, fallback_max_results: 2 } };
  await withStack(files, opts, async ({ pipeline, logs }) => {
    const plan = await pipeline.plan(input());
    const r = plan.report;
    assert.equal(r.source, "model");
    assert.ok(r.judged >= 1);
    assert.equal(r.unjudged, 4);
    assert.equal(r.fellBack, 2, "capped at fallback_max_results");
    assert.equal(r.kept, 3);
    const kept = r.items.filter((i) => i.stage === "kept");
    const byJudge = kept.filter((i) => i.selectedBy === "judge");
    const byFallback = kept.filter((i) => i.selectedBy === "fallback");
    assert.equal(byJudge.length, 1);
    assert.ok(byJudge.every((i) => i.judged === true));
    assert.equal(byFallback.length, 2);
    assert.ok(byFallback.every((i) => i.judged === false));
    // The rest of the unjudged passages are reported, not silently gone.
    assert.equal(r.items.filter((i) => i.stage === "not_judged").length, 2);
    // Judged keepers come first; the note is the unjudged one (not every item was judged).
    assert.ok(plan.block!.includes(UNJUDGED_NOTE));
    assert.ok(plan.block!.indexOf("buttermilk") < plan.block!.indexOf("SLOW"));
    const line = logs.find(([e]) => e === "memory_retrieval")![1];
    assert.equal(line.fellBack, 2);
    assert.equal(line.unjudged, 4);
  });
  // The overall max_results still bounds the judged keepers plus the fallback picks.
  await withStack(files, { ...opts, auto: { ...opts.auto, max_results: 2 } }, async ({ pipeline }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.kept, 2);
    assert.equal(plan.report.items.filter((i) => i.selectedBy === "judge").length, 1);
    assert.equal(plan.report.fellBack, 1);
    assert.equal(plan.report.items.filter((i) => i.stage === "budget").length, 1);
  });
});

test("all unjudged: the full fallback is unchanged and marks every shown item as fallen back", async () => {
  const files = {
    "2026-05-07.md":
      block("2026-05-07", "10:00", "kitchen", "pancake recipe decided pancake recipe one") +
      block("2026-05-07", "11:00", "kitchen", "pancake recipe decided pancake recipe two") +
      block("2026-05-07", "12:00", "kitchen", "pancake recipe decided pancake recipe three"),
  };
  await withStack(files, { fail: true, auto: { fallback_min_score: 0, fallback_max_results: 2 } }, async ({ pipeline }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.source, "fallback");
    assert.equal(plan.report.judged, 0);
    assert.equal(plan.report.unjudged, undefined);
    assert.equal(plan.report.kept, 2);
    assert.equal(plan.report.fellBack, 2);
    assert.ok(plan.report.items.filter((i) => i.stage === "kept").every((i) => i.selectedBy === "fallback" && i.judged === false));
    assert.ok(plan.block!.includes(UNJUDGED_NOTE));
  });
});

test("partial judgement with a cross-encoder: the fallback uses its calibrated cutoff, not the hybrid floor", async () => {
  const files = {
    "2026-05-08.md":
      block("2026-05-08", "09:00", "kitchen", "KEEP the pancake recipe needs buttermilk, we decided.") +
      block("2026-05-08", "10:00", "kitchen", "SLOW ALPHA pancake recipe decided pancake recipe") +
      block("2026-05-08", "11:00", "kitchen", "SLOW OMEGA pancake recipe decided pancake recipe again"),
  };
  // The hybrid floor would admit both slow passages (0); the cross-encoder cutoff admits only ALPHA.
  const rerank = { minScore: 0.5, score: (doc: string) => (/ALPHA|KEEP/.test(doc) ? 0.9 : 0.2) };
  await withStack(files, { hang: /SLOW/, decisionsConfig: { timeout_ms: 150 }, auto: { fallback_min_score: 0, fallback_max_results: 2 }, rerank }, async ({ pipeline }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.stages.rerank?.status, "ok");
    assert.equal(plan.report.source, "model");
    assert.equal(plan.report.fellBack, 1);
    const fellBack = plan.report.items.filter((i) => i.selectedBy === "fallback");
    assert.equal(fellBack.length, 1);
    assert.equal(fellBack[0]!.rerank, 0.9);
    assert.ok(plan.block!.includes("ALPHA"));
    assert.ok(!plan.block!.includes("OMEGA"));
  });
});

test("unjudged: no decision model → today's two-lane selection with excerpts", async () => {
  const files = { "2026-05-04.md": block("2026-05-04", "10:00", "kitchen", "pancake recipe decide pancake recipe decided") };
  await withStack(files, { decisions: false }, async ({ pipeline }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.source, "unjudged");
    assert.equal(plan.report.reason, "no_decision_model");
    assert.ok(plan.block?.includes("pancake"));
  });
});

test("judged filters ride in the relevance call; verdicts are cached and a hidden block is dropped", async () => {
  const files = {
    "2026-05-05.md": block("2026-05-05", "10:00", "kitchen", "KEEP pancake recipe HABIT the assistant did the thing") +
      block("2026-05-05", "11:00", "kitchen", "KEEP pancake recipe fine"),
  };
  const filters = { unwanted: { description: "The entry describes the assistant doing the thing." } };
  await withStack(files, { filters }, async ({ pipeline, calls, store }) => {
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.kept, 1);
    assert.ok(!plan.block!.includes("HABIT"));
    const withFilter = calls.filter((c) => c.questions["filter__unwanted"]);
    assert.equal(withFilter.length, 2, "both passages asked the filter question in the same request");
    await new Promise((r) => setTimeout(r, 20));
    const hidden = store.filterVerdicts(null, plan.report.items.map((i) => i.contentHash)).filter((v) => v.hidden);
    assert.equal(hidden.length, 1);
    // Second build: the cached verdict hides the block before any call.
    calls.length = 0;
    const again = await pipeline.plan(input());
    assert.equal(again.report.kept, 1);
    assert.ok(calls.every((c) => !c.questions["filter__unwanted"]));
    assert.ok(again.report.items.some((i) => i.stage === "hidden" && i.hiddenBy?.key === "unwanted"));
  });
});

test("keyword filter hides mechanically; time scope limits it", async () => {
  const files = {
    "2026-04-01.md": block("2026-04-01", "10:00", "kitchen", "KEEP pancake recipe oldnick said hi"),
    "2026-05-06.md": block("2026-05-06", "10:00", "kitchen", "KEEP pancake recipe oldnick again"),
  };
  const filters = { nick: { keywords: ["oldnick"], before: "2026-05-01" } };
  await withStack(files, { filters }, async ({ pipeline }) => {
    const plan = await pipeline.plan(input());
    const april = plan.report.items.find((i) => i.citation.startsWith("memory/2026-04-01.md"));
    const may = plan.report.items.find((i) => i.citation.startsWith("memory/2026-05-06.md"));
    assert.equal(april?.stage, "hidden");
    assert.equal(april?.hiddenBy?.kind, "keyword");
    assert.notEqual(may?.stage, "hidden", "out of the time scope: never hidden by it");
  });
});

test("ordering: participant ties only break near-ties", () => {
  const mk = (hash: string, presence = false): any => ({
    chunk: { contentHash: hash },
    hybrid: 0,
    score: 0,
    laneRelevance: {},
    presence,
    pendingFilters: [],
  });
  const v = (relevant: number, about: number | null = null): any => ({ keep: true, relevant, aboutParticipant: about, filters: {}, judged: true, meta: {} });
  const a = mk("a");
  const b = mk("b", true);
  const c = mk("c");
  const verdicts = new Map([
    ["a", v(0.8)],
    ["b", v(0.75)], // participant, within 0.1 → ahead of a
    ["c", v(0.95)],
  ]);
  assert.deepEqual(orderJudged([a, b, c], verdicts).map((x) => x.chunk.contentHash), ["c", "b", "a"]);
  // A participant tie never outranks a clearly more relevant passage.
  const far = new Map([
    ["a", v(0.9)],
    ["b", v(0.75, 0.9)],
  ]);
  assert.deepEqual(orderJudged([a, b], far).map((x) => x.chunk.contentHash), ["a", "b"]);
});

test("proactive: the conversation stands in for the request (no request in state)", async () => {
  const files = { "2026-05-07.md": block("2026-05-07", "10:00", "kitchen", "KEEP breakfast talk pancakes") };
  await withStack(files, {}, async ({ pipeline, calls }) => {
    const plan = await pipeline.plan(
      input({ proactive: true, request: undefined, conversation: [{ from: "bob", text: "breakfast pancakes anyone" }] }),
    );
    assert.equal(plan.report.source, "model");
    const memoryCalls = calls.filter((c) => c.state.entry && c.state.conversation);
    assert.ok(memoryCalls.length > 0);
    assert.ok(memoryCalls.every((c) => !("request" in c.state)));
    assert.match(String(memoryCalls[0].questions.relevant.instructions), /respond in this `conversation`/);
  });
});

test("person-cued recall: newest tagged entries of active people go straight to the judge", async () => {
  const files = {
    "2026-05-09.md": block("2026-05-09", "10:00", "kitchen", "KEEP unrelated garden talk with carol"),
  };
  await withStack(files, { auto: { person_recent: 2, person_recent_max: 8 } }, async ({ pipeline, store, storage, calls }) => {
    // Tag the block with a participant (provenance) directly.
    const [row] = storage.read((db) => db.prepare("select content_hash as h from memory_chunks where text like '%garden talk%'").all() as Array<{ h: string }>);
    await store.setProvenance({
      agent: "",
      contentHash: row!.h,
      status: "tagged",
      summaryId: "sum1",
      timelineKey: "matrix:acc:!room",
      participants: [{ provider: "matrix", senderId: "@carol:x", count: 3 }],
      at: 1,
    });
    // A bare greeting matches nothing lexically.
    const plan = await pipeline.plan(
      input({
        request: { from: "carol", text: "hey" },
        activePeople: [{ provider: "matrix", senderId: "@carol:x", name: "carol" }],
      }),
    );
    assert.equal(plan.report.kept, 1);
    const item = plan.report.items.find((i) => i.lanes.includes("person"));
    assert.ok(item, "person-cued lane");
    assert.ok(calls.some((c) => c.state.entry?.text.includes("garden")));
  });
});

test("recency layer blocks are excluded", async () => {
  const files = { "2026-05-10.md": block("2026-05-10", "10:00", "kitchen", "KEEP pancake recipe recent one") };
  configureAgentTimezone(TZ);
  await withStack(files, {}, async ({ pipeline }) => {
    (pipeline as any).deps.recencyContent = async () => "## header\nKEEP pancake recipe recent one\n";
    const plan = await pipeline.plan(input());
    assert.equal(plan.report.kept, 0);
    assert.ok(plan.report.items.every((i) => i.stage === "recency"));
  });
});

test("the memory_retrieval log line carries counts only", async () => {
  const files = { "2026-05-11.md": block("2026-05-11", "10:00", "kitchen", "KEEP pancake recipe secret text") };
  await withStack(files, {}, async ({ pipeline, logs }) => {
    await pipeline.plan(input());
    const line = logs.find(([e]) => e === "memory_retrieval");
    assert.ok(line);
    const fields = line![1];
    for (const k of ["candidates", "judged", "kept", "tokens", "source", "ms"]) assert.ok(k in fields, k);
    assert.ok(!JSON.stringify(fields).includes("secret"));
  });
});

test("DAY constant sanity", () => {
  assert.equal(DAY, 86_400_000);
});
