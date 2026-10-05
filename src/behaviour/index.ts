/**
 * Model behaviour statistics (spec REFUSAL-HANDLING §12.3, §12.4): the boot-time
 * behaviour snapshot and its change events, observed prompt changes, the hourly
 * rollups and the read API behind the console's `/models` page.
 */

import type { AppConfig } from "../config/index.js";
import type { CheckCatalogue } from "../checks/types.js";
import type { Logger } from "../observability/index.js";
import type { Storage } from "../storage/index.js";
import type { UsageEventInput } from "../storage/database.js";
import { recordBehaviourSnapshot, type RecordSnapshotResult } from "./changes.js";
import { PromptChangeTracker } from "./prompt-changes.js";
import { readBehaviourIncidents, readModelBehaviour, type ModelBehaviourQuery } from "./read.js";
import { ModelBehaviourRollups } from "./rollups.js";
import { buildBehaviourSnapshot, snapshotHash, type CodeVersion } from "./snapshot.js";
import type { BehaviourIncidentPage, ModelBehaviourResponse } from "./types.js";
import { resolveCodeVersion } from "./version.js";

export * from "./types.js";
export { HEADLINE_RATES, MODEL_BEHAVIOUR_METRICS, MODEL_BEHAVIOUR_METRIC_FAMILIES } from "./metrics.js";
export { buildBehaviourSnapshot, snapshotHash, type BehaviourSnapshot } from "./snapshot.js";
export { diffBehaviourSnapshots, listBehaviourChanges, recordBehaviourSnapshot } from "./changes.js";
export { ModelBehaviourRollups, computeHourRollups } from "./rollups.js";
export { PromptChangeTracker } from "./prompt-changes.js";
export { BEHAVIOUR_GROUP_BYS, BEHAVIOUR_WINDOWS, type ModelBehaviourQuery } from "./read.js";
export { resolveCodeVersion } from "./version.js";

/** Rollup hours a read recomputes before answering (the background drain does the rest). */

/** What the console server needs. */
export interface ModelBehaviourApi {
  read(query: ModelBehaviourQuery): Promise<ModelBehaviourResponse>;
  incidents(query: ModelBehaviourQuery): Promise<BehaviourIncidentPage>;
}

export interface ModelBehaviourServiceOptions {
  storage: Storage;
  config: AppConfig;
  /** The app's single check catalogue (contract R2). */
  catalogue: CheckCatalogue;
  agentForTimelineKey(timelineKey: string | null): string | null;
  logger?: Logger;
  /** Injected in tests; default {@link resolveCodeVersion}. */
  codeVersion?: CodeVersion;
  rollupIntervalMs?: number;
}

export class ModelBehaviourService implements ModelBehaviourApi {
  readonly rollups: ModelBehaviourRollups;
  readonly prompts: PromptChangeTracker;

  constructor(private readonly options: ModelBehaviourServiceOptions) {
    const checkKind = (code: string, agent: string | null) => options.catalogue.get(code, agent)?.kind;
    this.rollups = new ModelBehaviourRollups({
      storage: options.storage,
      agentForTimelineKey: options.agentForTimelineKey,
      checkKind,
      logger: options.logger,
      intervalMs: options.rollupIntervalMs,
    });
    this.prompts = new PromptChangeTracker({
      storage: options.storage,
      agentForTimelineKey: options.agentForTimelineKey,
      logger: options.logger,
    });
  }

  /** Build the boot snapshot, store it when it changed, and log what changed. */
  async recordStartupSnapshot(now = Date.now()): Promise<RecordSnapshotResult> {
    const snapshot = buildBehaviourSnapshot({
      config: this.options.config,
      catalogue: this.options.catalogue,
      code: this.options.codeVersion ?? resolveCodeVersion(),
    });
    const result = await recordBehaviourSnapshot(this.options.storage, snapshot, now);
    this.options.logger?.info("behaviour_snapshot_recorded", {
      hash: snapshotHash(snapshot),
      changed: result.changed,
      events: result.events.length,
      kinds: [...new Set(result.events.map((e) => e.kind))],
    });
    return result;
  }

  /** Seed the prompt tracker and start the rollup drain. */
  start(): void {
    this.prompts.seed();
    this.rollups.start();
  }

  stop(): void {
    this.rollups.stop();
  }

  /**
   * Recompute every rollup hour from the raw tables (the history backfill calls this
   * after writing back-derived rows). Resolves to the number of hours recomputed.
   */
  rebuildModelBehaviourRollups(): Promise<number> {
    return this.rollups.rebuild();
  }

  /** Ledger fan-in hook: observed prompt changes. Never throws. */
  observeUsage(event: UsageEventInput): void {
    try {
      this.prompts.observe(event);
    } catch (error) {
      this.options.logger?.warn("prompt_change_observe_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private readContext() {
    const models = this.options.config.models as Record<string, { family?: string } | undefined>;
    return {
      storage: this.options.storage,
      agentForTimelineKey: this.options.agentForTimelineKey,
      familyOf: (model: string) => models[model]?.family ?? model,
      checkKind: (code: string) => this.options.catalogue.get(code)?.kind,
      pendingHours: () => this.rollups.pendingHours(),
    };
  }

  async read(query: ModelBehaviourQuery): Promise<ModelBehaviourResponse> {
    // Never recompute on the read path: a recompute holds the main thread, and a
    // backfill keeps old hours dirty. Reads serve the rollups as they are; the
    // background drain catches up (the response reports `pendingHours`).
    return readModelBehaviour(this.readContext(), query);
  }

  async incidents(query: ModelBehaviourQuery): Promise<BehaviourIncidentPage> {
    return readBehaviourIncidents(this.readContext(), query);
  }
}
