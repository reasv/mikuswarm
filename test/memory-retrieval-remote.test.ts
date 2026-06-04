import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AddressInfo } from "node:net";
import { Storage } from "../src/storage/index.js";
import {
  VectorStore,
  RemoteEmbeddingProvider,
  createRetrievalSubsystem,
  resolveRetrievalConfig,
} from "../src/retrieval/index.js";

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
