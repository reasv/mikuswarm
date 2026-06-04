import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import { chunkMemoryFile, dayFromFilename } from "./chunk.js";
import type { ResolvedRetrievalConfig } from "./config.js";

const MEMORY_DIR = "memory";
const MD_FILE_RE = /\.md$/;
const CORPUS_SIGNATURE_KEY = "corpus_signature";

export interface MemoryIndexerOptions {
  storage: Storage;
  workspaceRoot: string;
  config: ResolvedRetrievalConfig;
  logger?: Logger;
  /** Prune vectors for chunks removed this reconcile (set by the subsystem, §9d). */
  pruneVectors?: (rowids: number[]) => void;
  /** Fired after a reconcile that inserted chunks, to wake the embed worker. */
  onChunksInserted?: () => void;
}

/**
 * Keeps the `memory_chunks` lexical index in sync with the `memory/*.md` files on
 * disk (ARCHITECTURE.md §9d / design §7). Memory is *files*, not DB rows, so there
 * is no insert site to stamp `pending` — instead this performs content-hash
 * **reconciliation**, triggered cheaply and often: a precise per-file hook after
 * each `MemoryFileWriter` mutation, a full sweep at startup, and a lazy
 * corpus-signature check before each search. All three converge on the same
 * idempotent set-diff (the DB is the idempotency authority), so a missed hook only
 * costs latency, never correctness.
 */
export class MemoryIndexer {
  private readonly storage: Storage;
  private readonly workspaceRoot: string;
  private readonly config: ResolvedRetrievalConfig;
  private readonly logger?: Logger;
  private readonly pruneVectors?: (rowids: number[]) => void;
  private readonly onChunksInserted?: () => void;
  /** Strict-FIFO tail so reconciles never overlap (low volume; mirrors the writer). */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: MemoryIndexerOptions) {
    this.storage = opts.storage;
    this.workspaceRoot = opts.workspaceRoot;
    this.config = opts.config;
    this.logger = opts.logger;
    this.pruneVectors = opts.pruneVectors;
    this.onChunksInserted = opts.onChunksInserted;
  }

  private get memoryDir(): string {
    return path.join(this.workspaceRoot, MEMORY_DIR);
  }

  /** Workspace-relative, posix-style path for a memory file (the index `path` key). */
  private relativePath(absOrName: string): string {
    const base = path.basename(absOrName);
    return `${MEMORY_DIR}/${base}`;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op);
    this.tail = run.catch(() => {});
    return run;
  }

  /**
   * Fire-and-forget reconcile of one file, hooked off `MemoryFileWriter` mutations
   * (§7). Serialized on the tail; errors are logged, never thrown to the writer.
   */
  enqueueReconcile(absPath: string): void {
    const rel = this.relativePath(absPath);
    void this.enqueue(() => this.reconcileFileInner(rel)).catch((error) => {
      this.logger?.warn("memory_reconcile_failed", {
        path: rel,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Reconcile every `memory/*.md` and prune index entries for vanished files (§7). */
  reconcileAll(): Promise<void> {
    return this.enqueue(() => this.reconcileAllInner());
  }

  /**
   * Lazy pre-search freshness check (§7): hash the directory listing + mtimes/sizes
   * into a signature and reconcile only if it changed since the last sweep.
   * Near-free when clean; the safety net if a write hook was ever missed.
   */
  async ensureFreshForQuery(): Promise<void> {
    const signature = await this.corpusSignature();
    if (signature === this.storage.getIndexMeta(CORPUS_SIGNATURE_KEY)) return;
    await this.reconcileAll();
  }

  private async reconcileAllInner(): Promise<void> {
    const names = await this.listMemoryFiles();
    const onDisk = new Set(names.map((n) => this.relativePath(n)));
    for (const name of names) {
      await this.reconcileFileInner(this.relativePath(name));
    }
    // Prune index entries whose file no longer exists on disk.
    for (const indexedPath of this.storage.listMemoryChunkPaths()) {
      if (!onDisk.has(indexedPath)) {
        const removed = await this.storage.deleteMemoryChunksForPath(indexedPath);
        this.logger?.info("memory_index_pruned", { path: indexedPath, removed });
      }
    }
    const signature = await this.corpusSignature();
    await this.storage.setIndexMeta(CORPUS_SIGNATURE_KEY, signature);
  }

  /**
   * Read, chunk, and set-diff a single memory file into the index. The actual work;
   * NOT self-serializing — every public entry point (enqueueReconcile / reconcileAll)
   * already runs it under the tail, so calling `enqueue` here would deadlock.
   */
  private async reconcileFileInner(rel: string): Promise<void> {
    const abs = path.join(this.workspaceRoot, rel);
    let text: string;
    let mtimeMs: number;
    try {
      const st = await stat(abs);
      mtimeMs = st.mtimeMs;
      text = await readFile(abs, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // File gone between hook and read → drop its chunks.
        await this.storage.deleteMemoryChunksForPath(rel);
        return;
      }
      throw error;
    }
    const chunks = chunkMemoryFile({
      relativePath: rel,
      text,
      fileDate: dayFromFilename(path.basename(rel)),
      fallbackTimestamp: mtimeMs,
      maxChunkTokens: this.config.index.maxChunkTokens,
      fallbackChunkTokens: this.config.index.fallbackChunkTokens,
      fallbackChunkOverlap: this.config.index.fallbackChunkOverlap,
    });
    const result = await this.storage.reconcileMemoryChunks(rel, chunks);
    if (result.deletedRowids.length > 0) this.pruneVectors?.(result.deletedRowids);
    if (result.inserted || result.deleted) {
      this.logger?.debug("memory_reconciled", {
        path: rel,
        inserted: result.inserted,
        updated: result.updated,
        deleted: result.deleted,
        chunks: chunks.length,
      });
    }
    if (result.inserted > 0) this.onChunksInserted?.();
  }

  private async listMemoryFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.memoryDir);
      return entries.filter((n) => MD_FILE_RE.test(n)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  /** Cheap corpus fingerprint: sorted (name, mtimeMs, size) hashed. */
  private async corpusSignature(): Promise<string> {
    const names = await this.listMemoryFiles();
    const hash = createHash("sha256");
    for (const name of names) {
      try {
        const st = await stat(path.join(this.memoryDir, name));
        hash.update(`${name}\0${st.mtimeMs}\0${st.size}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
    return hash.digest("hex");
  }
}
