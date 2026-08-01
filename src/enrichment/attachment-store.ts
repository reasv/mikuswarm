import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  mkdir,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/**
 * Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / §13 Phase 5d).
 *
 * Deduplicates attachment *files* across agents by storing a single canonical
 * copy keyed by sha256 hash and hardlinking it into every workspace that needs
 * it. `media_assets.local_path` semantics are unchanged — it remains a
 * workspace-relative path to the hardlink.
 *
 * Store layout: `<storePath>/<hh>/<fullSha256Hex>`
 *   Two-level fan-out (`hh` = first two hex characters) limits top-level
 *   directory entries to at most 256 entries (one per hex pair), keeping
 *   directory stat cost constant regardless of corpus size.
 *
 * Read-only discipline: store files are set chmod 0444 immediately after they
 * land (both new inserts and adopted files). Since workspace paths are
 * hardlinks to the same inode, a write attempt through any path fails loudly
 * rather than silently corrupting other agents' copies (spec §11.5
 * "read-only or copy-on-write discipline").
 *
 * Same-filesystem requirement: the store and every workspace root must share a
 * filesystem (hardlinks cannot cross device boundaries). Validated at startup
 * via a cross-device link() probe; a startup error names the offending root.
 *
 * Default-off: `AttachmentStore` is only constructed when
 * `[attachment_store] enabled = true` is set. When absent, all write-path
 * functions (`moveFileToWorkspace`, `saveMediaToWorkspace`) behave byte-
 * identically to before this feature — no store object is created, no probe
 * runs, no extra I/O.
 */
export class AttachmentStore {
  private ready = false;
  /** Roots for which we have already emitted an EXDEV warning (suppresses spam). */
  private readonly exdevWarnedDirs = new Set<string>();

  constructor(
    private readonly storePath: string,
    private readonly logger: {
      info(msg: string, data?: Record<string, unknown>): void;
      warn(msg: string, data?: Record<string, unknown>): void;
      error(msg: string, data?: Record<string, unknown>): void;
    },
  ) {}

  /**
   * Create the store directory and run the cross-device link() probe against
   * every declared workspace root. Throws with a clear message if any root is
   * on a different filesystem (EXDEV from link()).
   *
   * Must be called before any other method. After a successful call
   * `isReady()` returns true.
   */
  async init(workspaceRoots: string[]): Promise<void> {
    await mkdir(this.storePath, { recursive: true });

    // Cross-device probe: create a temp file in the store dir, then try
    // link() it into each workspace root's msg-attach/ subdir. EXDEV means
    // they live on different filesystems — fail startup with a clear message.
    const probeName = `.probe-${randomBytes(8).toString("hex")}`;
    const probeSrc = path.join(this.storePath, probeName);
    await writeFile(probeSrc, "");
    try {
      for (const wsRoot of workspaceRoots) {
        const attachDir = path.join(wsRoot, "msg-attach");
        await mkdir(attachDir, { recursive: true });
        const probeDst = path.join(attachDir, probeName);
        try {
          await link(probeSrc, probeDst);
          await unlink(probeDst).catch(() => {});
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EXDEV") {
            throw new Error(
              `[attachment_store] workspace root "${wsRoot}" is on a different filesystem than ` +
                `the store at "${this.storePath}". Hardlinks cannot cross device boundaries. ` +
                `Mount the store on the same filesystem as all workspace roots, or disable ` +
                `[attachment_store].`,
            );
          }
          throw err;
        }
      }
    } finally {
      await unlink(probeSrc).catch(() => {});
    }

    this.ready = true;
    this.logger.info("attachment_store_ready", {
      path: this.storePath,
      workspaceRoots: workspaceRoots.length,
    });
  }

  /** True after a successful `init()`. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * The canonical store path for a sha256 hex hash.
   * Layout: `<store>/<hh>/<fullHash>` (two-level fan-out).
   */
  storePathForHash(hash: string): string {
    return path.join(this.storePath, hash.slice(0, 2), hash);
  }

  /**
   * Integrate a temp download file into the store.
   *
   * - **Hash already in store**: hardlink store → dest; unlink source. The
   *   download itself happened — we only save the duplicate *disk copy*.
   * - **Hash new**: rename/move source → store; chmod 0444; hardlink store
   *   → dest. Falls back to copy+unlink if rename crosses filesystems.
   * - **EXDEV at link time**: log warn once per directory, fall back to a
   *   plain move/copy to dest without store participation.
   *
   * `destDir` is created if it does not exist. Returns the absolute path of
   * the destination file. Throws on unrecoverable errors.
   */
  async integrateDownload(params: {
    sourcePath: string;
    destDir: string;
    filename: string;
    hash: string; // full sha256 hex
  }): Promise<string> {
    const { sourcePath, destDir, filename, hash } = params;
    const storeFanDir = path.join(this.storePath, hash.slice(0, 2));
    const storePath = path.join(storeFanDir, hash);
    const destPath = path.join(destDir, filename);

    await mkdir(destDir, { recursive: true });

    // Check whether the hash is already in the store.
    let storeExists = false;
    try {
      await stat(storePath);
      storeExists = true;
    } catch {
      // Not in store yet.
    }

    if (storeExists) {
      // Dedup path: hardlink store → dest, discard source.
      try {
        await link(storePath, destPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EEXIST") {
          // Dest already exists (another worker beat us, same content). Fine.
        } else if (code === "EXDEV") {
          this.warnExdev(destDir, storePath, destPath);
          return this.fallbackMove(sourcePath, destPath);
        } else {
          throw err;
        }
      }
      await unlink(sourcePath).catch(() => {});
      return destPath;
    }

    // New content path: land source in the store, then hardlink to dest.
    await mkdir(storeFanDir, { recursive: true });

    try {
      await rename(sourcePath, storePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        // Temp file and store are on different fs — this should have been
        // caught by the startup probe, but degrade gracefully.
        this.warnExdev(destDir, storePath, sourcePath);
        return this.fallbackMove(sourcePath, destPath);
      }
      throw err;
    }

    // Read-only: protect the store inode (and all future hardlinks to it).
    await chmod(storePath, 0o444).catch(() => {});

    // Hardlink store → dest.
    try {
      await link(storePath, destPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Destination already exists — race with a concurrent worker.
      } else if (code === "EXDEV") {
        // Store and workspace are on different filesystems (probe missed this).
        this.warnExdev(destDir, storePath, destPath);
        await copyFile(storePath, destPath).catch(() => {});
      } else {
        throw err;
      }
    }

    return destPath;
  }

  /**
   * Integrate a Buffer into the store.
   *
   * Writes the buffer to a temp file inside the store directory (same-fs as
   * the store is guaranteed; same-fs as workspace roots is guaranteed by the
   * startup probe), then delegates to `integrateDownload`.
   */
  async integrateBuffer(params: {
    data: Buffer;
    hash: string; // full sha256 hex
    destDir: string;
    filename: string;
  }): Promise<string> {
    // Dedup fast path: content already in the store → hardlink straight to the
    // destination, skipping the temp write entirely.
    const existing = this.storePathForHash(params.hash);
    try {
      await stat(existing);
      const destPath = path.join(params.destDir, params.filename);
      await mkdir(params.destDir, { recursive: true });
      await link(existing, destPath);
      return destPath;
    } catch {
      // Not in store (or racing link failure) — fall through to the temp-write path.
    }
    const tmpPath = path.join(this.storePath, `.tmp-${randomBytes(8).toString("hex")}`);
    await mkdir(this.storePath, { recursive: true });
    await writeFile(tmpPath, params.data);
    try {
      return await this.integrateDownload({
        sourcePath: tmpPath,
        destDir: params.destDir,
        filename: params.filename,
        hash: params.hash,
      });
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  /**
   * Background adoption sweep (spec §11.5 "resumable background
   * reconciliation sweep").
   *
   * Walks every `msg-attach/` tree under each workspace root and adopts
   * existing files into the store:
   *
   * - **Not in store**: `link()` the workspace file into the store (adopts
   *   the inode); chmod 0444.
   * - **In store, different inode**: atomic swap — link(store→tmp);
   *   rename(tmp→workspace) — workspace path now points to the store inode,
   *   freeing the duplicate block allocation.
   * - **Same inode**: already hardlinked; skip.
   *
   * Skips `.tmp-*` files (in-flight downloads). Skips files on a different
   * filesystem (EXDEV, logged once per directory). No persistent cursor
   * needed: the inode comparison makes every re-walk idempotent and cheap
   * (stat() only on already-adopted files).
   *
   * DB `local_path` values are never updated — paths remain valid because
   * the swap preserves the workspace-side filename (only the inode changes).
   */
  async adoptSweep(workspaceRoots: string[]): Promise<void> {
    if (!this.ready) return;
    const counters = { adopted: 0, swapped: 0, skipped: 0, errors: 0 };

    for (const wsRoot of workspaceRoots) {
      await this.sweepDir(path.join(wsRoot, "msg-attach"), counters);
    }

    if (counters.adopted > 0 || counters.swapped > 0 || counters.errors > 0) {
      this.logger.info("attachment_store_sweep_done", counters);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async sweepDir(
    dir: string,
    counters: { adopted: number; swapped: number; skipped: number; errors: number },
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return; // directory doesn't exist yet
    }

    for (const entry of entries) {
      if (entry.startsWith(".tmp-")) continue;
      if (entry.includes(".swap-")) {
        // Orphaned swap temp from a crash between link() and rename() — the
        // workspace path still holds the old inode, so the orphan is pure
        // residue. Unlinking only decrements the store inode's link count.
        await unlink(path.join(dir, entry)).catch(() => {});
        continue;
      }

      const filePath = path.join(dir, entry);
      let fileStat: Awaited<ReturnType<typeof stat>>;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue; // vanished concurrently
      }

      if (fileStat.isDirectory()) {
        await this.sweepDir(filePath, counters);
        continue;
      }
      if (!fileStat.isFile()) continue;

      let hash: string;
      try {
        hash = await hashFileSha256(filePath);
      } catch {
        counters.errors++;
        continue;
      }

      const storeFanDir = path.join(this.storePath, hash.slice(0, 2));
      const storePath = path.join(storeFanDir, hash);

      let storeStat: Awaited<ReturnType<typeof stat>> | null = null;
      try {
        storeStat = await stat(storePath);
      } catch {
        // Not in store.
      }

      if (storeStat === null) {
        // Adopt: link workspace file into store.
        try {
          await mkdir(storeFanDir, { recursive: true });
          await link(filePath, storePath);
          await chmod(storePath, 0o444).catch(() => {});
          counters.adopted++;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EEXIST") {
            // Race: another sweep/write created the store entry. Re-check.
            storeStat = await stat(storePath).catch(() => null);
            if (storeStat && storeStat.ino !== fileStat.ino) {
              await this.swapInodes(filePath, storePath, counters);
            } else {
              counters.skipped++;
            }
          } else if (code === "EXDEV") {
            this.warnExdevSweep(dir, filePath);
            counters.errors++;
          } else {
            counters.errors++;
          }
        }
      } else if (storeStat.ino !== fileStat.ino) {
        // Duplicate inode: swap workspace path to the store inode.
        await this.swapInodes(filePath, storePath, counters);
      } else {
        // Already hardlinked.
        counters.skipped++;
      }
    }
  }

  private async swapInodes(
    workspacePath: string,
    storePath: string,
    counters: { swapped: number; errors: number },
  ): Promise<void> {
    // Atomic swap: link(store→tmp), rename(tmp→workspace).
    // After rename, the workspace path points to the store inode; the old
    // duplicate block allocation is freed when its link count drops to zero.
    const tmpPath = `${workspacePath}.swap-${randomBytes(4).toString("hex")}`;
    try {
      await link(storePath, tmpPath);
      await rename(tmpPath, workspacePath);
      counters.swapped++;
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        this.warnExdevSweep(path.dirname(workspacePath), workspacePath);
      }
      counters.errors++;
    }
  }

  private async fallbackMove(sourcePath: string, destPath: string): Promise<string> {
    if (existsSync(destPath)) {
      await unlink(sourcePath).catch(() => {});
      return destPath;
    }
    try {
      await rename(sourcePath, destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        await copyFile(sourcePath, destPath);
        await unlink(sourcePath).catch(() => {});
      } else {
        throw err;
      }
    }
    return destPath;
  }

  private warnExdev(destDir: string, storePath: string, related: string): void {
    if (!this.exdevWarnedDirs.has(destDir)) {
      this.exdevWarnedDirs.add(destDir);
      this.logger.warn("attachment_store_exdev_fallback", {
        destDir,
        storePath,
        related,
        message:
          "EXDEV: store and workspace appear to be on different filesystems — " +
          "falling back to direct workspace write (startup probe should have caught this)",
      });
    }
  }

  private warnExdevSweep(dir: string, file: string): void {
    if (!this.exdevWarnedDirs.has(dir)) {
      this.exdevWarnedDirs.add(dir);
      this.logger.warn("attachment_store_sweep_exdev", {
        dir,
        file,
        message: "EXDEV during adoption sweep — file left un-adopted (cross-filesystem)",
      });
    }
  }
}

/**
 * Compute the sha256 hex hash of a file (streaming, no extra key).
 * Exported for tests.
 */
export async function hashFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
