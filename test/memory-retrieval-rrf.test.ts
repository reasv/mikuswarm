/**
 * Reciprocal-rank fusion of the hybrid halves (ARCHITECTURE.md §9d "Fusion"):
 * `[retrieval.query].fusion = "rrf"` sums `1 / (k + rank)` over the lanes a block
 * appears in and normalizes by `lanes / (k + 1)`; the default stays weighted.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryIndexer, MemorySearch, rrfFuse, resolveRetrievalConfig } from "../src/retrieval/index.js";
import type { QueryVectorIndex } from "../src/retrieval/search.js";
import type { VectorStore } from "../src/retrieval/vector-store.js";
import { GptTokenizer } from "../src/context/tokenizer/index.js";

test("rrfFuse: per lane 1/(k+rank), summed, normalized by lanes/(k+1)", () => {
  const k = 60;
  const fused = rrfFuse([[1, 2, 3], [2, 4]], k);
  const max = 2 / (k + 1);
  assert.equal(fused.get(2), (1 / (k + 2) + 1 / (k + 1)) / max);
  assert.equal(fused.get(1), 1 / (k + 1) / max);
  assert.equal(fused.get(1), 0.5);
  assert.equal(fused.get(4), 1 / (k + 2) / max);
  // In both lanes beats first in one; the order follows the summed score.
  const order = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  assert.deepEqual(order, [2, 1, 4, 3]);
  // First in every lane is the maximum, 1.
  assert.equal(rrfFuse([[7], [7]], k).get(7), 1);
  assert.equal(rrfFuse([[7]], k).get(7), 1);
  assert.equal(rrfFuse([], k).size, 0);
  // Rank 60 in one of two lanes stays above the default 0.25 candidate floor.
  const deep = rrfFuse([Array.from({ length: 60 }, (_, i) => i + 1), [1000]], k);
  assert.ok(deep.get(60)! > 0.25);
});

test("config: fusion defaults to weighted, k 60; rrf resolves", () => {
  const def = resolveRetrievalConfig({ enabled: true }).query;
  assert.equal(def.fusion, "weighted");
  assert.equal(def.rrfK, 60);
  const rrf = resolveRetrievalConfig({ enabled: true, query: { fusion: "rrf", rrf_k: 10 } }).query;
  assert.equal(rrf.fusion, "rrf");
  assert.equal(rrf.rrfK, 10);
});

const DOCS: Record<string, string> = {
  a: "pancake pancake pancake recipe with maple pancake syrup",
  b: "a pancake mention among unrelated notes",
  c: "breakfast plans for the weekend",
};

async function withCorpus(run: (ctx: { storage: Storage; indexer: MemoryIndexer; rows: Record<string, number> }) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-rrf-"));
  const root = path.join(dir, "ws");
  await mkdir(path.join(root, "memory"), { recursive: true });
  for (const [name, text] of Object.entries(DOCS)) await writeFile(path.join(root, "memory", `${name}.md`), `${text}\n`);
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const config = resolveRetrievalConfig({ enabled: true });
    const indexer = new MemoryIndexer({ storage, workspaceRoot: root, config, tokenizer: new GptTokenizer() });
    await indexer.reconcileAll();
    const rows: Record<string, number> = {};
    const lex = new MemorySearch(storage, indexer, config);
    for (const [name, text] of Object.entries(DOCS)) {
      const hit = (await lex.searchScored({ query: text, limit: 10, minScore: 0 })).scored.find((s) => s.text.includes(text));
      assert.ok(hit, `row for ${name}`);
      rows[name] = hit.rowid;
    }
    await run({ storage, indexer, rows });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fixed vector half: `ranked` rowids best first with the given cosines. */
function fakeIndex(ranked: Array<[number, number]>): QueryVectorIndex {
  return {
    async query() {
      return {
        hits: ranked.map(([chunkId, cos]) => ({ chunkId, distance: 1 - cos })),
        store: {} as VectorStore,
        index: "builtin",
        vector: new Float32Array([1, 0, 0, 0]),
      };
    },
    // Exact cosine for a scope: the same cosines against the unit query.
    vectors: (_store, rowids) =>
      new Map(ranked.filter(([r]) => rowids.includes(r)).map(([r, cos]) => [r, new Float32Array([cos, 0, 0, 0])])),
  };
}

test("searchScored: weighted by default, RRF when configured (incl. semantic-only)", async () => {
  await withCorpus(async ({ storage, indexer, rows }) => {
    // Lexical: a (strong) then b. Vector: c then b, both near-identical cosines.
    const vec = fakeIndex([
      [rows.c!, 0.9],
      [rows.b!, 0.89],
    ]);
    const weighted = new MemorySearch(storage, indexer, resolveRetrievalConfig({ enabled: true, query: { temporal_decay_enabled: false } }), { vectorIndex: vec });
    const w = await weighted.searchScored({ query: "pancake", limit: 10, minScore: 0 });
    assert.equal(w.mode, "hybrid");
    const wb = w.scored.find((s) => s.rowid === rows.b)!;
    assert.ok(Math.abs(wb.relevance - (0.7 * wb.vecScore + 0.3 * wb.bm25Score)) < 1e-12, "default is the weighted sum");

    const cfg = resolveRetrievalConfig({ enabled: true, query: { fusion: "rrf", temporal_decay_enabled: false } });
    const rrf = new MemorySearch(storage, indexer, cfg, { vectorIndex: vec });
    const r = await rrf.searchScored({ query: "pancake", limit: 10, minScore: 0 });
    const k = 60;
    const max = 2 / (k + 1);
    const byRow = new Map(r.scored.map((s) => [s.rowid, s]));
    // b: lexical rank 2 + vector rank 2; a: lexical rank 1; c: vector rank 1.
    assert.equal(r.scored[0]!.rowid, rows.b);
    assert.ok(Math.abs(byRow.get(rows.b!)!.relevance - (2 / (k + 2)) / max) < 1e-12);
    assert.ok(Math.abs(byRow.get(rows.a!)!.relevance - 0.5) < 1e-12);
    assert.ok(Math.abs(byRow.get(rows.c!)!.relevance - 0.5) < 1e-12);
    for (const s of r.scored) assert.ok(s.relevance > 0 && s.relevance <= 1);
    // The raw lane scores are still reported.
    assert.ok(byRow.get(rows.c!)!.vecScore > 0.8);

    // A floor tests the normalized score: 0.6 keeps only the two-lane block.
    const floored = await rrf.searchScored({ query: "pancake", limit: 10, minScore: 0.6 });
    assert.deepEqual(floored.scored.map((s) => s.rowid), [rows.b]);

    // Semantic-only: the one vector lane, normalized by one lane.
    const sem = await rrf.searchScored({ query: "pancake", limit: 10, minScore: 0, semanticOnly: true });
    assert.deepEqual(sem.scored.map((s) => s.rowid), [rows.c, rows.b]);
    assert.equal(sem.scored[0]!.relevance, 1);
    assert.ok(Math.abs(sem.scored[1]!.relevance - (k + 1) / (k + 2)) < 1e-12);

    // A rowid scope (the user-lane ranking) ranks within the scope.
    const scoped = await rrf.searchScored({ query: "pancake", limit: 10, minScore: 0, rowidScope: [rows.a!, rows.c!] });
    assert.deepEqual(new Set(scoped.scored.map((s) => s.rowid)), new Set([rows.a, rows.c]));

    // Temporal decay still multiplies the fused relevance.
    const decayed = new MemorySearch(storage, indexer, resolveRetrievalConfig({ enabled: true, query: { fusion: "rrf" } }), { vectorIndex: vec });
    const d = await decayed.searchScored({ query: "pancake", limit: 10, minScore: 0, now: Date.now() + 45 * 86_400_000 });
    for (const s of d.scored) assert.ok(s.score < s.relevance && s.score > 0);
  });
});
