import { test } from "node:test";
import assert from "node:assert/strict";
import { ExactMaxSimScorer, MaxSimEngine } from "../src/retrieval/late/maxsim.js";
import { packBatches } from "../src/retrieval/late/maxsim-worker.js";
import type { TokenMatrix } from "../src/retrieval/models/types.js";

/** Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomMatrix(rand: () => number, tokens: number, dim: number): TokenMatrix {
  const data = new Float32Array(tokens * dim);
  for (let t = 0; t < tokens; t++) {
    let norm = 0;
    for (let k = 0; k < dim; k++) {
      const v = rand() * 2 - 1;
      data[t * dim + k] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    for (let k = 0; k < dim; k++) data[t * dim + k]! /= norm;
  }
  return { tokens, dim, data };
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

function docs(rand: () => number, n: number, dim: number, prefix: string) {
  // Varied lengths (1..60) so batches mix lengths and padding is masked.
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    matrix: randomMatrix(rand, 1 + Math.floor(rand() * 60), dim),
  }));
}

function assertScores(got: Map<string, number>, query: TokenMatrix, expected: Array<{ key: string; matrix: TokenMatrix }>) {
  assert.equal(got.size, expected.length);
  for (const d of expected) {
    const s = got.get(d.key);
    assert.ok(s !== undefined, `missing ${d.key}`);
    assert.ok(Math.abs(s - referenceScore(query, d.matrix)) < 1e-4, `${d.key}: ${s} vs ${referenceScore(query, d.matrix)}`);
  }
}

test("packBatches buckets by length and masks padding", () => {
  const rand = rng(7);
  const set = docs(rand, 40, 8, "d").map((d) => ({ key: d.key, tokens: d.matrix.tokens, dim: 8, data: d.matrix.data }));
  set.push({ key: "empty", tokens: 0, dim: 8, data: new Float32Array(0) });
  const batches = packBatches(set, 200);
  const keys = batches.flatMap((b) => b.keys);
  assert.equal(keys.length, 40);
  assert.ok(!keys.includes("empty"));
  for (const b of batches) {
    assert.ok(b.b === 1 || b.b * b.t <= 200);
    assert.equal(b.data.length, b.b * b.t * 8);
  }
});

test("exact MaxSim matches a JS reference on ad-hoc docs and a resident window", async () => {
  const scorer = await ExactMaxSimScorer.create({ threads: 2, maxBatchTokens: 256 });
  try {
    assert.equal(scorer.backend, "exact");
    assert.equal(scorer.approximate, false);
    const rand = rng(42);
    const dim = 16;
    const query = randomMatrix(rand, 5, dim);
    const window = docs(rand, 50, dim, "w");
    const adhoc = docs(rand, 12, dim, "a");

    const adhocOnly = await scorer.score(query, { docs: adhoc });
    assertScores(adhocOnly, query, adhoc);

    await scorer.setWindow("recent", window);
    const windowOnly = await scorer.score(query, { windowId: "recent", windowTopK: 3 });
    assertScores(windowOnly, query, window); // exact ignores windowTopK

    const both = await scorer.score(query, { windowId: "recent", docs: adhoc });
    assertScores(both, query, [...window, ...adhoc]);

    // A matrix that is a view into a larger buffer is scored on its own rows.
    const big = randomMatrix(rand, 10, dim);
    const view: TokenMatrix = { tokens: 3, dim, data: big.data.subarray(2 * dim, 5 * dim) };
    const viewScores = await scorer.score(query, { docs: [{ key: "v", matrix: view }] });
    assertScores(viewScores, query, [{ key: "v", matrix: view }]);
  } finally {
    await scorer.close();
  }
});

test("replacing a window frees the old one; dropping it makes it unknown", async () => {
  const scorer = await MaxSimEngine.create({ threads: 1 });
  try {
    const rand = rng(3);
    const dim = 8;
    const query = randomMatrix(rand, 4, dim);
    const first = docs(rand, 5, dim, "old");
    const second = docs(rand, 7, dim, "new");
    await scorer.setWindow("w", first);
    await scorer.setWindow("w", second);
    const scores = await scorer.score(query, { windowId: "w" });
    assertScores(scores, query, second);
    assert.ok(![...scores.keys()].some((k) => k.startsWith("old")));
    await scorer.dropWindow("w");
    await assert.rejects(scorer.score(query, { windowId: "w" }), /unknown window/);
    await assert.rejects(scorer.score(randomMatrix(rand, 2, 4), { docs: second }), /dim/);
  } finally {
    await scorer.close();
  }
});

test("score rejects with AbortError when the signal aborts, and the scorer stays usable", async () => {
  const scorer = await ExactMaxSimScorer.create({ threads: 1, maxBatchTokens: 64 });
  try {
    const rand = rng(11);
    const dim = 32;
    const query = randomMatrix(rand, 8, dim);
    await scorer.setWindow("w", docs(rand, 400, dim, "w"));

    const pre = new AbortController();
    pre.abort();
    await assert.rejects(scorer.score(query, { windowId: "w" }, pre.signal), { name: "AbortError" });

    const mid = new AbortController();
    const pending = scorer.score(query, { windowId: "w" }, mid.signal);
    mid.abort();
    await assert.rejects(pending, { name: "AbortError" });

    const small = docs(rand, 3, dim, "s");
    assertScores(await scorer.score(query, { docs: small }), query, small);
  } finally {
    await scorer.close();
  }
  await assert.rejects(scorer.score(randomMatrix(rng(1), 1, 4), { docs: [] }), /closed/);
});

test("stored fp16 / int8 rows are decoded in the worker; windows update in place", async () => {
  const { encodeTokenMatrix, decodeTokenMatrix } = await import("../src/retrieval/late/codec.js");
  const scorer = await ExactMaxSimScorer.create({ threads: 1 });
  try {
    const rand = rng(7);
    const dim = 16;
    const plain = docs(rand, 6, dim, "d");
    const encoded = plain.map((d, i) => ({ key: d.key, encoded: encodeTokenMatrix(d.matrix, i % 2 === 0 ? "fp16" : "int8") }));
    const asStored = plain.map((d, i) => ({ key: d.key, matrix: decodeTokenMatrix(encoded[i]!.encoded) }));
    const query = randomMatrix(rand, 3, dim);
    assertScores(await scorer.score(query, { docs: encoded }), query, asStored);
    await scorer.addToWindow("w", encoded.slice(0, 4));
    assert.equal(scorer.hasWindow("w"), true);
    await scorer.addToWindow("w", encoded.slice(4));
    await scorer.removeFromWindow("w", ["d0", "d1"]);
    assertScores(await scorer.score(query, { windowId: "w" }), query, asStored.slice(2));
    // A corrupt blob is skipped (no score), the rest still score.
    const broken = { key: "bad", encoded: { ...encoded[0]!.encoded, vectors: Buffer.alloc(3) } };
    const got = await scorer.score(query, { docs: [broken, encoded[2]!] });
    assert.deepEqual([...got.keys()], ["d2"]);
  } finally {
    await scorer.close();
  }
});

test("a dead worker is respawned on the next call (with backoff); its windows are reported lost", async () => {
  const scorer = await ExactMaxSimScorer.create({ threads: 1, respawnDelayMs: 300 });
  try {
    const dim = 2;
    const q = { tokens: 1, dim, data: new Float32Array([1, 0]) };
    const d = [{ key: "a", matrix: { tokens: 1, dim, data: new Float32Array([1, 0]) } }];
    await scorer.setWindow("w", d);
    const kill = async () => {
      const child = (scorer as unknown as { rpc: { child: import("node:child_process").ChildProcess } }).rpc.child;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGKILL");
      await exited;
    };
    await kill();
    assert.equal(scorer.hasWindow("w"), false, "the window died with the worker");
    assert.equal((await scorer.score(q, { docs: d })).get("a"), 1, "the first death respawns at once");
    await kill();
    await assert.rejects(scorer.score(q, { docs: d }), /respawning/, "a second death backs off");
    await new Promise((r) => setTimeout(r, 350));
    assert.equal((await scorer.score(q, { docs: d })).get("a"), 1);
  } finally {
    await scorer.close();
  }
});
