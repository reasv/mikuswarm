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
