import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import {
  LocalEmbeddingProvider,
  VectorStore,
  activeEmbeddingModelId,
  resolveRetrievalConfig,
} from "../src/retrieval/index.js";
import { ensureHfModel, resolveLocalModel } from "../src/retrieval/embedding/index.js";

const BGE_QUERY = "Represent this sentence for searching relevant passages: ";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-local-models-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A fake fastembed instance recording what reaches `embed`; the e5 helpers must never be called. */
function fakeFlag(seen: string[][]) {
  return {
    async *embed(texts: string[], _batchSize: number) {
      seen.push(texts);
      yield texts.map(() => [3, 4, 0, 0]);
    },
    passageEmbed() {
      throw new Error("passageEmbed must not be used (it forces e5 prefixes)");
    },
    queryEmbed() {
      throw new Error("queryEmbed must not be used (it forces e5 prefixes)");
    },
  };
}

test("bge v1.5 embeds queries with the retrieval instruction and passages bare", () => {
  const m = resolveLocalModel("bge-small-en-v1.5");
  assert.equal(m.queryPrefix, BGE_QUERY);
  assert.equal(m.passagePrefix, "");
  assert.equal(m.spec.hf?.repo, "BAAI/bge-small-en-v1.5");
  assert.equal(resolveLocalModel("bge-base-en-v1.5").queryPrefix, BGE_QUERY);
});

test("each model gets its own trained prefixes", () => {
  const e5 = resolveLocalModel("multilingual-e5-large");
  assert.deepEqual([e5.queryPrefix, e5.passagePrefix], ["query: ", "passage: "]);
  const minilm = resolveLocalModel("all-MiniLM-L6-v2");
  assert.deepEqual([minilm.queryPrefix, minilm.passagePrefix], ["", ""]);
  // A fastembed id resolves to the same entry as its config name.
  assert.equal(resolveLocalModel("fast-multilingual-e5-large").passagePrefix, "passage: ");
  // An unknown model goes to fastembed unchanged with no prefixes.
  const unknown = resolveLocalModel("some-custom-model");
  assert.equal(unknown.spec.fastembedId, "some-custom-model");
  assert.deepEqual([unknown.queryPrefix, unknown.passagePrefix], ["", ""]);
});

test("the model id moves off the pre-prefix-table id, so existing indexes re-embed", () => {
  const m = resolveLocalModel("bge-small-en-v1.5");
  assert.match(m.modelId, /^local:bge-small-en-v1\.5#[0-9a-f]{12}$/);
  assert.notEqual(m.modelId, "local:bge-small-en-v1.5");
  assert.equal(resolveLocalModel("bge-small-en-v1.5").modelId, m.modelId, "stable across calls");
});

test("prefix overrides change the model id; an explicit empty prefix differs from the default", () => {
  const base = resolveLocalModel("bge-small-en-v1.5");
  const noQuery = resolveLocalModel("bge-small-en-v1.5", { queryPrefix: "" });
  assert.equal(noQuery.queryPrefix, "");
  assert.notEqual(noQuery.modelId, base.modelId);
  const sameAsDefault = resolveLocalModel("bge-small-en-v1.5", { queryPrefix: BGE_QUERY, passagePrefix: "" });
  assert.equal(sameAsDefault.modelId, base.modelId, "restating the defaults keeps the index");
  const passage = resolveLocalModel("bge-small-en-v1.5", { passagePrefix: "doc: " });
  assert.notEqual(passage.modelId, base.modelId);
});

test("config prefixes flow into the provider and the reported active model id", () => {
  const resolved = resolveRetrievalConfig({
    enabled: true,
    embedding: { provider: "local", local: { model: "bge-small-en-v1.5", dim: 384, query_prefix: "q> ", passage_prefix: "p> " } },
  });
  assert.equal(resolved.embedding.local.queryPrefix, "q> ");
  assert.equal(resolved.embedding.local.passagePrefix, "p> ");
  const expected = resolveLocalModel("bge-small-en-v1.5", { queryPrefix: "q> ", passagePrefix: "p> " }).modelId;
  assert.equal(activeEmbeddingModelId(resolved), expected);
  const provider = new LocalEmbeddingProvider({ model: "bge-small-en-v1.5", dim: 384, cacheDir: "/nonexistent", queryPrefix: "q> ", passagePrefix: "p> " });
  assert.equal(provider.modelId, expected);
});

test("LocalEmbeddingProvider sends model-appropriate prefixes through fastembed's embed()", async () => {
  const seen: string[][] = [];
  const provider = new LocalEmbeddingProvider({ model: "bge-small-en-v1.5", dim: 4, cacheDir: "/nonexistent" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).flag = Promise.resolve(fakeFlag(seen));
  const docs = await provider.embedDocuments(["the kettle whistled at dawn", "a paper boat in the gutter"]);
  const query = await provider.embedQuery("when did the kettle whistle");
  assert.deepEqual(seen, [
    ["the kettle whistled at dawn", "a paper boat in the gutter"],
    [`${BGE_QUERY}when did the kettle whistle`],
  ]);
  // Vectors are still L2-normalized.
  assert.deepEqual(Array.from(query), [0.6000000238418579, 0.800000011920929, 0, 0]);
  assert.equal(docs.length, 2);
});

test("LocalEmbeddingProvider applies configured prefix overrides", async () => {
  const seen: string[][] = [];
  const provider = new LocalEmbeddingProvider({
    model: "bge-small-en-v1.5",
    dim: 4,
    cacheDir: "/nonexistent",
    queryPrefix: "",
    passagePrefix: "passage: ",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).flag = Promise.resolve(fakeFlag(seen));
  await provider.embedDocuments(["a lighthouse keeper's log"]);
  await provider.embedQuery("lighthouse");
  assert.deepEqual(seen, [["passage: a lighthouse keeper's log"], ["lighthouse"]]);
});

test("a stored pre-upgrade model id is seen as a model switch", async () => {
  await withTempDir(async (dir) => {
    const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
    try {
      const vs = new VectorStore(storage);
      await vs.ensureSchema(384, "local:bge-small-en-v1.5");
      const provider = new LocalEmbeddingProvider({ model: "bge-small-en-v1.5", dim: 384, cacheDir: dir });
      const result = await vs.ensureSchema(provider.dim, provider.modelId);
      assert.deepEqual(result, { recreated: false, modelChanged: true });
    } finally {
      await storage.waitForIdle();
      storage.close();
    }
  });
});

/** A tiny stand-in for the Hub's `/<repo>/resolve/<revision>/<file>` route. */
async function withHub(
  files: Record<string, string>,
  run: (endpoint: string, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const body = files[req.url ?? ""];
    if (body === undefined) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const REV = "0123456789abcdef0123456789abcdef01234567";
const ONNX = "synthetic onnx bytes";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hubFiles = (onnx: string) => ({
  [`/acme/tiny-embed/resolve/${REV}/config.json`]: '{"pad_token_id":0}',
  [`/acme/tiny-embed/resolve/${REV}/tokenizer.json`]: "{}",
  [`/acme/tiny-embed/resolve/${REV}/tokenizer_config.json`]: "{}",
  [`/acme/tiny-embed/resolve/${REV}/special_tokens_map.json`]: "{}",
  [`/acme/tiny-embed/resolve/${REV}/onnx/model.onnx`]: onnx,
});
const source = { repo: "acme/tiny-embed", revision: REV, onnxFile: "onnx/model.onnx", onnxSha256: sha256(ONNX), pooling: "cls" as const };

test("ensureHfModel downloads a pinned revision once and reuses it", async () => {
  await withTempDir(async (cacheDir) => {
    await withHub(hubFiles(ONNX), async (endpoint, requests) => {
      const dir = await ensureHfModel(cacheDir, source, { endpoint });
      assert.equal(dir, path.join(cacheDir, "acme_tiny-embed@0123456789ab"));
      assert.equal(readFileSync(path.join(dir, "onnx/model.onnx"), "utf8"), ONNX);
      assert.equal(readFileSync(path.join(dir, "config.json"), "utf8"), '{"pad_token_id":0}');
      assert.equal(requests.length, 5);
      assert.ok(requests.every((u) => u.includes(`/resolve/${REV}/`)), "every file comes from the pinned revision");

      await ensureHfModel(cacheDir, source, { endpoint });
      assert.equal(requests.length, 5, "a complete cache makes no requests");
    });
  });
});

test("ensureHfModel rejects a graph whose sha256 does not match and leaves nothing behind", async () => {
  await withTempDir(async (cacheDir) => {
    await withHub(hubFiles("tampered bytes"), async (endpoint) => {
      await assert.rejects(() => ensureHfModel(cacheDir, source, { endpoint }), /checksum mismatch/);
      const onnxDir = path.join(cacheDir, "acme_tiny-embed@0123456789ab", "onnx");
      assert.deepEqual(await readdir(onnxDir), [], "neither the .part file nor the graph survives");
    });
    // A later good download resumes: the tokenizer files are kept, only the graph is fetched.
    await withHub(hubFiles(ONNX), async (endpoint, requests) => {
      await ensureHfModel(cacheDir, source, { endpoint });
      assert.deepEqual(requests, [`/acme/tiny-embed/resolve/${REV}/onnx/model.onnx`]);
    });
  });
});

test("ensureHfModel surfaces an HTTP failure with the URL", async () => {
  await withTempDir(async (cacheDir) => {
    await withHub({}, async (endpoint) => {
      await assert.rejects(() => ensureHfModel(cacheDir, source, { endpoint }), /HTTP 404/);
      assert.equal(existsSync(path.join(cacheDir, "acme_tiny-embed@0123456789ab", "config.json")), false);
    });
  });
});
