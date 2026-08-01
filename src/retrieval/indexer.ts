import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { Tokenizer } from "../context/tokenizer/types.js";
import { chunkMemoryFile, dayFromFilename } from "./chunk.js";
import type { ResolvedRetrievalConfig } from "./config.js";

const MEMORY_DIR = "memory";
const MD_FILE_RE = /\.md$/;
/**
 * Files in `memory/` that are NOT memory *content* and must never be indexed as
 * retrieval candidates. `README.md` is the agent's own scratchpad/instructions
 * *about* the memory directory (how to log, what to keep) — meta, not a diary
 * entry — yet it used to top almost every auto-retrieval result because its prose
 * ("notable room events", "user-profile updates", …) lexically resembles a query.
 * Matched case-insensitively on basename. Any chunks already indexed for an excluded
 * file are pruned on the next `reconcileAll` (the on-disk set no longer lists it).
 */
const NON_CONTENT_FILES = new Set(["readme.md"]);
/**
 * Base key for the corpus-freshness signature in `index_meta`. In legacy mode this
 * key is used as-is. In agents mode it is namespaced per-agent (`"corpus_signature:<name>"`)
 * so each agent's indexer has an independent freshness signal without global
 * invalidation (spec MULTI-AGENT-SUPPORT §7.1).
 */
const CORPUS_SIGNATURE_KEY_BASE = "corpus_signature";

export interface MemoryIndexerOptions {
  storage: Storage;
  workspaceRoot: string;
  config: ResolvedRetrievalConfig;
  /**
   * Embedder-matched tokenizer for chunking (spec/TOKENIZER-SWAP.md §5.3). Injected
   * (not read from the module-level chat tokenizer) so the memory corpus's chunk
   * boundaries/hashes track the embedding model and are unaffected by switching the
   * chat tokenizer. Defaults to `gpt-tokenizer` (`[tokenizer].retrieval`).
   */
  tokenizer: Tokenizer;
  logger?: Logger;
  /** Prune vectors for chunks removed this reconcile (set by the subsystem, §9d). */
  pruneVectors?: (rowids: number[]) => void;
  /** Fired after a reconcile that inserted chunks, to wake the embed worker. */
  onChunksInserted?: () => void;
  /**
   * Whether an embedding provider is active (#2). When false (lexical-only mode —
   * provider/vector-store init failed or no model resolved), newly-inserted chunks
   * are stamped `'skip'` instead of `'pending'` so the embed queue doesn't grow
   * unbounded with work nothing will ever process. Defaults to active.
   */
  embeddingsActive?: () => boolean;
  /**
   * Agent name for this indexer's corpus (spec MULTI-AGENT-SUPPORT §7.1). In agents
   * mode, chunks indexed by this instance are stamped with this name and queries are
   * scoped to it. Null (default) = legacy mode: no stamping, no filtering.
   * The `"__legacy__"` sentinel used by agentWorkspaceMap in app.ts is treated as
   * null here (it is an internal map key, not a real agent name to stamp on rows).
   */
  agentName?: string | null;
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
  private readonly tokenizer: Tokenizer;
  private readonly logger?: Logger;
  private readonly pruneVectors?: (rowids: number[]) => void;
  private readonly onChunksInserted?: () => void;
  private readonly embeddingsActive?: () => boolean;
  /**
   * The effective agent name for this indexer: null in legacy mode, the configured
   * agent name in agents mode. The `"__legacy__"` sentinel is normalized to null.
   */
  readonly agentName: string | null;
  /** Strict-FIFO tail so reconciles never overlap (low volume; mirrors the writer). */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: MemoryIndexerOptions) {
    this.storage = opts.storage;
    this.workspaceRoot = opts.workspaceRoot;
    this.config = opts.config;
    this.tokenizer = opts.tokenizer;
    this.logger = opts.logger;
    this.pruneVectors = opts.pruneVectors;
    this.onChunksInserted = opts.onChunksInserted;
    this.embeddingsActive = opts.embeddingsActive;
    // Normalize the sentinel: "__legacy__" is an internal map key, not a real agent name.
    const raw = opts.agentName ?? null;
    this.agentName = raw === "__legacy__" ? null : raw;
  }

  /** Per-agent corpus signature key in `index_meta` (spec §7.1). */
  private get corpusSignatureKey(): string {
    return this.agentName !== null
      ? `${CORPUS_SIGNATURE_KEY_BASE}:${this.agentName}`
      : CORPUS_SIGNATURE_KEY_BASE;
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

  /**
   * Reconcile every `memory/*.md` and prune index entries for vanished files (§7).
   * Returns the set of workspace-relative paths that are on disk in this indexer's
   * `memory/` directory, so the subsystem can build the union across all agents and
   * run the null-orphan sweep at the subsystem level (spec §7.1 — see subsystem.ts).
   */
  reconcileAll(): Promise<Set<string>> {
    return this.enqueue(() => this.reconcileAllInner());
  }

  /**
   * Lazy pre-search freshness check (§7): hash the directory listing + mtimes/sizes
   * into a signature and reconcile only if it changed since the last sweep.
   * Near-free when clean; the safety net if a write hook was ever missed.
   */
  async ensureFreshForQuery(): Promise<void> {
    const signature = await this.corpusSignature();
    if (signature === this.storage.getIndexMeta(this.corpusSignatureKey)) return;
    await this.reconcileAll();
  }

  private async reconcileAllInner(): Promise<Set<string>> {
    const names = await this.listMemoryFiles();
    const onDisk = new Set(names.map((n) => this.relativePath(n)));
    for (const name of names) {
      await this.reconcileFileInner(this.relativePath(name));
    }
    // Prune index entries owned by THIS agent whose file no longer exists on disk.
    // Scoped strictly to `this.agentName` (including NULL for legacy mode) — never
    // touches another agent's rows or NULL rows in agents mode. The subsystem is
    // responsible for sweeping NULL rows that are orphaned across ALL roots after
    // all per-agent walks complete (spec §7.1 — see subsystem.ts).
    const agentPaths = this.storage.listMemoryChunkPaths(this.agentName);
    for (const indexedPath of agentPaths) {
      if (!onDisk.has(indexedPath)) {
        const removed = await this.storage.deleteMemoryChunksForPath(indexedPath, this.agentName);
        this.logger?.info("memory_index_pruned", {
          path: indexedPath,
          agent: this.agentName,
          removed,
        });
      }
    }
    const signature = await this.corpusSignature();
    await this.storage.setIndexMeta(this.corpusSignatureKey, signature);
    return onDisk;
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
        // File gone between hook and read → drop its chunks (this agent's only).
        await this.storage.deleteMemoryChunksForPath(rel, this.agentName);
        return;
      }
      throw error;
    }
    const chunks = await chunkMemoryFile({
      relativePath: rel,
      text,
      fileDate: dayFromFilename(path.basename(rel)),
      fallbackTimestamp: mtimeMs,
      maxChunkTokens: this.config.index.maxChunkTokens,
      fallbackChunkTokens: this.config.index.fallbackChunkTokens,
      fallbackChunkOverlap: this.config.index.fallbackChunkOverlap,
      tokenizer: this.tokenizer,
    });
    // In lexical-only mode (no active provider) stamp new chunks 'skip' so the embed
    // queue doesn't grow unbounded (#2); 'pending' otherwise. `resetAllEmbeddings()`
    // re-queues 'skip' rows if a provider later becomes active (§5a).
    const newChunkStatus = this.embeddingsActive?.() === false ? "skip" : "pending";
    const result = await this.storage.reconcileMemoryChunks(rel, chunks, newChunkStatus, this.agentName);
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
      return entries
        .filter((n) => MD_FILE_RE.test(n) && !NON_CONTENT_FILES.has(n.toLowerCase()))
        .sort();
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
