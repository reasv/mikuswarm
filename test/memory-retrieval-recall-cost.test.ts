/**
 * What auto-retrieval's recall costs (ARCHITECTURE.md §9d "Judged retrieval"):
 * the corpus freshness check re-chunks only changed files and is shared by
 * concurrent searches, and recall stays bounded on a database of realistic size
 * (~4k chunks, ~360k timeline events, ~30k participant tags), with the
 * participant pages planned on covering indexes. Synthetic fixtures only.
 */
import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryIndexer, MemorySearch, resolveRetrievalConfig } from "../src/retrieval/index.js";
import { GptTokenizer } from "../src/context/tokenizer/index.js";
import { MemoryRetrievalStore } from "../src/storage/memory-retrieval-store.js";
import { MemoryRetrievalPipeline } from "../src/retrieval/auto/pipeline.js";
import { configureAgentTimezone, resetAgentTimezone } from "../src/time/index.js";

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;

function diaryFile(day: string, blocks: number, salt: string): string {
  let text = `# ${day}\n\n`;
  for (let h = 0; h < blocks; h++) {
    const hh = String(h % 24).padStart(2, "0");
    text += `## ${day} ${hh}:00 → ${day} ${hh}:30 · matrix · #lobby\n\nNotes ${salt} ${h}: the group talked about music, trains and weekend plans.\n\n`;
  }
  return text;
}

async function withIndexer(
  run: (s: { storage: Storage; indexer: MemoryIndexer; search: MemorySearch; memoryDir: string; reconciles: string[] }) => Promise<void>,
): Promise<void> {
  configureAgentTimezone("UTC");
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-recall-fresh-"));
  const memoryDir = path.join(dir, "ws", "memory");
  await mkdir(memoryDir, { recursive: true });
  for (let d = 1; d <= 30; d++) {
    const day = `2026-04-${String(d).padStart(2, "0")}`;
    await writeFile(path.join(memoryDir, `${day}.md`), diaryFile(day, 6, `d${d}`));
  }
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  // Every file reconcile goes through reconcileMemoryChunks: count them.
  const reconciles: string[] = [];
  const original = storage.reconcileMemoryChunks.bind(storage);
  (storage as any).reconcileMemoryChunks = (rel: string, ...rest: unknown[]) => {
    reconciles.push(rel);
    return (original as any)(rel, ...rest);
  };
  const config = resolveRetrievalConfig({ enabled: true } as any);
  const indexer = new MemoryIndexer({ storage, workspaceRoot: path.join(dir, "ws"), config, tokenizer: new GptTokenizer(), agentName: "a" });
  const search = new MemorySearch(storage, [indexer], config);
  try {
    await indexer.reconcileAll();
    assert.equal(reconciles.length, 30);
    reconciles.length = 0;
    await run({ storage, indexer, search, memoryDir, reconciles });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
}

test("freshness: a hooked diary write costs the next searches no re-chunking", async () => {
  await withIndexer(async ({ search, indexer, memoryDir, reconciles }) => {
    const file = path.join(memoryDir, "2026-04-20.md");
    await appendFile(file, "## 2026-04-20 23:00 → 2026-04-20 23:10 · matrix · #lobby\n\nA late note about trains.\n");
    indexer.enqueueReconcile(file);
    // The auto-retrieval lanes search concurrently: one check, no full sweep.
    await Promise.all(Array.from({ length: 5 }, () => search.ensureFresh()));
    assert.deepEqual(reconciles, ["memory/2026-04-20.md"]);
    await search.ensureFresh();
    assert.equal(reconciles.length, 1, "the signature is current again");
  });
});

test("freshness: an unhooked write is caught once, re-chunking only that file", async () => {
  await withIndexer(async ({ search, memoryDir, reconciles }) => {
    await appendFile(path.join(memoryDir, "2026-04-07.md"), "## 2026-04-07 23:00 → 2026-04-07 23:10 · matrix · #lobby\n\nOut of band.\n");
    await Promise.all(Array.from({ length: 5 }, () => search.ensureFresh()));
    assert.deepEqual(reconciles, ["memory/2026-04-07.md"]);
    const hits = await search.searchScored({ query: "out of band", limit: 5, minScore: 0, agentName: "a" });
    assert.ok(hits.scored.some((h) => h.path === "memory/2026-04-07.md" && h.text.includes("Out of band")));
    assert.ok(hits.timings.lexicalMs >= 0 && hits.timings.freshMs >= 0);
  });
});

test("freshness: searches use the index as it stands while the startup sweep runs", async () => {
  await withIndexer(async ({ search, indexer, memoryDir, reconciles }) => {
    indexer.setStartupSweep(true);
    await appendFile(path.join(memoryDir, "2026-04-03.md"), "\nMore.\n");
    await search.ensureFresh();
    assert.equal(reconciles.length, 0);
    indexer.setStartupSweep(false);
    await search.ensureFresh();
    assert.deepEqual(reconciles, ["memory/2026-04-03.md"]);
  });
});

test("recall stays bounded on a realistic-size database (4k chunks, 360k events, 30k tags)", { timeout: 120_000 }, async () => {
  configureAgentTimezone("UTC");
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-recall-bound-"));
  const storage = await Storage.open({ databasePath: path.join(dir, "t.db") });
  try {
    const senders = 100;
    await storage.write((db) => {
      db.transaction(() => {
        db.exec(`with recursive n(i) as (select 0 union all select i + 1 from n where i < 359999)
          insert into timeline_events (id, timeline_key, provider, role, sender_id, sender_display_name, body,
            timestamp, received_at, event_json, enrichment_status, created_at, updated_at)
          select 'e' || i, 'matrix:acc:!room' || (i % 12), 'matrix', 'user', '@u' || (i % ${senders}) || ':example.org',
            'User' || (i % ${senders}) || case when i % 50 = 0 then 'x' else '' end, 'message ' || i,
            ${T0} + i * ${MIN}, ${T0} + i * ${MIN}, '{}', 'complete', ${T0}, ${T0}
          from n`);
        const topics = ["music", "trains", "chess", "garden", "movies", "coffee", "cats", "rain", "bikes", "books", "games", "pancakes"];
        db.exec(`with recursive n(i) as (select 0 union all select i + 1 from n where i < 3999)
          insert into memory_chunks (agent, id, path, ordinal, source, start_line, end_line, room, entry_ts, text,
            token_count, content_hash, embed_status, indexed_at)
          select 'a', 'c' || i, 'memory/2026-' || printf('%02d', 1 + (i / 400)) || '-' || printf('%02d', 1 + (i / 15) % 28) || '.md',
            i % 15, 'memory', 1 + (i % 15) * 4, 4 + (i % 15) * 4, '#lobby', ${T0} + i * 90 * ${MIN},
            '## block ' || i || char(10) || 'User' || (i % ${senders}) || ' and User' || ((i * 7) % ${senders}) || ' talked about '
              || json_extract('${JSON.stringify(topics)}', '$[' || (i % 12) || ']') || ' and '
              || json_extract('${JSON.stringify(topics)}', '$[' || ((i * 5) % 12) || ']') || ', at length. '
              || replace(hex(randomblob(400)), '0', ' '),
            300, 'h' || i, 'skip', ${T0}
          from n`);
        db.exec(`with recursive n(i) as (select 0 union all select i + 1 from n where i < 3999),
            k(j) as (select 0 union all select j + 1 from k where j < 7)
          insert or ignore into memory_block_participants (agent, content_hash, provider, sender_id, message_count)
          select 'a', 'h' || i, 'matrix', '@u' || ((i * 7 + j * 13) % ${senders}) || ':example.org', 1 + j
          from n, k where j < 7 or i % 2 = 0`);
      })();
    });
    const counts = storage.read((db) => ({
      chunks: (db.prepare(`select count(*) as n from memory_chunks`).get() as { n: number }).n,
      events: (db.prepare(`select count(*) as n from timeline_events`).get() as { n: number }).n,
      tags: (db.prepare(`select count(*) as n from memory_block_participants`).get() as { n: number }).n,
    }));
    assert.deepEqual(counts, { chunks: 4000, events: 360_000, tags: 30_000 });

    const store = new MemoryRetrievalStore(storage);
    const config = resolveRetrievalConfig({ enabled: true, auto_retrieval: true } as any);
    const search = new MemorySearch(storage, [], config);
    const pipeline = new MemoryRetrievalPipeline({ search, store, config });
    const sender = (n: number) => ({ provider: "matrix", senderId: `@u${n}:example.org` });

    // The participant pages are planned on the covering indexes: no table scan.
    const captured: Array<{ sql: string; args: unknown[] }> = [];
    const db = storage.db as any;
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const st = prepare(sql);
      if (/from memory_block_participants p/.test(sql)) {
        const all = st.all.bind(st);
        st.all = (...args: unknown[]) => {
          captured.push({ sql, args });
          return all(...args);
        };
      }
      return st;
    };
    store.chunksWithParticipants("a", [sender(1), sender(2), sender(3)], 40, 80);
    db.prepare = prepare;
    assert.equal(captured.length, 1);
    const planRows = (prepare(`explain query plan ${captured[0]!.sql}`).all(...captured[0]!.args) as Array<{ detail: string }>).map((r) => r.detail);
    assert.ok(!planRows.some((d) => /^SCAN (c|p)\b/.test(d)), planRows.join(" | "));
    assert.ok(planRows.some((d) => d.includes("idx_memory_block_participants_sender_hash")), planRows.join(" | "));
    assert.ok(planRows.some((d) => d.includes("idx_memory_chunks_hash_agent_ts")), planRows.join(" | "));

    const participants = [1, 2, 3].map((n, i) => ({ ...sender(n), name: `User${n}`, role: i === 0 ? ("requester" as const) : ("mentioned" as const) }));
    const activePeople = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ ...sender(n), name: `User${n}` }));
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const plan = await pipeline.plan({
        agentName: "a",
        timelineKey: "matrix:acc:!room1",
        attribution: { agentSessionId: null, timelineKey: "matrix:acc:!room1", sessionType: "default" } as any,
        proactive: false,
        now: T0 + 400 * 86_400_000,
        request: { from: "User1", text: "what did we say about trains and pancakes", replyTo: { from: "User2", text: "the chess thing" } },
        conversation: Array.from({ length: 12 }, (_, j) => ({ from: `User${j % 3}`, text: `message ${j} about music and coffee` })),
        participants,
        activePeople,
        judge: false,
        deferRecord: true,
      });
      timings.push(performance.now() - t0);
      assert.ok(plan.report.candidates > 0);
      const s = plan.report.stages;
      for (const key of ["lexicalMs", "lanesMs", "personMs", "namesMs", "freshMs"] as const) assert.equal(typeof s[key], "number", key);
    }
    // Measured at ~50 ms; the bound leaves room for a loaded test machine while
    // catching a multi-second regression (a scan per page, a sweep per query).
    timings.sort((a, b) => a - b);
    assert.ok(timings[1]! < 1500, `median plan ${timings[1]!.toFixed(0)} ms`);
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
});
