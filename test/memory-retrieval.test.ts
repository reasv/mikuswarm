import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Storage } from "../src/storage/index.js";
import { MemoryIndexer, MemorySearch, resolveRetrievalConfig } from "../src/retrieval/index.js";
import { chunkMemoryFile } from "../src/retrieval/chunk.js";
import { buildDiaryHeader } from "../src/diary/header.js";
import {
  configureAgentTimezone,
  resetAgentTimezone,
  parseZonedWallClock,
} from "../src/time/index.js";

const TZ = "Asia/Tokyo";

interface Harness {
  workspaceRoot: string;
  storage: Storage;
  indexer: MemoryIndexer;
  search: MemorySearch;
}

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  configureAgentTimezone(TZ);
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-retrieval-"));
  const workspaceRoot = path.join(dir, "ws");
  await mkdir(path.join(workspaceRoot, "memory"), { recursive: true });
  const storage = await Storage.open({ databasePath: path.join(dir, "test.db") });
  const config = resolveRetrievalConfig({ enabled: true });
  const indexer = new MemoryIndexer({ storage, workspaceRoot, config });
  const search = new MemorySearch(storage, indexer, config);
  try {
    await run({ workspaceRoot, storage, indexer, search });
  } finally {
    await storage.waitForIdle();
    storage.close();
    await rm(dir, { recursive: true, force: true });
    resetAgentTimezone();
  }
}

async function writeMemory(workspaceRoot: string, name: string, content: string): Promise<string> {
  const p = path.join(workspaceRoot, "memory", name);
  await writeFile(p, content, "utf8");
  return p;
}

function diaryFile(): string {
  const header1 = buildDiaryHeader({
    earliestTimestamp: parseZonedWallClock("2026-04-12 14:00", TZ)!,
    latestTimestamp: parseZonedWallClock("2026-04-12 15:30", TZ)!,
    room: "#general",
  });
  const header2 = buildDiaryHeader({
    earliestTimestamp: parseZonedWallClock("2026-04-12 18:00", TZ)!,
    latestTimestamp: parseZonedWallClock("2026-04-12 19:00", TZ)!,
    room: "Project Hammer",
  });
  return (
    `# 2026-04-12 Daily Memory\n\n` +
    `${header1}\nToday I argued with Bob about databases and we decided to use SQLite for storage.\n\n` +
    `${header2}\nAlice asked me to remember that the launch date is in May.\n`
  );
}

test("parseZonedWallClock round-trips through the configured zone", () => {
  configureAgentTimezone(TZ);
  try {
    const ts = parseZonedWallClock("2026-04-12 15:30", TZ);
    assert.ok(ts != null);
    // Asia/Tokyo is UTC+9 with no DST.
    assert.equal(new Date(ts!).toISOString(), "2026-04-12T06:30:00.000Z");
    assert.equal(parseZonedWallClock("nonsense", TZ), null);
  } finally {
    resetAgentTimezone();
  }
});

test("chunkMemoryFile: one chunk per diary block with header metadata", () => {
  configureAgentTimezone(TZ);
  try {
    const chunks = chunkMemoryFile({
      relativePath: "memory/2026-04-12.md",
      text: diaryFile(),
      fileDate: "2026-04-12",
      fallbackTimestamp: 0,
      maxChunkTokens: 512,
      fallbackChunkTokens: 400,
      fallbackChunkOverlap: 80,
    });
    // The `# ... Daily Memory` title block is dropped; two diary blocks remain.
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.room, "#general");
    assert.equal(chunks[1]!.room, "Project Hammer");
    assert.equal(chunks[0]!.entryTs, parseZonedWallClock("2026-04-12 15:30", TZ));
    assert.equal(chunks[1]!.entryTs, parseZonedWallClock("2026-04-12 19:00", TZ));
    assert.ok(chunks[0]!.text.includes("SQLite"));
    // Ordinals are sequential; content identity differs per block.
    assert.equal(chunks[0]!.ordinal, 0);
    assert.equal(chunks[1]!.ordinal, 1);
    assert.notEqual(chunks[0]!.id, chunks[1]!.id);
    // Line ranges are 1-indexed and point into the file.
    assert.ok(chunks[0]!.startLine >= 1 && chunks[0]!.endLine >= chunks[0]!.startLine);
  } finally {
    resetAgentTimezone();
  }
});

test("chunkMemoryFile: oversized header block sub-splits, inheriting metadata", () => {
  configureAgentTimezone(TZ);
  try {
    const header = buildDiaryHeader({
      earliestTimestamp: parseZonedWallClock("2026-04-12 14:00", TZ)!,
      latestTimestamp: parseZonedWallClock("2026-04-12 15:30", TZ)!,
      room: "#general",
    });
    const body = Array.from({ length: 200 }, (_, i) => `sentence number ${i} about widgets`).join(" ");
    const chunks = chunkMemoryFile({
      relativePath: "memory/2026-04-12.md",
      text: `${header}\n${body}\n`,
      fileDate: "2026-04-12",
      fallbackTimestamp: 0,
      maxChunkTokens: 50,
      fallbackChunkTokens: 40,
      fallbackChunkOverlap: 8,
    });
    assert.ok(chunks.length > 1, "oversized block should sub-split");
    for (const c of chunks) {
      assert.equal(c.room, "#general");
      assert.equal(c.entryTs, parseZonedWallClock("2026-04-12 15:30", TZ));
    }
  } finally {
    resetAgentTimezone();
  }
});

test("chunkMemoryFile: oversized multi-byte block maps each chunk to lines that contain its text (issue #18)", () => {
  configureAgentTimezone(TZ);
  try {
    const header = buildDiaryHeader({
      earliestTimestamp: parseZonedWallClock("2026-04-12 14:00", TZ)!,
      latestTimestamp: parseZonedWallClock("2026-04-12 15:30", TZ)!,
      room: "#general",
    });
    // A multi-line body laced with emoji and CJK so a token-window boundary lands on
    // (or beside) a multi-byte character. Many lines so the [startLine,endLine] mapping
    // is non-trivial and a mis-count would surface.
    const body = Array.from(
      { length: 60 },
      (_, i) => `行 ${i} 🎌 about the launch 🚀 with café notes 日本語 and ümlauts`,
    ).join("\n");
    const text = `${header}\n${body}\n`;
    // Force the oversized path: maxChunkTokens below the block's size so it sub-splits,
    // and a fallback window small enough to yield several sub-chunks (≥2).
    const chunks = chunkMemoryFile({
      relativePath: "memory/2026-04-12.md",
      text,
      fileDate: "2026-04-12",
      fallbackTimestamp: 0,
      maxChunkTokens: 40,
      fallbackChunkTokens: 30,
      fallbackChunkOverlap: 6,
    });
    assert.ok(chunks.length >= 2, `oversized multi-byte block should sub-split, got ${chunks.length}`);

    // Re-read the file by 1-indexed line number; each chunk's reported [startLine,endLine]
    // span must actually contain its text. This guards splitByTokens' char offsets +
    // chunk.ts' lineAt/emit mapping against multi-byte miscounting. The span is
    // reconstructed preserving line terminators (a chunk may begin/end mid-line and its
    // text can include a trailing newline), so `splitLines` keeps each line's own "\n".
    const splitLines = text.split(/(?<=\n)/); // keep the terminating newline on each line
    const lineCount = text.split("\n").length;
    for (const c of chunks) {
      assert.ok(c.startLine >= 1, `startLine must be 1-indexed, got ${c.startLine}`);
      assert.ok(c.endLine >= c.startLine, `endLine ≥ startLine, got [${c.startLine},${c.endLine}]`);
      assert.ok(c.endLine <= lineCount, `endLine ${c.endLine} within file (${lineCount} lines)`);
      // Lines are 1-indexed inclusive; slice is 0-indexed half-open.
      const span = splitLines.slice(c.startLine - 1, c.endLine).join("");
      assert.ok(
        span.includes(c.text),
        `chunk text must lie within lines [${c.startLine},${c.endLine}]\n` +
          `--- chunk.text ---\n${JSON.stringify(c.text)}\n--- span ---\n${JSON.stringify(span)}`,
      );
    }
    // Sanity: at least one chunk actually carries multi-byte content (the test is real).
    assert.ok(chunks.some((c) => /[🎌🚀日本語café]/u.test(c.text)), "chunks should retain multi-byte content");
  } finally {
    resetAgentTimezone();
  }
});

test("chunkMemoryFile: header-less legacy file falls back to token windows", () => {
  const chunks = chunkMemoryFile({
    relativePath: "memory/legacy.md",
    text: "Some imported OpenClaw note about the Helsinki trip and the sauna incident.",
    fileDate: null,
    fallbackTimestamp: 1_700_000_000_000,
    maxChunkTokens: 512,
    fallbackChunkTokens: 400,
    fallbackChunkOverlap: 80,
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.room, null);
  assert.equal(chunks[0]!.entryTs, 1_700_000_000_000);
  assert.ok(chunks[0]!.text.includes("Helsinki"));
});

test("reconcile + lexical search returns ranked, cited results", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    await writeMemory(workspaceRoot, "2026-04-12.md", diaryFile());
    await indexer.reconcileAll();

    const outcome = await search.search({
      query: "what did we decide about databases",
      maxResults: 6,
      minScore: 0,
      snippetMaxChars: 200,
    });
    assert.equal(outcome.mode, "lexical");
    assert.ok(outcome.results.length >= 1);
    const top = outcome.results[0]!;
    assert.equal(top.path, "memory/2026-04-12.md");
    assert.equal(top.room, "#general");
    assert.equal(top.date, "2026-04-12");
    assert.ok(top.snippet.includes("SQLite"));
    assert.ok(top.score > 0);
  });
});

test("recall supports room and date filters", async () => {
  await withHarness(async ({ workspaceRoot, indexer, search }) => {
    await writeMemory(workspaceRoot, "2026-04-12.md", diaryFile());
    await indexer.reconcileAll();

    const byRoom = await search.search({
      query: "remember launch date May databases",
      maxResults: 6,
      minScore: 0,
      room: "Project Hammer",
      snippetMaxChars: 200,
    });
    assert.ok(byRoom.results.length >= 1);
    for (const r of byRoom.results) assert.equal(r.room, "Project Hammer");

    const outOfRange = await search.search({
      query: "databases SQLite",
      maxResults: 6,
      minScore: 0,
      before: "2026-04-11",
      snippetMaxChars: 200,
    });
    assert.equal(outOfRange.results.length, 0);
  });
});

test("appends are indexed and deletions are pruned across reconciles", async () => {
  await withHarness(async ({ workspaceRoot, storage, indexer, search }) => {
    const file = await writeMemory(workspaceRoot, "2026-04-12.md", diaryFile());
    await indexer.reconcileAll();
    const before = storage.read((db) =>
      (db.prepare("select count(*) as n from memory_chunks").get() as { n: number }).n,
    );
    assert.equal(before, 2);

    // Append a new diary block; reconcile only that file.
    const header3 = buildDiaryHeader({
      earliestTimestamp: parseZonedWallClock("2026-04-12 20:00", TZ)!,
      latestTimestamp: parseZonedWallClock("2026-04-12 21:00", TZ)!,
      room: "#random",
    });
    await appendFile(file, `\n${header3}\nCarol shared a recipe for pancakes today.\n`, "utf8");
    await new Promise<void>((resolve) => {
      indexer.enqueueReconcile(file);
      // enqueueReconcile is fire-and-forget; flush via a full reconcile barrier.
      void indexer.reconcileAll().then(() => resolve());
    });
    const found = await search.search({
      query: "pancakes recipe Carol",
      maxResults: 6,
      minScore: 0,
      snippetMaxChars: 200,
    });
    assert.ok(found.results.some((r) => r.snippet.includes("pancakes")));

    // Now overwrite the file with only the title (all blocks removed) → pruned.
    await writeFile(file, "# 2026-04-12 Daily Memory\n", "utf8");
    await indexer.reconcileAll();
    const after = storage.read((db) =>
      (db.prepare("select count(*) as n from memory_chunks").get() as { n: number }).n,
    );
    assert.equal(after, 0);
  });
});

test("lazy ensureFreshForQuery reindexes after an out-of-band write", async () => {
  await withHarness(async ({ workspaceRoot, search }) => {
    // No reconcileAll yet; the search path's corpus-signature check must catch it.
    await writeMemory(workspaceRoot, "2026-04-12.md", diaryFile());
    const outcome = await search.search({
      query: "SQLite databases decided",
      maxResults: 6,
      minScore: 0,
      snippetMaxChars: 200,
    });
    assert.ok(outcome.results.length >= 1);
  });
});
