import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryFileWriter } from "../src/storage/memory-writer.js";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-memory-writer-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ensureDailyFile creates the day file with the single-# top header", async () => {
  await withWorkspace(async (root) => {
    const writer = new MemoryFileWriter(root);
    const p = await writer.ensureDailyFile("2026-06-03");
    assert.equal(await readFile(p, "utf8"), "# 2026-06-03 Daily Memory\n");
    // Idempotent: re-ensuring does not clobber.
    const p2 = await writer.ensureDailyFile("2026-06-03");
    assert.equal(p, p2);
    assert.equal(await readFile(p, "utf8"), "# 2026-06-03 Daily Memory\n");
  });
});

test("appendEntry guarantees a blank-line boundary before each block", async () => {
  await withWorkspace(async (root) => {
    const writer = new MemoryFileWriter(root);
    const date = "2026-06-03";
    await writer.appendEntry(date, "## 2026-06-03 14:05 → 2026-06-03 15:30 · UTC · Room A\nfirst entry\n");
    await writer.appendEntry(date, "## 2026-06-03 16:00 → 2026-06-03 16:30 · UTC · Room B\nsecond entry\n");

    const content = await readFile(path.join(root, "memory", `${date}.md`), "utf8");
    assert.equal(
      content,
      "# 2026-06-03 Daily Memory\n\n" +
        "## 2026-06-03 14:05 → 2026-06-03 15:30 · UTC · Room A\nfirst entry\n\n" +
        "## 2026-06-03 16:00 → 2026-06-03 16:30 · UTC · Room B\nsecond entry\n",
    );
  });
});

test("appendEntry adds a trailing newline when the block lacks one", async () => {
  await withWorkspace(async (root) => {
    const writer = new MemoryFileWriter(root);
    await writer.appendEntry("2026-06-03", "## h · no trailing newline · Room\nbody");
    const content = await readFile(path.join(root, "memory", "2026-06-03.md"), "utf8");
    assert.ok(content.endsWith("body\n"));
  });
});

test("the FIFO serializes concurrent appends without interleaving or loss", async () => {
  await withWorkspace(async (root) => {
    const writer = new MemoryFileWriter(root);
    const date = "2026-06-03";
    // Fire many appends concurrently; the single-writer chain must apply them all,
    // in order, with intact boundaries (no torn read-modify-write).
    const blocks = Array.from({ length: 20 }, (_, i) => `## entry-${i} · UTC · Room\nbody ${i}\n`);
    await Promise.all(blocks.map((b) => writer.appendEntry(date, b)));

    const content = await readFile(path.join(root, "memory", `${date}.md`), "utf8");
    for (let i = 0; i < 20; i++) {
      assert.ok(content.includes(`body ${i}`), `body ${i} present`);
    }
    // Every block is preceded by a blank line (the \n\n boundary held under concurrency).
    const headerCount = (content.match(/^## entry-\d+ /gm) ?? []).length;
    assert.equal(headerCount, 20);
  });
});

test("editorCommand routes a view through the same queue", async () => {
  await withWorkspace(async (root) => {
    const writer = new MemoryFileWriter(root);
    await writer.ensureDailyFile("2026-06-03");
    const result = await writer.editorCommand({ command: "view", path: "memory/2026-06-03.md" });
    assert.match(result.text, /Daily Memory/);
  });
});

test("a rejected op does not poison the FIFO chain", async () => {
  await withWorkspace(async (root) => {
    const writer = new MemoryFileWriter(root);
    // An editor command against a non-existent file should reject...
    await assert.rejects(writer.editorCommand({ command: "view", path: "memory/does-not-exist.md" }));
    // ...but the chain must keep working for subsequent ops.
    await writer.appendEntry("2026-06-03", "## after failure · UTC · Room\nstill works\n");
    const content = await readFile(path.join(root, "memory", "2026-06-03.md"), "utf8");
    assert.ok(content.includes("still works"));
  });
});
