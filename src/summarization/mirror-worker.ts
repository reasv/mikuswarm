import { nanoid } from "nanoid";
import type { Storage } from "../storage/index.js";
import type { SummarizationConfig } from "../config/index.js";
import { parseTimelineKey, buildTimelineKey } from "../storage/timeline-key.js";
import type { Logger } from "../observability/index.js";
import type { SummarizationIndexer } from "./indexer.js";
import type { AppConfig } from "../config/index.js";
import { estimateTokens } from "../context/tokens.js";
import { renderCompactMessage, renderRichMessage } from "../context/renderer.js";
import { hydrateEvents } from "../context/hydrate.js";
import { selectSummaryCoverage } from "../context/summary-layer.js";
import type { TimelineStore } from "../timeline/index.js";

// =============================================================================
// Summary mirroring worker (spec MULTI-AGENT-SUPPORT §10b, Phase 5c).
//
// When an agent has `summaries_from = "<donor>"`, timelines that share a channel
// with the donor receive *mirrored* summaries instead of generating their own.
// This cuts per-persona LLM cost to near-zero for background summarization.
//
// The worker is hooked on two paths:
//
//   L1: the pool's external onComplete callback → mirrorL1OnDonorComplete().
//       Runs for every donor L1 completion; finds affected secondaries and copies
//       the summary with translated lineage (event external_id lookup).
//
//   L2+ / status / liveness: a periodic sweep (sweep()) that catches:
//       - L2+ condensation completions (internal to the pool, not on the hook)
//       - superseded/truncated status changes to propagate to mirrors
//       - donor liveness failures (→ one-way native flip)
//
// Idempotency: every secondary summary stores mirrored_from = donorSummaryId.
// getMirroredSummaryIdByDonor checks before inserting.
//
// One-way liveness flip: once a secondary timeline has a native summary
// (mirrored_from IS NULL), it is permanently native. hasNativeSummaries() guards
// this; the donor indexer is reconciled as a wait-or-omit escalation.
// =============================================================================

/**
 * Describes the mirroring topology for a single secondary agent.
 */
export interface AgentMirrorEntry {
  /** Agent name of the secondary (the one configured with summaries_from). */
  secondaryAgentName: string;
  /** Agent name of the donor (the one that actually summarizes). */
  donorAgentName: string;
  /**
   * For each provider that both agents share, the donor account key to use as
   * the mirror source (first in config order, per the tie-break rule).
   */
  donorAccountByProvider: Map<string, string>; // provider → donor accountKey
  /**
   * All secondary account keys per provider for this agent.
   */
  secondaryAccountsByProvider: Map<string, string[]>; // provider → [accountKey, ...]
}

export interface MirrorWorkerOptions {
  storage: Storage;
  store: TimelineStore;
  config: SummarizationConfig;
  /** Per-context-tier config for the liveness token-count calculation. */
  tiers: AppConfig["context"]["tiers"];
  /** All configured mirror topology entries (one per secondary agent). */
  mirrorEntries: AgentMirrorEntry[];
  /**
   * The shared summarization indexer, used for wait-or-omit escalation and
   * liveness-flip native job enqueueing. Set after construction to break the
   * circular dependency (indexer needs mirrorWorker; mirrorWorker needs indexer).
   */
  indexer: SummarizationIndexer | null;
  /** Callback to wake the diary pool when a new L1 mirror arrives. */
  notifyDiaryPool?: () => void;
  logger: Logger;
}

export class MirrorWorker {
  private running = false;
  private sweepTimer?: ReturnType<typeof setTimeout>;
  /**
   * Per-timeline set of timelines whose liveness flip was decided this process
   * lifetime. Lost on restart, but the DB condition (hasNativeSummaries) takes
   * over once a native summary lands.
   */
  private readonly livenessFlipped = new Set<string>();

  constructor(private readonly options: MirrorWorkerOptions) {}

  /**
   * Inject the shared summarization indexer after construction (breaks the
   * circular dependency: indexer needs isMirroredTimeline from mirrorWorker;
   * mirrorWorker needs indexer for wait-or-omit escalation and liveness flip).
   * Must be called before start().
   */
  setIndexer(indexer: SummarizationIndexer): void {
    this.options.indexer = indexer;
  }

  start(): void {
    this.running = true;
    this.scheduleSweep(5_000); // first sweep after 5s
  }

  stop(): void {
    this.running = false;
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /**
   * True when the given secondary timeline is currently mirror-eligible.
   * Three conditions must hold:
   *   1. The secondary agent has `summaries_from` and the donor has an account
   *      on the same provider/channel (topology eligible).
   *   2. The secondary timeline has NO native summaries (one-way flip guard).
   *   3. The secondary's liveness-flip set does not include this timeline (in-
   *      memory flag set before the native job lands).
   *   4. The inverse-topology condition is absent (secondary's first event older
   *      than donor's coverage start → native; decided here via DB reads).
   *
   * Result is used synchronously by the indexer and evaluator to skip enqueueing
   * for mirrored timelines.
   */
  isMirroredTimeline(timelineKey: string): boolean {
    if (this.livenessFlipped.has(timelineKey)) return false;
    const donor = this.resolveDonorTimeline(timelineKey);
    if (!donor) return false;
    if (this.options.storage.hasNativeSummaries(timelineKey)) return false;
    // Inverse topology: secondary has events older than donor's earliest summary
    const donorEarliestSummaryTs = this.options.storage.getFirstSummaryEarliestTimestamp(donor);
    if (donorEarliestSummaryTs !== undefined) {
      const secondaryFirstEventTs = this.options.storage.getFirstEventTimestamp(timelineKey);
      if (secondaryFirstEventTs !== undefined && secondaryFirstEventTs < donorEarliestSummaryTs) {
        return false; // inverse topology → native
      }
    }
    return true;
  }

  /**
   * Called from the summarization pool's onComplete callback when a donor L1
   * summary completes. Mirrors it to all eligible secondaries immediately.
   */
  async onDonorComplete(donorSummaryId: string): Promise<void> {
    const { storage, logger } = this.options;
    const donor = storage.getSummaryById(donorSummaryId);
    if (!donor || donor.level !== 1) return;

    const secondaryKeys = this.getSecondaryTimelinesForDonorTimeline(donor.timelineKey);
    for (const secondaryKey of secondaryKeys) {
      if (!this.isMirroredTimeline(secondaryKey)) continue;
      await this.mirrorL1Summary(donor, secondaryKey).catch((err) => {
        const isConstraint = err instanceof Error && err.message.includes("UNIQUE constraint failed");
        if (isConstraint) {
          // Race between onDonorComplete and sweep: both passed the idempotency
          // guard before either write committed. The UNIQUE index on
          // (timeline_key, mirrored_from) ensures only one row lands; the
          // second attempt surfaces this constraint error — benign, log at debug.
          logger.debug("mirror_l1_already_mirrored", {
            donorSummaryId,
            secondaryTimelineKey: secondaryKey,
          });
        } else {
          logger.warn("mirror_l1_failed", {
            donorSummaryId,
            secondaryTimelineKey: secondaryKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  }

  // ── Periodic sweep ────────────────────────────────────────────────────────

  private scheduleSweep(delayMs: number): void {
    if (!this.running) return;
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      void this.sweep().catch((err) =>
        this.options.logger.error("mirror_sweep_error", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }, delayMs);
  }

  /**
   * Periodic reconciliation sweep. Handles:
   *   - L2+ condensation tree mirroring
   *   - Status propagation (superseded/truncated)
   *   - Liveness check → native flip
   */
  async sweep(): Promise<void> {
    if (!this.running) return;
    try {
      for (const entry of this.options.mirrorEntries) {
        await this.sweepAgent(entry);
      }
    } finally {
      this.scheduleSweep(30_000); // every 30s
    }
  }

  private async sweepAgent(entry: AgentMirrorEntry): Promise<void> {
    const { logger } = this.options;
    // Hoist once: listActiveTimelineKeys is a full-table read; calling it once
    // per sweep (not per inner account loop) keeps the scan count at O(1).
    const allKeys = this.options.storage.listActiveTimelineKeys();
    // For each secondary account, iterate its timelines
    for (const [provider, secondaryKeys] of entry.secondaryAccountsByProvider) {
      const donorAccountKey = entry.donorAccountByProvider.get(provider);
      if (!donorAccountKey) continue;

      for (const secondaryAccountKey of secondaryKeys) {
        const secondaryPrefix = `${provider}:${secondaryAccountKey}:`;
        const donorPrefix = `${provider}:${donorAccountKey}:`;

        for (const secondaryKey of allKeys) {
          if (!secondaryKey.startsWith(secondaryPrefix)) continue;
          // Build the matching donor timeline key
          const donorKey = this.buildDonorTimelineKey(secondaryKey, donorAccountKey, provider);
          if (!donorKey) continue;

          try {
            await this.sweepTimeline(secondaryKey, donorKey);
          } catch (err) {
            logger.warn("mirror_sweep_timeline_error", {
              secondaryTimelineKey: secondaryKey,
              donorTimelineKey: donorKey,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        void donorPrefix; // suppress unused-variable lint
      }
    }
  }

  private async sweepTimeline(secondaryKey: string, donorKey: string): Promise<void> {
    const { storage, logger } = this.options;

    // Skip if permanently native
    if (storage.hasNativeSummaries(secondaryKey)) return;
    if (this.livenessFlipped.has(secondaryKey)) {
      // Already flipped in-memory; the indexer should now be running natively
      return;
    }

    // Inverse topology check
    const donorEarliestSummaryTs = storage.getFirstSummaryEarliestTimestamp(donorKey);
    if (donorEarliestSummaryTs !== undefined) {
      const secondaryFirstEventTs = storage.getFirstEventTimestamp(secondaryKey);
      if (secondaryFirstEventTs !== undefined && secondaryFirstEventTs < donorEarliestSummaryTs) {
        // Inverse topology: secondary has older events than donor's coverage start → native
        logger.info("mirror_inverse_topology_skip", { secondaryTimelineKey: secondaryKey });
        return;
      }
    }

    // Mirror any un-mirrored L1 donor summaries.
    // Full scan with per-row idempotency check — same pattern as sweepL2Plus.
    // The per-row getMirroredSummaryIdByDonor lookup is an indexed point read
    // (idx_summaries_mirrored_from, a partial unique index), and the L1 summary
    // count per timeline is condensation-bounded, so the scan cost is low.
    // A cursor (MAX(latest_timestamp)) was previously used here but permanently
    // skips any summary whose hook failed while a later summary succeeded.
    const donorL1 = storage.getAllCompletedSummariesByLevel(donorKey, 1);
    for (const donorSummary of donorL1) {
      if (storage.getMirroredSummaryIdByDonor(secondaryKey, donorSummary.id)) continue;
      await this.mirrorL1Summary(donorSummary, secondaryKey).catch((err) => {
        const isConstraint = err instanceof Error && err.message.includes("UNIQUE constraint failed");
        if (isConstraint) {
          logger.debug("mirror_sweep_l1_already_mirrored", {
            donorSummaryId: donorSummary.id,
            secondaryTimelineKey: secondaryKey,
          });
        } else {
          logger.warn("mirror_sweep_l1_failed", {
            donorSummaryId: donorSummary.id,
            secondaryTimelineKey: secondaryKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    // Mirror L2+ condensation trees
    await this.sweepL2Plus(secondaryKey, donorKey);

    // Propagate status changes
    await this.propagateStatusChanges(secondaryKey, donorKey);

    // Liveness check
    await this.checkLiveness(secondaryKey, donorKey);
  }

  private async sweepL2Plus(secondaryKey: string, donorKey: string): Promise<void> {
    const { storage, logger } = this.options;
    // Find the max level on donor
    const maxLevel = storage.getMaxSummaryLevel(donorKey);
    if (maxLevel === undefined || maxLevel < 2) return;

    for (let level = 2; level <= maxLevel; level++) {
      const donorSummaries = storage.getAllCompletedSummariesByLevel(donorKey, level);
      for (const donorSummary of donorSummaries) {
        if (storage.getMirroredSummaryIdByDonor(secondaryKey, donorSummary.id)) continue;
        // All donor parent summaries must be mirrored
        const donorParentIds = storage.getSummaryParentIds(donorSummary.id);
        const mappedParentIds: string[] = [];
        let allMirrored = true;
        for (const donorParentId of donorParentIds) {
          const mirrorParentId = storage.getMirroredSummaryIdByDonor(secondaryKey, donorParentId);
          if (!mirrorParentId) { allMirrored = false; break; }
          mappedParentIds.push(mirrorParentId);
        }
        if (!allMirrored) continue;
        if (mappedParentIds.length === 0) continue;

        // Determine latestEventId: use the last parent mirror's latestEventId
        const lastParentMirrorId = mappedParentIds[mappedParentIds.length - 1]!;
        const lastParentMirror = storage.getSummaryById(lastParentMirrorId, secondaryKey);
        if (!lastParentMirror) continue;

        const mirrorId = `sum_${nanoid(10)}`;
        await storage.insertMirroredSummary({
          id: mirrorId,
          timelineKey: secondaryKey,
          level: donorSummary.level,
          content: donorSummary.content,
          earliestTimestamp: donorSummary.earliestTimestamp,
          latestTimestamp: donorSummary.latestTimestamp,
          latestEventId: lastParentMirror.latestEventId,
          eventCount: donorSummary.eventCount,
          tokenCount: donorSummary.tokenCount,
          modelId: donorSummary.modelId,
          status: donorSummary.status,
          generatedAt: donorSummary.generatedAt,
          mirroredFrom: donorSummary.id,
          parentIds: mappedParentIds,
        }).then(() => {
          logger.info("mirror_l2plus_inserted", {
            donorSummaryId: donorSummary.id,
            mirrorId,
            summaryLevel: donorSummary.level,
            secondaryTimelineKey: secondaryKey,
          });
        }).catch((err: unknown) => {
          const isConstraint = err instanceof Error && err.message.includes("UNIQUE constraint failed");
          if (isConstraint) {
            logger.debug("mirror_l2plus_already_mirrored", {
              donorSummaryId: donorSummary.id,
              secondaryTimelineKey: secondaryKey,
              summaryLevel: donorSummary.level,
            });
          } else {
            logger.warn("mirror_l2plus_failed", {
              donorSummaryId: donorSummary.id,
              secondaryTimelineKey: secondaryKey,
              summaryLevel: donorSummary.level,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
    }
  }

  private async propagateStatusChanges(secondaryKey: string, donorKey: string): Promise<void> {
    const { storage, logger } = this.options;
    // Find donor summaries with superseded/truncated status and propagate to mirrors
    const donorSuperseded = storage.getSummariesByStatus(donorKey, "superseded");
    for (const donorSummary of donorSuperseded) {
      const mirrorId = storage.getMirroredSummaryIdByDonor(secondaryKey, donorSummary.id);
      if (!mirrorId) continue;
      const mirror = storage.getSummaryById(mirrorId, secondaryKey);
      if (!mirror || mirror.status === "superseded") continue;
      await storage.updateSummaryStatus(mirrorId, "superseded");
      logger.info("mirror_status_propagated", {
        donorSummaryId: donorSummary.id,
        mirrorId,
        status: "superseded",
      });
    }
  }

  private async checkLiveness(secondaryKey: string, donorKey: string): Promise<void> {
    const { storage, config, store, tiers, logger } = this.options;
    const indexer = this.options.indexer;
    if (!indexer) return; // not yet wired up (should not happen at sweep time)
    // Compute un-mirrored tail token count for the secondary
    const coverageEndEventId = this.getMirrorCoverageEventId(secondaryKey);
    const rawEvents = coverageEndEventId
      ? store.queryAfterContext(secondaryKey, coverageEndEventId)
      : store.queryForContext(secondaryKey, store.getCompactionState(secondaryKey));
    if (rawEvents.length === 0) return;
    const events = hydrateEvents(storage, rawEvents);
    // Carve off the rich tail (mirrors indexer logic — uses renderRichMessage so
    // the token estimate for native-flip eligibility matches the indexer's threshold).
    const richTarget = tiers.rich_target_tokens;
    let richTailTokens = 0;
    let richTailStart = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      if (richTailTokens >= richTarget) break;
      richTailTokens += estimateTokens(renderRichMessage(events[i]!));
      richTailStart = i;
    }
    const compactEvents = events.slice(0, richTailStart);
    const compactTotal = compactEvents.reduce(
      (sum, e) => sum + estimateTokens(renderCompactMessage(e)),
      0,
    );
    const threshold = config.generation_threshold_tokens ?? 6000;
    if (compactTotal <= threshold) return;

    // Tail exceeds threshold. Try to escalate the donor's indexer.
    await indexer.reconcileTimeline(donorKey);
    const donorActiveJobs = storage.getActiveSummarizationJobs(donorKey, 1);
    if (donorActiveJobs.length > 0) return; // donor is working on it

    // No active donor job after reconcile → donor is stalled. Flip to native.
    logger.warn("mirror_liveness_flip", {
      secondaryTimelineKey: secondaryKey,
      donorTimelineKey: donorKey,
      unMirroredTokens: compactTotal,
    });
    this.livenessFlipped.add(secondaryKey);
    // Trigger the indexer to create a native job for the secondary.
    // The indexer's isMirroredTimeline check will return false for this timeline
    // because it's in the livenessFlipped set, so a native job gets enqueued.
    indexer.enqueueReconcileTimeline(secondaryKey);
  }

  // ── L1 mirror logic ───────────────────────────────────────────────────────

  private async mirrorL1Summary(
    donorSummary: NonNullable<ReturnType<Storage["getSummaryById"]>>,
    secondaryKey: string,
  ): Promise<void> {
    const { storage, logger } = this.options;

    // Idempotency: already mirrored?
    if (storage.getMirroredSummaryIdByDonor(secondaryKey, donorSummary.id)) return;

    const provider = parseTimelineKey(secondaryKey)?.provider ?? "";
    const mirrorId = `sum_${nanoid(10)}`;

    // Translate donor event ids to secondary event ids via (provider, external_id)
    const donorEventEntries = storage.getSummaryEventExternalIds(donorSummary.id);
    const translatedEventIds: string[] = [];
    for (const { externalId } of donorEventEntries) {
      if (!externalId) continue; // no external_id → drop from lineage
      const ev = storage.getEventByExternalIdOnTimeline(provider, externalId, secondaryKey);
      if (ev) {
        translatedEventIds.push(ev.id);
      }
      // Unmatched events drop silently (pre-join, decryption gap, etc.)
    }

    // Find a valid latestEventId for the mirror. Use the last matched event,
    // or fall back to looking up the donor's latestEventId by external_id.
    let mirrorLatestEventId: string | undefined = translatedEventIds[translatedEventIds.length - 1];
    if (!mirrorLatestEventId) {
      // Pre-join: secondary has no events in this range. Use a synthetic anchor.
      // We still insert the summary with empty lineage (renderable ancient history).
      // Use the donor's latestEventId as the anchor (it won't appear in summary_events
      // but is required by the schema). For a pre-join summary this field only anchors
      // ordering; it won't be in the secondary's timeline, so we use the donor's
      // external_id-translated id if available, or a placeholder.
      const donorLatestEntries = donorEventEntries.filter((e) => e.externalId);
      const lastEntry = donorLatestEntries[donorLatestEntries.length - 1];
      if (lastEntry?.externalId) {
        const ev = storage.getEventByExternalIdOnTimeline(provider, lastEntry.externalId, secondaryKey);
        if (ev) mirrorLatestEventId = ev.id;
      }
    }
    if (!mirrorLatestEventId) {
      // No events at all on the secondary for this range. Find any event on the
      // secondary timeline as the latestEventId anchor (coverage ordering will be
      // by timestamp, not this field). Pick the secondary's last event before
      // the donor summary's latestTimestamp.
      const anchor = storage.getLatestEventBeforeTimestamp(secondaryKey, donorSummary.latestTimestamp);
      mirrorLatestEventId = anchor?.id;
    }
    if (!mirrorLatestEventId) {
      // Secondary has no events at all — skip (the summary is truly pre-join and
      // there's no anchor to insert into the secondary timeline).
      logger.debug("mirror_l1_skip_no_anchor", {
        donorSummaryId: donorSummary.id,
        secondaryTimelineKey: secondaryKey,
      });
      return;
    }

    await storage.insertMirroredSummary({
      id: mirrorId,
      timelineKey: secondaryKey,
      level: 1,
      content: donorSummary.content,
      earliestTimestamp: donorSummary.earliestTimestamp,
      latestTimestamp: donorSummary.latestTimestamp,
      latestEventId: mirrorLatestEventId,
      eventCount: donorSummary.eventCount,
      tokenCount: donorSummary.tokenCount,
      modelId: donorSummary.modelId,
      status: donorSummary.status,
      generatedAt: donorSummary.generatedAt,
      mirroredFrom: donorSummary.id,
      eventIds: translatedEventIds,
    });
    this.options.notifyDiaryPool?.();
    logger.info("mirror_l1_inserted", {
      donorSummaryId: donorSummary.id,
      mirrorId,
      secondaryTimelineKey: secondaryKey,
      lineageCount: translatedEventIds.length,
    });
  }

  // ── Topology helpers ──────────────────────────────────────────────────────

  /**
   * Given a secondary timeline key, return the donor timeline key (same
   * channel/thread, different accountId). Returns undefined if not mirror-eligible
   * by config (donor account not on same provider, or no summaries_from).
   */
  resolveDonorTimeline(secondaryKey: string): string | undefined {
    const parsed = parseTimelineKey(secondaryKey);
    if (!parsed) return undefined;

    for (const entry of this.options.mirrorEntries) {
      // Check if this key belongs to one of the secondary's accounts
      const secondaryAccountsForProvider = entry.secondaryAccountsByProvider.get(parsed.provider);
      if (!secondaryAccountsForProvider?.includes(parsed.accountId)) continue;
      // Found: get the donor account for this provider
      const donorAccountKey = entry.donorAccountByProvider.get(parsed.provider);
      if (!donorAccountKey) return undefined;
      return buildTimelineKey({
        provider: parsed.provider,
        accountId: donorAccountKey,
        kind: parsed.kind,
        channelId: parsed.channelId,
        threadId: parsed.threadId,
      });
    }
    return undefined;
  }

  /**
   * Given a donor timeline key, return all secondary timeline keys that mirror
   * from it (same channel/thread coordinates, secondary accounts).
   */
  private getSecondaryTimelinesForDonorTimeline(donorKey: string): string[] {
    const parsed = parseTimelineKey(donorKey);
    if (!parsed) return [];
    const result: string[] = [];
    for (const entry of this.options.mirrorEntries) {
      const donorAccountKey = entry.donorAccountByProvider.get(parsed.provider);
      if (donorAccountKey !== parsed.accountId) continue;
      const secondaryAccounts = entry.secondaryAccountsByProvider.get(parsed.provider);
      if (!secondaryAccounts) continue;
      for (const secondaryAccountKey of secondaryAccounts) {
        result.push(
          buildTimelineKey({
            provider: parsed.provider,
            accountId: secondaryAccountKey,
            kind: parsed.kind,
            channelId: parsed.channelId,
            threadId: parsed.threadId,
          }),
        );
      }
    }
    return result;
  }

  /**
   * Build the donor timeline key from a secondary key and a known donor accountKey.
   */
  private buildDonorTimelineKey(
    secondaryKey: string,
    donorAccountKey: string,
    provider: string,
  ): string | undefined {
    const parsed = parseTimelineKey(secondaryKey);
    if (!parsed || parsed.provider !== provider) return undefined;
    return buildTimelineKey({
      provider: parsed.provider,
      accountId: donorAccountKey,
      kind: parsed.kind,
      channelId: parsed.channelId,
      threadId: parsed.threadId,
    });
  }

  /**
   * Return the latestTimestamp of the most recently mirrored L1 summary on the
   * secondary, or undefined if no mirrored summaries exist.
   */
  /**
   * Return the event ID of the latest event covered by the secondary's summary
   * layer, or undefined if no summaries exist. Mirrors indexer.ts's use of
   * selectSummaryCoverage: queryAfterContext takes the event ID string directly.
   */
  private getMirrorCoverageEventId(secondaryKey: string): string | undefined {
    const selection = selectSummaryCoverage(this.options.storage, secondaryKey);
    return selection.coverageEndEventId ?? undefined;
  }
}

/**
 * Build the `AgentMirrorEntry[]` topology list from config.
 * Called once at startup in app.ts.
 */
export function buildMirrorTopology(config: AppConfig): AgentMirrorEntry[] {
  const agents = config.agents;
  if (!agents) return [];

  // Build: agentName → [{ provider, accountKey }] for all accounts of that agent
  const agentAccounts = new Map<string, Array<{ provider: string; accountKey: string }>>();
  for (const [accountKey, account] of Object.entries(config.matrix?.accounts ?? {})) {
    const agentName = (account as { agent?: string }).agent ?? accountKey;
    const list = agentAccounts.get(agentName) ?? [];
    list.push({ provider: "matrix", accountKey });
    agentAccounts.set(agentName, list);
  }
  for (const [accountKey, account] of Object.entries(config.discord?.accounts ?? {})) {
    const agentName = account.agent ?? accountKey;
    const list = agentAccounts.get(agentName) ?? [];
    list.push({ provider: "discord", accountKey });
    agentAccounts.set(agentName, list);
  }
  for (const [accountKey, account] of Object.entries(config.irc?.accounts ?? {})) {
    const agentName = account.agent ?? accountKey;
    const list = agentAccounts.get(agentName) ?? [];
    list.push({ provider: "irc", accountKey });
    agentAccounts.set(agentName, list);
  }

  const entries: AgentMirrorEntry[] = [];
  for (const [agentName, block] of Object.entries(agents)) {
    const donorName = block.summaries_from;
    if (!donorName) continue;

    const secondaryAccounts = agentAccounts.get(agentName) ?? [];
    const donorAccounts = agentAccounts.get(donorName) ?? [];

    // Build: provider → [secondary accountKeys]
    const secondaryAccountsByProvider = new Map<string, string[]>();
    for (const { provider, accountKey } of secondaryAccounts) {
      const list = secondaryAccountsByProvider.get(provider) ?? [];
      list.push(accountKey);
      secondaryAccountsByProvider.set(provider, list);
    }

    // Build: provider → first donor accountKey in config order (tie-break rule)
    const donorAccountByProvider = new Map<string, string>();
    for (const { provider, accountKey } of donorAccounts) {
      if (!donorAccountByProvider.has(provider)) {
        donorAccountByProvider.set(provider, accountKey);
      }
    }

    entries.push({
      secondaryAgentName: agentName,
      donorAgentName: donorName,
      donorAccountByProvider,
      secondaryAccountsByProvider,
    });
  }
  return entries;
}
