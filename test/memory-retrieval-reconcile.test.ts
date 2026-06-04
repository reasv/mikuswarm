import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { buildFtsMatch } from "../src/retrieval/index.js";
import type { MemoryChunkInput } from "../src/storage/index.js";

async function withStorage(run: (storage: Storage) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-reconcile-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  try {
    await run(storage);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A chunk id is sha256(path\0text), so two byte-identical chunks in one file
// share an id (reachable via repetitive imported content or coinciding
// splitByTokens windows). Pre-fix, the second occurrence saw `prev === undefined`
// from the pre-read snapshot and ran the insert again → UNIQUE constraint failed,
// rolling back the whole reconcile transaction (review issue #1).
test("reconcile dedupes byte-identical chunks sharing an id (review #1)", async () => {
  await withStorage(async (storage) => {
    const dupChunk: MemoryChunkInput = {
      id: "dup-id",
      path: "memory/2026-04-12.md",
      ordinal: 0,
      source: "memory",
      startLine: 1,
      endLine: 2,
      room: "#general",
      entryTs: Date.parse("2026-04-12T15:00:00Z"),
      text: "We talked about pangolins twice.",
      tokenCount: 6,
      contentHash: "dup-hash",
    };

    // Two entries with the SAME id (byte-identical text). Pre-fix this threw
    // `UNIQUE constraint failed: memory_chunks.id`.
    const result = await storage.reconcileMemoryChunks("memory/2026-04-12.md", [
      dupChunk,
      { ...dupChunk, ordinal: 1, startLine: 3, endLine: 4 },
    ]);
    await storage.waitForIdle();

    // The dedup is reflected in the inserted count: one logical row, not two.
    assert.equal(result.inserted, 1, "only the first occurrence of a duplicate id is inserted");
    assert.equal(result.updated, 0);
    assert.equal(result.deleted, 0);

    // Exactly one physical row exists for that id.
    const hits = storage.searchMemoryLexical({ match: buildFtsMatch("pangolins")!, limit: 10 });
    const forId = hits.filter((h) => h.id === "dup-id");
    assert.equal(forId.length, 1, "exactly one memory_chunks row exists for the duplicated id");

    // Bonus: a follow-up reconcile of the same file is idempotent — the surviving
    // row already matches the first occurrence (ordinal 0, lines 1-2), so no
    // spurious insert/update/delete and still no throw.
    const again = await storage.reconcileMemoryChunks("memory/2026-04-12.md", [
      dupChunk,
      { ...dupChunk, ordinal: 1, startLine: 3, endLine: 4 },
    ]);
    await storage.waitForIdle();
    assert.equal(again.inserted, 0, "idempotent reconcile inserts nothing");
    assert.equal(again.updated, 0, "idempotent reconcile updates nothing");
    assert.equal(again.deleted, 0, "idempotent reconcile deletes nothing");

    const hitsAfter = storage.searchMemoryLexical({ match: buildFtsMatch("pangolins")!, limit: 10 });
    assert.equal(hitsAfter.filter((h) => h.id === "dup-id").length, 1);
  });
});
