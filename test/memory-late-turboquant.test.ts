import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurboQuantScorer, loadTurboQuantBinding } from "../src/retrieval/late/turboquant.js";
import type { TokenMatrix } from "../src/retrieval/models/types.js";

let skip: string | false = false;
try {
  loadTurboQuantBinding();
} catch (error) {
  skip = (error as Error).message;
}

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function gauss(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
}

function unitRow(rand: () => number, dim: number, toward?: Float32Array, cos = 0): Float32Array {
  const v = new Float32Array(dim);
  let n = 0;
  for (let k = 0; k < dim; k++) n += (v[k] = gauss(rand)) ** 2;
  for (let k = 0; k < dim; k++) v[k]! /= Math.sqrt(n);
  if (toward) {
    const s = Math.sqrt(1 - cos * cos);
    n = 0;
    for (let k = 0; k < dim; k++) n += (v[k] = cos * toward[k]! + s * v[k]!) ** 2;
    for (let k = 0; k < dim; k++) v[k]! /= Math.sqrt(n);
  }
  return v;
}

function matrix(rows: Float32Array[], dim: number): TokenMatrix {
  const data = new Float32Array(rows.length * dim);
  rows.forEach((r, i) => data.set(r, i * dim));
  return { tokens: rows.length, dim, data };
}

/** A query plus docs with graded planted relevance (a share of tokens near query tokens). */
function corpus(seed: number, dim: number, nDocs: number, prefix = "d") {
  const rand = rng(seed);
  const qRows = Array.from({ length: 16 }, () => unitRow(rand, dim));
  const query = matrix(qRows, dim);
  const docs = Array.from({ length: nDocs }, (_, i) => {
    const r = rand();
    const len = 1 + Math.floor(rand() * 90);
    const rows = Array.from({ length: len }, () =>
      rand() < 0.3 ? unitRow(rand, dim, qRows[Math.floor(rand() * qRows.length)], 0.9 * r) : unitRow(rand, dim),
    );
    return { key: `${prefix}${i}`, matrix: matrix(rows, dim) };
  });
  return { query, docs };
}

function referenceScore(q: TokenMatrix, d: TokenMatrix): number {
  let sum = 0;
  for (let i = 0; i < q.tokens; i++) {
    let best = -Infinity;
    for (let j = 0; j < d.tokens; j++) {
      let dot = 0;
      for (let k = 0; k < q.dim; k++) dot += q.data[i * q.dim + k]! * d.data[j * d.dim + k]!;
      if (dot > best) best = dot;
    }
    sum += best;
  }
  return sum / q.tokens;
}

function topKeys(scores: Map<string, number>, k: number): string[] {
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([key]) => key);
}

test("turboquant: window top-k contains the exact top-k (4-bit)", { skip }, async () => {
  const dim = 64;
  const { query, docs } = corpus(1, dim, 300);
  const scorer = await createTurboQuantScorer({ dim, bits: 4 });
  assert.equal(scorer.backend, "turboquant");
  assert.equal(scorer.approximate, true);
  await scorer.setWindow("w", docs);

  const exact = new Map(docs.map((d) => [d.key, referenceScore(query, d.matrix)]));
  const all = await scorer.score(query, { windowId: "w" });
  assert.equal(all.size, docs.length);
  for (const d of docs) assert.ok(Math.abs(all.get(d.key)! - exact.get(d.key)!) < 0.05, d.key);

  const shortlist = await scorer.score(query, { windowId: "w", windowTopK: 30 });
  assert.equal(shortlist.size, 30);
  const exactTop10 = topKeys(exact, 10);
  const contained = exactTop10.filter((k) => shortlist.has(k)).length;
  assert.ok(contained >= 9, `only ${contained}/10 of the exact top 10 in the quantised top 30`);
  await scorer.close();
});

test("turboquant: 2-bit stays close; ad-hoc docs scored alongside the window", { skip }, async () => {
  const dim = 48;
  const { query, docs } = corpus(2, dim, 60);
  const scorer = await createTurboQuantScorer({ bits: 2 });
  await scorer.setWindow("w", docs.slice(0, 40));
  const extra = docs.slice(40);
  const got = await scorer.score(query, { windowId: "w", windowTopK: 5, docs: extra });
  assert.equal(got.size, 5 + extra.length);
  for (const d of extra) assert.ok(Math.abs(got.get(d.key)! - referenceScore(query, d.matrix)) < 0.1, d.key);
  // Ad-hoc only, no window.
  const only = await scorer.score(query, { docs: extra });
  assert.deepEqual([...only.keys()].sort(), extra.map((d) => d.key).sort());
  await scorer.close();
});

test("turboquant: window replace, drop and empty docs", { skip }, async () => {
  const dim = 32;
  const a = corpus(3, dim, 20, "a");
  const b = corpus(4, dim, 15, "b");
  const scorer = await createTurboQuantScorer({ dim, bits: 3 });
  await scorer.setWindow("w", a.docs);
  assert.deepEqual([...(await scorer.score(a.query, { windowId: "w" })).keys()].sort(), a.docs.map((d) => d.key).sort());

  // Replace: only the new docs remain; zero-token docs are omitted.
  const empty = { key: "empty", matrix: { tokens: 0, dim, data: new Float32Array(0) } };
  await scorer.setWindow("w", [...b.docs, empty]);
  const replaced = await scorer.score(a.query, { windowId: "w" });
  assert.deepEqual([...replaced.keys()].sort(), b.docs.map((d) => d.key).sort());

  // An empty window scores nothing; a dropped one is unknown.
  await scorer.setWindow("w", []);
  assert.equal((await scorer.score(a.query, { windowId: "w" })).size, 0);
  await scorer.dropWindow("w");
  await assert.rejects(scorer.score(a.query, { windowId: "w" }), /unknown window/);

  // Dim mismatch is an error, not garbage.
  await assert.rejects(scorer.setWindow("x", corpus(5, 16, 3).docs), /dim 16/);
  await scorer.close();
});

test("turboquant: abort rejects with AbortError", { skip }, async () => {
  const dim = 64;
  const { query, docs } = corpus(6, dim, 50);
  const scorer = await createTurboQuantScorer({ dim, bits: 4 });
  await scorer.setWindow("w", docs);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(scorer.score(query, { windowId: "w" }, pre.signal), (e: Error) => e.name === "AbortError");

  const mid = new AbortController();
  const p = scorer.score(query, { windowId: "w", docs: docs.slice(0, 10) }, mid.signal);
  mid.abort();
  await assert.rejects(p, (e: Error) => e.name === "AbortError");

  // The scorer still works afterwards.
  assert.equal((await scorer.score(query, { windowId: "w" })).size, docs.length);
  await scorer.close();
});

test("turboquant: native class rejects bad shapes", { skip }, async () => {
  const Native = loadTurboQuantBinding();
  assert.throws(() => new Native({ dim: 64, bits: 5 }), /bits/);
  await assert.rejects(createTurboQuantScorer({ bits: 1 as 2 }), /bits/);
  const n = new Native({ dim: 8, bits: 4 });
  await assert.rejects(n.setBlocks(["a"], [2], new Float32Array(8)), /expected 2 rows/);
  await assert.rejects(n.setBlocks(["a", "b"], [1], new Float32Array(8)), /2 keys but 1 token counts/);
  await n.setBlocks(["a", "b"], new Uint32Array([1, 2]), new Float32Array(24).fill(0.5));
  assert.equal(n.blockCount(), 2);
  assert.ok(n.memoryBytes() > 0);
  await n.addBlocks(["c", "a"], [1, 1], new Float32Array(16).fill(-0.5));
  assert.equal(n.blockCount(), 3);
  assert.equal(n.removeBlocks(["a", "zzz"]), 1);
  assert.equal(n.blockCount(), 2);
  const r = await n.scan(new Float32Array(8).fill(Math.SQRT1_2 / 2), 1, 1);
  assert.deepEqual(r.keys, ["b"]);
});

test("turboquant: stored fp16 / int8 rows load natively and match the decoded floats; windows update in place", { skip }, async () => {
  const { encodeTokenMatrix, decodeTokenMatrix } = await import("../src/retrieval/late/codec.js");
  const dim = 32;
  const { query, docs } = corpus(11, dim, 30);
  const scorer = await createTurboQuantScorer({ bits: 4 });
  const encoded = docs.map((d, i) => ({ key: d.key, encoded: encodeTokenMatrix(d.matrix, i % 3 === 0 ? "int8" : "fp16") }));
  const decoded = docs.map((d, i) => ({ key: d.key, matrix: decodeTokenMatrix(encoded[i]!.encoded) }));
  await scorer.setWindow("f32", decoded);
  await scorer.addToWindow("enc", encoded.slice(0, 20));
  await scorer.addToWindow("enc", encoded.slice(20));
  const a = await scorer.score(query, { windowId: "f32" });
  const b = await scorer.score(query, { windowId: "enc" });
  assert.equal(b.size, docs.length);
  for (const [k, v] of a) assert.ok(Math.abs(b.get(k)! - v) < 1e-9, `${k}: same codes either way`);
  await scorer.removeFromWindow("enc", ["d0", "d1", "missing"]);
  const c = await scorer.score(query, { windowId: "enc" });
  assert.equal(c.size, docs.length - 2);
  assert.ok(!c.has("d0") && !c.has("d1"));
  assert.equal(scorer.hasWindow("enc"), true);
  await scorer.dropWindow("enc");
  assert.equal(scorer.hasWindow("enc"), false);
  await scorer.close();
});

test("turboquant: codes are reported to V8 as external memory and free() releases them at once", { skip }, async () => {
  const Native = loadTurboQuantBinding();
  const dim = 64;
  const { docs } = corpus(5, dim, 50);
  const n = new Native({ dim, bits: 4, threads: 1 });
  const floats = docs.reduce((s, d) => s + d.matrix.tokens * dim, 0);
  const v = new Float32Array(floats);
  let o = 0;
  for (const d of docs) {
    v.set(d.matrix.data, o);
    o += d.matrix.tokens * dim;
  }
  await n.setBlocks(docs.map((d) => d.key), docs.map((d) => d.matrix.tokens), v);
  assert.ok(n.memoryBytes() > 0);
  assert.equal(n.externalBytes(), n.memoryBytes(), "the resident codes are counted by V8");
  n.removeBlocks(["d0"]);
  assert.equal(n.externalBytes(), n.memoryBytes());
  n.free();
  assert.equal(n.blockCount(), 0);
  assert.equal(n.externalBytes(), 0);
  await n.addBlocks(["late"], [1], v.subarray(0, dim));
  assert.equal(n.blockCount(), 0, "a mutation after free() is discarded");
  assert.equal((await n.scan(v.subarray(0, dim), 1, 0)).keys.length, 0);
  n.free();
});
