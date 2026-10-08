import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tokenizer } from "@anush008/tokenizers";
import { encodeModel, rawBytes, TensorType, type OnnxModel } from "../src/retrieval/onnx/proto.js";
import { resolveModelFiles, repoSlug } from "../src/retrieval/onnx/model-files.js";
import { LocalCrossEncoder } from "../src/retrieval/onnx/cross-encoder.js";
import { LocalLateEncoder } from "../src/retrieval/onnx/late-encoder.js";
import { truncateInput } from "../src/retrieval/onnx/encoding.js";
import { ProviderNotReadyError } from "../src/retrieval/models/types.js";
import type { ResolvedModelProvider } from "../src/retrieval/config.js";

// ---- fixtures ---------------------------------------------------------------

const WORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
const SPECIAL = { "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3 } as const;
const VOCAB: Record<string, number> = { ...SPECIAL };
WORDS.forEach((w, i) => (VOCAB[w] = 4 + i));
const VOCAB_SIZE = 4 + WORDS.length;
const PAD_ID = 0;

function tokenizerJson(): string {
  const special = (content: string, id: number) => ({
    id,
    content,
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true,
  });
  const tok = (id: string, typeId: number) => ({ SpecialToken: { id, type_id: typeId } });
  const seq = (id: "A" | "B", typeId: number) => ({ Sequence: { id, type_id: typeId } });
  return JSON.stringify({
    version: "1.0",
    // Settings a real tokenizer.json often carries; the loader must override them.
    truncation: { direction: "Right", max_length: 4, strategy: "LongestFirst", stride: 0 },
    padding: null,
    added_tokens: Object.entries(SPECIAL).map(([c, id]) => special(c, id)),
    normalizer: null,
    pre_tokenizer: { type: "Whitespace" },
    post_processor: {
      type: "TemplateProcessing",
      single: [tok("[CLS]", 0), seq("A", 0), tok("[SEP]", 0)],
      pair: [tok("[CLS]", 0), seq("A", 0), tok("[SEP]", 0), seq("B", 1), tok("[SEP]", 1)],
      special_tokens: {
        "[CLS]": { id: "[CLS]", ids: [2], tokens: ["[CLS]"] },
        "[SEP]": { id: "[SEP]", ids: [3], tokens: ["[SEP]"] },
      },
    },
    decoder: null,
    model: { type: "WordLevel", vocab: VOCAB, unk_token: "[UNK]" },
  });
}

function floatInit(name: string, dims: number[], values: number[]) {
  return { name, dataType: TensorType.FLOAT, dims, raw: rawBytes(Float32Array.from(values)) };
}
function int64Init(name: string, dims: number[], values: number[]) {
  return { name, dataType: TensorType.INT64, dims, raw: rawBytes(BigInt64Array.from(values.map(BigInt))) };
}

const I64 = TensorType.INT64;
const F32 = TensorType.FLOAT;

/**
 * Fake cross-encoder: logit = 0.01 × (Σ ids·mask + Σ type_ids), as [B,1]
 * ("one") or as [B,2] with a constant 0.5 negative logit ("two").
 */
function crossEncoderModel(head: "one" | "two"): Uint8Array {
  const model: OnnxModel = {
    opset: 13,
    graph: {
      name: "fake_cross",
      nodes: [
        { opType: "Cast", inputs: ["input_ids"], outputs: ["idf"], attributes: { to: { int: TensorType.FLOAT } } },
        { opType: "Cast", inputs: ["attention_mask"], outputs: ["mf"], attributes: { to: { int: TensorType.FLOAT } } },
        { opType: "Cast", inputs: ["token_type_ids"], outputs: ["tf"], attributes: { to: { int: TensorType.FLOAT } } },
        { opType: "Mul", inputs: ["idf", "mf"], outputs: ["masked"] },
        { opType: "Add", inputs: ["masked", "tf"], outputs: ["summand"] },
        { opType: "ReduceSum", inputs: ["summand", "axes"], outputs: ["sum"], attributes: { keepdims: { int: 1 } } },
        { opType: "Mul", inputs: ["sum", "scale"], outputs: head === "one" ? ["logits"] : ["pos"] },
        ...(head === "two"
          ? [
              { opType: "Mul", inputs: ["pos", "zero"], outputs: ["z"] },
              { opType: "Add", inputs: ["z", "neg"], outputs: ["negl"] },
              { opType: "Concat", inputs: ["negl", "pos"], outputs: ["logits"], attributes: { axis: { int: 1 } } },
            ]
          : []),
      ],
      inputs: [
        { name: "input_ids", elemType: I64, dims: ["batch", "seq"] },
        { name: "attention_mask", elemType: I64, dims: ["batch", "seq"] },
        { name: "token_type_ids", elemType: I64, dims: ["batch", "seq"] },
      ],
      outputs: [{ name: "logits", elemType: F32, dims: ["batch", head === "one" ? 1 : 2] }],
      initializers: [
        int64Init("axes", [1], [1]),
        floatInit("scale", [], [0.01]),
        ...(head === "two" ? [floatInit("zero", [], [0]), floatInit("neg", [], [0.5])] : []),
      ],
    },
  };
  return encodeModel(model);
}

const DIM = 4;
/** Embedding row r = [r+1, (r % 3) - 1, 1, -r/2] (distinct directions per id). */
const EMBED = Array.from({ length: VOCAB_SIZE }, (_, r) => [r + 1, (r % 3) - 1, 1, -r / 2]);

/**
 * Fake late encoder: Gather rows of an embedding table → [B,T,D]. A decoy
 * pooled output comes first, so the encoder must pick `last_hidden_state`.
 * No token_type_ids input: the encoder must not feed one.
 */
function lateEncoderModel(opts: { projected?: string } = {}): Uint8Array {
  // `projected`: also a ColBERT-style projection output (here the negated states), listed after the raw states.
  const projection = opts.projected
    ? { nodes: [{ opType: "Neg", inputs: ["last_hidden_state"], outputs: [opts.projected] }], outputs: [{ name: opts.projected, elemType: F32, dims: ["batch", "seq", DIM] }] }
    : { nodes: [], outputs: [] };
  return encodeModel({
    opset: 13,
    graph: {
      name: "fake_late",
      nodes: [
        { opType: "Gather", inputs: ["E", "input_ids"], outputs: ["last_hidden_state"], attributes: { axis: { int: 0 } } },
        ...projection.nodes,
        {
          opType: "ReduceMean",
          inputs: ["last_hidden_state"],
          outputs: ["pooler_output"],
          attributes: { axes: { ints: [1] }, keepdims: { int: 0 } },
        },
      ],
      inputs: [
        { name: "input_ids", elemType: I64, dims: ["batch", "seq"] },
        { name: "attention_mask", elemType: I64, dims: ["batch", "seq"] },
      ],
      outputs: [
        { name: "pooler_output", elemType: F32, dims: ["batch", DIM] },
        { name: "last_hidden_state", elemType: F32, dims: ["batch", "seq", DIM] },
        ...projection.outputs,
      ],
      initializers: [floatInit("E", [VOCAB_SIZE, DIM], EMBED.flat())],
    },
  });
}

async function modelDir(root: string, name: string, onnx: Uint8Array, config?: object): Promise<string> {
  const dir = join(root, name);
  await mkdir(join(dir, "onnx"), { recursive: true });
  await writeFile(join(dir, "onnx", "model.onnx"), onnx);
  await writeFile(join(dir, "tokenizer.json"), tokenizerJson());
  if (config) await writeFile(join(dir, "config.json"), JSON.stringify(config));
  return dir;
}

function provider(over: Partial<ResolvedModelProvider>): ResolvedModelProvider {
  return {
    name: "builtin",
    kind: "local",
    enabled: true,
    zdr: false,
    selfHosted: false,
    requestFormat: "documents",
    onnxFile: "onnx/model.onnx",
    maxTokens: 512,
    batchSize: 8,
    queryPrefix: "",
    documentPrefix: "",
    inputTypeField: "",
    ...over,
  };
}

const ids = (text: string): number[] => text.split(/\s+/).filter(Boolean).map((w) => VOCAB[w] ?? 1);
const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

/** Expected fake-cross logit for [CLS] q [SEP] d [SEP] with doc trimmed to `docKeep` words. */
function expectedLogit(query: string, doc: string, docKeep = Infinity): number {
  const q = ids(query);
  const d = ids(doc).slice(0, docKeep);
  const idSum = 2 + q.reduce((a, b) => a + b, 0) + 3 + d.reduce((a, b) => a + b, 0) + 3;
  const typeSum = d.length + 1; // document tokens and the final [SEP] have type 1
  return 0.01 * (idSum + typeSum);
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "onnx-local-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const never = new AbortController().signal;

// ---- tests ------------------------------------------------------------------

test("the WordLevel fixture tokenizer yields pair type ids", async () => {
  const tok = Tokenizer.fromString(tokenizerJson());
  tok.disableTruncation();
  const enc = await tok.encode("alpha beta", "gamma");
  assert.deepEqual(enc.getIds(), [2, 4, 5, 3, 6, 3]);
  assert.deepEqual(enc.getTypeIds(), [0, 0, 0, 0, 1, 1]);
});

test("truncateInput trims the second sequence first, then the first, keeping specials", () => {
  const input = { ids: [2, 10, 11, 3, 20, 21, 22, 3], typeIds: [0, 0, 0, 0, 1, 1, 1, 1], sequenceIds: [null, 0, 0, null, 1, 1, 1, null] };
  assert.deepEqual(truncateInput(input, 6).ids, [2, 10, 11, 3, 20, 3]);
  assert.deepEqual(truncateInput(input, 4).ids, [2, 10, 3, 3]);
  assert.equal(truncateInput(input, 20), input);
});

test("LocalCrossEncoder: not ready before warm, then scores in input order with batching and padding", async () => {
  await withTemp(async (root) => {
    const dir = await modelDir(root, "cross", crossEncoderModel("one"), { pad_token_id: 7 });
    const docs = ["alpha", "beta gamma delta epsilon", "zeta", "kappa iota theta eta zeta", "unknownword beta"];
    const query = "alpha beta";
    const enc = new LocalCrossEncoder(provider({ modelDir: dir, batchSize: 2 }), { cacheRoot: join(root, "cache") });
    await assert.rejects(enc.score(query, docs, never), ProviderNotReadyError);
    await enc.warm();
    assert.equal(enc.ready(), true);
    const scores = await enc.score(query, docs, never);
    assert.equal(scores.length, docs.length);
    docs.forEach((d, i) => assert.ok(Math.abs(scores[i]! - sigmoid(expectedLogit(query, d))) < 1e-6, `doc ${i}`));
    // Batching does not change scores.
    const one = new LocalCrossEncoder(provider({ modelDir: dir, batchSize: 1 }), { cacheRoot: join(root, "cache") });
    await one.warm();
    assert.deepEqual(
      (await one.score(query, docs, never)).map((s) => s.toFixed(6)),
      scores.map((s) => s.toFixed(6)),
    );
    await one.close();

    // Truncation trims the document, never the query.
    const short = new LocalCrossEncoder(provider({ modelDir: dir, maxTokens: 7 }), { cacheRoot: join(root, "cache") });
    await short.warm();
    const [trimmed] = await short.score(query, ["gamma delta epsilon zeta"], never);
    assert.ok(Math.abs(trimmed! - sigmoid(expectedLogit(query, "gamma delta epsilon zeta", 2))) < 1e-6);
    await short.close();

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(enc.score(query, docs, aborted.signal), { name: "AbortError" });
    const mid = new AbortController();
    const pending = enc.score(query, docs, mid.signal);
    mid.abort();
    await assert.rejects(pending, { name: "AbortError" });
    // The worker stays usable after an abandoned call.
    assert.equal((await enc.score(query, docs, never)).length, docs.length);
    await enc.close();
    await assert.rejects(enc.score(query, docs, never), ProviderNotReadyError);
  });
});

test("LocalCrossEncoder: a two-logit head scores the positive class", async () => {
  await withTemp(async (root) => {
    const dir = await modelDir(root, "cross2", crossEncoderModel("two"));
    const enc = new LocalCrossEncoder(provider({ modelDir: dir }), { cacheRoot: root });
    await enc.warm();
    const [s] = await enc.score("alpha", ["beta"], never);
    assert.ok(Math.abs(s! - sigmoid(expectedLogit("alpha", "beta") - 0.5)) < 1e-6);
    await enc.close();
  });
});

test("LocalLateEncoder: drops padding, normalizes rows, applies prefixes and budgets", async () => {
  await withTemp(async (root) => {
    const dir = await modelDir(root, "late", lateEncoderModel(), { pad_token_id: 5 });
    const enc = new LocalLateEncoder(provider({ modelDir: dir, documentPrefix: "eta ", queryPrefix: "iota ", maxTokens: 6 }), {
      cacheRoot: root,
    });
    await assert.rejects(enc.encodeQuery("alpha", 8, never), ProviderNotReadyError);
    await enc.warm();
    const texts = ["alpha", "beta gamma delta"];
    const mats = await enc.encodeDocuments(texts, never);
    const expectIds = [
      [2, VOCAB.eta!, VOCAB.alpha!, 3],
      [2, VOCAB.eta!, VOCAB.beta!, VOCAB.gamma!, VOCAB.delta!, 3],
    ];
    mats.forEach((m, i) => {
      assert.equal(m.dim, DIM);
      assert.equal(m.tokens, expectIds[i]!.length);
      expectIds[i]!.forEach((id, row) => {
        const raw = EMBED[id]!;
        const norm = Math.hypot(...raw);
        for (let k = 0; k < DIM; k++) assert.ok(Math.abs(m.data[row * DIM + k]! - raw[k]! / norm) < 1e-6);
      });
    });

    // The provider's max_tokens (6) caps the document side, keeping [SEP].
    const [long] = await enc.encodeDocuments(["alpha beta gamma delta epsilon"], never);
    assert.equal(long!.tokens, 6);
    const lastRow = Array.from(long!.data.subarray(5 * DIM, 6 * DIM));
    const sep = EMBED[3]!.map((v) => v / Math.hypot(...EMBED[3]!));
    lastRow.forEach((v, k) => assert.ok(Math.abs(v - sep[k]!) < 1e-6));

    // Query: prefix, then min(requested, provider max) tokens.
    const q = await enc.encodeQuery("alpha beta gamma", 4, never);
    assert.equal(q.tokens, 4); // [CLS] iota alpha [SEP]
    const q2 = await enc.encodeQuery("alpha", 64, never);
    assert.equal(q2.tokens, 4); // [CLS] iota alpha [SEP]
    await enc.close();

    // A separate query thread count gets its own worker; both sides agree.
    const split = new LocalLateEncoder(provider({ modelDir: dir, queryPrefix: "iota ", maxTokens: 6 }), {
      cacheRoot: root,
      threads: 1,
      queryThreads: 2,
    });
    await split.warm();
    assert.equal(split.ready(), true);
    const [doc] = await split.encodeDocuments(["iota alpha"], never);
    const sq = await split.encodeQuery("alpha", 8, never);
    assert.deepEqual(Array.from(sq.data), Array.from(doc!.data));
    await split.close();
  });
});

test("resolveModelFiles downloads a repo once into the cache (optional files best effort)", async () => {
  await withTemp(async (root) => {
    const onnx = crossEncoderModel("one");
    const served: Record<string, Buffer> = {
      "/org/tiny-reranker/resolve/main/tokenizer.json": Buffer.from(tokenizerJson()),
      "/org/tiny-reranker/resolve/main/onnx/model.onnx": Buffer.from(onnx),
      "/org/tiny-reranker/resolve/main/config.json": Buffer.from(JSON.stringify({ pad_token_id: 0 })),
    };
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const body = served[req.url ?? ""];
      if (!body) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const cacheRoot = join(root, "cache");
      const files = await resolveModelFiles({ model: "org/tiny-reranker", onnxFile: "onnx/model.onnx", cacheRoot, baseUrl });
      assert.equal(files.dir, join(cacheRoot, repoSlug("org/tiny-reranker")));
      assert.deepEqual(await readFile(files.onnxPath), Buffer.from(onnx));
      assert.ok(files.configPath);
      const required = (h: string) => /tokenizer\.json$|model\.onnx$|config\.json$/.test(h) && !h.includes("tokenizer_config");
      assert.equal(hits.filter(required).length, 3);

      await resolveModelFiles({ model: "org/tiny-reranker", onnxFile: "onnx/model.onnx", cacheRoot, baseUrl });
      assert.equal(hits.filter(required).length, 3, "existing files are never fetched again");

      // A provider loads straight from the hub cache.
      const enc = new LocalCrossEncoder(provider({ model: "org/tiny-reranker" }), { cacheRoot, baseUrl });
      await enc.warm();
      const [s] = await enc.score("alpha", ["beta"], never);
      assert.ok(Math.abs(s! - sigmoid(expectedLogit("alpha", "beta"))) < 1e-6);
      await enc.close();

      // A missing required file fails, and the provider reports not ready with a backoff.
      await assert.rejects(
        resolveModelFiles({ model: "org/missing", onnxFile: "onnx/model.onnx", cacheRoot, baseUrl }),
        /HTTP|not found/,
      );
      const broken = new LocalCrossEncoder(provider({ model: "org/missing" }), { cacheRoot, baseUrl, retryDelayMs: 60_000 });
      await broken.warm();
      assert.equal(broken.ready(), false);
      await assert.rejects(broken.score("alpha", ["beta"], never), (e: Error) => e instanceof ProviderNotReadyError && /retrying/.test(e.message));
      await broken.close();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test("resolveModelFiles with modelDir requires the files and downloads nothing", async () => {
  await withTemp(async (root) => {
    await assert.rejects(resolveModelFiles({ modelDir: root, onnxFile: "onnx/model.onnx", cacheRoot: root }), /missing/);
    const dir = await modelDir(root, "m", crossEncoderModel("one"));
    const files = await resolveModelFiles({ modelDir: dir, onnxFile: "onnx/model.onnx", cacheRoot: root });
    assert.equal(files.dir, dir);
    assert.equal(files.configPath, undefined);
    await assert.rejects(resolveModelFiles({ modelDir: dir, onnxFile: "../x.onnx", cacheRoot: root }), /relative/);
  });
});

test("model workers are isolated: concurrent models and a main-thread session keep working", async () => {
  // onnxruntime-node's binding is not context-aware; a worker *thread* loading
  // it would break other environments. Provider workers are processes.
  const ort = await import("onnxruntime-node");
  await withTemp(async (root) => {
    const dir = await modelDir(root, "iso", crossEncoderModel("one"));
    const main = await ort.InferenceSession.create(join(dir, "onnx", "model.onnx"));
    const feeds = {
      input_ids: new ort.Tensor("int64", BigInt64Array.from([2n, 4n, 3n]), [1, 3]),
      attention_mask: new ort.Tensor("int64", BigInt64Array.from([1n, 1n, 1n]), [1, 3]),
      token_type_ids: new ort.Tensor("int64", BigInt64Array.from([0n, 0n, 0n]), [1, 3]),
    };
    const before = (await main.run(feeds)).logits!.data[0];
    const a = new LocalCrossEncoder(provider({ modelDir: dir }), { cacheRoot: root, threads: 1 });
    const b = new LocalCrossEncoder(provider({ modelDir: dir }), { cacheRoot: root, threads: 1 });
    await Promise.all([a.warm(), b.warm()]);
    const [sa, sb] = await Promise.all([a.score("alpha", ["beta"], never), b.score("alpha", ["beta"], never)]);
    assert.equal(sa![0], sb![0]);
    assert.equal((await a.score("alpha", ["beta"], never))[0], sa![0]);
    assert.equal((await main.run(feeds)).logits!.data[0], before);
    await a.close();
    assert.equal((await b.score("alpha", ["beta"], never))[0], sa![0]);
    await b.close();
    assert.equal((await main.run(feeds)).logits!.data[0], before);
    await main.release();
  });
});

test("resolveModelFiles: a pinned revision has its own cache dir, sha256 is enforced, concurrent resolves share downloads", async () => {
  const { createHash } = await import("node:crypto");
  await withTemp(async (root) => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const onnx = Buffer.from(crossEncoderModel("pinned"));
    const tok = Buffer.from(tokenizerJson());
    const served: Record<string, Buffer> = {
      [`/org/pinned/resolve/${commit}/tokenizer.json`]: tok,
      [`/org/pinned/resolve/${commit}/onnx/model.onnx`]: onnx,
    };
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? "");
      const body = served[req.url ?? ""];
      if (!body) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      setTimeout(() => res.end(body), 30);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    try {
      const cacheRoot = join(root, "cache");
      const opts = { model: "org/pinned", revision: commit, onnxFile: "onnx/model.onnx", cacheRoot, baseUrl, sha256: { "onnx/model.onnx": sha(onnx) } };
      const [a, b] = await Promise.all([resolveModelFiles(opts), resolveModelFiles(opts)]);
      assert.equal(a.dir, b.dir);
      assert.equal(a.dir, join(cacheRoot, `${repoSlug("org/pinned")}@${commit.slice(0, 12)}`));
      assert.equal(hits.filter((h) => h.endsWith("model.onnx")).length, 1, "one download for two concurrent resolves");
      assert.ok(hits.every((h) => h.includes(`/resolve/${commit}/`)), "every file comes from the pinned commit");
      // A wrong digest refuses the download (and leaves nothing behind that later looks complete).
      const bad = { ...opts, cacheRoot: join(root, "cache2"), sha256: { "onnx/model.onnx": "0".repeat(64) } };
      await assert.rejects(resolveModelFiles(bad), /checksum mismatch/);
      await assert.rejects(resolveModelFiles(bad), /checksum mismatch/);
      // A model_dir file is checked too.
      await assert.rejects(resolveModelFiles({ modelDir: a.dir, onnxFile: "onnx/model.onnx", cacheRoot, sha256: { "tokenizer.json": "1".repeat(64) } }), /checksum mismatch/);
      await resolveModelFiles({ modelDir: a.dir, onnxFile: "onnx/model.onnx", cacheRoot, sha256: { "tokenizer.json": sha(tok) } });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

test("LocalLateEncoder: a projected ColBERT output is preferred over last_hidden_state", async () => {
  await withTemp(async (root) => {
    for (const name of ["token_embeddings", "linear_out"]) {
      const dir = await modelDir(root, `late-${name}`, lateEncoderModel({ projected: name }), { pad_token_id: 5 });
      const enc = new LocalLateEncoder(provider({ modelDir: dir, maxTokens: 6 }), { cacheRoot: root });
      await enc.warm();
      const [m] = await enc.encodeDocuments(["alpha"], never);
      const raw = EMBED[VOCAB.alpha!]!;
      const norm = Math.hypot(...raw);
      for (let k = 0; k < DIM; k++) assert.ok(Math.abs(m!.data[1 * DIM + k]! + raw[k]! / norm) < 1e-6, `${name}: the projected (negated) vectors`);
      await enc.close();
    }
  });
});
