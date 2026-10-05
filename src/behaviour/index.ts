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
import type { AuditBacklogProgress, BehaviourIncidentPage, BehaviourModelInfo, ModelBehaviourResponse } from "./types.js";
import { resolveCodeVersion } from "./version.js";

export * from "./types.js";
export { HEADLINE_RATES, MIX_FAMILIES, MODEL_BEHAVIOUR_METRICS, MODEL_BEHAVIOUR_METRIC_FAMILIES, mixMetricId } from "./metrics.js";
export { buildBehaviourSnapshot, snapshotHash, type BehaviourSnapshot } from "./snapshot.js";
export { diffBehaviourSnapshots, listBehaviourChanges, recordBehaviourSnapshot } from "./changes.js";
export { MODEL_BEHAVIOUR_ROLLUP_VERSION, ModelBehaviourRollups, computeHourRollups, ensureRollupVersion } from "./rollups.js";
export { PromptChangeTracker } from "./prompt-changes.js";
export { BEHAVIOUR_GROUP_BYS, BEHAVIOUR_WINDOWS, type ModelBehaviourQuery } from "./read.js";
export { resolveCodeVersion } from "./version.js";

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

/**
 * The family a config entry groups under on the page: `[models.<key>].family` when
 * set, else its wire model id (`[models.<key>].id`), so entries serving the same
 * upstream model (a direct and a proxied route, say) group together with no extra
 * config; a key no longer configured stays on its own.
 */
export function behaviourFamilyOf(models: Record<string, { id?: string; family?: string } | undefined>, key: string): string {
  const entry = models[key];
  return entry?.family ?? entry?.id ?? key;
}

export class ModelBehaviourService implements ModelBehaviourApi {
  readonly rollups: ModelBehaviourRollups;
  readonly prompts: PromptChangeTracker;
  private auditProgress: (() => AuditBacklogProgress | null) | undefined;

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

  /** The offline audit worker's progress source (set when the worker runs). */
  setAuditProgressSource(source: (() => AuditBacklogProgress | null) | undefined): void {
    this.auditProgress = source;
  }

  private readContext() {
    const models = this.options.config.models as Record<string, { id?: string; family?: string } | undefined>;
    return {
      storage: this.options.storage,
      agentForTimelineKey: this.options.agentForTimelineKey,
      familyOf: (model: string) => behaviourFamilyOf(models, model),
      modelInfo: (model: string): BehaviourModelInfo => ({ id: models[model]?.id ?? null, family: models[model]?.family ?? null }),
      checkKind: (code: string) => this.options.catalogue.get(code)?.kind,
      pendingHours: () => this.rollups.pendingHours(),
      auditProgress: () => this.auditProgress?.() ?? null,
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
