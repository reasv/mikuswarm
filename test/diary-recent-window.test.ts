import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recentMemoryWindow, trimToTokenCeiling, buildDiaryHeader } from "../src/diary/index.js";

async function withMemoryDir(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-diary-window-"));
  await mkdir(path.join(dir, "memory"), { recursive: true });
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function writeDay(root: string, date: string, body: string): Promise<void> {
  return writeFile(path.join(root, "memory", `${date}.md`), `# ${date} Daily Memory\n\n${body}\n`, "utf8");
}

test("recentMemoryWindow returns empty string when there are no day files", async () => {
  await withMemoryDir(async (root) => {
    const out = await recentMemoryWindow({ workspaceRoot: root, anchorDay: "2026-06-03", ceilingTokens: 6000, fileCount: 2 });
    assert.equal(out, "");
  });
});

test("recentMemoryWindow returns empty when the memory dir is absent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-diary-window-"));
  try {
    const out = await recentMemoryWindow({ workspaceRoot: dir, anchorDay: "2026-06-03", ceilingTokens: 6000, fileCount: 2 });
    assert.equal(out, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recentMemoryWindow takes the N most recent files ≤ anchor, newest last", async () => {
  await withMemoryDir(async (root) => {
    await writeDay(root, "2026-05-30", "oldest");
    await writeDay(root, "2026-06-01", "middle");
    await writeDay(root, "2026-06-03", "newest");
    // A file AFTER the anchor must be excluded.
    await writeDay(root, "2026-06-10", "future");

    const out = await recentMemoryWindow({ workspaceRoot: root, anchorDay: "2026-06-03", ceilingTokens: 100000, fileCount: 2 });
    // Two most recent ≤ anchor are 06-03 and 06-01, concatenated newest-last.
    assert.ok(out.includes("middle"));
    assert.ok(out.includes("newest"));
    assert.ok(!out.includes("oldest"), "third-oldest file excluded by fileCount");
    assert.ok(!out.includes("future"), "files after the anchor excluded");
    assert.ok(out.indexOf("middle") < out.indexOf("newest"), "newest is concatenated last");
  });
});

test("recentMemoryWindow walks back over gaps (sparse files), not calendar days", async () => {
  await withMemoryDir(async (root) => {
    await writeDay(root, "2026-01-01", "ancient-but-most-recent");
    // Anchor is far in the future; calendar 'yesterday' doesn't exist.
    const out = await recentMemoryWindow({ workspaceRoot: root, anchorDay: "2026-06-03", ceilingTokens: 100000, fileCount: 2 });
    assert.ok(out.includes("ancient-but-most-recent"));
  });
});

test("recentMemoryWindow trims through to the ceiling: drops earliest blocks, keeps the most recent", async () => {
  await withMemoryDir(async (root) => {
    // Two day files, each a single big header-delimited block. A low ceiling forces
    // the trim path THROUGH recentMemoryWindow (not just trimToTokenCeiling directly).
    const h1 = buildDiaryHeader({ earliestTimestamp: 0, latestTimestamp: 1, room: "A", timezone: "UTC" });
    const h2 = buildDiaryHeader({ earliestTimestamp: 2, latestTimestamp: 3, room: "B", timezone: "UTC" });
    const big = "word ".repeat(800);
    await writeDay(root, "2026-06-01", `${h1}\n${big}\nOLDEST-BODY`);
    await writeDay(root, "2026-06-03", `${h2}\nNEWEST-BODY`);

    const out = await recentMemoryWindow({
      workspaceRoot: root,
      anchorDay: "2026-06-03",
      ceilingTokens: 50,
      fileCount: 2,
    });
    // The earliest (front-most in text) oversized block is dropped; the newest block survives.
    assert.ok(out.includes("NEWEST-BODY"), "the most recent block is retained");
    assert.ok(!out.includes(big.trim()), "the oversized earliest block was dropped to fit the ceiling");
    assert.ok(!out.includes("OLDEST-BODY"), "the dropped block's body is gone too");
  });
});

test("recentMemoryWindow ignores malformed/garbage filenames (DAY_FILE_RE)", async () => {
  await withMemoryDir(async (root) => {
    const memory = path.join(root, "memory");
    // A single valid day file...
    await writeDay(root, "2026-06-03", "VALID-DAY");
    // ...alongside files that DAY_FILE_RE must reject.
    await writeFile(path.join(memory, "2026-6-3.md"), "MALFORMED-SHORT-MONTH\n", "utf8"); // single-digit month/day
    await writeFile(path.join(memory, "notes.md"), "FREEFORM-NOTES\n", "utf8");
    await writeFile(path.join(memory, ".2026-06-02.md"), "DOTFILE-PREFIX\n", "utf8"); // leading dot
    await writeFile(path.join(memory, "2026-06-04.txt"), "WRONG-EXT\n", "utf8"); // not .md
    await writeFile(path.join(memory, "2026-06-02-extra.md"), "TRAILING-EXTRA\n", "utf8"); // extra suffix

    const out = await recentMemoryWindow({
      workspaceRoot: root,
      anchorDay: "2026-06-03",
      ceilingTokens: 100000,
      fileCount: 5,
    });
    assert.ok(out.includes("VALID-DAY"), "the well-formed day file is included");
    assert.ok(!out.includes("MALFORMED-SHORT-MONTH"));
    assert.ok(!out.includes("FREEFORM-NOTES"));
    assert.ok(!out.includes("DOTFILE-PREFIX"));
    assert.ok(!out.includes("WRONG-EXT"));
    assert.ok(!out.includes("TRAILING-EXTRA"));
  });
});

test("recentMemoryWindow includes a file whose date EXACTLY equals anchorDay (≤ boundary)", async () => {
  await withMemoryDir(async (root) => {
    await writeDay(root, "2026-06-03", "ANCHOR-DAY-BODY");
    const out = await recentMemoryWindow({
      workspaceRoot: root,
      anchorDay: "2026-06-03",
      ceilingTokens: 100000,
      fileCount: 2,
    });
    assert.ok(out.includes("ANCHOR-DAY-BODY"), "a file dated exactly anchorDay is in the window (≤, not <)");
  });
});

test("trimToTokenCeiling drops earliest header-delimited blocks from the front", () => {
  const h1 = buildDiaryHeader({ earliestTimestamp: 0, latestTimestamp: 1, room: "A", timezone: "UTC" });
  const h2 = buildDiaryHeader({ earliestTimestamp: 2, latestTimestamp: 3, room: "B", timezone: "UTC" });
  const big = "word ".repeat(800);
  const text = `# 2026-06-03 Daily Memory\n\n${h1}\n${big}\n\n${h2}\nkeep me\n`;
  // A tight ceiling forces dropping the first (oldest) block; the last must survive.
  const trimmed = trimToTokenCeiling(text, 50);
  assert.ok(trimmed.includes("keep me"));
  assert.ok(!trimmed.includes(big.trim()), "the oversized earliest block was dropped");
});

test("trimToTokenCeiling hard-truncates header-less legacy content over budget", () => {
  const legacy = "no headers here, just imported prose. ".repeat(500);
  const trimmed = trimToTokenCeiling(legacy, 30);
  // No header split points → single unit → hard-truncated to roughly the ceiling.
  assert.ok(trimmed.length < legacy.length);
});

test("trimToTokenCeiling is a no-op when already within budget", () => {
  const text = "## 2026-06-03 14:05 → 2026-06-03 15:30 · UTC · Room\nshort entry";
  assert.equal(trimToTokenCeiling(text, 100000), text);
});
