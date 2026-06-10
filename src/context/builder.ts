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
import { agentDateStamp, formatAgentTimestamp } from "../time/index.js";
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
  /**
   * When true, build context for a proactive check-in (ARCHITECTURE.md §9g): the
   * live conversation renders as usual (recent timeline, summary/diary layers,
   * auto-retrieval) but no events are pulled out as a trigger group and the final
   * user turn is a synthetic "decide now" kickoff (`proactive.kickoff_prompt`,
   * `{time}` substituted) rather than a triggering message. Mutually exclusive
   * with `summarizationCutoff`.
   */
  proactive?: boolean;
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

/**
 * Fallback proactive kickoff prompt (§9g) when `proactive.kickoff_prompt` is
 * unset. The shipped default lives in 00-defaults.toml; this only guards a config
 * that enables proactive without supplying the template.
 */
const DEFAULT_PROACTIVE_KICKOFF =
  "It is {time}. No message is addressed to you right now — you have not been triggered. " +
  "Read the recent conversation above and decide, honestly, whether you have something " +
  "genuinely worth adding right now. If you do, say it with send_message — one message, " +
  "natural, not forced. If you do not, output exactly NO_REPLY. Staying quiet is the normal, " +
  "common outcome; only post when it actually adds something.";

export class ContextBuilder {
  /**
   * Priority inheritance (spec CONCURRENCY-AND-RATE-LIMITING §5.5): injected by
   * app wiring (the builder must not import the scheduler or the worker pool).
   * Raises the named summarization job to the waiting build's class at BOTH
   * ordering points — the job row (claim order) and the scheduler entry (a
   * request already queued at `background`) — then wakes the pool. Called when
   * a live build must wait on a specific summary job.
   */
  escalateSummary?: (
    jobId: string,
    priority: "interactive" | "proactive" | "background" | "background_low",
  ) => void;

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
    // Proactive check-in (§9g): live context as usual, but no trigger group and a
    // synthetic kickoff as the final user turn. Distinct from `cutoff`, which cuts
    // the whole context at a timestamp for summarization.
    const proactive = options.proactive === true;
    const now = options.trigger.timestamp;
    const triggerGroupIds = cutoff || proactive ? new Set<string>() : this.resolveTriggerGroupIds(options.trigger);
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

    // 3. Wait-or-omit (spec CONCURRENCY-AND-RATE-LIMITING §7.2): if the compact
    //    tier is over budget, the ONLY outcomes are (a) use a completed summary,
    //    (b) wait — until the covering job reaches a terminal state, no wall
    //    clock; priority inheritance promotes it for the duration — or (c) for a
    //    genuinely *failed* job, render an explicit failure placeholder in the
    //    summary slot. There is no "truncate oldest to fit" step. Skipped for
    //    summarization builds.
    let compactionInput = timelineEvents;
    let failurePlaceholders: Summary[] = [];
    if (!cutoff) {
      const resolved = await this.resolveCompactionOverflow(
        options.timelineKey,
        timelineEvents,
        triggerGroupIds,
        selection,
        options.abortSignal,
      );
      compactionInput = resolved.events;
      // Adopt the post-wait selection so the summary layer renders the summary
      // whose completion just trimmed the raw set — otherwise those events would
      // be dropped from both the raw turns and the layer (a coverage gap).
      selection = resolved.selection;
      // Refresh trigger events from the re-queried set so they reflect any
      // enrichment that landed during the wait (issue #3).
      if (resolved.triggerEvents) {
        triggerEvents = resolved.triggerEvents;
      }
      failurePlaceholders = resolved.placeholders;
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
          selfUserId: this.resolveSelfUserId(options.timelineKey),
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

    // NOTE: level-1 job creation no longer happens here. The build path is
    // read-only w.r.t. summarization jobs — ingestion writes them eagerly
    // (`SummarizationIndexer`, src/summarization/indexer.ts); builds only
    // consume summaries and wait on / escalate jobs (spec §7.1/§7.3).

    // Proactive's synthetic trigger carries no attachments — no image blocks.
    const imageBlocks = cutoff || proactive ? [] : await this.selectImageBlocks(options.trigger);
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

    // Failure placeholders (§7.2) render inside the summary layer, in their
    // chronological slot, with the usual envelope — an explicit "couldn't
    // summarize this range" marker, not a silent gap.
    const layerSummaries =
      failurePlaceholders.length === 0
        ? selection.summaries
        : [...selection.summaries, ...failurePlaceholders].sort(
            (a, b) => a.earliestTimestamp - b.earliestTimestamp,
          );
    const summaryLayer = await this.buildSummaryLayerMessage(
      options.timelineKey,
      layerSummaries,
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
    // For a proactive build there are no trigger events; the immediate "decide now"
    // prompt is the kickoff (§9g). Standing framing (default to silence, don't
    // announce yourself) lives in the proactive session type's session_instruction,
    // rendered inside the satellite block above — two knobs, distinct roles.
    const finalTurnTail = proactive ? this.renderProactiveKickoff(now) : triggerContent;
    const finalUserContent = cutoff
      ? systemBlock
      : [retrievedMemory, systemBlock, finalTurnTail].filter(Boolean).join("\n\n");

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
   * Wait-or-omit (spec §7.2, replaces the old grace-wait-then-truncate): while
   * the compact tier is over `compact_max_tokens`, branch on the state of the
   * job covering the oldest at-risk events:
   *
   * - **pending / processing** → escalate it to the waiter's class (priority
   *   inheritance, §5.5) and wait until it reaches a TERMINAL state. No
   *   wall-clock deadline — the wait is bounded by the job itself (Layer-1
   *   mechanical retries + Layer-3 semantic retries always end in `complete`
   *   or `failed`). On completion, re-select + re-query so the new summary's
   *   coverage trims the raw set.
   * - **failed** (terminal, no salvageable draft) → substitute the range with
   *   an explicit failure-placeholder summary (rendered in the summary layer's
   *   normal slot) and omit its raw events — a surfaced failure, not a silent
   *   gap, and never a "truncate oldest to fit".
   *
   * Only when NOTHING covers the oldest events (summarization disabled, or the
   * eager indexer hasn't enqueued the range yet) does the set pass through
   * unchanged and compaction's ordinary bounds apply. Cutoff (summarization)
   * builds never enter here.
   */
  private async resolveCompactionOverflow(
    timelineKey: string,
    events: CanonicalChatEvent[],
    triggerGroupIds: Set<string>,
    selection: SummarySelection,
    abortSignal?: AbortSignal,
  ): Promise<{
    events: CanonicalChatEvent[];
    selection: SummarySelection;
    triggerEvents?: CanonicalChatEvent[];
    placeholders: Summary[];
  }> {
    const placeholders: Summary[] = [];
    let current: {
      events: CanonicalChatEvent[];
      selection: SummarySelection;
      triggerEvents?: CanonicalChatEvent[];
    } = { events, selection };
    if (this.config.summarization?.enabled === false) return { ...current, placeholders };
    const compactMax = this.config.context.tiers.compact_max_tokens;

    // Each iteration strictly shrinks the raw set (completion advances coverage;
    // a failed substitution removes >= 1 event) or breaks — so the loop
    // terminates. A job waited on is terminal afterwards and leaves the active
    // set, so no job is waited on twice.
    for (;;) {
      if (abortSignal?.aborted) break;
      if (current.events.length === 0) break;
      if (this.estimateCompactTierTokens(current.events) <= compactMax) break;

      const oldest = current.events[0]!;
      const oldestCursor = this.storage.getEventCursor(timelineKey, oldest.id);
      if (!oldestCursor) break;

      const covering = this.storage
        .getActiveSummarizationJobs(timelineKey, 1)
        .find((job) => this.jobCoversCursor(timelineKey, job, oldestCursor));
      if (covering) {
        // Priority inheritance (spec §5.5): this live build is now waiting on
        // the covering job — promote it to the waiter's class so it is claimed
        // next and its LLM request is admitted ahead of unrelated background
        // work. Only live builds reach here, so the waiter's class is
        // `interactive`.
        this.escalateSummary?.(covering.id, "interactive");
        this.logger?.info("context_build_waiting_on_summary", {
          timelineKey,
          jobId: covering.id,
          jobStatus: covering.status,
        });
        const outcome = await this.waitForJobTerminal(covering.id, abortSignal);
        if (outcome === "aborted") break;
        if (outcome === "complete") {
          const requeried = this.requeryAfterCoverageAdvance(timelineKey, triggerGroupIds);
          current = requeried ?? current;
        }
        // failed → next iteration finds it in the failed set and placeholders it.
        continue;
      }

      const failed = this.storage
        .getFailedSummarizationJobs(timelineKey, 1)
        .find((job) => this.jobCoversCursor(timelineKey, job, oldestCursor));
      if (!failed) break;
      const substituted = this.substituteFailedRange(timelineKey, failed, current.events);
      if (!substituted) break;
      placeholders.push(substituted.placeholder);
      current = { ...current, events: substituted.events };
    }

    return { ...current, placeholders };
  }

  /**
   * Compact-tier token estimate without running compaction: total compact-
   * rendered tokens minus the rich tail's compact cost. Mirrors the compaction
   * boundary (rich tokens accumulated from the newest event up to
   * rich_target_tokens).
   */
  private estimateCompactTierTokens(events: CanonicalChatEvent[]): number {
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
    return Math.max(0, totalCompactRendered - richTailCompactCost);
  }

  /** Does the job's input range cover the given event cursor? */
  private jobCoversCursor(
    timelineKey: string,
    job: { inputStartId: string; inputEndId: string },
    cursor: TimelineCursor,
  ): boolean {
    const start = this.storage.getEventCursor(timelineKey, job.inputStartId);
    const end = this.storage.getEventCursor(timelineKey, job.inputEndId);
    return start != null && end != null && !cursorAfter(start, cursor) && !cursorAfter(cursor, end);
  }

  /**
   * Poll the job until it reaches a terminal state (§7.2 — no wall-clock
   * deadline; termination is guaranteed by Design B's bounded retries). A job
   * row that vanishes is treated as complete (matches the old grace-wait).
   */
  private async waitForJobTerminal(
    jobId: string,
    abortSignal?: AbortSignal,
  ): Promise<"complete" | "failed" | "aborted"> {
    for (;;) {
      if (abortSignal?.aborted) return "aborted";
      const job = this.storage.getSummarizationJobById(jobId);
      if (!job || job.status === "complete") return "complete";
      if (job.status === "failed") return "failed";
      await delay(250);
    }
  }

  /**
   * Re-select and re-query against the (possibly advanced) coverage cursor ONCE
   * after a summary lands. The raw events AND the summary-layer selection must
   * move together, or the newly-covered events would be dropped from both (a
   * coverage gap). Returns null when there is still no coverage cursor (keep
   * the current raw set, adopt the fresh selection via the caller).
   */
  private requeryAfterCoverageAdvance(
    timelineKey: string,
    triggerGroupIds: Set<string>,
  ): {
    events: CanonicalChatEvent[];
    selection: SummarySelection;
    triggerEvents?: CanonicalChatEvent[];
  } | null {
    const reselected = selectSummaries(this.storage.getSummaryCandidates(timelineKey));
    if (!reselected.coverageEndEventId) return null;
    const allRequeried = this.hydrateEvents(
      this.store.queryAfterContext(timelineKey, reselected.coverageEndEventId),
    );
    return {
      events: allRequeried.filter((e) => !triggerGroupIds.has(e.id)),
      selection: reselected,
      triggerEvents: allRequeried.filter((e) => triggerGroupIds.has(e.id)),
    };
  }

  /**
   * Failure placeholder (§7.2): omit the failed job's raw events from the build
   * and stand in a synthetic summary occupying the same compact-tier slot — the
   * usual envelope (time range, level, event count) with a "couldn't summarize"
   * body. Never persisted; re-synthesized deterministically on every build while
   * the job stays failed (stable id `sumfail_<jobId>`, so the label cache holds).
   */
  private substituteFailedRange(
    timelineKey: string,
    job: { id: string; level: number; inputStartId: string; inputEndId: string; updatedAt: number },
    events: CanonicalChatEvent[],
  ): { events: CanonicalChatEvent[]; placeholder: Summary } | null {
    const start = this.storage.getEventCursor(timelineKey, job.inputStartId);
    const end = this.storage.getEventCursor(timelineKey, job.inputEndId);
    if (!start || !end) return null;
    const covered = this.storage.getTimelineEventsBetween(timelineKey, start, end);
    if (covered.length === 0) return null;
    const coveredIds = new Set(covered.map((e) => e.id));
    const remaining = events.filter((e) => !coveredIds.has(e.id));
    if (remaining.length === events.length) return null;

    const content =
      "[Summary for this range could not be generated — summarization failed after retries; " +
      "the underlying messages are omitted from context.]";
    const first = covered[0]!;
    const last = covered[covered.length - 1]!;
    const placeholder: Summary = {
      id: `sumfail_${job.id}`,
      timelineKey,
      level: job.level,
      content,
      earliestTimestamp: first.timestamp,
      latestTimestamp: last.timestamp,
      latestEventId: last.id,
      eventCount: covered.length,
      tokenCount: estimateTokens(content),
      modelId: null,
      status: "complete",
      backfillJobId: null,
      generatedAt: job.updatedAt,
      createdAt: job.updatedAt,
    };
    this.logger?.warn("summary_failure_placeholder_rendered", {
      timelineKey,
      jobId: job.id,
      omittedEvents: covered.length,
    });
    return { events: remaining, placeholder };
  }

  /**
   * Render the proactive kickoff — the final user turn for a proactive build
   * (§9g). Substitutes `{time}` in `proactive.kickoff_prompt` with the
   * agent-formatted anchor time (the trigger timestamp = wake-up moment). Falls
   * back to a built-in prompt if the config value is absent (the default ships in
   * 00-defaults.toml, so this is only a safety net).
   */
  private renderProactiveKickoff(now: number): string {
    // Treat an empty/whitespace-only configured prompt as absent: an empty kickoff
    // would be `filter(Boolean)`-dropped from finalUserContent, silently removing the
    // final "decide now / NO_REPLY" user turn, so fall back to the built-in default.
    const configured = this.config.proactive?.kickoff_prompt;
    const template = configured?.trim() ? configured : DEFAULT_PROACTIVE_KICKOFF;
    return template.replaceAll("{time}", formatAgentTimestamp(now)).trim();
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
  /**
   * Resolve the bot's own Matrix user id for a build from its timelineKey
   * (`matrix:{account}:room:{roomId}` / `:dm:` / with `:thread:` suffix — the
   * account is the 2nd colon-segment) via `config.matrix.accounts[account].user_id`
   * (same lookup as src/app.ts). Returns undefined when it can't be resolved; the
   * caller then falls back to the reactor's display name.
   */
  private resolveSelfUserId(timelineKey: string): string | undefined {
    const accountId = timelineKey.split(":")[1];
    if (accountId === undefined) return undefined;
    return this.config.matrix.accounts[accountId]?.user_id;
  }

  private buildDiscreteReactionLines(
    events: CanonicalChatEvent[],
    opts: { assistantOnly: boolean; nameCap: number; selfUserId?: string },
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
    return synthesizeReactionLines(rows, targetInfo, {
      nameCap: opts.nameCap,
      selfUserId: opts.selfUserId,
    });
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

