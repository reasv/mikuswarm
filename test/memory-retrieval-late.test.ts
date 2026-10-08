/**
 * Late interaction (ARCHITECTURE.md §9d "Late interaction"): the on-disk
 * codec, background indexing (newest first, bounded retries, pruning, lag),
 * the query stage (exhaustive window + re-score, quantised shortlist +
 * exact rescoring, missing vectors bypass, timeout skip), and the pipeline's
 * use of the late and cross-encoder stages. Synthetic vectors only.
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
import { decodeTokenMatrix, encodeTokenMatrix, fromHalf, toHalf } from "../src/retrieval/late/codec.js";
import { LateIndexWorker } from "../src/retrieval/late/indexer.js";
import { LateStage } from "../src/retrieval/late/stage.js";
import { ExactMaxSimScorer } from "../src/retrieval/late/maxsim.js";
import type { MaxSimScorer } from "../src/retrieval/late/scorer.js";
import { ProviderChain } from "../src/retrieval/models/chain.js";
import type { LateEncoder, RerankProvider, TokenMatrix } from "../src/retrieval/models/types.js";
import { MemoryRetrievalPipeline } from "../src/retrieval/auto/pipeline.js";

const TZ = "UTC";
const DIM = 8;
const WORDS = ["pancake", "recipe", "garden", "chess", "rain", "train", "music", "cat"];

/** A toy late encoder: one unit vector per known word (others: a small noise axis). */
function encodeText(text: string): TokenMatrix {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const rows = words.map((w) => {
    const v = new Float32Array(DIM);
    const i = WORDS.indexOf(w);
    if (i >= 0) v[i] = 1;
    else v[(w.length * 7) % DIM] = 0.2;
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return Array.from(v, (x) => x / n);
  });
  const data = new Float32Array(rows.length * DIM);
  rows.forEach((r, t) => data.set(r, t * DIM));
  return { tokens: rows.length, dim: DIM, data };
}

function fakeEncoder(name = "cpu", opts: { fail?: boolean; delayMs?: number } = {}): LateEncoder & { docCalls: number } {
  const e = {
    name,
    kind: "local" as const,
    model: "late-toy",
    docCalls: 0,
    async encodeDocuments(texts: string[]) {
      e.docCalls += 1;
      if (opts.fail) throw new Error("encoder down");
      return texts.map(encodeText);
    },
    async encodeQuery(text: string, maxTokens: number) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const m = encodeText(text);
      return m.tokens <= maxTokens ? m : { tokens: maxTokens, dim: DIM, data: m.data.slice(0, maxTokens * DIM) };
    },
    async close() {},
  };
  return e;
}

test("codec: fp16 and int8 round-trip within quantization error", () => {
  assert.equal(fromHalf(toHalf(1)), 1);
  assert.equal(fromHalf(toHalf(-0.5)), -0.5);
  assert.ok(Math.abs(fromHalf(toHalf(0.1234)) - 0.1234) < 1e-3);
  const m = encodeText("pancake recipe unknownword garden");
  for (const dtype of ["fp16", "int8"] as const) {
    const enc = encodeTokenMatrix(m, dtype);
    assert.equal(enc.vectors.length, m.tokens * DIM * (dtype === "fp16" ? 2 : 1));
    const dec = decodeTokenMatrix(enc);
    for (let i = 0; i < m.data.length; i++) assert.ok(Math.abs(dec.data[i]! - m.data[i]!) < 0.01, `${dtype} ${i}`);
  }
});

function header(day: string, hh: string): string {
  const t = parseZonedWallClock(`${day} ${hh}`, TZ)!;
  return buildDiaryHeader({ earliestTimestamp: t, latestTimestamp: t + 600_000, room: "general", timezone: TZ });
}

interface Fixture {
  storage: Storage;
  store: MemoryRetrievalStore;
  search: MemorySearch;
  root: string;
}

async function withFixture(files: Record<string, string>, run: (f: Fixture) => Promise<void>) {
  configureAgentTimezone(TZ);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-late-"));
  const root = path.join(dir, "ws");
  await mkdir(path.join(root, "memory"), { recursive: true });
  for (const [n, t] of Object.entries(files)) await writeFile(path.join(root, "memory", n), t);
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  const config = resolveRetrievalConfig({ enabled: true });
  const indexer = new MemoryIndexer({ storage, workspaceRoot: root, config, tokenizer: new GptTokenizer() });
  await indexer.reconcileAll();
  try {
    await run({ storage, store: new MemoryRetrievalStore(storage), search: new MemorySearch(storage, indexer, config), root });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
}

const lateCfg = (over: Record<string, unknown> = {}) =>
  resolveRetrievalConfig({
    enabled: true,
    late: {
      enabled: true,
      model: "late-toy",
      chain: ["cpu"],
      providers: { cpu: { kind: "local", model: "late-toy" } },
      ...over,
    },
  } as any).late;

const FILES = {
  "2026-04-01.md": `${header("2026-04-01", "10:00")}\npancake recipe with syrup\n\n${header("2026-04-01", "11:00")}\nchess and rain talk\n`,
  "2026-04-02.md": `${header("2026-04-02", "10:00")}\ngarden and music\n\n${header("2026-04-02", "11:00")}\ntrain cat\n`,
};

test("indexer: encodes blocks newest first in batches, prunes other models, reports lag; failures are bounded", async () => {
  await withFixture(FILES, async ({ store }) => {
    await store.putLateVectors("old-model", [{ contentHash: "x", ...encodeTokenMatrix(encodeText("cat"), "fp16") }], 1);
    const enc = fakeEncoder();
    const logs: Array<[string, any]> = [];
    const worker = new LateIndexWorker({
      store,
      config: lateCfg({ index_batch_size: 2 }),
      chain: new ProviderChain("late_documents", [{ provider: enc, enabled: true, timeoutMs: 5000 }]),
      recencyPaths: async () => new Set(["memory/2026-04-02.md"]),
      logger: { info: (e: string, f: any) => logs.push([e, f]), warn: (e: string, f: any) => logs.push([e, f]), debug() {} } as any,
    });
    assert.deepEqual(await worker.lag(), { missing: 4, outsideRecency: 2 });
    await worker.start();
    await worker.stop();
    assert.ok(logs.some(([e, f]) => e === "late_index_lag" && f.outsideRecency === 2), "warns about blocks outside the recency layer");
    // A fresh worker (the stopped one's signal is aborted) drains the rest.
    const drain = new LateIndexWorker({
      store,
      config: lateCfg({ index_batch_size: 2 }),
      chain: new ProviderChain("late_documents", [{ provider: enc, enabled: true, timeoutMs: 5000 }]),
      recencyPaths: async () => new Set(["memory/2026-04-02.md"]),
    });
    while ((await drain.batch()) > 0);
    assert.equal(store.lateIndexedHashes("late-toy").size, 4);
    assert.equal(store.lateIndexedHashes("old-model").size, 0, "other models' vectors pruned");
    assert.deepEqual(await drain.lag(), { missing: 0, outsideRecency: 0 });
  });
  await withFixture(FILES, async ({ store }) => {
    const enc = fakeEncoder("cpu", { fail: true });
    const worker = new LateIndexWorker({
      store,
      config: lateCfg({ index_batch_size: 10 }),
      chain: new ProviderChain("late_documents", [{ provider: enc, enabled: true, timeoutMs: 5000 }], { baseBackoffMs: 0 }),
      recencyPaths: async () => new Set(),
    });
    for (let i = 0; i < 5; i++) await worker.batch();
    assert.equal(enc.docCalls, 3, "each block retried at most 3 times");
  });
});

async function indexAll(store: MemoryRetrievalStore) {
  const worker = new LateIndexWorker({
    store,
    config: lateCfg({ index_batch_size: 50 }),
    chain: new ProviderChain("late_documents", [{ provider: fakeEncoder(), enabled: true, timeoutMs: 5000 }]),
    recencyPaths: async () => new Set(),
  });
  while ((await worker.batch()) > 0);
  return worker;
}

test("stage: exhaustive window + re-score beyond it; a missing block bypasses; timeout skips the stage", async () => {
  const exact = await ExactMaxSimScorer.create({ threads: 1 });
  try {
    await withFixture(FILES, async ({ store }) => {
      const worker = await indexAll(store);
      const stage = new LateStage({
        config: lateCfg({ exhaustive_blocks: 2 }),
        store,
        queryChain: new ProviderChain("late_queries", [{ provider: fakeEncoder(), enabled: true, timeoutMs: 1000 }]),
        exact,
        scan: exact,
        recencyPaths: async () => new Set(),
        indexVersion: () => worker.version,
      });
      await stage.refreshWindow(null);
      const old = store.chunksByContentHashes([...store.lateIndexedHashes("late-toy")], null).find((r) => r.text.includes("pancake"))!;
      const out = await stage.score({ agent: null, queryText: "pancake recipe", candidates: [{ contentHash: old.contentHash }, { contentHash: "unindexed" }] });
      assert.equal(out.status, "ok");
      assert.equal(out.windowSize, 2, "the two newest indexed blocks");
      assert.equal(out.windowChunks.length, 2);
      assert.ok(Math.abs(out.scores.get(old.contentHash)! - 1) < 1e-3, "beyond-window candidate re-scored exactly");
      assert.equal(out.missing, 1, "the unindexed candidate has no score (it bypasses the cut)");
      assert.equal(out.queryModel, "late-toy");

      const slowStage = new LateStage({
        config: lateCfg({ timeout_ms: 20 }),
        store,
        queryChain: new ProviderChain("late_queries", [{ provider: fakeEncoder("cpu", { delayMs: 200 }), enabled: true, timeoutMs: 1000 }]),
        exact,
        scan: exact,
        recencyPaths: async () => new Set(),
        indexVersion: () => worker.version,
      });
      const timedOut = await slowStage.score({ agent: null, queryText: "pancake", candidates: [] });
      assert.equal(timedOut.status, "timeout");
    });
  } finally {
    await exact.close();
  }
});

test("stage: a quantised scan's shortlist is re-scored exactly from the stored vectors", async () => {
  const exact = await ExactMaxSimScorer.create({ threads: 1 });
  try {
    await withFixture(FILES, async ({ store }) => {
      const worker = await indexAll(store);
      let windowTopK: number | undefined;
      const approx: MaxSimScorer = {
        backend: "fake-quantised",
        approximate: true,
        async setWindow() {},
        async dropWindow() {},
        async score(_q, target) {
          windowTopK = target.windowTopK;
          // Pretend the scan put every window block in the shortlist with a wrong score.
          const keys = [...store.lateIndexedHashes("late-toy")];
          return new Map(keys.map((k) => [k, 0.01]));
        },
        async close() {},
      };
      const stage = new LateStage({
        config: lateCfg({ exhaustive_blocks: "all", rescore: 3 }),
        store,
        queryChain: new ProviderChain("late_queries", [{ provider: fakeEncoder(), enabled: true, timeoutMs: 1000 }]),
        exact,
        scan: approx,
        recencyPaths: async () => new Set(),
        indexVersion: () => worker.version,
      });
      await stage.refreshWindow(null);
      const out = await stage.score({ agent: null, queryText: "garden music", candidates: [] });
      assert.equal(out.backend, "fake-quantised");
      assert.equal(windowTopK, 3);
      const garden = out.windowChunks.find((r) => r.text.includes("garden"))!;
      assert.ok(out.scores.get(garden.contentHash)! > 0.9, "exact rescoring replaced the scan's score");
    });
  } finally {
    await exact.close();
  }
});

test("pipeline: late cut + cross-encoder top_n before the judge; unjudged selection uses the cross-encoder's cutoff", async () => {
  const exact = await ExactMaxSimScorer.create({ threads: 1 });
  try {
    await withFixture(FILES, async ({ store, search }) => {
      const worker = await indexAll(store);
      const cfg = resolveRetrievalConfig({
        enabled: true,
        auto: { candidate_min_score: 0 },
        late: { enabled: true, model: "late-toy", top_n: 2, exhaustive_blocks: "all", chain: ["cpu"], providers: { cpu: { kind: "local", model: "late-toy" } } },
        rerank: { enabled: true, top_n: 1, chain: ["ce"], providers: { ce: { kind: "local", model: "toy-ce", min_score: 0.5 } } },
      } as any);
      const late = new LateStage({
        config: cfg.late,
        store,
        queryChain: new ProviderChain("late_queries", [{ provider: fakeEncoder(), enabled: true, timeoutMs: 1000 }]),
        exact,
        scan: exact,
        recencyPaths: async () => new Set(),
        indexVersion: () => worker.version,
      });
      await late.refreshWindow(null);
      const seen: string[][] = [];
      const ce: RerankProvider = {
        name: "ce",
        kind: "local",
        async score(_q, docs) {
          seen.push(docs);
          return docs.map((d) => (d.includes("pancake") ? 0.9 : 0.1));
        },
        async close() {},
      };
      const rerank = new ProviderChain("rerank", [{ provider: ce, enabled: true, timeoutMs: 1000 }]);
      const pipeline = new MemoryRetrievalPipeline({ search, store, config: cfg, late, rerank });
      const plan = await pipeline.plan({
        agentName: null,
        timelineKey: "matrix:a:!r",
        attribution: {},
        proactive: false,
        now: parseZonedWallClock("2026-05-01 10:00", TZ)!,
        request: { from: "alice", text: "pancake recipe" },
        conversation: [],
        participants: [],
      });
      assert.equal(seen.length, 1);
      assert.ok(seen[0]!.length <= 2, "the late stage cut to top_n before the cross-encoder");
      assert.equal(plan.report.stages.late?.status, "ok");
      assert.equal(plan.report.stages.rerank?.provider, "ce");
      assert.equal(plan.report.source, "unjudged");
      assert.equal(plan.report.kept, 1);
      assert.ok(plan.block!.includes("pancake"));
      assert.ok(plan.report.items.some((i) => i.stage === "cut_late" || i.stage === "cut_rerank"));
    });
  } finally {
    await exact.close();
  }
});
