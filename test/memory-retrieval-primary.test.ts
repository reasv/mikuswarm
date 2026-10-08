/**
 * Two vector indexes (ARCHITECTURE.md §9d): the built-in index always serves
 * when the primary embedder is incomplete, slow or down; the primary fills its
 * own index in the background (with the shared embedding cache) and is used
 * once complete and answering in time.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryIndexer, MemorySearch, VectorStore, EmbedWorkerPool, resolveRetrievalConfig, l2normalize, type EmbeddingProvider } from "../src/retrieval/index.js";
import { GptTokenizer } from "../src/context/tokenizer/index.js";
import { MemoryRetrievalStore } from "../src/storage/memory-retrieval-store.js";
import { PrimaryIndex, PRIMARY_INDEX_SLUG, dualVectorIndex } from "../src/retrieval/embedding/primary.js";

const KEYWORDS = ["pancake", "garden", "chess", "rain"];

class Toy implements EmbeddingProvider {
  constructor(
    readonly modelId: string,
    readonly dim = KEYWORDS.length,
    private readonly opts: { delayMs?: number; fail?: boolean } = {},
  ) {}
  calls = 0;
  private vec(t: string) {
    return l2normalize(KEYWORDS.map((k) => (t.toLowerCase().includes(k) ? 1 : 0.01)));
  }
  async embedDocuments(texts: string[]) {
    this.calls += texts.length;
    return texts.map((t) => this.vec(t));
  }
  async embedQuery(text: string, signal?: AbortSignal) {
    if (this.opts.fail) throw new Error("down");
    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    return this.vec(text);
  }
  async close() {}
}

test("dual index: primary used once complete and in time; built-in otherwise", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-primary-"));
  const root = path.join(dir, "ws");
  await mkdir(path.join(root, "memory"), { recursive: true });
  await writeFile(path.join(root, "memory", "notes.md"), "pancake breakfast\n\nAnother paragraph about the garden.\n");
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const config = resolveRetrievalConfig({ enabled: true });
    const indexer = new MemoryIndexer({ storage, workspaceRoot: root, config, tokenizer: new GptTokenizer() });
    await indexer.reconcileAll();
    const builtin = new Toy("local:toy");
    const builtinStore = new VectorStore(storage);
    await builtinStore.ensureSchema(builtin.dim, builtin.modelId);
    const embed = new EmbedWorkerPool({ storage, vectorStore: builtinStore, provider: builtin, config });
    await embed.start();
    await new Promise((r) => setTimeout(r, 200));
    await embed.stop();

    const store = new MemoryRetrievalStore(storage);
    const make = async (provider: Toy) => {
      const vs = new VectorStore(storage, undefined, PRIMARY_INDEX_SLUG);
      const p = new PrimaryIndex({ storage, store, provider, vectorStore: vs, timeoutMs: 50, batchSize: 8 });
      await p.init();
      return p;
    };
    const fast = await make(new Toy("gpu:big"));
    const index = dualVectorIndex({ provider: builtin, store: builtinStore }, fast);
    // Not complete yet → built-in.
    assert.equal((await index!.query("pancake", 5))!.index, "builtin");
    while ((await fast.batch()) > 0);
    await fast.batch();
    assert.equal(fast.ready, true);
    assert.equal(builtinStore.table, "memory_vec");
    assert.equal((await index!.query("pancake", 5))!.index, "primary");
    const search = new MemorySearch(storage, indexer, config, { vectorIndex: index });
    const out = await search.searchScored({ query: "pancake", limit: 5, minScore: 0 });
    assert.equal(out.vectorIndex, "primary");

    // A slow primary falls back to the built-in index within its deadline.
    const slowProvider = new Toy("gpu:big", undefined, { delayMs: 500 });
    const slow = await make(slowProvider);
    while ((await slow.batch()) > 0);
    await slow.batch();
    const started = Date.now();
    const r = await dualVectorIndex({ provider: builtin, store: builtinStore }, slow)!.query("garden", 5);
    assert.equal(r!.index, "builtin");
    assert.ok(Date.now() - started < 400);

    // A model change clears the primary index (it refills; built-in keeps serving).
    const other = await make(new Toy("gpu:other"));
    assert.equal(other.ready, false);
    assert.equal((await dualVectorIndex({ provider: builtin, store: builtinStore }, other)!.query("rain", 5))!.index, "builtin");
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("config: a primary embedder must declare zdr or self_hosted", () => {
  assert.throws(() => resolveRetrievalConfig({ enabled: true, embedding: { primary: { model: "e", dim: 8 } } } as any), /zdr = true or self_hosted = true/);
  const ok = resolveRetrievalConfig({ enabled: true, embedding: { primary: { model: "e", dim: 8, self_hosted: true } } } as any);
  assert.deepEqual(ok.embedding.primary, { model: "e", dim: 8, timeoutMs: 1000, charsPerToken: undefined });
  assert.equal(resolveRetrievalConfig({ enabled: true, embedding: { primary: { model: "e", dim: 8, zdr: true, enabled: false } } } as any).embedding.primary, null);
});

class Flaky extends Toy {
  failuresLeft: number;
  constructor(modelId: string, failures: number) {
    super(modelId);
    this.failuresLeft = failures;
  }
  override async embedDocuments(texts: string[]) {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("HTTP 502 (GPU server restarting)");
    }
    return super.embedDocuments(texts);
  }
}

async function primaryFixture(run: (f: { storage: Storage; store: MemoryRetrievalStore; builtin: Toy; builtinStore: VectorStore }) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-primary-"));
  const root = path.join(dir, "ws");
  await mkdir(path.join(root, "memory"), { recursive: true });
  await writeFile(path.join(root, "memory", "notes.md"), "pancake breakfast\n\nAnother paragraph about the garden.\n");
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const config = resolveRetrievalConfig({ enabled: true });
    await new MemoryIndexer({ storage, workspaceRoot: root, config, tokenizer: new GptTokenizer() }).reconcileAll();
    const builtin = new Toy("local:toy");
    const builtinStore = new VectorStore(storage);
    await builtinStore.ensureSchema(builtin.dim, builtin.modelId);
    const embed = new EmbedWorkerPool({ storage, vectorStore: builtinStore, provider: builtin, config });
    await embed.start();
    await new Promise((r) => setTimeout(r, 200));
    await embed.stop();
    await run({ storage, store: new MemoryRetrievalStore(storage), builtin, builtinStore });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("primary index: a short outage only delays chunks (backoff), queries never lose them, failures clear", async () => {
  await primaryFixture(async ({ storage, store, builtin, builtinStore }) => {
    let clock = 1_000_000;
    const provider = new Flaky("gpu:big", 3);
    const vs = new VectorStore(storage, undefined, PRIMARY_INDEX_SLUG);
    const primary = new PrimaryIndex({ storage, store, provider, vectorStore: vs, timeoutMs: 500, batchSize: 1, now: () => clock });
    await primary.init();
    // The outage: three failures, each retried after its backoff (1 min, then 2 min).
    await primary.batch();
    assert.equal(await primary.batch(), 0);
    assert.equal(provider.failuresLeft, 2, "a failed chunk is not retried before its backoff");
    clock += 61_000;
    await primary.batch();
    clock += 121_000;
    await primary.batch();
    assert.equal(provider.failuresLeft, 0, "the provider is healthy again");
    assert.equal(await primary.batch(), 0, "failed chunks wait for their backoff");
    assert.equal(primary.ready, false, "an index missing chunks is not complete");
    const index = dualVectorIndex({ provider: builtin, store: builtinStore }, primary)!;
    const before = await index.query("pancake", 5);
    assert.equal(before!.index, "builtin", "queries stay on the built-in index, which has every chunk");
    assert.ok(before!.hits.length > 0);
    clock += 5 * 60_000; // past the third backoff (4 min): never excluded for good
    while ((await primary.batch()) > 0);
    await primary.batch();
    assert.equal(primary.ready, true);
    assert.equal(store.indexFailureCount("vec:gpu:big"), 0, "failures clear once the chunks are in");
    const after = await index.query("pancake", 5);
    assert.equal(after!.index, "primary");
    assert.ok(after!.hits.length > 0, "the chunk the outage hit is found");
  });
});

test("dual index: a hanging primary costs the hedge delay once, then is skipped until one query probes it", async () => {
  await primaryFixture(async ({ storage, store, builtin, builtinStore }) => {
    let clock = 0;
    const slowProvider = new Toy("gpu:big", undefined, { delayMs: 400 });
    const vs = new VectorStore(storage, undefined, PRIMARY_INDEX_SLUG);
    const slow = new PrimaryIndex({ storage, store, provider: slowProvider, vectorStore: vs, timeoutMs: 5000, batchSize: 8 });
    await slow.init();
    while ((await slow.batch()) > 0);
    await slow.batch();
    assert.equal(slow.ready, true);
    const index = dualVectorIndex({ provider: builtin, store: builtinStore }, slow, undefined, { hedgeMs: 30, skipMs: 1000, now: () => clock })!;
    let t = Date.now();
    assert.equal((await index.query("garden", 5))!.index, "builtin");
    assert.ok(Date.now() - t < 300, "answered after the hedge, not the 5 s timeout");
    t = Date.now();
    assert.equal((await index.query("garden", 5))!.index, "builtin");
    assert.ok(Date.now() - t < 25, "the slow primary is skipped (no hedge wait)");
    clock += 2000;
    const [a, b] = await Promise.all([index.query("garden", 5), index.query("rain", 5)]);
    assert.deepEqual([a!.index, b!.index], ["builtin", "builtin"], "one probe; the other query does not wait");
  });
});
