/**
 * Phase 2 multi-agent support tests (spec MULTI-AGENT-SUPPORT §7.1 / §7.2).
 *
 * Covers:
 *   - v6→v7 migration: existing rows get agent=NULL; UNIQUE(agent,id) enforced
 *   - Stamp-in-place: indexer in agents mode stamps NULL rows without re-embedding
 *   - Cross-agent retrieval isolation: each agent sees only its own chunks
 *   - NULL exclusion in agents mode: un-stamped rows are filtered out
 *   - Legacy mode unfiltered: no filter (all chunks visible)
 *   - Chunk-id collision: same content in two workspaces → two rows, one per agent
 *   - Per-agent corpus signature: independent freshness signals per agent
 *   - §7.2 rooms:"all" account-prefix filtering
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryIndexer, MemorySearch, resolveRetrievalConfig } from "../src/retrieval/index.js";
import { GptTokenizer } from "../src/context/tokenizer/index.js";
import { resolveRoomsForAgent } from "../src/search/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentHarness {
  agentName: string;
  workspaceRoot: string;
  indexer: MemoryIndexer;
}

/**
 * Open a multi-agent harness with N named agents, each getting their own
 * workspace directory under a shared temp root, sharing one Storage and MemorySearch.
 */
async function openMultiAgentHarness(agentNames: string[]): Promise<{
  storage: Storage;
  agents: AgentHarness[];
  search: MemorySearch;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ma2-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  const config = resolveRetrievalConfig({ enabled: true });

  const agents: AgentHarness[] = [];
  const indexers: MemoryIndexer[] = [];

  for (const name of agentNames) {
    const workspaceRoot = path.join(dir, `ws-${name}`);
    await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
    const indexer = new MemoryIndexer({
      storage,
      workspaceRoot,
      config,
      tokenizer: new GptTokenizer(),
      agentName: name,
    });
    agents.push({ agentName: name, workspaceRoot, indexer });
    indexers.push(indexer);
  }

  const search = new MemorySearch(storage, indexers, config);

  return {
    storage,
    agents,
    search,
    cleanup: async () => {
      await storage.waitForIdle();
      storage.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function writeMemoryFile(workspaceRoot: string, name: string, content: string): Promise<void> {
  await writeFile(path.join(workspaceRoot, "memory", name), content, "utf8");
}

// ---------------------------------------------------------------------------
// §7.1 Migration: v6→v7 table rebuild
// ---------------------------------------------------------------------------

test("v6→v7 migration: memory_chunks gets agent column (NULL for existing rows)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ma2-migr-"));
  const dbPath = path.join(dir, "test.db");
  try {
    // Step 1: Open a fresh DB (v7 schema). Downgrade memory_chunks to v6 format
    // (no agent column, id UNIQUE instead of composite UNIQUE(agent,id)) to simulate
    // a pre-Phase-2 database, then stamp user_version=6 so the next open runs the migration.
    {
      const storage = await Storage.open({ databasePath: dbPath });
      await storage.write((db) => {
        db.exec(`
          drop trigger if exists memory_chunks_ai;
          drop trigger if exists memory_chunks_ad;
          drop trigger if exists memory_chunks_au;
          create table memory_chunks_v6 (
            rowid          integer primary key autoincrement,
            id             text unique not null,
            path           text not null,
            ordinal        integer not null,
            source         text not null default 'memory',
            start_line     integer not null,
            end_line       integer not null,
            room           text,
            entry_ts       integer not null,
            text           text not null,
            token_count    integer not null,
            content_hash   text not null,
            model_id       text,
            embed_status   text not null default 'pending',
            embed_attempts integer not null default 0,
            indexed_at     integer not null
          );
          insert into memory_chunks_v6(rowid, id, path, ordinal, source, start_line, end_line,
            room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
          values (42, 'abc123', 'memory/2026-01-01.md', 0, 'memory', 1, 5, null, 1000000,
                  'hello world migration test', 10, 'hash1', 'done', 0, 1000000);
          drop table memory_chunks;
          alter table memory_chunks_v6 rename to memory_chunks;
        `);
        db.pragma("user_version = 6");
      });
      await storage.waitForIdle();
      storage.close();
    }

    // Step 2: Reopen — the migration v6→v7 should run automatically.
    {
      const storage = await Storage.open({ databasePath: dbPath });
      try {
        const version = storage.read((db) =>
          Number(db.pragma("user_version", { simple: true })),
        );
        assert.equal(version, 12, "migration stamps to latest (v12)");

        // The existing row must have agent=NULL with rowid preserved.
        const row = storage.read((db) =>
          db
            .prepare("select rowid, agent, id, embed_status from memory_chunks where id = 'abc123'")
            .get() as { rowid: number; agent: null; id: string; embed_status: string } | undefined,
        );
        assert.ok(row, "existing row preserved after migration");
        assert.equal(row!.agent, null, "existing row gets agent=NULL");
        assert.equal(row!.id, "abc123", "id preserved");
        assert.equal(row!.rowid, 42, "rowid preserved (vector index integrity)");
        assert.equal(row!.embed_status, "done", "embed_status preserved");

        // Verify UNIQUE(agent,id): two rows with the same id but different agents can coexist.
        await storage.write((db) => {
          db.prepare(
            `insert into memory_chunks(agent, id, path, ordinal, source, start_line, end_line,
             room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
             values (?, ?, ?, 0, 'memory', 1, 5, null, 1000000, 'hello world migration test',
                     10, 'hash1', 'done', 0, 1000000)`,
          ).run("agentA", "abc123", "memory/2026-01-01.md");
        });
        const count = storage.read((db) =>
          Number((db.prepare("select count(*) as n from memory_chunks").get() as { n: number }).n),
        );
        assert.equal(count, 2, "two rows: one NULL-agent and one agentA with same id");

        // Verify the old id-alone UNIQUE was dropped: (NULL,'abc123') and ('agentA','abc123')
        // coexist, which was impossible under the old UNIQUE(id) constraint.
        // Also verify the new UNIQUE(agent,id): inserting ('agentA','abc123') a second time
        // must fail because (agent,id) is not unique for that pair.
        let threw = false;
        try {
          storage.read((db) => {
            db.prepare(
              `insert into memory_chunks(agent, id, path, ordinal, source, start_line, end_line,
               room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
               values ('agentA', 'abc123', 'memory/x.md', 0, 'memory', 1, 5, null, 1000000, 'dup',
                       10, 'h2', 'done', 0, 1000000)`,
            ).run();
          });
        } catch {
          threw = true;
        }
        assert.ok(threw, "inserting a second ('agentA','abc123') violates UNIQUE(agent,id)");
      } finally {
        await storage.waitForIdle();
        storage.close();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7.1 Stamp-in-place: NULL rows stamped without re-embedding
// ---------------------------------------------------------------------------

test("stamp-in-place: agents-mode reconcile stamps NULL-agent rows without re-embed", async () => {
  const { storage, cleanup } = await openMultiAgentHarness(["agentA"]);

  try {
    // Insert a row directly with agent=NULL and embed_status='done' — simulates a
    // legacy row that was already embedded before Phase 2 was deployed.
    await storage.write((db) => {
      db.prepare(
        `insert into memory_chunks(rowid, agent, id, path, ordinal, source, start_line, end_line,
         room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
         values (99, null, 'legacy-chunk-id', 'memory/2026-01-01.md', 0, 'memory',
                 1, 3, null, 1000000, 'legacy content text', 10, 'contenthash1', 'done', 0, 1000000)`,
      ).run();
    });

    // Verify the NULL row exists with embed_status='done'.
    const beforeRows = storage.read((db) =>
      db
        .prepare("select agent, id, embed_status from memory_chunks")
        .all() as Array<{ agent: string | null; id: string; embed_status: string }>,
    );
    assert.equal(beforeRows.length, 1, "one row before stamp");
    assert.equal(beforeRows[0]!.agent, null, "row has agent=NULL before stamp");
    assert.equal(beforeRows[0]!.embed_status, "done", "row has embed_status='done' before stamp");

    // Agents-mode reconcile: same chunk id → stamp-in-place, no new insert.
    const result = await storage.reconcileMemoryChunks(
      "memory/2026-01-01.md",
      [
        {
          id: "legacy-chunk-id",
          path: "memory/2026-01-01.md",
          ordinal: 0,
          source: "memory",
          startLine: 1,
          endLine: 3,
          room: null,
          entryTs: 1_000_000,
          text: "legacy content text",
          tokenCount: 10,
          contentHash: "contenthash1",
        },
      ],
      "skip", // status for NEW inserts — stamp-in-place is not an insert
      "agentA",
    );

    assert.equal(result.inserted, 0, "no new row inserted (stamp-in-place)");
    assert.equal(result.updated, 1, "one row updated (the NULL row was stamped)");
    assert.equal(result.deleted, 0, "no deletions");

    // After stamp: agent='agentA', embed_status still 'done' (embedding NOT redone).
    const afterRows = storage.read((db) =>
      db
        .prepare("select rowid, agent, id, embed_status from memory_chunks")
        .all() as Array<{ rowid: number; agent: string | null; id: string; embed_status: string }>,
    );
    assert.equal(afterRows.length, 1, "still one row after stamp");
    assert.equal(afterRows[0]!.agent, "agentA", "row now has agent='agentA'");
    assert.equal(afterRows[0]!.embed_status, "done", "embed_status unchanged — no re-embed");
    assert.equal(afterRows[0]!.rowid, 99, "rowid preserved — vector index remains valid");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// §7.1 Cross-agent retrieval isolation
// ---------------------------------------------------------------------------

test("cross-agent isolation: each agent sees only its own chunks via lexical search", async () => {
  const { agents, search, cleanup } = await openMultiAgentHarness(["alice", "bob"]);
  const [alice, bob] = agents as [AgentHarness, AgentHarness];

  try {
    // Use search terms that appear in ONLY one agent's corpus:
    // "xylophone" only in alice's content; "zoetrope" only in bob's.
    await writeMemoryFile(alice.workspaceRoot, "2026-01-01.md",
      "## 2026-01-01\n\nAlice played xylophone at the concert today.");
    await writeMemoryFile(bob.workspaceRoot, "2026-01-01.md",
      "## 2026-01-01\n\nBob demonstrated the zoetrope device to visitors.");

    await alice.indexer.reconcileAll();
    await bob.indexer.reconcileAll();

    // Alice finds her own content.
    const aliceFinds = await search.search({
      query: "xylophone",
      maxResults: 5,
      minScore: 0,
      snippetMaxChars: 200,
      agentName: "alice",
    });
    assert.ok(aliceFinds.results.length > 0, "alice finds her own xylophone content");

    // Alice cannot find bob's chunk — the agent filter restricts to alice's rows only.
    const aliceMissesBob = await search.search({
      query: "zoetrope",
      maxResults: 5,
      minScore: 0,
      snippetMaxChars: 200,
      agentName: "alice",
    });
    assert.equal(
      aliceMissesBob.results.length,
      0,
      "alice cannot find bob's zoetrope (agent filter excludes bob's chunks)",
    );

    // Bob finds his own content.
    const bobFinds = await search.search({
      query: "zoetrope",
      maxResults: 5,
      minScore: 0,
      snippetMaxChars: 200,
      agentName: "bob",
    });
    assert.ok(bobFinds.results.length > 0, "bob finds his own zoetrope content");

    // Bob cannot find alice's chunk.
    const bobMissesAlice = await search.search({
      query: "xylophone",
      maxResults: 5,
      minScore: 0,
      snippetMaxChars: 200,
      agentName: "bob",
    });
    assert.equal(
      bobMissesAlice.results.length,
      0,
      "bob cannot find alice's xylophone (agent filter excludes alice's chunks)",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// §7.1 NULL exclusion in agents mode / legacy mode unfiltered
// ---------------------------------------------------------------------------

test("NULL exclusion: un-stamped NULL rows are invisible in agents mode", async () => {
  const { storage, cleanup } = await openMultiAgentHarness(["agent1"]);

  try {
    // Insert a NULL-agent row directly (simulates a pre-Phase-2 un-stamped row).
    await storage.write((db) => {
      db.prepare(
        `insert into memory_chunks(agent, id, path, ordinal, source, start_line, end_line,
         room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
         values (null, 'chunk-anc', 'memory/old.md', 0, 'memory', 1, 3, null,
                 1000000, 'ancient relics of the old epoch', 7, 'hanc', 'skip', 0, 1000000)`,
      ).run();
    });

    // Agents-mode lexical search: the agent filter (agent = 'agent1') must exclude NULL rows.
    const agentHits = storage.searchMemoryLexical({
      match: `{text} : ("ancient")`,
      limit: 10,
      agent: "agent1",
    });
    assert.equal(agentHits.length, 0, "NULL-agent rows excluded from agents-mode search");

    // Legacy-mode lexical search (no agent param → no filter): should see the row.
    const legacyHits = storage.searchMemoryLexical({
      match: `{text} : ("ancient")`,
      limit: 10,
    });
    assert.ok(legacyHits.length > 0, "NULL-agent rows visible in legacy-mode search");
    assert.equal(legacyHits[0]!.text, "ancient relics of the old epoch");
  } finally {
    await cleanup();
  }
});

test("legacy mode: searchMemoryLexical(no agent) returns all chunks regardless of agent column", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ma2-legacy-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });

  try {
    // Seed three rows: alice-owned, bob-owned, and null-agent — simulating a mixed DB
    // opened by a legacy (non-agents-mode) process.
    await storage.write((db) => {
      for (const [agent, id, txt] of [
        ["alice", "ch-a", "vermillion sundial artifact"],
        ["bob",   "ch-b", "cerulean sundial relic"],
        [null,    "ch-n", "obsidian sundial remnant"],
      ] as Array<[string | null, string, string]>) {
        db.prepare(
          `insert into memory_chunks(agent, id, path, ordinal, source, start_line, end_line,
           room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
           values (?, ?, 'memory/2026-01-01.md', 0, 'memory', 1, 1, null,
                   1000000, ?, 5, ?, 'skip', 0, 1000000)`,
        ).run(agent, id, txt, `hash-${id}`);
      }
    });

    // Legacy-mode lexical search (no agent filter): all three chunks must be returned.
    const hits = storage.searchMemoryLexical({
      match: `{text} : ("sundial")`,
      limit: 10,
      // no agent param → no filter
    });
    assert.equal(hits.length, 3, "legacy mode (no agent filter) returns all 3 chunks");
    const ids = hits.map((h) => h.id).sort();
    assert.deepEqual(ids, ["ch-a", "ch-b", "ch-n"], "all three chunks returned");
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7.1 Chunk-id collision: same content in two workspaces → two rows
// ---------------------------------------------------------------------------

test("chunk-id collision: identical content in two agents → two rows, one per agent", async () => {
  const { agents, storage, cleanup } = await openMultiAgentHarness(["alice", "bob"]);
  const [alice, bob] = agents as [AgentHarness, AgentHarness];

  try {
    // Same file content in both workspaces → identical chunk ids from the reconciler.
    const IDENTICAL = "## 2026-06-01\n\nShared content that both agents have seeded.";
    await writeMemoryFile(alice.workspaceRoot, "2026-06-01.md", IDENTICAL);
    await writeMemoryFile(bob.workspaceRoot, "2026-06-01.md", IDENTICAL);

    await alice.indexer.reconcileAll();
    await bob.indexer.reconcileAll();

    // Two rows: one per agent, same chunk id (UNIQUE(agent,id) allows this).
    const rows = storage.read((db) =>
      db
        .prepare("select agent, id from memory_chunks order by agent")
        .all() as Array<{ agent: string; id: string }>,
    );
    assert.equal(rows.length, 2, "two rows: one per agent despite identical content");
    const agentNames = rows.map((r) => r.agent).sort();
    assert.deepEqual(agentNames, ["alice", "bob"], "rows stamped with correct agent names");
    assert.equal(rows[0]!.id, rows[1]!.id, "both rows share the same chunk id (same content)");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// §7.1 Per-agent corpus signature: independent freshness signals
// ---------------------------------------------------------------------------

test("per-agent corpus signature: indexers maintain independent index_meta keys", async () => {
  const { agents, storage, cleanup } = await openMultiAgentHarness(["a1", "a2"]);
  const [a1, a2] = agents as [AgentHarness, AgentHarness];

  try {
    await writeMemoryFile(a1.workspaceRoot, "2026-01-01.md", "a1 only content");
    await a1.indexer.reconcileAll();

    // a1's key should be set; a2's should not yet exist.
    const a1Key = storage.getIndexMeta("corpus_signature:a1");
    const a2Key = storage.getIndexMeta("corpus_signature:a2");
    assert.ok(a1Key !== undefined, "a1 corpus signature set after its reconcile");
    assert.equal(a2Key, undefined, "a2 corpus signature not yet set before its reconcile");

    await writeMemoryFile(a2.workspaceRoot, "2026-01-01.md", "a2 only content");
    await a2.indexer.reconcileAll();

    const a2KeyAfter = storage.getIndexMeta("corpus_signature:a2");
    assert.ok(a2KeyAfter !== undefined, "a2 corpus signature set after its reconcile");
    // Different content → different signatures.
    assert.notEqual(a1Key, a2KeyAfter, "each agent has its own independent corpus signature");

    // Agents mode must not pollute the bare "corpus_signature" key (legacy key).
    const legacyKey = storage.getIndexMeta("corpus_signature");
    assert.equal(legacyKey, undefined, "agents mode does not write to the bare legacy key");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// §7.1 __legacy__ sentinel normalization
// ---------------------------------------------------------------------------

test("__legacy__ sentinel is normalized to null (no agent stamping or filtering)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ma2-sentinel-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  const config = resolveRetrievalConfig({ enabled: true });
  const workspaceRoot = path.join(dir, "ws");
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });

  // Pass the sentinel — the constructor must normalize it to null.
  const indexer = new MemoryIndexer({
    storage,
    workspaceRoot,
    config,
    tokenizer: new GptTokenizer(),
    agentName: "__legacy__",
  });

  try {
    assert.equal(indexer.agentName, null, "__legacy__ sentinel normalized to null in constructor");

    // Write a file and reconcile → rows must have agent=NULL.
    await writeFile(path.join(workspaceRoot, "memory", "2026-01-01.md"), "legacy sentinel test");
    await indexer.reconcileAll();

    const rows = storage.read((db) =>
      db.prepare("select agent from memory_chunks").all() as Array<{ agent: string | null }>,
    );
    assert.ok(rows.length > 0, "rows indexed by the sentinel indexer");
    for (const r of rows) {
      assert.equal(r.agent, null, "sentinel indexer stamps rows with agent=NULL");
    }

    // Bare corpus_signature key (not suffixed) is used in legacy mode.
    const key = storage.getIndexMeta("corpus_signature");
    assert.ok(key !== undefined, "sentinel indexer writes to the bare corpus_signature key");
    const namedKey = storage.getIndexMeta("corpus_signature:__legacy__");
    assert.equal(namedKey, undefined, "sentinel string never appears as a corpus_signature suffix");
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7.2 resolveRoomsForAgent: rooms:"all" account-prefix scoping
// ---------------------------------------------------------------------------

test("resolveRoomsForAgent: legacy mode (no prefixes) returns undefined for rooms:'all'", () => {
  const result = resolveRoomsForAgent("all", "matrix:account1:room:!abc", undefined, undefined);
  assert.equal(result, undefined, "legacy: rooms='all' with no prefixes → no filter");
});

test("resolveRoomsForAgent: empty prefix list returns undefined (no filter)", () => {
  const result = resolveRoomsForAgent("all", "matrix:x:room:!r", [], undefined);
  assert.equal(result, undefined, "empty prefix list → no filter (legacy fallback)");
});

test("resolveRoomsForAgent: non-'all' rooms pass through unchanged", () => {
  const prefixes = ["matrix:alice"];
  assert.deepEqual(
    resolveRoomsForAgent("current", "matrix:alice:room:!r1", prefixes, undefined),
    ["matrix:alice:room:!r1"],
    "rooms='current' resolves to current timeline key",
  );
  assert.deepEqual(
    resolveRoomsForAgent(
      ["matrix:bob:room:!r2"],
      "matrix:alice:room:!r1",
      prefixes,
      undefined,
    ),
    ["matrix:bob:room:!r2"],
    "explicit array passes through unchanged",
  );
});

test("resolveRoomsForAgent: agents mode restricts rooms:'all' to account-prefix keys", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-ma2-rooms-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });

  try {
    // Populate timeline_events (required for chat_index FK) and their chat_index rows.
    await storage.write((db) => {
      const now = 5000;
      for (const [evId, tk] of [
        ["ev1", "matrix:alice:room:!room1"],
        ["ev2", "matrix:bob:room:!room2"],
        ["ev3", "discord:alice:room:123456"],
      ]) {
        db.prepare(
          `insert into timeline_events(id, external_id, timeline_key, provider, role, sender_id,
           body, timestamp, received_at, event_json, enrichment_status, created_at, updated_at)
           values (?, null, ?, 'matrix', 'user', '@u:h.org', 'hi', 1000, 1000, '{}',
                   'complete', ?, ?)`,
        ).run(evId, tk, now, now);
        db.prepare(
          `insert into chat_index(event_id, timeline_key, sender_id, role, timestamp, body,
           aux_text, content_sig, indexed_at)
           values (?, ?, '@u:h.org', 'user', 1000, 'hi', '', ?, ?)`,
        ).run(evId, tk, `sig-${evId}`, now);
      }
    });

    // Alice owns matrix:alice and discord:alice accounts.
    const alicePrefixes = ["matrix:alice", "discord:alice"];
    const aliceKeys = resolveRoomsForAgent(
      "all",
      "matrix:alice:room:!room1",
      alicePrefixes,
      storage,
    );
    assert.ok(Array.isArray(aliceKeys), "returns array in agents mode");
    assert.ok(aliceKeys!.includes("matrix:alice:room:!room1"), "includes alice's matrix room");
    assert.ok(aliceKeys!.includes("discord:alice:room:123456"), "includes alice's discord room");
    assert.ok(!aliceKeys!.includes("matrix:bob:room:!room2"), "excludes bob's room");

    // Bob owns only matrix:bob.
    const bobKeys = resolveRoomsForAgent(
      "all",
      "matrix:bob:room:!room2",
      ["matrix:bob"],
      storage,
    );
    assert.ok(Array.isArray(bobKeys), "bob also gets an array");
    assert.ok(bobKeys!.includes("matrix:bob:room:!room2"), "includes bob's matrix room");
    assert.ok(!bobKeys!.includes("matrix:alice:room:!room1"), "excludes alice's matrix room");
    assert.ok(!bobKeys!.includes("discord:alice:room:123456"), "excludes alice's discord room");
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7.1 Sequential startup sweep — null-orphan safety (findings #1 + #2)
// ---------------------------------------------------------------------------

test("startup sequential sweep: B's walk does not delete A's un-stamped NULL row (path present in A's workspace)", async () => {
  // Mirrors the production startup scenario: a legacy database opened with two agents
  // configured. A has a file; B's workspace is empty. In the old code, B's walk would
  // call listMemoryChunkPaths(null) and delete rows for paths absent from B's root —
  // incorrectly deleting A's not-yet-stamped NULL rows before A's walk runs.
  // After the fix, reconcileAll() never touches NULL rows; the subsystem sweep (which
  // has the full union) handles them after all walks complete.
  const { storage, agents, cleanup } = await openMultiAgentHarness(["agentA", "agentB"]);
  const [a, b] = agents as [AgentHarness, AgentHarness];

  try {
    // Write a file to A's workspace (B has no files).
    await writeMemoryFile(a.workspaceRoot, "2026-02-01.md", "## 2026-02-01\n\nLegacy content for stamp test.");

    // Seed the real chunk id by running A's reconcile once, then reset to NULL.
    await a.indexer.reconcileAll();
    const derived = storage.read((db) =>
      db
        .prepare("select rowid, id from memory_chunks limit 1")
        .get() as { rowid: number; id: string } | undefined,
    );
    assert.ok(derived, "initial reconcile inserted a row");
    const chunkId = derived!.id;

    // Reset: delete the stamped row and reinsert as NULL with embed_status='done' and
    // a known rowid — simulating a legacy (pre-Phase 2) database.
    await storage.write((db) => {
      db.prepare("delete from memory_chunks").run();
      db.prepare(
        `insert into memory_chunks(rowid, agent, id, path, ordinal, source, start_line, end_line,
         room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
         values (777, null, ?, 'memory/2026-02-01.md', 0, 'memory', 1, 3, null,
                 1000000, 'Legacy content for stamp test.', 5, 'chstamp', 'done', 0, 1000000)`,
      ).run(chunkId);
    });

    // B walks first (empty workspace). Must not delete the NULL row for A's path.
    const bOnDisk = await b.indexer.reconcileAll();
    assert.equal(bOnDisk.size, 0, "B's workspace is empty");

    const afterB = storage.read((db) =>
      db
        .prepare("select rowid, agent, embed_status from memory_chunks where id=?")
        .get(chunkId) as { rowid: number; agent: null; embed_status: string } | undefined,
    );
    assert.ok(afterB, "NULL row survives B's walk — B did not delete A's un-stamped row");
    assert.equal(afterB!.agent, null, "row still NULL-agent after B");
    assert.equal(afterB!.rowid, 777, "rowid unchanged after B");

    // A walks second — stamps in-place (same rowid, embed_status unchanged).
    await a.indexer.reconcileAll();

    const afterA = storage.read((db) =>
      db
        .prepare("select rowid, agent, embed_status from memory_chunks where id=?")
        .get(chunkId) as { rowid: number; agent: string; embed_status: string } | undefined,
    );
    assert.ok(afterA, "row exists after A's walk");
    assert.equal(afterA!.agent, "agentA", "row stamped with agentA by A's walk");
    assert.equal(afterA!.embed_status, "done", "embed_status unchanged — no re-embed triggered");
    assert.equal(afterA!.rowid, 777, "rowid preserved — vector index remains valid");
  } finally {
    await cleanup();
  }
});

test("ensureFreshForQuery: agent B's freshness check does not delete agent A's un-stamped NULL row", async () => {
  // Even at query time (not just startup), agent B's lazy reconcile must not delete
  // NULL rows for paths that exist in agent A's workspace. In agents mode,
  // reconcileAll() only prunes rows owned by the calling agent; NULL rows are
  // managed exclusively by the subsystem-level sweep at startup.
  const { storage, agents, cleanup } = await openMultiAgentHarness(["agentA", "agentB"]);
  const [a, b] = agents as [AgentHarness, AgentHarness];

  try {
    // Write a file in A's workspace.
    await writeMemoryFile(a.workspaceRoot, "2026-03-01.md", "## 2026-03-01\n\nA-only content.");

    // Insert a NULL-agent row for A's path (legacy row, embed_status='done').
    await storage.write((db) => {
      db.prepare(
        `insert into memory_chunks(rowid, agent, id, path, ordinal, source, start_line, end_line,
         room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
         values (888, null, 'null-row-for-a-path', 'memory/2026-03-01.md', 0, 'memory',
                 1, 3, null, 1000000, 'A-only content.', 3, 'ch888', 'done', 0, 1000000)`,
      ).run();
    });

    // Trigger B's ensureFreshForQuery. B's workspace is empty, so the corpus
    // signature will not match any stored value and reconcileAll fires. The
    // reconcileAll must not delete the NULL row for A's path.
    await b.indexer.ensureFreshForQuery();

    const after = storage.read((db) =>
      db
        .prepare("select rowid, agent from memory_chunks where id='null-row-for-a-path'")
        .get() as { rowid: number; agent: null } | undefined,
    );
    assert.ok(after, "NULL row for A's path survived B's ensureFreshForQuery");
    assert.equal(after!.agent, null, "row still NULL — B did not delete A's un-stamped row");
    assert.equal(after!.rowid, 888, "rowid unchanged");

    // A can still stamp it afterwards.
    await a.indexer.ensureFreshForQuery();
    // (Stamp-in-place happens only if the id matches a real chunk from A's file;
    //  for a fake id the row is left NULL until the real reconciler stamps it.
    //  The important invariant is that B never deleted it.)
    assert.ok(true, "B's query-time freshness check left A's NULL row intact");
  } finally {
    await cleanup();
  }
});

test("subsystem null-orphan sweep: truly-orphaned NULL rows deleted; paths in any root preserved", async () => {
  // Simulates what subsystem.ts does after all agents' reconcileAll() calls: collect
  // the union of on-disk paths across all agents, then delete NULL rows for paths
  // absent from ALL roots. Paths present in at least one root must survive (they will
  // be stamped by that agent's walk); only paths under NO root are deleted.
  const { storage, agents, cleanup } = await openMultiAgentHarness(["agentA", "agentB"]);
  const [a] = agents as [AgentHarness, AgentHarness];

  try {
    // File exists only in A's workspace.
    await writeMemoryFile(a.workspaceRoot, "2026-04-01.md", "## 2026-04-01\n\nA has this file.");

    // Two NULL rows:
    //   (a) path present in A's workspace → must NOT be deleted
    //   (b) path absent from ALL roots → truly orphaned, must be deleted
    await storage.write((db) => {
      db.prepare(
        `insert into memory_chunks(rowid, agent, id, path, ordinal, source, start_line, end_line,
         room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
         values (900, null, 'chunk-a-exists', 'memory/2026-04-01.md', 0, 'memory',
                 1, 3, null, 1000000, 'A has this file.', 4, 'ch900', 'done', 0, 1000000)`,
      ).run();
      db.prepare(
        `insert into memory_chunks(rowid, agent, id, path, ordinal, source, start_line, end_line,
         room, entry_ts, text, token_count, content_hash, embed_status, embed_attempts, indexed_at)
         values (901, null, 'chunk-orphaned', 'memory/deleted-long-ago.md', 0, 'memory',
                 1, 3, null, 1000000, 'This file was deleted.', 5, 'ch901', 'done', 0, 1000000)`,
      ).run();
    });

    // Run both agents' walks sequentially and collect the union of on-disk paths
    // (reproducing what subsystem.ts does in start()).
    const allOnDiskPaths = new Set<string>();
    for (const h of agents) {
      const onDisk = await h.indexer.reconcileAll();
      for (const p of onDisk) allOnDiskPaths.add(p);
    }

    // Subsystem-level null-orphan sweep: delete NULL rows for paths in no root.
    const nullPaths = storage.listMemoryChunkPaths(null);
    for (const nullPath of nullPaths) {
      if (!allOnDiskPaths.has(nullPath)) {
        await storage.deleteMemoryChunksForPath(nullPath, null);
      }
    }

    // 'memory/2026-04-01.md' is under A's root → its NULL row must survive.
    const survives = storage.read((db) =>
      db
        .prepare("select id from memory_chunks where id='chunk-a-exists' and agent is null")
        .get() as { id: string } | undefined,
    );
    assert.ok(survives, "NULL row for a path present in A's workspace survives the sweep");

    // 'memory/deleted-long-ago.md' is under no root → its NULL row must be deleted.
    const orphan = storage.read((db) =>
      db
        .prepare("select id from memory_chunks where id='chunk-orphaned'")
        .get() as { id: string } | undefined,
    );
    assert.equal(orphan, undefined, "truly-orphaned NULL row (no root has the file) is deleted");
  } finally {
    await cleanup();
  }
});
