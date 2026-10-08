/**
 * Re-rank stage plumbing (ARCHITECTURE.md §9d "Re-rank stages"): the provider
 * chain's health and fallover, per-member timeouts, not-ready members, the
 * remote `/rerank` and multi-vector shapes (against a local test server), and
 * the provider config rules (remote needs zdr or self_hosted).
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ProviderChain, ChainUnavailableError } from "../src/retrieval/models/chain.js";
import { ProviderNotReadyError, type RerankProvider } from "../src/retrieval/models/types.js";
import { RemoteLateEncoder, RemoteRerankProvider, parseRerankResponse } from "../src/retrieval/models/remote.js";
import { resolveRetrievalConfig, judgedPassageCap } from "../src/retrieval/config.js";

function fake(name: string, behave: () => Promise<number[]>): RerankProvider & { calls: number } {
  const p = {
    name,
    kind: "remote" as const,
    calls: 0,
    async score() {
      p.calls += 1;
      return behave();
    },
    async close() {},
  };
  return p;
}

test("chain: falls over on error and on timeout; an unhealthy member is skipped until its backoff elapses", async () => {
  let now = 1_000_000;
  const bad = fake("gpu", async () => {
    throw new Error("down");
  });
  const slow = fake("api", () => new Promise((r) => setTimeout(() => r([0.5]), 200)));
  const good = fake("cpu", async () => [0.9]);
  const chain = new ProviderChain(
    "rerank",
    [
      { provider: bad, enabled: true, timeoutMs: 1000 },
      { provider: slow, enabled: true, timeoutMs: 30 },
      { provider: good, enabled: true, timeoutMs: 1000 },
    ],
    { now: () => now, baseBackoffMs: 10_000 },
  );
  const r1 = await chain.run((p, s) => p.score("q", ["d"], s));
  assert.equal(r1.provider.name, "cpu");
  assert.deepEqual(r1.value, [0.9]);
  const health = chain.healthSnapshot();
  assert.equal(health.find((h) => h.name === "gpu")!.state, "unhealthy");
  assert.equal(health.find((h) => h.name === "api")!.state, "unhealthy");
  await chain.run((p, s) => p.score("q", ["d"], s));
  assert.equal(bad.calls, 1, "skipped while unhealthy");
  now += 10_001;
  await chain.run((p, s) => p.score("q", ["d"], s));
  assert.equal(bad.calls, 2, "probed once the backoff elapsed");
});

test("chain: a not-ready member is skipped without a strike; disabled members are never tried; all failing throws", async () => {
  const cold = fake("builtin", async () => {
    throw new ProviderNotReadyError("loading");
  });
  const off = fake("off", async () => [1]);
  const chain = new ProviderChain("rerank", [
    { provider: off, enabled: false, timeoutMs: 100 },
    { provider: cold, enabled: true, timeoutMs: 100 },
  ]);
  await assert.rejects(() => chain.run((p, s) => p.score("q", ["d"], s)), (e: unknown) => {
    assert.ok(e instanceof ChainUnavailableError);
    assert.deepEqual((e as ChainUnavailableError).attempts, [{ name: "builtin", outcome: "not_ready" }]);
    return true;
  });
  assert.equal(off.calls, 0);
  assert.equal(chain.healthSnapshot().find((h) => h.name === "builtin")!.state, "healthy");
});

test("chain: the caller's abort is neutral", async () => {
  const slow = fake("gpu", () => new Promise((r) => setTimeout(() => r([1]), 200)));
  const chain = new ProviderChain("rerank", [{ provider: slow, enabled: true, timeoutMs: 1000 }]);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 10);
  await assert.rejects(() => chain.run((p, s) => p.score("q", ["d"], s), { signal: ctrl.signal }), /aborted/);
  assert.equal(chain.healthSnapshot()[0]!.state, "healthy");
});

test("rerank response shapes: bare array, results with relevance_score, missing index is an error", () => {
  assert.deepEqual(parseRerankResponse([{ index: 1, score: 0.2 }, { index: 0, score: 0.7 }], 2), [0.7, 0.2]);
  assert.deepEqual(parseRerankResponse({ results: [{ index: 0, relevance_score: 0.4 }] }, 1), [0.4]);
  assert.throws(() => parseRerankResponse({ results: [{ index: 0, relevance_score: 0.4 }] }, 2), /scored 1 of 2/);
  assert.throws(() => parseRerankResponse({ results: [{ index: 5, score: 1 }] }, 1), /out of range/);
});

async function withServer(handler: (body: any, url: string) => unknown, run: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const out = handler(JSON.parse(data), req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
}

const providerCfg = (over: Record<string, unknown>): any => ({
  name: "gpu",
  kind: "remote",
  enabled: true,
  zdr: false,
  selfHosted: true,
  requestFormat: "documents",
  onnxFile: "onnx/model.onnx",
  maxTokens: 512,
  batchSize: 16,
  queryPrefix: "",
  documentPrefix: "",
  inputTypeField: "input_type",
  ...over,
});

test("remote rerank: the documents and texts request formats", async () => {
  const seen: any[] = [];
  await withServer(
    (body, url) => {
      seen.push({ body, url });
      const docs: string[] = body.documents ?? body.texts;
      return body.texts
        ? docs.map((d, index) => ({ index, score: d.length / 10 }))
        : { results: docs.map((d, index) => ({ index, relevance_score: d.length / 10 })) };
    },
    async (base) => {
      const a = new RemoteRerankProvider(providerCfg({ endpoint: base, model: "m1" }));
      assert.deepEqual(await a.score("q", ["ab", "abcd"], new AbortController().signal), [0.2, 0.4]);
      const b = new RemoteRerankProvider(providerCfg({ endpoint: base, requestFormat: "texts", path: "/v1/rerank" }));
      assert.deepEqual(await b.score("q", ["abc"], new AbortController().signal), [0.3]);
    },
  );
  assert.equal(seen[0].url, "/rerank");
  assert.equal(seen[0].body.model, "m1");
  assert.equal(seen[1].url, "/v1/rerank");
  assert.ok(Array.isArray(seen[1].body.texts));
});

test("remote late encoder: token matrices, normalized rows, input type, query cap", async () => {
  await withServer(
    (body) => ({
      data: body.input.map((_: string, index: number) => ({ index, embeddings: [[3, 4], [0, 2], [1, 0]] })),
      side: body.input_type,
    }),
    async (base) => {
      const enc = new RemoteLateEncoder(providerCfg({ endpoint: base, model: "late-small" }));
      const [m] = await enc.encodeDocuments(["x"], new AbortController().signal);
      assert.equal(m!.tokens, 3);
      assert.equal(m!.dim, 2);
      assert.ok(Math.abs(m!.data[0]! - 0.6) < 1e-6 && Math.abs(m!.data[1]! - 0.8) < 1e-6);
      const q = await enc.encodeQuery("y", 2, new AbortController().signal);
      assert.equal(q.tokens, 2);
    },
  );
});

test("config: remote providers need zdr or self_hosted; local needs a model; chains must name providers", () => {
  assert.throws(
    () => resolveRetrievalConfig({ enabled: true, rerank: { enabled: true, chain: ["a"], providers: { a: { kind: "remote", endpoint: "http://x" } } } } as any),
    /zdr = true or self_hosted = true/,
  );
  assert.throws(
    () => resolveRetrievalConfig({ enabled: true, rerank: { enabled: true, chain: ["a"], providers: { a: { kind: "local" } } } } as any),
    /no built-in default model/,
  );
  assert.throws(
    () => resolveRetrievalConfig({ enabled: true, rerank: { enabled: true, chain: ["missing"], providers: {} } } as any),
    /not a \[retrieval\.rerank\.providers/,
  );
  assert.throws(
    () =>
      resolveRetrievalConfig({
        enabled: true,
        late: { enabled: true, model: "big", chain: ["a"], providers: { a: { kind: "remote", endpoint: "http://x", zdr: true, model: "other" } } },
      } as any),
    /not the index model "big" or of its family/,
  );
  const ok = resolveRetrievalConfig({
    enabled: true,
    late: {
      enabled: true,
      model: "big",
      family: ["small"],
      exhaustive_blocks: "all",
      chain: ["gpu"],
      query_chain: ["gpu", "cpu"],
      providers: { gpu: { kind: "remote", endpoint: "http://x", self_hosted: true, model: "big" }, cpu: { kind: "local", model: "small" } },
    },
  } as any);
  assert.equal(ok.late.exhaustiveBlocks, Number.POSITIVE_INFINITY);
  assert.deepEqual(ok.late.queryChain, ["gpu", "cpu"]);
  assert.equal(ok.late.quantization, "turboquant");
  assert.equal(judgedPassageCap(ok), 8);
  assert.equal(judgedPassageCap(resolveRetrievalConfig({ enabled: true })), 12);
});
