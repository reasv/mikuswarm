import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AddressInfo } from "node:net";
import { Storage } from "../src/storage/index.js";
import type { LlmScheduler } from "../src/agent/scheduler.js";
import {
  MemoryIndexer,
  VectorStore,
  RemoteEmbeddingProvider,
  LocalEmbeddingProvider,
  createRetrievalSubsystem,
  resolveRetrievalConfig,
} from "../src/retrieval/index.js";
import { GptTokenizer } from "../src/context/tokenizer/index.js";

async function withStorage(run: (s: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-remote-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("RemoteEmbeddingProvider posts OpenAI-shaped requests and normalizes vectors", async () => {
  const seen: { url?: string; auth?: string; body?: any } = {};
  const server = http.createServer((req, res) => {
    let chunks = "";
    req.on("data", (c) => (chunks += c));
    req.on("end", () => {
      seen.url = req.url;
      seen.auth = req.headers.authorization;
      seen.body = JSON.parse(chunks);
      const input: string[] = seen.body.input;
      // Return 4-dim vectors; index out-of-order to verify the provider re-sorts.
      const data = input.map((_t, i) => ({
        embedding: [i + 1, 0, 0, 0],
        index: input.length - 1 - i,
      }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret-key",
      dim: 4,
      batchSize: 8,
    });
    const vecs = await provider.embedDocuments(["alpha", "beta"]);
    assert.equal(seen.url, "/v1/embeddings");
    assert.equal(seen.auth, "Bearer secret-key");
    assert.equal(seen.body.model, "test-embed");
    assert.deepEqual(seen.body.input, ["alpha", "beta"]);
    assert.equal(seen.body.encoding_format, "float");
    // Re-sorted by index: input[0]="alpha" got index 1 (embedding [2,0,0,0] → normalized [1,0,0,0]).
    assert.equal(vecs.length, 2);
    assert.ok(Math.abs(vecs[0]![0]! - 1) < 1e-6, "normalized to unit length");
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("RemoteEmbeddingProvider rejects a dim mismatch", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: [1, 2, 3], index: 0 }] })); // dim 3, not 4
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
    });
    await assert.rejects(() => provider.embedQuery("x"), /dim 3 != configured 4/);
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("RemoteEmbeddingProvider throws on a short/partial response instead of misaligning", async () => {
  // Respond with ONE vector for a TWO-input batch (a truncated/partial response).
  // Without count validation the provider would silently return a single vector,
  // mis-mapping it to the wrong content-hash; it must throw so the batch retries.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
    });
    await assert.rejects(
      () => provider.embedDocuments(["alpha", "beta"]),
      /returned 1 vectors for 2 inputs/,
    );
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("RemoteEmbeddingProvider throws on an out-of-range / duplicated index", async () => {
  // Two inputs, two vectors, but both at index 0 (a duplicated-index response):
  // would leave one slot empty and overwrite the other → misalignment. Must throw.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          data: [
            { embedding: [1, 0, 0, 0], index: 0 },
            { embedding: [0, 1, 0, 0], index: 0 },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
    });
    await assert.rejects(
      () => provider.embedDocuments(["alpha", "beta"]),
      /duplicate index 0/,
    );
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("RemoteEmbeddingProvider: a scheduler queue wait does not burn the HTTP timeout (#10)", async () => {
  // Admission takes LONGER than timeoutMs. Before the fix the timer was armed
  // before acquire (and its controller doubled as the acquire signal), so the
  // queue wait aborted the request before the fetch ever started. Now the
  // timeout is armed only once admitted, so the request succeeds.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const scheduler = {
      acquire: async () => {
        await new Promise((r) => setTimeout(r, 120));
        return () => {};
      },
      noteOutcome: () => {},
    } as unknown as LlmScheduler;
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
      timeoutMs: 50,
      scheduler,
    });
    const vec = await provider.embedQuery("x");
    assert.equal(vec.length, 4);
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("RemoteEmbeddingProvider: a rejected admission leaks no stop-signal listener or timer (#10)", async () => {
  const scheduler = {
    acquire: async () => {
      throw new Error("LLM scheduler stopped");
    },
    noteOutcome: () => {},
  } as unknown as LlmScheduler;
  const provider = new RemoteEmbeddingProvider({
    id: "test-embed",
    endpoint: "http://127.0.0.1:9",
    apiKey: "k",
    dim: 4,
    batchSize: 8,
    scheduler,
  });
  const controller = new AbortController();
  await assert.rejects(() => provider.embedDocuments(["x"], controller.signal), /scheduler stopped/);
  assert.equal(
    getEventListeners(controller.signal, "abort").length,
    0,
    "the stop-signal abort listener must not leak on admission rejection",
  );
  await provider.close();
});

test("RemoteEmbeddingProvider feeds status + Retry-After to the scheduler backoff (#9)", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.statusCode = 429;
      res.setHeader("retry-after", "7");
      res.end("slow down");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const noted: Array<[string, string | undefined, string | undefined, number | undefined, number | undefined]> = [];
    const scheduler = {
      acquire: async () => () => {},
      noteOutcome: (
        group: string,
        modelKey: string | undefined,
        classification: string | undefined,
        status: number | undefined,
        retryAfterMs: number | undefined,
      ) => {
        noted.push([group, modelKey, classification, status, retryAfterMs]);
      },
    } as unknown as LlmScheduler;
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
      scheduler,
    });
    await assert.rejects(() => provider.embedQuery("x"), /status 429/);
    assert.deepEqual(noted, [
      ["default", `http://127.0.0.1:${port}::test-embed`, "environmental", 429, 7000],
    ]);
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("RemoteEmbeddingProvider feeds noteOutcome environmental on a THROWN fetch (#5)", async () => {
  // A fetch that THROWS (here: connection refused — nothing listening on the
  // port) never reaches the response-path noteOutcome, so before the fix a
  // hard-down endpoint never accrued a health streak. The catch must feed the
  // model-health streak with an environmental outcome and re-throw.
  const noted: Array<[string, string | undefined, string | undefined]> = [];
  const scheduler = {
    acquire: async () => () => {},
    noteOutcome: (group: string, modelKey: string | undefined, classification: string | undefined) => {
      noted.push([group, modelKey, classification]);
    },
  } as unknown as LlmScheduler;
  const provider = new RemoteEmbeddingProvider({
    id: "test-embed",
    // Reserved-discard port 9 with nothing bound → connect refused → fetch throws.
    endpoint: "http://127.0.0.1:9",
    apiKey: "k",
    dim: 4,
    batchSize: 8,
    timeoutMs: 2000,
    scheduler,
  });
  await assert.rejects(() => provider.embedQuery("x"));
  assert.equal(noted.length, 1, "exactly one outcome fed for the thrown fetch");
  assert.equal(noted[0]![2], "environmental", "thrown fetch counts as environmental");
  assert.equal(noted[0]![1], "http://127.0.0.1:9::test-embed");
  await provider.close();
});

test("RemoteEmbeddingProvider: a stop-signal abort during fetch stays NEUTRAL (#5)", async () => {
  // A fetch aborted by the EXTERNAL stop signal (shutdown) is a neutral event,
  // not an environmental streak hit. Server hangs without responding; the stop
  // signal aborts the in-flight fetch — noteOutcome must NOT be called.
  const server = http.createServer(() => {
    /* never respond — leave the request hanging until the stop-signal abort */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const noted: unknown[] = [];
    const scheduler = {
      acquire: async () => () => {},
      noteOutcome: (...args: unknown[]) => {
        noted.push(args);
      },
    } as unknown as LlmScheduler;
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
      // Long timeout so the stop signal (not the per-request timeout) is what aborts.
      timeoutMs: 30_000,
      scheduler,
    });
    const stop = new AbortController();
    const pending = provider.embedDocuments(["x"], stop.signal);
    // Let the fetch start, then trigger shutdown.
    setTimeout(() => stop.abort(), 50);
    await assert.rejects(() => pending);
    assert.equal(noted.length, 0, "a stop-signal abort must not feed the health streak");
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("LocalEmbeddingProvider throws when passageEmbed returns the wrong vector count (#6)", async () => {
  // The local provider binds out[i] to texts[i]'s content-hash positionally; a
  // fastembed under-count/reorder would silently misalign vectors with hashes. Inject
  // a fake `flag` whose passageEmbed yields one vector for two inputs and assert the
  // descriptive count guard throws (the native fastembed module is not exercised).
  const provider = new LocalEmbeddingProvider({
    model: "bge-small-en-v1.5",
    dim: 4,
    cacheDir: "/tmp/none",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).flag = Promise.resolve({
    // Two inputs in, but only one vector out.
    async *passageEmbed(_texts: string[], _batchSize: number) {
      yield [[1, 0, 0, 0]];
    },
  });
  await assert.rejects(
    () => provider.embedDocuments(["alpha", "beta"]),
    /returned 1 vectors for 2 inputs/,
  );
});

test("RemoteEmbeddingProvider throws a descriptive error on a malformed embedding element (#7)", async () => {
  // An element whose `embedding` is missing/non-array would raw-TypeError on `.length`;
  // the provider must throw the descriptive "malformed embedding element" error so it
  // routes through the normal retry path with a clear log instead.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ embedding: null, index: 0 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
    });
    await assert.rejects(
      () => provider.embedQuery("x"),
      /malformed embedding element at index 0/,
    );
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("RemoteEmbeddingProvider rejects an absurdly large content-length before reading the body (#7)", async () => {
  // The abort timeout bounds wall-clock, not bytes. A misbehaving endpoint advertising
  // a huge body must be rejected before we buffer it.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      // Advertise an absurd length, then send a small valid body. The guard should fire
      // on the header before reading.
      res.setHeader("content-length", String(1024 * 1024 * 1024)); // 1 GiB
      res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0], index: 0 }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const provider = new RemoteEmbeddingProvider({
      id: "test-embed",
      endpoint: `http://127.0.0.1:${port}`,
      apiKey: "k",
      dim: 4,
      batchSize: 8,
    });
    await assert.rejects(() => provider.embedQuery("x"), /response too large/);
    await provider.close();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("VectorStore.ensureSchema flags model swaps and dim changes (active-model invariant)", async () => {
  await withStorage(async (storage) => {
    const vs = new VectorStore(storage);
    const first = await vs.ensureSchema(4, "model-a");
    assert.deepEqual(first, { recreated: false, modelChanged: false });

    // Same dim, different model → modelChanged (cross-space; caller must re-embed).
    const swap = await vs.ensureSchema(4, "model-b");
    assert.equal(swap.modelChanged, true);
    assert.equal(swap.recreated, false);

    // Different dim → table dropped + recreated.
    const dim = await vs.ensureSchema(8, "model-b");
    assert.equal(dim.recreated, true);
    assert.equal(storage.getIndexMeta("active_dim"), "8");
    assert.equal(storage.getIndexMeta("active_model_id"), "model-b");
  });
});

test("resetAllEmbeddings re-queues embedded chunks for the new model", async () => {
  await withStorage(async (storage) => {
    await storage.reconcileMemoryChunks("memory/x.md", [
      {
        id: "a",
        path: "memory/x.md",
        ordinal: 0,
        source: "memory",
        startLine: 1,
        endLine: 2,
        room: null,
        entryTs: 1,
        text: "hello world",
        tokenCount: 2,
        contentHash: "h-a",
      },
    ]);
    const row = storage.read(
      (db) => db.prepare("select rowid from memory_chunks where id='a'").get() as { rowid: number },
    );
    await storage.setEmbedDone(row.rowid, "model-a");
    assert.equal(storage.countPendingEmbedding(), 0);

    const requeued = await storage.resetAllEmbeddings();
    assert.equal(requeued, 1);
    assert.equal(storage.countPendingEmbedding(), 1);
    const after = storage.read(
      (db) => db.prepare("select model_id from memory_chunks where id='a'").get() as { model_id: string | null },
    );
    assert.equal(after.model_id, null);
  });
});

test("subsystem fail-fast: provider=remote with no remote block throws", async () => {
  await withStorage(async (storage) => {
    const config = resolveRetrievalConfig({ enabled: true, embedding: { provider: "remote" } });
    await assert.rejects(
      () =>
        createRetrievalSubsystem({
          storage,
          workspaceRoot: "/tmp/nope",
          dataDir: "/tmp/nope-data",
          config,
        }),
      /no resolvable \[retrieval\.embedding\.remote\] block/,
    );
  });
});

// #19: a CONFIGURED-but-unreachable remote endpoint must fail startup loudly via a
// boot probe, not silently degrade to lexical-only. Before the fix, the provider was
// created but never called at boot, so an unreachable endpoint was caught and
// swallowed into lexical-only mode.
test("subsystem fail-fast: configured remote that errors on probe rejects at boot", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end("upstream exploded");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    await withStorage(async (storage) => {
      const config = resolveRetrievalConfig({
        enabled: true,
        embedding: {
          provider: "remote",
          remote: {
            id: "test-embed",
            endpoint: `http://127.0.0.1:${port}/v1`,
            api_key: "k",
            dim: 4,
          },
        },
      });
      await assert.rejects(
        () =>
          createRetrievalSubsystem({
            storage,
            workspaceRoot: "/tmp/nope",
            dataDir: "/tmp/nope-data",
            config,
          }),
        /configured but unreachable/,
      );
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

// #2: in lexical-only mode (no active provider) the reconciler must stamp new chunks
// 'skip', not 'pending' — otherwise the pending queue grows forever with work nothing
// will ever process. Drives the real indexer over an on-disk memory file so the
// embeddingsActive → 'skip' wiring is exercised end to end.
test("indexer stamps new chunks 'skip' when embeddings are inactive (#2)", async () => {
  const ws = await mkdtemp(path.join(os.tmpdir(), "miku-skip-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(ws, "memory"), { recursive: true });
  await writeFile(
    path.join(ws, "memory", "2026-06-03.md"),
    "# 2026-06-03\n\n## 09:00 → 09:05 · UTC · #general\nLexical-only diary entry.\n",
  );
  try {
    await withStorage(async (storage) => {
      // Lexical-only: embeddingsActive() === false.
      const skipIndexer = new MemoryIndexer({
        storage,
        workspaceRoot: ws,
        config: resolveRetrievalConfig({ enabled: true }),
        tokenizer: new GptTokenizer(),
        embeddingsActive: () => false,
      });
      await skipIndexer.reconcileAll();
      assert.ok(storage.listMemoryChunkPaths().includes("memory/2026-06-03.md"));
      assert.equal(storage.countPendingEmbedding(), 0, "no pending chunks in lexical-only mode");
      const statuses = storage.read(
        (db) =>
          db.prepare("select embed_status from memory_chunks").all() as Array<{
            embed_status: string;
          }>,
      );
      assert.ok(statuses.length > 0);
      assert.ok(
        statuses.every((r) => r.embed_status === "skip"),
        "all chunks stamped 'skip'",
      );
    });

    // And the provider-present default (embeddingsActive true) stamps 'pending'.
    await withStorage(async (storage) => {
      const activeIndexer = new MemoryIndexer({
        storage,
        workspaceRoot: ws,
        config: resolveRetrievalConfig({ enabled: true }),
        tokenizer: new GptTokenizer(),
        embeddingsActive: () => true,
      });
      await activeIndexer.reconcileAll();
      assert.ok(storage.countPendingEmbedding() > 0, "provider-present path keeps 'pending'");
    });
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
});

// #2 (round-trip): skipPendingEmbedding converts a stale 'pending' backlog to 'skip',
// and resetAllEmbeddings re-queues those 'skip' rows when a provider returns.
test("skipPendingEmbedding drains the queue; resetAllEmbeddings re-queues skip rows (#2)", async () => {
  await withStorage(async (storage) => {
    await storage.reconcileMemoryChunks("memory/x.md", [
      {
        id: "a",
        path: "memory/x.md",
        ordinal: 0,
        source: "memory",
        startLine: 1,
        endLine: 2,
        room: null,
        entryTs: 1,
        text: "hello",
        tokenCount: 1,
        contentHash: "h-a",
      },
    ]);
    assert.equal(storage.countPendingEmbedding(), 1);
    const skipped = await storage.skipPendingEmbedding();
    assert.equal(skipped, 1);
    assert.equal(storage.countPendingEmbedding(), 0);
    const requeued = await storage.resetAllEmbeddings();
    assert.equal(requeued, 1);
    assert.equal(storage.countPendingEmbedding(), 1);
  });
});

// #3: a same-dim model swap must EMPTY memory_vec so KNN never compares new-model
// query vectors against leftover old-model rows mid-reindex.
test("ensureSchema empties memory_vec on a same-dim model swap (#3)", async () => {
  await withStorage(async (storage) => {
    const vs = new VectorStore(storage);
    await vs.ensureSchema(4, "model-a");
    // Seed a vector under model-a.
    await vs.upsert(1, "memory", new Float32Array([1, 0, 0, 0]));
    let count = storage.read(
      (db) => (db.prepare("select count(*) as n from memory_vec").get() as { n: number }).n,
    );
    assert.equal(count, 1);

    // Same dim, different model id → table kept (dim unchanged) but must be cleared.
    const swap = await vs.ensureSchema(4, "model-b");
    assert.equal(swap.modelChanged, true);
    assert.equal(swap.recreated, false);
    count = storage.read(
      (db) => (db.prepare("select count(*) as n from memory_vec").get() as { n: number }).n,
    );
    assert.equal(count, 0, "old-model vectors cleared on same-dim swap");
  });
});

// #8: an orphan memory_vec row (chunk deleted by reconcile after pruneVectors but
// before the worker's upsert) is removed by the startup sweep; valid rows are kept.
test("sweepOrphanVectors deletes vectors with no owning chunk (#8)", async () => {
  await withStorage(async (storage) => {
    const vs = new VectorStore(storage);
    await vs.ensureSchema(4, "model-a");
    // A real chunk (rowid assigned) plus its vector.
    await storage.reconcileMemoryChunks("memory/x.md", [
      {
        id: "live",
        path: "memory/x.md",
        ordinal: 0,
        source: "memory",
        startLine: 1,
        endLine: 2,
        room: null,
        entryTs: 1,
        text: "live chunk",
        tokenCount: 2,
        contentHash: "h-live",
      },
    ]);
    const liveRowid = storage.read(
      (db) =>
        (db.prepare("select rowid from memory_chunks where id='live'").get() as { rowid: number })
          .rowid,
    );
    await vs.upsert(liveRowid, "memory", new Float32Array([1, 0, 0, 0]));
    // An orphan vector: a chunk_id with no memory_chunks row.
    await vs.upsert(999999, "memory", new Float32Array([0, 1, 0, 0]));

    const before = storage.read(
      (db) => (db.prepare("select count(*) as n from memory_vec").get() as { n: number }).n,
    );
    assert.equal(before, 2);

    const swept = await storage.sweepOrphanVectors();
    assert.equal(swept, 1, "exactly the orphan removed");

    const rows = storage.read(
      (db) =>
        db.prepare("select chunk_id from memory_vec").all() as Array<{ chunk_id: number }>,
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0]!.chunk_id), liveRowid, "live vector retained");
  });
});

// #8 (no-op guard): sweep must not throw when memory_vec doesn't exist (lexical-only).
test("sweepOrphanVectors is a no-op when memory_vec is absent (#8)", async () => {
  await withStorage(async (storage) => {
    const swept = await storage.sweepOrphanVectors();
    assert.equal(swept, 0);
  });
});
