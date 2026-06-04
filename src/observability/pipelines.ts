import type { PipelineId } from "../storage/index.js";

/**
 * The tiny read-only stats seam each background worker pool exposes for the
 * pipeline monitor (ARCHITECTURE.md §11). Counts-by-status are derived from the DB
 * (the single source of truth that survives restart); the only genuinely live
 * number here is `inFlight()` (the pool's `activeWorkers.size`). `workerCount`/
 * `maxRetries` come from config; `concurrency` is captioning's per-modality limit
 * map (image/video/audio), absent for the other pools.
 */
export interface PipelineStats {
  readonly pool: PipelineId;
  workerCount: number;
  maxRetries: number;
  inFlight(): number;
  concurrency?: Record<string, number>;
}

/**
 * The four pool stat sources handed to the observability server. Summarization and
 * diary are nullable: either can be disabled by config, in which case the monitor
 * still reports DB-derived history for the pool but shows it as not running
 * (no live worker, inFlight 0).
 */
export interface PipelineRegistry {
  enrichment: PipelineStats;
  captioning: PipelineStats;
  summarization: PipelineStats | null;
  diary: PipelineStats | null;
}
