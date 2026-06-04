import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";

const ACTIVE_DIM_KEY = "active_dim";
const ACTIVE_MODEL_KEY = "active_model_id";

/** One KNN hit from the vector index. */
export interface VecHit {
  chunkId: number;
  /** Cosine distance in [0,2] (vec0 `distance_metric=cosine`). */
  distance: number;
}

function toBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Thin wrapper over the `sqlite-vec` `memory_vec` virtual table (ARCHITECTURE.md
 * §9d / design §5b). The extension is loaded onto the single Storage connection
 * once; the table is created with the active model's dimension. A dimension change
 * (model switch, §5a) drops and recreates the table — `memory_chunks` (lexical,
 * text, metadata) is untouched, so search stays live on BM25 throughout.
 *
 * IMPORTANT: `chunk_id` must be bound as a BigInt — better-sqlite3 binds plain JS
 * numbers in a form vec0 rejects ("Only integers are allowed for primary key").
 */
export class VectorStore {
  private loaded = false;
  /**
   * Once-per-process guard so a genuine vec0 corruption/binding failure (which makes
   * the semantic half silently no-op) is surfaced exactly once rather than spammed on
   * every query (#17). Set the first time `getVectors`/`knn` swallows an error.
   */
  private loggedVectorError = false;

  constructor(
    private readonly storage: Storage,
    private readonly logger?: Logger,
  ) {}

  /** Warn once per process when a read path swallows an error into a graceful empty result (#17). */
  private warnVectorError(op: string, error: unknown): void {
    if (this.loggedVectorError) return;
    this.loggedVectorError = true;
    this.logger?.warn("vector_store_read_failed", {
      op,
      error: error instanceof Error ? error.message : String(error),
      note: "semantic half degraded to empty for this query; warned once per process",
    });
  }

  /** Load the sqlite-vec extension onto the Storage connection (idempotent). */
  async load(): Promise<void> {
    if (this.loaded) return;
    const sqliteVec: any = await import("sqlite-vec");
    await this.storage.write((db) => sqliteVec.load(db));
    this.loaded = true;
  }

  /**
   * Ensure `memory_vec` exists at `dim`. If a prior table exists at a different
   * dimension (a model switch), drop+recreate it and return `true` so the caller
   * can mark all chunks for re-embedding (§5a/§5b). Records `(active_model_id,
   * active_dim)` in `index_meta`.
   */
  async ensureSchema(
    dim: number,
    modelId: string,
  ): Promise<{ recreated: boolean; modelChanged: boolean }> {
    await this.load();
    const priorDim = this.storage.getIndexMeta(ACTIVE_DIM_KEY);
    const priorModel = this.storage.getIndexMeta(ACTIVE_MODEL_KEY);
    // A same-dim model swap still crosses vector spaces → caller must re-embed.
    const modelChanged = priorModel !== undefined && priorModel !== modelId;
    const tableExists = this.storage.read(
      (db) =>
        (
          db
            .prepare(
              `select count(*) as n from sqlite_master where type = 'table' and name = 'memory_vec'`,
            )
            .get() as { n: number }
        ).n > 0,
    );

    let recreated = false;
    if (tableExists && priorDim !== String(dim)) {
      await this.storage.write((db) => db.exec(`drop table if exists memory_vec`));
      this.logger?.warn("vector_index_dim_changed", { from: priorDim, to: dim, model: modelId });
      recreated = true;
    }

    await this.storage.write((db) =>
      db.exec(
        `create virtual table if not exists memory_vec using vec0(
           chunk_id integer primary key,
           embedding float[${dim}] distance_metric=cosine,
           source text partition key
         )`,
      ),
    );

    // A same-dim model swap keeps the table (dim is unchanged) but every existing
    // vector belongs to the OLD model's space — cosine against new-model query
    // vectors is meaningless (#3). The caller re-queues all chunks for re-embedding,
    // but until each is overwritten the table would mix old/new-model rows and KNN
    // could surface stale cross-space hits. Clear it now so KNN returns only fresh
    // rows and search degrades to lexical for the rest (the intended graceful path,
    // §4/§5a). `memory_chunks` (lexical/FTS) is untouched, so search stays live.
    // (The dim-change branch above already dropped+recreated the table, so this only
    // matters for the same-dim case where the table survived.)
    if (modelChanged && !recreated) {
      await this.storage.write((db) => db.exec(`delete from memory_vec`));
      this.logger?.warn("vector_index_model_changed", { from: priorModel, to: modelId, dim });
    }

    if (priorModel !== modelId) await this.storage.setIndexMeta(ACTIVE_MODEL_KEY, modelId);
    if (priorDim !== String(dim)) await this.storage.setIndexMeta(ACTIVE_DIM_KEY, String(dim));
    return { recreated, modelChanged };
  }

  /** Insert/replace a chunk's vector. `chunkId` = `memory_chunks.rowid`. */
  async upsert(chunkId: number, source: string, vec: Float32Array): Promise<void> {
    await this.storage.write((db) => {
      db.prepare(`delete from memory_vec where chunk_id = ?`).run(BigInt(chunkId));
      db.prepare(`insert into memory_vec(chunk_id, embedding, source) values (?, ?, ?)`).run(
        BigInt(chunkId),
        toBuffer(vec),
        source,
      );
    });
  }

  /**
   * Fetch stored vectors by chunk id (for MMR diversity re-ranking, §8a). Best-effort:
   * returns whatever it can read as Float32Arrays, or an empty map on any error.
   */
  getVectors(chunkIds: number[]): Map<number, Float32Array> {
    const out = new Map<number, Float32Array>();
    if (!this.loaded || chunkIds.length === 0) return out;
    try {
      this.storage.read((db) => {
        const sel = db.prepare(`select embedding from memory_vec where chunk_id = ?`);
        for (const id of chunkIds) {
          const row = sel.get(BigInt(id)) as { embedding: Buffer | Uint8Array } | undefined;
          if (!row) continue;
          const buf = Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding);
          const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
          out.set(id, new Float32Array(copy));
        }
      });
    } catch (error) {
      this.warnVectorError("getVectors", error);
      return new Map();
    }
    return out;
  }

  /** Remove a chunk's vector (chunk deleted from the corpus). */
  async remove(chunkId: number): Promise<void> {
    await this.storage.write((db) =>
      db.prepare(`delete from memory_vec where chunk_id = ?`).run(BigInt(chunkId)),
    );
  }

  /**
   * Brute-force cosine KNN over the index (§5b). `k` is interpolated (a validated
   * integer, never user input) to sidestep the same integer-binding quirk; `source`
   * is bound normally. Returns `[]` if the table doesn't exist yet.
   */
  knn(queryVec: Float32Array, k: number, source?: string): VecHit[] {
    if (!this.loaded) return [];
    const safeK = Math.max(1, Math.floor(k));
    try {
      return this.storage.read((db) => {
        const exists =
          (
            db
              .prepare(
                `select count(*) as n from sqlite_master where type = 'table' and name = 'memory_vec'`,
              )
              .get() as { n: number }
          ).n > 0;
        if (!exists) return [];
        // `k` is interpolated (a validated integer) for the same reason chunk_id is
        // bound as BigInt: vec0's hidden `k` constraint is strict about integer typing.
        const sourceClause = source !== undefined ? " and source = ?" : "";
        const params: unknown[] =
          source !== undefined ? [toBuffer(queryVec), source] : [toBuffer(queryVec)];
        const rows = db
          .prepare(
            `select chunk_id as chunkId, distance from memory_vec
             where embedding match ? and k = ${safeK}${sourceClause} order by distance`,
          )
          .all(...params) as VecHit[];
        return rows;
      });
    } catch (error) {
      // A genuine vec0 corruption/binding failure would otherwise present as "the
      // semantic half just no-ops" forever with no log. Warn once, degrade to empty so
      // search.ts falls back to lexical-only (#17). Behavior unchanged on the missing-
      // table path (that returns `[]` above without throwing).
      this.warnVectorError("knn", error);
      return [];
    }
  }
}
