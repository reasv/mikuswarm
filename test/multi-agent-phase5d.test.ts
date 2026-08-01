/**
 * Phase 5d multi-agent support tests (spec MULTI-AGENT-SUPPORT §11.5 / §13).
 *
 * Covers:
 *   - Store layout: storePathForHash uses two-level fan-out (<hh>/<fullhash>)
 *   - init() probe: creates msg-attach dir in each workspace root
 *   - Write path — integrateBuffer: new content → store + hardlink; chmod 0444
 *   - Write path — integrateBuffer: dedup → same inode (hardlink to existing store entry)
 *   - Write path — integrateDownload: new content → store rename + hardlink
 *   - Write path — integrateDownload: dedup (hash already in store) → hardlink only
 *   - Write path — two agents, same content → one store inode, two workspace hardlinks
 *   - Read-only discipline: chmod 0444 on store file; link count reflects hardlinks
 *   - Adoption sweep — adopt-new: links file into store, sets chmod 0444
 *   - Adoption sweep — swap-duplicate: replaces workspace file with store inode
 *   - Adoption sweep — idempotent: same inode already → skip
 *   - Adoption sweep — .tmp-* skip: temp files are never swept
 *   - Adoption sweep — subdirectory recursion
 *   - Default-off: store absent → moveFileToWorkspace/saveMediaToWorkspace legacy behaviour
 *   - hashFileSha256: matches crypto.createHash result
 *   - saveMediaToWorkspace: store path, no-store path (byte-identical)
 *   - moveFileToWorkspace: store path, no-store path (byte-identical)
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AttachmentStore,
  hashFileSha256,
} from "../src/enrichment/attachment-store.js";
import {
  saveMediaToWorkspace,
  moveFileToWorkspace,
  generateTempDownloadPath,
} from "../src/enrichment/media.js";

// ---------------------------------------------------------------------------
// Test logger (silent)
// ---------------------------------------------------------------------------

type Logger = {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
};

function makeLogger(): Logger & { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    warnings,
    errors,
    info() {},
    warn(msg) { warnings.push(msg); },
    error(msg) { errors.push(msg); },
  };
}

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

/** Create a store + two workspace roots on the same filesystem (required for hardlinks). */
async function makeEnv(): Promise<{
  storePath: string;
  ws1: string;
  ws2: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(path.join(os.tmpdir(), "miku-p5d-"));
  const storePath = path.join(base, "store");
  const ws1 = path.join(base, "ws1");
  const ws2 = path.join(base, "ws2");
  await Promise.all([mkdir(storePath), mkdir(ws1), mkdir(ws2)]);
  return {
    storePath,
    ws1,
    ws2,
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Store layout
// ---------------------------------------------------------------------------

test("storePathForHash: two-level fan-out layout", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    const hash = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const p = store.storePathForHash(hash);
    assert.equal(path.dirname(p), path.join(env.storePath, "ab"));
    assert.equal(path.basename(p), hash);
  } finally {
    await env.cleanup();
  }
});

test("storePathForHash: fan-out bucket is the first two hex chars", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    const hash = "ff" + "0".repeat(62);
    const p = store.storePathForHash(hash);
    assert.ok(p.includes(`${path.sep}ff${path.sep}`), `expected 'ff' bucket in path, got: ${p}`);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// init(): cross-device probe creates msg-attach dirs
// ---------------------------------------------------------------------------

test("init(): creates msg-attach under each workspace root", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1, env.ws2]);
    assert.ok(existsSync(path.join(env.ws1, "msg-attach")));
    assert.ok(existsSync(path.join(env.ws2, "msg-attach")));
    assert.ok(store.isReady());
  } finally {
    await env.cleanup();
  }
});

test("init(): probe temp file is removed after init", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(env.storePath),
    );
    // No .probe-* files should remain.
    assert.ok(!entries.some((e) => e.startsWith(".probe-")));
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// hashFileSha256 utility
// ---------------------------------------------------------------------------

test("hashFileSha256: matches crypto.createHash sha256", async () => {
  const env = await makeEnv();
  try {
    const data = Buffer.from("hello phase 5d");
    const filePath = path.join(env.ws1, "probe.bin");
    await writeFile(filePath, data);
    const got = await hashFileSha256(filePath);
    const expected = sha256Hex(data);
    assert.equal(got, expected);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// integrateBuffer: new content
// ---------------------------------------------------------------------------

test("integrateBuffer: new content → store file + hardlink in destDir", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("attachment data for phase 5d");
    const hash = sha256Hex(data);
    const destDir = path.join(env.ws1, "msg-attach");
    const filename = "file.txt";

    const destPath = await store.integrateBuffer({ data, hash, destDir, filename });

    // Destination file exists and has the right content.
    assert.ok(existsSync(destPath));
    assert.deepEqual(await readFile(destPath), data);

    // Store file exists.
    const storePath = store.storePathForHash(hash);
    assert.ok(existsSync(storePath));

    // Both paths share the same inode (hardlink).
    const dStat = await stat(destPath);
    const sStat = await stat(storePath);
    assert.equal(dStat.ino, sStat.ino, "dest and store must share inode");

    // Link count is >= 2 (store + at least one workspace link).
    assert.ok(sStat.nlink >= 2, `expected nlink >= 2, got ${sStat.nlink}`);
  } finally {
    await env.cleanup();
  }
});

test("integrateBuffer: store file is chmod 0444 (read-only)", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("read-only test data");
    const hash = sha256Hex(data);
    const destDir = path.join(env.ws1, "msg-attach");

    await store.integrateBuffer({ data, hash, destDir, filename: "ro.bin" });

    const storePath = store.storePathForHash(hash);
    const s = await stat(storePath);
    // On Linux the mode bits (without type) should be 0o444.
    assert.equal(s.mode & 0o777, 0o444, `expected 0444, got ${(s.mode & 0o777).toString(8)}`);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// integrateBuffer: dedup (same hash already in store)
// ---------------------------------------------------------------------------

test("integrateBuffer: dedup — second call returns same inode as store", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("duplicate attachment");
    const hash = sha256Hex(data);
    const destDir = path.join(env.ws1, "msg-attach");

    // First integration: establishes store entry.
    await store.integrateBuffer({ data, hash, destDir, filename: "dup1.bin" });
    const storeStat = await stat(store.storePathForHash(hash));

    // Second integration: should hardlink to existing store entry.
    await store.integrateBuffer({ data, hash, destDir, filename: "dup2.bin" });
    const dup2Stat = await stat(path.join(destDir, "dup2.bin"));

    assert.equal(dup2Stat.ino, storeStat.ino, "dedup file must share store inode");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// integrateDownload
// ---------------------------------------------------------------------------

test("integrateDownload: new content — source renamed to store; dest is hardlink", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("downloaded file content");
    const hash = sha256Hex(data);
    const tmpSrc = path.join(env.ws1, "msg-attach", `.tmp-${Date.now()}`);
    await mkdir(path.dirname(tmpSrc), { recursive: true });
    await writeFile(tmpSrc, data);

    const destDir = path.join(env.ws1, "msg-attach", "sub");
    const destPath = await store.integrateDownload({
      sourcePath: tmpSrc,
      destDir,
      filename: "dl.bin",
      hash,
    });

    // Source file is gone (renamed/consumed).
    assert.ok(!existsSync(tmpSrc), "source temp file should be consumed");
    // Destination exists and shares inode with store.
    const storePath = store.storePathForHash(hash);
    const dStat = await stat(destPath);
    const sStat = await stat(storePath);
    assert.equal(dStat.ino, sStat.ino, "dest must share store inode");
    assert.deepEqual(await readFile(destPath), data);
  } finally {
    await env.cleanup();
  }
});

test("integrateDownload: dedup — source discarded, dest hardlinked to store", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("dedup download test");
    const hash = sha256Hex(data);
    const destDir = path.join(env.ws1, "msg-attach");

    // Seed the store manually.
    const storeDir = path.join(env.storePath, hash.slice(0, 2));
    await mkdir(storeDir, { recursive: true });
    await writeFile(path.join(storeDir, hash), data);

    // A second "download" of the same content.
    const tmpSrc = path.join(env.ws1, `.tmp-dl2-${Date.now()}`);
    await writeFile(tmpSrc, data);

    const destPath = await store.integrateDownload({
      sourcePath: tmpSrc,
      destDir,
      filename: "dl2.bin",
      hash,
    });

    // Source discarded.
    assert.ok(!existsSync(tmpSrc), "source should be discarded");
    // Destination shares inode with store.
    const storePath = store.storePathForHash(hash);
    const dStat = await stat(destPath);
    const sStat = await stat(storePath);
    assert.equal(dStat.ino, sStat.ino, "dedup dest must share store inode");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Two agents, same content → one store inode
// ---------------------------------------------------------------------------

test("two agents, same content → one store inode, two workspace hardlinks", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1, env.ws2]);

    const data = Buffer.from("shared attachment content — same across agents");
    const hash = sha256Hex(data);

    const dir1 = path.join(env.ws1, "msg-attach", "matrix.agent1");
    const dir2 = path.join(env.ws2, "msg-attach", "matrix.agent2");

    await store.integrateBuffer({ data, hash, destDir: dir1, filename: "shared.bin" });
    await store.integrateBuffer({ data, hash, destDir: dir2, filename: "shared.bin" });

    const storePath = store.storePathForHash(hash);
    const sStat = await stat(storePath);
    const s1Stat = await stat(path.join(dir1, "shared.bin"));
    const s2Stat = await stat(path.join(dir2, "shared.bin"));

    assert.equal(s1Stat.ino, sStat.ino, "agent1 file must share store inode");
    assert.equal(s2Stat.ino, sStat.ino, "agent2 file must share store inode");
    // Link count: store + ws1 + ws2 = 3
    assert.ok(sStat.nlink >= 3, `expected nlink >= 3, got ${sStat.nlink}`);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adoption sweep — adopt-new
// ---------------------------------------------------------------------------

test("adoptSweep: adopt-new — file not in store → link into store, chmod 0444", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    // Place a file in the workspace (simulates a pre-store attachment).
    const data = Buffer.from("pre-existing attachment to adopt");
    const hash = sha256Hex(data);
    const msgAttach = path.join(env.ws1, "msg-attach");
    const wsFile = path.join(msgAttach, "oldfile.bin");
    await writeFile(wsFile, data);

    await store.adoptSweep([env.ws1]);

    const storePath = store.storePathForHash(hash);
    assert.ok(existsSync(storePath), "store entry should exist after sweep");

    // Store file is read-only.
    const sStat = await stat(storePath);
    assert.equal(sStat.mode & 0o777, 0o444, "adopted store file should be chmod 0444");

    // Workspace file and store file share an inode.
    const wStat = await stat(wsFile);
    assert.equal(wStat.ino, sStat.ino, "workspace file should share store inode after adopt");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adoption sweep — swap-duplicate
// ---------------------------------------------------------------------------

test("adoptSweep: swap-duplicate — workspace file has different inode → swapped to store inode", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("content that exists in store under different inode");
    const hash = sha256Hex(data);

    // Pre-populate the store with the canonical inode.
    const storeDir = path.join(env.storePath, hash.slice(0, 2));
    await mkdir(storeDir, { recursive: true });
    const storePath = path.join(storeDir, hash);
    await writeFile(storePath, data);
    const canonicalIno = (await stat(storePath)).ino;

    // Workspace has a duplicate (different inode, same content).
    const msgAttach = path.join(env.ws1, "msg-attach");
    const wsFile = path.join(msgAttach, "dup.bin");
    await writeFile(wsFile, data);
    const dupIno = (await stat(wsFile)).ino;
    // Verify they are truly separate inodes before the sweep.
    assert.notEqual(dupIno, canonicalIno, "setup: workspace and store should be separate inodes");

    await store.adoptSweep([env.ws1]);

    // After sweep the workspace path should point to the canonical inode.
    const afterStat = await stat(wsFile);
    assert.equal(afterStat.ino, canonicalIno, "workspace file should be swapped to store inode");
    // Content unchanged.
    assert.deepEqual(await readFile(wsFile), data);
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adoption sweep — idempotent (same inode)
// ---------------------------------------------------------------------------

test("adoptSweep: idempotent — already hardlinked file is skipped (same inode)", async () => {
  const env = await makeEnv();
  try {
    const log = makeLogger();
    const store = new AttachmentStore(env.storePath, log);
    await store.init([env.ws1]);

    const data = Buffer.from("already integrated content");
    const hash = sha256Hex(data);

    // Integrate via the normal write path (creates hardlink).
    const destDir = path.join(env.ws1, "msg-attach");
    await store.integrateBuffer({ data, hash, destDir, filename: "already.bin" });
    const statBefore = await stat(path.join(destDir, "already.bin"));

    // Run sweep — should skip this file (same inode).
    await store.adoptSweep([env.ws1]);

    // Inode must not change.
    const statAfter = await stat(path.join(destDir, "already.bin"));
    assert.equal(statAfter.ino, statBefore.ino, "already-hardlinked file inode must not change");
    // No errors logged.
    assert.equal(log.errors.length, 0, "no errors expected for idempotent sweep");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adoption sweep — .tmp-* skip
// ---------------------------------------------------------------------------

test("adoptSweep: .tmp-* files are skipped", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const msgAttach = path.join(env.ws1, "msg-attach");
    const tmpFile = path.join(msgAttach, ".tmp-inflight");
    await writeFile(tmpFile, Buffer.from("in-flight download"));

    await store.adoptSweep([env.ws1]);

    // Temp file must still exist (not moved/consumed by sweep).
    assert.ok(existsSync(tmpFile), ".tmp- file must be untouched by sweep");
    // Store must NOT contain an entry for this file.
    const hash = sha256Hex(Buffer.from("in-flight download"));
    const storePath = store.storePathForHash(hash);
    assert.ok(!existsSync(storePath), "store must not contain the .tmp- file");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adoption sweep — subdirectory recursion
// ---------------------------------------------------------------------------

test("adoptSweep: recurses into account-scoped subdirectories", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    // Place a file in a nested account-scoped subdir.
    const data = Buffer.from("nested attachment");
    const hash = sha256Hex(data);
    const subDir = path.join(env.ws1, "msg-attach", "matrix.agent1");
    await mkdir(subDir, { recursive: true });
    await writeFile(path.join(subDir, "nested.bin"), data);

    await store.adoptSweep([env.ws1]);

    const storePath = store.storePathForHash(hash);
    assert.ok(existsSync(storePath), "sweep should recurse into subdirs and adopt the file");
    const wStat = await stat(path.join(subDir, "nested.bin"));
    const sStat = await stat(storePath);
    assert.equal(wStat.ino, sStat.ino, "adopted nested file must share store inode");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adoption sweep — multiple roots
// ---------------------------------------------------------------------------

test("adoptSweep: sweeps all workspace roots", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1, env.ws2]);

    const d1 = Buffer.from("ws1 file");
    const d2 = Buffer.from("ws2 file");
    const h1 = sha256Hex(d1);
    const h2 = sha256Hex(d2);

    await writeFile(path.join(env.ws1, "msg-attach", "a.bin"), d1);
    await writeFile(path.join(env.ws2, "msg-attach", "b.bin"), d2);

    await store.adoptSweep([env.ws1, env.ws2]);

    assert.ok(existsSync(store.storePathForHash(h1)), "ws1 file should be in store");
    assert.ok(existsSync(store.storePathForHash(h2)), "ws2 file should be in store");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Default-off: no store → legacy byte-identical behaviour
// ---------------------------------------------------------------------------

test("saveMediaToWorkspace: no store → direct write, same file content", async () => {
  const env = await makeEnv();
  try {
    const data = Buffer.from("legacy mode attachment");
    const result = await saveMediaToWorkspace({
      data,
      workspaceRoot: env.ws1,
      originalFilename: "test.png",
      contentType: "image/png",
      // no store
    });

    assert.ok(result.absolutePath.startsWith(env.ws1));
    assert.ok(result.localPath.startsWith("msg-attach/"));
    assert.deepEqual(await readFile(result.absolutePath), data);
    // contentHash is still returned (computed in-process even without store).
    assert.equal(result.contentHash, sha256Hex(data));
  } finally {
    await env.cleanup();
  }
});

test("moveFileToWorkspace: no store → legacy rename, same file content", async () => {
  const env = await makeEnv();
  try {
    const data = Buffer.from("legacy rename content");
    const tmpSrc = generateTempDownloadPath(env.ws1);
    await mkdir(path.dirname(tmpSrc), { recursive: true });
    await writeFile(tmpSrc, data);

    const result = await moveFileToWorkspace({
      sourcePath: tmpSrc,
      workspaceRoot: env.ws1,
      originalFilename: "dl.bin",
      // no store
    });

    assert.ok(!existsSync(tmpSrc), "source should be consumed");
    assert.deepEqual(await readFile(result.absolutePath), data);
    assert.equal(result.contentHash, sha256Hex(data));
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// saveMediaToWorkspace: with store
// ---------------------------------------------------------------------------

test("saveMediaToWorkspace: with store → integrated into store + hardlink", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("buffer attachment via saveMediaToWorkspace");
    const result = await saveMediaToWorkspace({
      data,
      workspaceRoot: env.ws1,
      originalFilename: "img.png",
      contentType: "image/png",
      store,
    });

    const hash = sha256Hex(data);
    assert.equal(result.contentHash, hash);

    const storePath = store.storePathForHash(hash);
    assert.ok(existsSync(storePath));

    const dStat = await stat(result.absolutePath);
    const sStat = await stat(storePath);
    assert.equal(dStat.ino, sStat.ino, "saveMediaToWorkspace dest must share store inode");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// moveFileToWorkspace: with store
// ---------------------------------------------------------------------------

test("moveFileToWorkspace: with store → integrated into store + hardlink", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1]);

    const data = Buffer.from("downloaded content via moveFileToWorkspace");
    const tmpSrc = generateTempDownloadPath(env.ws1);
    await mkdir(path.dirname(tmpSrc), { recursive: true });
    await writeFile(tmpSrc, data);

    const result = await moveFileToWorkspace({
      sourcePath: tmpSrc,
      workspaceRoot: env.ws1,
      originalFilename: "dl.png",
      contentType: "image/png",
      store,
    });

    const hash = sha256Hex(data);
    assert.equal(result.contentHash, hash);

    const storePath = store.storePathForHash(hash);
    assert.ok(existsSync(storePath));

    const dStat = await stat(result.absolutePath);
    const sStat = await stat(storePath);
    assert.equal(dStat.ino, sStat.ino, "moveFileToWorkspace dest must share store inode");
    assert.ok(!existsSync(tmpSrc), "source temp must be consumed");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// moveFileToWorkspace: dedup via store (two downloads, same content)
// ---------------------------------------------------------------------------

test("moveFileToWorkspace: dedup — second download same content → same store inode", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    await store.init([env.ws1, env.ws2]);

    const data = Buffer.from("shared download content");

    // Agent 1 downloads.
    const tmp1 = generateTempDownloadPath(env.ws1);
    await mkdir(path.dirname(tmp1), { recursive: true });
    await writeFile(tmp1, data);
    const r1 = await moveFileToWorkspace({
      sourcePath: tmp1,
      workspaceRoot: env.ws1,
      attachSubdir: "matrix.agent1",
      originalFilename: "shared.bin",
      store,
    });

    // Agent 2 downloads the same content independently.
    const tmp2 = generateTempDownloadPath(env.ws2);
    await mkdir(path.dirname(tmp2), { recursive: true });
    await writeFile(tmp2, data);
    const r2 = await moveFileToWorkspace({
      sourcePath: tmp2,
      workspaceRoot: env.ws2,
      attachSubdir: "matrix.agent2",
      originalFilename: "shared.bin",
      store,
    });

    const s1 = await stat(r1.absolutePath);
    const s2 = await stat(r2.absolutePath);
    assert.equal(s1.ino, s2.ino, "two agents' copies of the same content must share one inode");
    assert.equal(r1.contentHash, r2.contentHash, "contentHash must match");
  } finally {
    await env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// isReady() before init()
// ---------------------------------------------------------------------------

test("isReady(): false before init", () => {
  const store = new AttachmentStore("/tmp/non-existent", makeLogger());
  assert.equal(store.isReady(), false);
});

// ---------------------------------------------------------------------------
// adoptSweep(): no-op when not ready
// ---------------------------------------------------------------------------

test("adoptSweep(): no-op when store not ready (does not throw)", async () => {
  const env = await makeEnv();
  try {
    const store = new AttachmentStore(env.storePath, makeLogger());
    // Do not call init() — store is not ready.
    await assert.doesNotReject(() => store.adoptSweep([env.ws1]));
  } finally {
    await env.cleanup();
  }
});
