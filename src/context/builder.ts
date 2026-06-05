import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config/index.js";
import type { AgentSessionRecord } from "../agent/index.js";
import type { AttachmentMeta, CanonicalChatEvent, ReactionAggregate } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import type {
  Storage,
  MediaAssetRow,
  Summary,
  TimelineCursor,
} from "../storage/index.js";
import { processImageForInference, cleanupProcessedImage, buildInferenceImageOptions } from "../media/index.js";
import { compactTimelineEvents } from "./compaction.js";
import { renderCompactMessage, renderRichMessage } from "./renderer.js";
import { hydrateEvents as hydrateEventsShared, mediaAssetToAttachmentMeta } from "./hydrate.js";
import { synthesizeReactionLines, type ReactionLine, type ReactionTarget } from "./reactions.js";
import { estimateTokens, truncateToTokens } from "./tokens.js";
import {
  selectSummaries,
  resolveRecencyLabels,
  renderSummaryLayer,
  type SummaryLabelCache,
  type SummarySelection,
} from "./summary-layer.js";
import type { WorkspaceContent, SessionTypeConfig } from "../workspace/types.js";
import { renderSystemPrompt, renderSatelliteBlock } from "../workspace/prompt.js";
import { buildRecentDiaryContent } from "./diary-layer.js";
import { buildAutoRetrievalBlock, type AutoRetrievalDeps } from "./auto-retrieval.js";
import { agentDateStamp } from "../time/index.js";
import { nanoid } from "nanoid";
import type { Logger } from "../observability/index.js";

export interface ContextMessage {
  type: "system" | "chatEvent" | "triggerGroup" | "summaryLayer" | "diaryLayer" | "satellite";
  role: "user" | "assistant" | "system";
  content: string;
  tier?: "compact" | "rich" | "mixed" | "runtime" | "system" | "trigger" | "summary" | "diary";
  tokenEstimate: number;
  imageBlocks?: ImageBlock[];
  timestamp?: number;
}

export interface ImageBlock {
  eventId: string;
  attachmentId: string;
  mediaType: string;
  dataBase64: string;
}

export interface BuildContextOptions {
  timelineKey: string;
  trigger: CanonicalChatEvent;
  activeSessions: AgentSessionRecord[];
  workspace: WorkspaceContent;
  sessionType?: SessionTypeConfig;
  fallbackPrompt?: string;
  /** When set, build context for a summarization session. */
  summarizationCutoff?: {
    /** Cut context at this timestamp — no events past it are rendered. */
    endTimestamp: number;
  };
  /** Optional signal to cancel a grace wait early (e.g. on shutdown). */
  abortSignal?: AbortSignal;
}

export interface BuiltContext {
  messages: ContextMessage[];
  tokenEstimate: number;
  compactTokens: number;
  richTokens: number;
  imageBlocks: ImageBlock[];
}

export class ContextBuilder {
  /** Called after a level-1 summarization job is enqueued (§4 threshold). */
  onJobEnqueued?: () => void;

  /**
   * Auto-retrieval dependencies (ARCHITECTURE.md §9d / design §8c). Set when the
   * retrieval subsystem is enabled AND `retrieval.auto_retrieval` is on; otherwise
   * undefined and no auto-retrieval block is built.
   */
  private readonly autoRetrieval?: AutoRetrievalDeps;

  constructor(
    private readonly store: TimelineStore,
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly logger?: Logger,
    autoRetrieval?: AutoRetrievalDeps,
  ) {
    this.autoRetrieval = autoRetrieval;
  }

  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const cutoff = options.summarizationCutoff;
    const now = options.trigger.timestamp;
    const triggerGroupIds = cutoff ? new Set<string>() : this.resolveTriggerGroupIds(options.trigger);
    const compactionState = this.store.getCompactionState(options.timelineKey);

    // 1. Select summaries and derive the event-ID coverage cursor (§4).
    let selection = selectSummaries(this.storage.getSummaryCandidates(options.timelineKey));

    // 2. Query events starting strictly after the coverage cursor.
    let events = selection.coverageEndEventId
      ? this.store.queryAfterContext(options.timelineKey, selection.coverageEndEventId)
      : this.store.queryForContext(options.timelineKey, compactionState);

    if (cutoff) {
      // Cut at endTimestamp; re-select the summary layer to exclude any summary
      // overlapping the events being summarized (§6). `getSummaryCandidates` uses
      // an inclusive `<=` bound so a summary whose `latestTimestamp` equals
      // `earliest` is still included (prevents a coverage gap on millisecond-
      // precision timestamp collisions from Matrix batch sends).
      events = events.filter((e) => e.timestamp <= cutoff.endTimestamp);
      const earliest = events[0]?.timestamp ?? cutoff.endTimestamp + 1;
      selection = selectSummaries(
        this.storage.getSummaryCandidates(options.timelineKey, earliest),
      );

      // Re-query events against the corrected coverage cursor. The re-selection
      // may have moved the cursor earlier (fewer summaries qualify with the
      // beforeTimestamp filter), so events between the old and new cursor would
      // be silently lost without this re-query.
      if (selection.coverageEndEventId) {
        events = this.store
          .queryAfterContext(options.timelineKey, selection.coverageEndEventId)
          .filter((e) => e.timestamp <= cutoff.endTimestamp);
      } else {
        events = this.store
          .queryForContext(options.timelineKey, compactionState)
          .filter((e) => e.timestamp <= cutoff.endTimestamp);
      }
    }

    this.logger?.debug("summary_coverage_resolved", {
      timelineKey: options.timelineKey,
      coverageEndEventId: selection.coverageEndEventId,
      selectedSummaryCount: selection.summaries.length,
    });

    events = this.hydrateEvents(events);

    if (cutoff) {
      events = events.map((e) => this.truncateOversizedEvent(e));
    }

    const timelineEvents = events.filter((e) => !triggerGroupIds.has(e.id));
    let triggerEvents = events.filter((e) => triggerGroupIds.has(e.id));

    // 3. Grace wait: if a drop is imminent and a processing job covers the
    //    oldest events, wait briefly for it (§11). Skipped for summarization builds.
    let compactionInput = timelineEvents;
    if (!cutoff) {
      const waited = await this.graceWaitForDrop(
        options.timelineKey,
        timelineEvents,
        triggerGroupIds,
        selection,
        options.abortSignal,
      );
      compactionInput = waited.events;
      // Adopt the post-wait selection so the summary layer renders the summary
      // whose completion just trimmed the raw set — otherwise those events would
      // be dropped from both the raw turns and the layer (a coverage gap).
      selection = waited.selection;
      // Refresh trigger events from the re-queried set so they reflect any
      // enrichment that landed during the wait (issue #3).
      if (waited.triggerEvents) {
        triggerEvents = waited.triggerEvents;
      }
    }

    // Passive reaction surfacing (ARCHITECTURE.md §9f). Both views are render-time
    // projections from the reaction store, attached now (after the grace wait has
    // finalized the event set) and never persisted into event_json. Off for
    // summarization builds — reactions must never leak into summaries (§4) — and
    // gated by [reactions] config.
    const rx = this.config.reactions ?? {};
    const reactionsEnabled = !cutoff && rx.enabled !== false;
    let reactionLines: ReactionLine[] = [];
    if (reactionsEnabled) {
      if (rx.show_aggregates !== false) {
        compactionInput = this.attachReactionAggregates(compactionInput);
        triggerEvents = this.attachReactionAggregates(triggerEvents);
      }
      if (rx.show_discrete !== false) {
        reactionLines = this.buildDiscreteReactionLines(compactionInput, {
          assistantOnly: rx.discrete_assistant_only !== false,
          nameCap: rx.discrete_name_cap ?? 8,
        });
      }
    }

    const compacted = compactTimelineEvents(
      compactionInput,
      renderRichMessage,
      renderCompactMessage,
      this.config.context.tiers,
      {
        timelineKey: options.timelineKey,
        // A summarization build operates on a cut-down event set; never persist
        // its derived boundaries into the real compaction state.
        state: cutoff ? undefined : compactionState,
        reactionLines,
        discreteHorizonMessages: rx.discrete_horizon_messages ?? 0,
      },
    );
    if (!cutoff && compacted.stateChanged && compacted.state) {
      await this.store.saveCompactionState(compacted.state);
    }

    // 4. Threshold evaluation: enqueue a level-1 job if compact tier is large
    //    enough (§4, §11). Skipped for summarization builds.
    if (!cutoff) {
      await this.maybeEnqueueLevel1(options.timelineKey, compacted.compactEvents);
    }

    const imageBlocks = cutoff ? [] : await this.selectImageBlocks(options.trigger);
    const imageBlockIds = new Set(imageBlocks.map((b) => b.attachmentId));

    this.markImageBlocks(triggerEvents, imageBlockIds);

    const chatMessages: ContextMessage[] = compacted.turns.map((turn) => ({
      type: "chatEvent",
      role: turn.role,
      content: turn.content,
      tier: turn.tier,
      tokenEstimate: turn.tokenEstimate,
      timestamp: turn.timestamp,
    }));

    // NOTE: System prompt is rendered identically here and in AgentSessionFactory.create().
    // Both are required: the factory's version sets initialState.systemPrompt (used by
    // pi-agent-core on every API call), and this one populates the system message in
    // transformContext output. They must produce identical results.
    const systemPrompt = renderSystemPrompt(options.workspace, options.fallbackPrompt);
    const satellite = renderSatelliteBlock(
      { ...options, suppressRuntimeState: cutoff != null },
      options.workspace,
      options.sessionType,
    );
    const triggerContent = triggerEvents.map((e) => renderRichMessage(e)).join("\n\n---\n\n");

    const summaryLayer = await this.buildSummaryLayerMessage(
      options.timelineKey,
      selection.summaries,
      now,
      cutoff != null,
    );

    // Recent-diary surfacing (§10a): a layer after the system prompt and before the
    // summaries layer (top-to-bottom: system → diary → summaries), so the agent
    // reads back what it wrote. Omitted from generation builds (summarizer cutoff) —
    // temporally wrong (they operate on past ranges) and a feedback risk. The diary
    // session itself never goes through here (it uses resume mode, no build).
    //
    // The anchor `now` is the trigger's timestamp (set above), used deliberately
    // rather than wall-clock Date.now(): it is deterministic and stable across
    // context rebuilds and replay. It is effectively the latest in-context event day
    // — the trigger (or one of the coalesced triggers) is the last event
    // chronologically. Any cross-midnight divergence from §10a's literal "latest
    // in-context message day" wording is cosmetic: recentMemoryWindow only surfaces
    // existing files ≤ the anchor and never shows empty days.
    const diaryLayer = cutoff ? null : await this.buildDiaryLayerMessage(now);

    // Auto-retrieval (§8c): a small, cited block of relevant-but-not-recent memory,
    // riding INSIDE the final user turn (cache-safe) BEFORE the trigger messages, so
    // the trigger stays last (most-attended). Deduped against the recency layer.
    // Omitted from generation builds (cutoff) — temporally wrong, a feedback risk.
    //
    // The retrieval QUERY is the plain message body the user typed — the bare
    // `body` of each trigger event joined by newlines, NOT `triggerContent` (the
    // rich `<message sender=… time=…>…` envelope with reply/attachment/link-preview
    // XML). Per the operator's decision, reply/caption/attachment context is
    // deliberately excluded from the query for now: the rich envelope's structural
    // tokens (sender, timestamps, XML) only dilute the lexical/semantic match. This
    // does NOT touch the context turn the model reads — `triggerContent` is still
    // what goes into `finalUserContent` below.
    const retrievalQuery = triggerEvents
      .map((e) => e.body)
      .filter(Boolean)
      .join("\n");
    const retrievedMemory =
      cutoff || !this.autoRetrieval
        ? null
        : await buildAutoRetrievalBlock(this.autoRetrieval, {
            query: retrievalQuery,
            recencyContent: diaryLayer?.content ?? null,
            now,
          }).catch((error) => {
            this.logger?.warn("auto_retrieval_failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            return null;
          });

    const systemBlock = `<system>\n${satellite}\n</system>`;
    const finalUserContent = cutoff
      ? systemBlock
      : [retrievedMemory, systemBlock, triggerContent].filter(Boolean).join("\n\n");

    const messages: ContextMessage[] = [
      {
        type: "system",
        role: "system",
        content: systemPrompt,
        tier: "system",
        tokenEstimate: estimateTokens(systemPrompt),
      },
      ...(diaryLayer ? [diaryLayer] : []),
      ...(summaryLayer ? [summaryLayer] : []),
      ...chatMessages,
      {
        type: cutoff ? "satellite" : "triggerGroup",
        role: "user",
        content: finalUserContent,
        tier: "trigger",
        tokenEstimate: estimateTokens(finalUserContent),
        imageBlocks,
      },
    ];
    return {
      messages,
      tokenEstimate: messages.reduce((sum, message) => sum + message.tokenEstimate, 0),
      compactTokens: compacted.compactTokens,
      richTokens: compacted.richTokens,
      imageBlocks,
    };
  }

  /**
   * Render the summary-layer message (§4). For normal builds the recency-label
   * cache is read/written to keep the prefix byte-stable (§5); summarization
   * builds compute labels directly and never touch the cache.
   */
  private async buildSummaryLayerMessage(
    timelineKey: string,
    summaries: Summary[],
    now: number,
    isSummarizationBuild: boolean,
  ): Promise<ContextMessage | null> {
    if (summaries.length === 0) return null;

    let labels: string[];
    if (isSummarizationBuild) {
      const resolved = resolveRecencyLabels(summaries, null, now, 0);
      labels = resolved.labels;
    } else {
      const ttlMs = this.config.summarization?.label_cache_ttl_ms ?? 600000;
      const cacheKey = `summary_labels:${timelineKey}`;
      const cached = this.readLabelCache(cacheKey);
      const resolved = resolveRecencyLabels(summaries, cached, now, ttlMs);
      if (resolved.cacheToStore) {
        await this.storage.setMetadata(cacheKey, JSON.stringify(resolved.cacheToStore));
      }
      labels = resolved.labels;
    }

    const content = renderSummaryLayer(summaries, labels);
    const latestTs = summaries.reduce((max, s) => Math.max(max, s.latestTimestamp), 0);
    return {
      type: "summaryLayer",
      role: "user",
      content,
      tier: "summary",
      tokenEstimate: estimateTokens(content),
      timestamp: latestTs,
    };
  }

  /**
   * Render the recent-diary surfacing layer (§10a). Anchored at the latest
   * in-context message day (`now` = trigger.timestamp), NOT wall-clock — so
   * backfill/replay surface the diary that was current then. Returns null when
   * nothing is surfaceable. Bounded by `diary.recency_max_tokens` and front-trimmed
   * by whole blocks; shared sparsity handling lives in `recentMemoryWindow` (§9a).
   */
  private async buildDiaryLayerMessage(now: number): Promise<ContextMessage | null> {
    const diaryCfg = this.config.diary ?? {};
    const content = await buildRecentDiaryContent({
      workspaceRoot: this.config.workspace.root_dir,
      anchorDay: agentDateStamp(now),
      ceilingTokens: diaryCfg.recency_max_tokens ?? 6000,
      fileCount: diaryCfg.recency_file_count ?? 2,
    }).catch((error) => {
      this.logger?.warn("diary_layer_build_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (!content) return null;
    return {
      type: "diaryLayer",
      role: "user",
      content,
      tier: "diary",
      tokenEstimate: estimateTokens(content),
      timestamp: now,
    };
  }

  private readLabelCache(cacheKey: string): SummaryLabelCache | null {
    const raw = this.storage.getMetadata(cacheKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SummaryLabelCache;
    } catch {
      return null;
    }
  }

  /**
   * Truncate an event whose body exceeds the summarization input budget so a
   * single oversized event cannot stall the floor (§6). Lineage is unaffected —
   * only the text shown to the summarizer is clipped.
   */
  private truncateOversizedEvent(event: CanonicalChatEvent): CanonicalChatEvent {
    const maxTokens = (this.config.summarization?.leaf_input_tokens ?? 4000) * 1.5;
    const body = event.body ?? "";
    if (estimateTokens(body) <= maxTokens) return event;
    const trailer = "…\n\n[Event truncated — exceeded summarization input budget.]";
    const trailerTokens = estimateTokens(trailer);
    const bodyBudget = Math.max(1, Math.floor(maxTokens) - trailerTokens);
    const clipped = `${truncateToTokens(body, bodyBudget)}${trailer}`;
    return { ...event, body: clipped };
  }

  /**
   * One-shot bounded grace wait (§11): if compaction is about to drop the oldest
   * events and a processing job covers them, poll up to summary_wait_timeout_ms
   * for that job to complete, then re-query once so the new summary's cursor
   * excludes those events.
   */
  private async graceWaitForDrop(
    timelineKey: string,
    events: CanonicalChatEvent[],
    triggerGroupIds: Set<string>,
    selection: SummarySelection,
    abortSignal?: AbortSignal,
  ): Promise<{ events: CanonicalChatEvent[]; selection: SummarySelection; triggerEvents?: CanonicalChatEvent[] }> {
    const unchanged = { events, selection };
    if (this.config.summarization?.enabled === false) return unchanged;
    const compactMax = this.config.context.tiers.compact_max_tokens;
    // Estimate the compact-tier token count by subtracting the rich-tier tail.
    // Compaction determines the rich boundary by accumulating rich-rendered
    // tokens from the newest events until reaching rich_target_tokens.
    // Mirror that here: use rich rendering for the tail to find how many
    // events land in the rich tier, then subtract their compact cost.
    const perEventCompact = events.map((e) => estimateTokens(renderCompactMessage(e)));
    const totalCompactRendered = perEventCompact.reduce((sum, t) => sum + t, 0);
    const richTarget = this.config.context.tiers.rich_target_tokens;
    let richTailTokens = 0;
    let richTailStart = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      if (richTailTokens >= richTarget) break;
      richTailTokens += estimateTokens(renderRichMessage(events[i]!));
      richTailStart = i;
    }
    const richTailCompactCost = perEventCompact.slice(richTailStart).reduce((sum, t) => sum + t, 0);
    const compactSum = Math.max(0, totalCompactRendered - richTailCompactCost);
    if (compactSum <= compactMax) return unchanged;

    const processing = this.storage.getProcessingSummarizationJobs(timelineKey);
    if (processing.length === 0) return unchanged;

    // The oldest events are the ones at risk of being dropped. A processing job
    // covers them if its input range starts at or before the oldest event.
    const oldest = events[0];
    if (!oldest) return unchanged;
    const oldestCursor = this.storage.getEventCursor(timelineKey, oldest.id);
    if (!oldestCursor) return unchanged;
    const covering = processing.find((job) => {
      const start = this.storage.getEventCursor(timelineKey, job.inputStartId);
      const end = this.storage.getEventCursor(timelineKey, job.inputEndId);
      return start != null && end != null && !cursorAfter(start, oldestCursor) && !cursorAfter(oldestCursor, end);
    });
    if (!covering) return unchanged;

    const timeoutMs = this.config.summarization?.summary_wait_timeout_ms ?? 5000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (abortSignal?.aborted) break;
      await delay(250);
      const job = this.storage.getSummarizationJobById(covering.id);
      if (!job || job.status === "complete") {
        // Re-select and re-query against the new coverage cursor ONCE. The raw
        // events AND the summary-layer selection must move together, or the
        // newly-covered events would be dropped from both (a coverage gap).
        const reselected = selectSummaries(this.storage.getSummaryCandidates(timelineKey));
        if (!reselected.coverageEndEventId) return { events, selection: reselected };
        const allRequeried = this.hydrateEvents(
          this.store.queryAfterContext(timelineKey, reselected.coverageEndEventId),
        );
        const requeriedTimeline = allRequeried.filter((e) => !triggerGroupIds.has(e.id));
        const requeriedTrigger = allRequeried.filter((e) => triggerGroupIds.has(e.id));
        return {
          events: requeriedTimeline,
          selection: reselected,
          triggerEvents: requeriedTrigger,
        };
      }
      if (job.status === "failed") break;
    }
    return unchanged;
  }

  /** Enqueue a level-1 summarization job for the oldest compact chunk (§4 threshold). */
  private async maybeEnqueueLevel1(
    timelineKey: string,
    compactEvents: Array<{ id: string; timestamp: number; compactTokens: number }>,
  ): Promise<void> {
    if (this.config.summarization?.enabled === false) return;
    const cfg = this.config.summarization ?? {};
    const generationThreshold = cfg.generation_threshold_tokens ?? 6000;
    const compactTotal = compactEvents.reduce((sum, e) => sum + e.compactTokens, 0);
    if (compactTotal <= generationThreshold) return;

    const leafInput = cfg.leaf_input_tokens ?? 4000;
    const chunk: typeof compactEvents = [];
    let running = 0;
    for (const e of compactEvents) {
      // Accumulate until the running sum first reaches leaf_input_tokens; the
      // crossing event is included, so a single large event naturally overshoots
      // (capped in practice by the oversized-event truncation at build time).
      chunk.push(e);
      running += e.compactTokens;
      if (running >= leafInput) break;
    }
    if (chunk.length === 0) return;

    const first = chunk[0]!;
    const last = chunk[chunk.length - 1]!;

    // Skip if a pending/processing level-1 job already covers this range.
    // If cursors are missing, the timeline is in an inconsistent state — skip
    // enqueueing rather than bypass the overlap check and risk duplicates.
    const active = this.storage.getActiveSummarizationJobs(timelineKey, 1);
    const firstCursor = this.storage.getEventCursor(timelineKey, first.id);
    const lastCursor = this.storage.getEventCursor(timelineKey, last.id);
    if (!firstCursor || !lastCursor) return;
    const overlaps = active.some((job) => {
      const jobStart = this.storage.getEventCursor(timelineKey, job.inputStartId);
      const jobEnd = this.storage.getEventCursor(timelineKey, job.inputEndId);
      if (!jobStart || !jobEnd) return false;
      // Ranges overlap unless one is entirely before the other.
      return !cursorAfter(firstCursor, jobEnd) && !cursorAfter(jobStart, lastCursor);
    });
    if (overlaps) return;

    const jobId = `sumjob_${nanoid(10)}`;
    await this.storage.insertSummarizationJob({
      id: jobId,
      timelineKey,
      level: 1,
      inputStartId: first.id,
      inputEndId: last.id,
      inputTokenCount: running,
      targetTokenCount: cfg.leaf_target_tokens ?? 600,
      maxRetries: cfg.max_retries ?? 2,
    });
    this.logger?.info("summarization_job_enqueued", {
      jobId,
      timelineKey,
      level: 1,
      inputTokens: running,
    });
    this.onJobEnqueued?.();
  }

  private resolveTriggerGroupIds(trigger: CanonicalChatEvent): Set<string> {
    const ids = new Set<string>();
    ids.add(trigger.id);
    for (const id of trigger.trigger?.groupedEventIds ?? []) {
      ids.add(id);
    }
    return ids;
  }

  private markImageBlocks(events: CanonicalChatEvent[], imageBlockIds: Set<string>): void {
    if (imageBlockIds.size === 0) return;
    for (const event of events) {
      for (const a of event.attachments ?? []) {
        if (imageBlockIds.has(a.id)) a.isImageBlock = true;
      }
      for (const m of event.linkedMedia ?? []) {
        if (imageBlockIds.has(m.id)) m.isImageBlock = true;
      }
      for (const lp of event.linkPreviews ?? []) {
        for (const m of lp.media ?? []) {
          if (imageBlockIds.has(m.id)) m.isImageBlock = true;
        }
      }
      if (event.replyTo) {
        for (const a of event.replyTo.attachments ?? []) {
          if (imageBlockIds.has(a.id)) a.isImageBlock = true;
        }
        for (const m of event.replyTo.linkedMedia ?? []) {
          if (imageBlockIds.has(m.id)) m.isImageBlock = true;
        }
        for (const lp of event.replyTo.linkPreviews ?? []) {
          for (const m of lp.media ?? []) {
            if (imageBlockIds.has(m.id)) m.isImageBlock = true;
          }
        }
      }
    }
  }

  private hydrateEvents(events: CanonicalChatEvent[]): CanonicalChatEvent[] {
    // Shared with search_messages (§9e) so search hits render at the same fidelity.
    // Note: reaction aggregates (View A) are attached separately, on the live
    // render path only (attachReactionAggregates) — NOT here — so search and
    // summarization builds never carry them.
    return hydrateEventsShared(this.storage, events);
  }

  /**
   * View A (ARCHITECTURE.md §9f): attach deduped reaction counts to each event
   * that has reactions, as a render-time derivation. Only the rich renderer emits
   * them; compact/dropped events carry them harmlessly. Events are returned
   * unchanged when they have no external id or no live reactions.
   */
  private attachReactionAggregates(events: CanonicalChatEvent[]): CanonicalChatEvent[] {
    const externalIds = events
      .map((e) => e.externalId)
      .filter((id): id is string => id !== undefined);
    if (externalIds.length === 0) return events;
    const aggregates = this.storage.getReactionAggregates(externalIds);
    if (aggregates.size === 0) return events;
    return events.map((event) => {
      if (!event.externalId) return event;
      const rows = aggregates.get(event.externalId);
      if (!rows || rows.length === 0) return event;
      const reactions: ReactionAggregate[] = rows.map((r) => ({
        normalizedKey: r.normalizedKey,
        kind: r.kind as ReactionAggregate["kind"],
        display: r.display,
        shortcode: r.shortcode ?? undefined,
        count: r.count,
      }));
      return { ...event, reactions };
    });
  }

  /**
   * View B (ARCHITECTURE.md §9f): synthesize discrete reaction lines for messages
   * among `events`. By default only the assistant's own messages are targeted
   * (`assistantOnly`); when false, any sender's recent messages qualify and the
   * line reads "<author>'s message" instead of "your message". The store is
   * queried for all such targets; compaction injects only the lines whose
   * timestamp falls within the rich tier's time span. Returns [] when there are no
   * targets or no live reactions on them.
   */
  private buildDiscreteReactionLines(
    events: CanonicalChatEvent[],
    opts: { assistantOnly: boolean; nameCap: number },
  ): ReactionLine[] {
    const targets = events.filter(
      (e) => e.externalId !== undefined && (!opts.assistantOnly || e.role === "assistant"),
    );
    const externalIds = targets
      .map((e) => e.externalId)
      .filter((id): id is string => id !== undefined);
    if (externalIds.length === 0) return [];
    const rows = this.storage.getDiscreteReactions(externalIds);
    if (rows.length === 0) return [];
    const targetInfo = new Map<string, ReactionTarget>();
    for (const target of targets) {
      if (!target.externalId) continue;
      targetInfo.set(target.externalId, {
        body: target.body,
        self: target.role === "assistant",
        authorDisplay: target.sender.displayName ?? undefined,
      });
    }
    return synthesizeReactionLines(rows, targetInfo, { nameCap: opts.nameCap });
  }

  private async selectImageBlocks(trigger: CanonicalChatEvent): Promise<ImageBlock[]> {
    const multimodal = this.config.models.default?.multimodal ?? false;
    if (!multimodal) return [];
    const images = this.selectImageAttachments(trigger);
    const blocks: ImageBlock[] = [];
    const imageOpts = buildInferenceImageOptions(this.config.media?.image);
    for (const { eventId, attachment } of images) {
      if (!attachment.localPath) continue;
      const absPath = attachment.localPath.startsWith("/")
        ? attachment.localPath
        : path.join(this.config.workspace.root_dir, attachment.localPath);
      try {
        const processed = await processImageForInference(absPath, imageOpts);
        const data = await readFile(processed.path);
        const mimeType = processed.mimeType;
        await cleanupProcessedImage(processed);
        blocks.push({
          eventId,
          attachmentId: attachment.id,
          mediaType: mimeType,
          dataBase64: data.toString("base64"),
        });
      } catch {
        continue;
      }
    }
    return blocks;
  }

  private selectImageAttachments(
    trigger: CanonicalChatEvent,
  ): Array<{ eventId: string; attachment: AttachmentMeta }> {
    const triggerGroupAssets = this.storage.getMediaAssetsForTriggerGroup(trigger.id);
    if (triggerGroupAssets.length > 0) {
      return this.applyImagePriorityCascade(trigger.id, triggerGroupAssets);
    }

    const triggerImages = imageAttachments(trigger).map((attachment) => ({ eventId: trigger.id, attachment }));
    if (triggerImages.length > 0) return triggerImages;

    const replyImages = (trigger.replyTo?.attachments ?? [])
      .filter((attachment) => attachment.mediaType === "image" && attachment.localPath)
      .map((attachment) => ({ eventId: trigger.replyTo?.externalId ?? trigger.id, attachment }));
    if (replyImages.length > 0) return replyImages;

    for (const eventId of trigger.trigger?.groupedEventIds ?? []) {
      if (eventId === trigger.id) continue;
      const event = this.store.getById(eventId);
      const groupedImages = event ? imageAttachments(event).map((attachment) => ({ eventId: event.id, attachment })) : [];
      if (groupedImages.length > 0) return groupedImages;
    }

    return [];
  }

  private applyImagePriorityCascade(
    triggerEventId: string,
    assets: MediaAssetRow[],
  ): Array<{ eventId: string; attachment: AttachmentMeta }> {
    const tiers: Array<{ eventMatch: (a: MediaAssetRow) => boolean; roleMatch: (a: MediaAssetRow) => boolean }> = [
      { eventMatch: (a) => a.event_id === triggerEventId, roleMatch: (a) => a.role === "attachment" },
      { eventMatch: (a) => a.event_id === triggerEventId, roleMatch: (a) => a.role === "reply_attachment" },
      { eventMatch: (a) => a.event_id === triggerEventId, roleMatch: (a) => ["preview_media", "linked_media"].includes(a.role) },
      { eventMatch: (a) => a.event_id !== triggerEventId, roleMatch: (a) => a.role === "attachment" },
      { eventMatch: (a) => a.event_id !== triggerEventId, roleMatch: () => true },
    ];

    for (const tier of tiers) {
      const matched = assets.filter((a) => tier.eventMatch(a) && tier.roleMatch(a));
      if (matched.length > 0) {
        return matched.map((a) => ({
          eventId: a.event_id,
          attachment: mediaAssetToAttachmentMeta(a),
        }));
      }
    }

    return [];
  }
}

function imageAttachments(event: CanonicalChatEvent): NonNullable<CanonicalChatEvent["attachments"]> {
  return (event.attachments ?? []).filter((attachment) => attachment.mediaType === "image" && attachment.localPath);
}

/** True if cursor `a` is strictly after cursor `b` in (timestamp, received_at, id) order. */
function cursorAfter(a: TimelineCursor, b: TimelineCursor): boolean {
  if (a.timestamp !== b.timestamp) return a.timestamp > b.timestamp;
  if (a.receivedAt !== b.receivedAt) return a.receivedAt > b.receivedAt;
  return a.id > b.id;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

