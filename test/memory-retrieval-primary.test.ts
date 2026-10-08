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
import { runIsolating } from "../src/retrieval/isolate.js";

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

test("primary index: an outage blames no chunk (the worker slows down instead), queries never lose a chunk", async () => {
  await primaryFixture(async ({ storage, store, builtin, builtinStore }) => {
    const clock = 1_000_000;
    const provider = new Flaky("gpu:big", 2);
    const vs = new VectorStore(storage, undefined, PRIMARY_INDEX_SLUG);
    const primary = new PrimaryIndex({ storage, store, provider, vectorStore: vs, timeoutMs: 500, batchSize: 1, now: () => clock });
    await primary.init();
    // The outage: the batch fails and so does the canary.
    assert.equal(await primary.batch(), 0);
    assert.equal(provider.failuresLeft, 0, "one batch request and one canary");
    assert.equal(store.indexFailureCount("vec:gpu:big"), 0, "an outage blames no chunk");
    assert.equal(primary.ready, false, "an index missing chunks is not complete");
    const index = dualVectorIndex({ provider: builtin, store: builtinStore }, primary)!;
    const before = await index.query("pancake", 5);
    assert.equal(before!.index, "builtin", "queries stay on the built-in index, which has every chunk");
    assert.ok(before!.hits.length > 0);
    // The provider is back: nothing waits for a backoff.
    while ((await primary.batch()) > 0);
    await primary.batch();
    assert.equal(primary.ready, true);
    const after = await index.query("pancake", 5);
    assert.equal(after!.index, "primary");
    assert.ok(after!.hits.length > 0, "the chunk the outage hit is found");
  });
});

/** Rejects any batch holding a poison chunk; serves the canary and every other input. */
class Poison extends Toy {
  requests = 0;
  constructor(modelId: string, private readonly poison: (text: string) => boolean) {
    super(modelId);
  }
  override async embedDocuments(texts: string[]) {
    this.requests += 1;
    if (texts.some(this.poison)) throw new Error("400 input rejected");
    return super.embedDocuments(texts);
  }
}

test("primary index: one bad chunk is isolated (its batch-mates are stored at once) and, after its tries, given up", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-poison-"));
  const root = path.join(dir, "ws");
  await mkdir(path.join(root, "memory"), { recursive: true });
  const paras = ["alpha about pancakes", "POISON block here", "gamma about gardens", "delta about chess", "epsilon about rain"];
  for (const [i, t] of paras.entries()) await writeFile(path.join(root, "memory", `n${i}.md`), t + "\n");
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const config = resolveRetrievalConfig({ enabled: true });
    await new MemoryIndexer({ storage, workspaceRoot: root, config, tokenizer: new GptTokenizer() }).reconcileAll();
    const store = new MemoryRetrievalStore(storage);
    let clock = 1_000_000;
    const vs = new VectorStore(storage, undefined, PRIMARY_INDEX_SLUG);
    const provider = new Poison("gpu:x", (t) => t.includes("POISON"));
    const primary = new PrimaryIndex({ storage, store, provider, vectorStore: vs, timeoutMs: 500, batchSize: 8, now: () => clock });
    await primary.init();
    assert.equal(store.countMissingFromVectorTable(vs.table), 5);
    assert.equal(await primary.batch(), 4, "the innocent chunks are stored in the same pass");
    assert.equal(store.indexFailureCount("vec:gpu:x"), 1, "only the bad chunk is blamed");
    assert.ok(provider.requests <= 2 * 5 - 1 + 1, "a bisect, not a request per poll");
    assert.equal(await primary.batch(), 0, "the bad chunk waits for its backoff");
    assert.equal(primary.ready, false, "a chunk short of its tries keeps the primary incomplete");
    for (let round = 0; round < 10; round++) {
      clock += 2 * 3_600_000;
      while ((await primary.batch()) > 0);
    }
    assert.equal(store.unembeddableCount("vec:gpu:x"), 1, "the bad chunk is unembeddable for this model");
    const requests = provider.requests;
    clock += 2 * 3_600_000;
    await primary.batch();
    assert.equal(provider.requests, requests, "an unembeddable chunk is never retried");
    assert.equal(store.countMissingFromVectorTable(vs.table), 1, "only the bad chunk is missing");
    assert.equal(primary.ready, true, "and it no longer blocks the primary");
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("primary index: a model change forgets unembeddable chunks (the new model retries them)", async () => {
  await primaryFixture(async ({ storage, store }) => {
    const vs = new VectorStore(storage, undefined, PRIMARY_INDEX_SLUG);
    const bad = new PrimaryIndex({ storage, store, provider: new Poison("gpu:a", (t) => t.includes("garden")), vectorStore: vs, timeoutMs: 500, batchSize: 8, giveUpAttempts: 1 });
    await bad.init();
    await bad.batch();
    await bad.batch();
    assert.equal(bad.ready, true);
    assert.equal(store.unembeddableCount("vec:gpu:a", 1), 1);
    const next = new PrimaryIndex({ storage, store, provider: new Toy("gpu:b"), vectorStore: vs, timeoutMs: 500, batchSize: 8 });
    await next.init();
    while ((await next.batch()) > 0);
    await next.batch();
    assert.equal(next.ready, true);
    assert.equal(store.countMissingFromVectorTable(vs.table), 0, "the new model embeds every chunk");
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

test("isolation: a bisect finds every bad item of a failed batch; an outage blames none", async () => {
  const items = ["a", "X1", "b", "c", "d", "X2", "e"];
  const run = async (list: string[]) => {
    if (list.some((t) => t.startsWith("X"))) throw new Error("bad input");
    return list.map((t) => t.toUpperCase());
  };
  const res = await runIsolating(items, run, async () => "ok");
  assert.deepEqual(res.bad.map((b) => b.item).sort(), ["X1", "X2"]);
  assert.deepEqual(res.ok.map((o) => o.item).sort(), ["a", "b", "c", "d", "e"]);
  assert.equal(res.outage, undefined);
  const down = await runIsolating(items, async () => { throw new Error("502"); }, async () => { throw new Error("502"); });
  assert.equal(down.outage, "502");
  assert.equal(down.bad.length + down.ok.length, 0);
});
