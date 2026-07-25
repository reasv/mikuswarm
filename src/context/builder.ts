import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AppConfig } from "../config/index.js";
import type { AgentSessionRecord } from "../agent/index.js";
import type { SessionClaims } from "../agent/session-claims.js";
import type { PriorityClass } from "../agent/scheduler.js";
import type { AttachmentMeta, CanonicalChatEvent, ReactionAggregate } from "../types.js";
import type { TimelineStore } from "../timeline/index.js";
import { parseTimelineKey } from "../storage/timeline-key.js";
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
  selectSummaryCoverage,
  resolveRecencyLabels,
  renderSummaryLayer,
  type SummaryLabelCache,
  type SummarySelection,
} from "./summary-layer.js";
import type { WorkspaceContent, SessionTypeConfig } from "../workspace/types.js";
import {
  renderSystemPromptWithSegments,
  renderSatelliteBlock,
  type SystemPromptSegment,
} from "../workspace/prompt.js";
import { renderToolBlock, type ToolDefinitionLike, type ToolBlockSummary } from "./tool-block.js";
import { buildRecentDiaryContent } from "./diary-layer.js";
import { buildAutoRetrievalBlock, type AutoRetrievalDeps } from "./auto-retrieval.js";
import { agentDateStamp, formatAgentTimestamp } from "../time/index.js";
import type { Logger } from "../observability/index.js";

/**
 * Self-describing note on the live summary-layer envelope (§9b). Plain text only —
 * no quotes or angle brackets — so it is safe to inline in the double-quoted XML
 * attribute without escaping. Added only to interactive/proactive builds; never to
 * generation builds (see {@link ContextBuilder.buildSummaryLayerMessage}).
 */
const SUMMARY_LAYER_NOTE =
  "Condensed, lossy recaps of older history (oldest first, newest last). " +
  "Each carries an id — call expand_summary with that id to recover the finer " +
  "detail and the raw messages beneath it.";

// Resume-gap (§9.2) safety fetch ceiling. The gap query is NOT pre-budget-capped
// — the full away-window is fetched so the truncation marker can report the TRUE
// omitted count and `max_messages = -1` (unlimited) is honoured. This is the one
// hard backstop against a pathological away-window (a very busy room, away for a
// very long time) materializing unbounded rows; it sits far above any sane gap
// (the §7 time-window heuristic keeps real gaps tiny). Hitting it switches the
// marker to an open-ended `at_least` form so the count is never silently
// undercounted.
const RESUME_GAP_FETCH_CEILING = 5000;

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
  /**
   * The session's resolved tool set (post-allowlist), structurally reduced to the
   * fields that hit the wire. When provided, the builder renders a
   * {@link BuiltContext.toolBlock} and folds its estimate into
   * {@link BuiltContext.tokenEstimate} — so the estimate accounts for the
   * tool-definition block the provider charges for (the dominant source of the
   * estimate-vs-actual gap). Absent (tests, generation builds that pass no tools)
   * → no tool block and the estimate is the message sum, as before.
   */
  tools?: ToolDefinitionLike[];
  /** When set, build context for a level-1 summarization session. */
  summarizationCutoff?: {
    /** Cut context at this timestamp — no events past it are rendered. */
    endTimestamp: number;
  };
  /**
   * When set, build context for a condensation (level 2+) session over an
   * explicit, pre-resolved list of child summaries (spec
   * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1, Fix B — input-addressed
   * generation). The builder renders EXACTLY these summaries, in the order
   * given, as the final-turn material (the summary-layer envelope the condense
   * `session_instruction` already describes), with NO coverage selection, NO
   * timeline query, and NO raw events — a condensation is a pure reduction of
   * its declared inputs and has no business reading live timeline state (P3).
   * The rendered summary IDs are surfaced as {@link BuiltContext.renderedInputIds}
   * so the worker can assert declared == rendered before the agent runs (P1/P2).
   * Mutually exclusive with `summarizationCutoff` and `diaryRange` (validated).
   */
  condenseInputs?: {
    /** Child summaries (level N-1) to condense, chronological order. */
    summaries: Summary[];
  };
  /**
   * When set, build context for a diary session over a level-1 summary range
   * (spec DIARY-CONTEXT-PARITY §3; ARCHITECTURE.md §9c). A sibling of
   * `summarizationCutoff` (the two are mutually exclusive — validated) that
   * differs from it ONLY in bounds: the summary layer is bounded at the range
   * START (`earliestTimestamp`, same inclusive semantics as the cutoff path)
   * with any range-overlapping summary — in particular `summaryId`, the
   * range's own already-persisted summary — explicitly excluded, and raw
   * events are cut at `latestTimestamp`. The range therefore renders as real
   * prefix chat turns under the prior chunks' summaries, exactly as a chat
   * session cut at `earliestTimestamp` would see them.
   */
  diaryRange?: {
    earliestTimestamp: number;
    latestTimestamp: number;
    /** The range's own summary id (the diary queue rides on `summaries` rows). */
    summaryId: string;
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
  /**
   * The building session's own id (spec DUPLICATE-REPLY-MITIGATION §4). When set
   * (live chat / proactive builds), claimed-message markers and the
   * `<coordination>` gate are computed against the claim registry, excluding this
   * session's own claims (a session may always answer its own trigger). Absent for
   * generation builds (summarize/condense/diary) and the room-context preview.
   */
  selfSessionId?: string;
  /**
   * Resolved scheduler priority class of the building session (spec §5.5: the
   * waiting class is the building session's OWN class). A summary job this
   * build must wait on is escalated to exactly this class — so a proactive
   * build escalates at `proactive` and never outranks live replies. Defaults
   * to `interactive` when unset (unknown callers are user-facing until
   * configured otherwise, matching `defaultPriorityForSessionType`).
   */
  priority?: PriorityClass;
  /**
   * Cancel a wait-or-omit wait early (shutdown drain, spec §7.2). When the
   * signal fires while the build is waiting on a summarization job, the build
   * REJECTS with an `AbortError` — a clean session-creation failure — instead
   * of polling a job that no worker will ever drive to terminal once the pool
   * stops.
   */
  abortSignal?: AbortSignal;
}

export interface BuiltContext {
  messages: ContextMessage[];
  tokenEstimate: number;
  compactTokens: number;
  richTokens: number;
  imageBlocks: ImageBlock[];
  /**
   * Input-addressed generation builds only (spec
   * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1, Fix B): the IDs of the material the
   * builder actually rendered as "the inputs to reduce", so the summarization
   * worker can assert they equal the job's declared input set before the agent
   * runs (P1/P2; invariant 1). For a `condenseInputs` (level 2+) build these
   * are the rendered child-summary IDs; for a `summarizationCutoff` (level 1)
   * build they are the rendered raw-event IDs. Undefined for every other build
   * (live chat, proactive, diary-range) — they have no declared input set.
   */
  renderedInputIds?: string[];
  /**
   * Per-segment token breakdown of the leading `system` message (the workspace
   * files, inlined skills, and the available-skills index). Computed on every
   * build but surfaced ONLY by the live room-context preview endpoint
   * (`roomContext`); the persisted frozen snapshot stays a flat string blob and
   * does not carry it (the breakdown is a live affordance — ARCHITECTURE.md §10a).
   * The estimates do not sum exactly to the system message's `tokenEstimate`; see
   * {@link SystemPromptSegment}.
   */
  systemPromptSegments: SystemPromptSegment[];
  /**
   * The tool-definition block sent out-of-band with the request (its whole-block
   * estimate + per-tool breakdown). Present only when {@link BuildContextOptions.tools}
   * was supplied; its `tokenEstimate` is already folded into {@link tokenEstimate}
   * above. Surfaced by the console inspector as a synthetic "tools" item above the
   * system message (it is NOT a real message and is never sent as content). See
   * {@link ToolBlockSummary}.
   */
  toolBlock?: ToolBlockSummary;
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
  escalateSummary?: (jobId: string, priority: PriorityClass) => void;

  /**
   * Eager-indexer reconcile hook (spec §7.2/§7.3): injected by app wiring to
   * run ONE awaited `SummarizationIndexer.reconcileTimeline` pass. Called by
   * the wait-or-omit loop when the compact tier is over budget but no
   * active/failed job covers the oldest events — which usually means the
   * indexer simply hasn't caught up yet (e.g. the previous summary's
   * pool-onComplete reconcile is still queued, or startup's `reconcileAll`
   * hasn't reached this timeline). The builder remains read-only w.r.t. job
   * CREATION — the indexer owns it; this only asks it to look now. Must never
   * reject (app wiring catches and logs).
   */
  reconcileSummaries?: (timelineKey: string) => Promise<void>;

  /**
   * Channel-descriptor hook for `<runtime_state>`: injected by app wiring so the
   * builder can label the current room (`Name (Space)` + DM flag) without taking
   * a Matrix dependency itself. Called once per live/proactive/preview build
   * (generation builds suppress runtime state and skip it). Resolves to null —
   * and the Channel/Type lines are omitted — when the timeline isn't a resolvable
   * Matrix room or the lookup fails. Must never reject (app wiring catches and
   * returns null); the builder also guards defensively.
   */
  resolveChannelContext?: (
    timelineKey: string,
  ) => Promise<{ label: string; isDirect: boolean } | null>;

  /**
   * Auto-retrieval dependencies (ARCHITECTURE.md §9d / design §8c). Set when the
   * retrieval subsystem is enabled AND `retrieval.auto_retrieval` is on; otherwise
   * undefined and no auto-retrieval block is built.
   */
  private readonly autoRetrieval?: AutoRetrievalDeps;

  /**
   * Session-claim registry (spec DUPLICATE-REPLY-MITIGATION §3/§4). Injected by
   * app wiring so the builder can mark, at build time, any in-context message that
   * another running session has claimed (`<handled_by_session>`). Undefined in
   * tests / non-claim contexts → no markers (the predicate is simply never bound).
   */
  private readonly claims?: SessionClaims;

  /**
   * Resolve the bot's own user id for a given provider + account (§6.3).
   * Injected by app wiring via `providers.get(provider)?.getSelf(accountId)?.id`.
   * When absent, `resolveSelfUserId` falls back to `config.matrix.accounts` so
   * tests and callers that pre-date Phase 3 continue to work unchanged.
   */
  getSelfUserId?: (provider: string, accountId: string) => string | undefined;

  constructor(
    private readonly store: TimelineStore,
    private readonly config: AppConfig,
    private readonly storage: Storage,
    private readonly logger?: Logger,
    autoRetrieval?: AutoRetrievalDeps,
    claims?: SessionClaims,
  ) {
    this.autoRetrieval = autoRetrieval;
    this.claims = claims;
  }

  async build(options: BuildContextOptions): Promise<BuiltContext> {
    const cutoff = options.summarizationCutoff;
    const diaryRange = options.diaryRange;
    const condenseInputs = options.condenseInputs;
    if ([cutoff, diaryRange, condenseInputs].filter((m) => m != null).length > 1) {
      throw new Error(
        "summarizationCutoff, condenseInputs and diaryRange are mutually exclusive build modes",
      );
    }
    // A "generation" build (level-1 summarize cutoff, level-2+ condense, or the
    // diary-range mode) produces memory artifacts over a past range rather than
    // answering a live trigger: no trigger group, no diary layer, no
    // auto-retrieval, no reactions, no wait-or-omit, runtime state suppressed,
    // satellite final turn. The cutoff and diary-range modes differ ONLY in
    // their bounds (cut at range end vs. coverage bounded at range start — spec
    // DIARY-CONTEXT-PARITY §3); the condense mode is input-addressed and reads
    // no timeline state at all (spec SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1).
    const generation = cutoff != null || diaryRange != null || condenseInputs != null;
    // Proactive check-in (§9g): live context as usual, but no trigger group and a
    // synthetic kickoff as the final user turn. Distinct from the generation
    // modes, which re-bound the whole context to a past range.
    const proactive = options.proactive === true;
    const now = options.trigger.timestamp;
    const triggerGroupIds = generation || proactive ? new Set<string>() : this.resolveTriggerGroupIds(options.trigger);
    const compactionState = this.store.getCompactionState(options.timelineKey);

    // 1. Select summaries and derive the event-ID coverage cursor (§4). The
    //    selection includes synthesized failure placeholders for terminally
    //    failed level-1 ranges (spec §7.2 — surfaced failure, never a silent
    //    gap), and its contiguity chain is event-existence based (§9b): the
    //    cursor advances across adjacent summaries (which are separated by
    //    real inter-message intervals) and stops only at a genuine gap of
    //    un-covered raw events.
    //
    //    The condense (level 2+) input-addressed path (spec
    //    SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1) is the exception: it renders
    //    EXACTLY the declared child summaries with no coverage selection and no
    //    timeline query at all (P3). The summary layer IS those summaries; there
    //    are no raw events.
    let selection: SummarySelection;
    let events: CanonicalChatEvent[];
    if (condenseInputs) {
      selection = { summaries: condenseInputs.summaries, coverageEndEventId: null };
      events = [];
    } else {
      selection = selectSummaryCoverage(this.storage, options.timelineKey);

      // 2. Query events starting strictly after the coverage cursor.
      events = selection.coverageEndEventId
        ? this.store.queryAfterContext(options.timelineKey, selection.coverageEndEventId)
        : this.store.queryForContext(options.timelineKey, compactionState);
    }

    if (cutoff) {
      // Cut at endTimestamp; re-select the summary layer to exclude any summary
      // overlapping the events being summarized (§6). `getSummaryCandidates` uses
      // an inclusive `<=` bound so a summary whose `latestTimestamp` equals
      // `earliest` is still included (prevents a coverage gap on millisecond-
      // precision timestamp collisions from Matrix batch sends).
      events = events.filter((e) => e.timestamp <= cutoff.endTimestamp);
      const earliest = events[0]?.timestamp ?? cutoff.endTimestamp + 1;
      selection = selectSummaryCoverage(this.storage, options.timelineKey, earliest);

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

    if (diaryRange) {
      // Diary-range mode (spec DIARY-CONTEXT-PARITY §3): same shape as the
      // cutoff path above, but coverage is bounded at the range START — the
      // diary runs AFTER its range's summary exists, so a naive end-bounded
      // selection would fold the work range into its own summary layer. The
      // inclusive `beforeTimestamp` keeps a prior chunk's summary that shares
      // a millisecond boundary with the range start; the explicit range
      // exclusion drops anything extending INTO the range (always including
      // the range's own summary). Raw events are cut at the range
      // end; uncovered pre-range events ride along as raw turns (benign
      // continuity, same as the summarize build).
      selection = selectSummaryCoverage(this.storage, options.timelineKey, diaryRange.earliestTimestamp, diaryRange);
      if (selection.coverageEndEventId) {
        events = this.store
          .queryAfterContext(options.timelineKey, selection.coverageEndEventId)
          .filter((e) => e.timestamp <= diaryRange.latestTimestamp);
      } else {
        events = this.store
          .queryForContext(options.timelineKey, compactionState)
          .filter((e) => e.timestamp <= diaryRange.latestTimestamp);
      }
    }

    this.logger?.debug("summary_coverage_resolved", {
      timelineKey: options.timelineKey,
      coverageEndEventId: selection.coverageEndEventId,
      selectedSummaryCount: selection.summaries.length,
    });

    events = this.hydrateEvents(events);

    if (generation) {
      events = events.map((e) => this.truncateOversizedEvent(e));
    }

    const timelineEvents = events.filter((e) => !triggerGroupIds.has(e.id));
    let triggerEvents = events.filter((e) => triggerGroupIds.has(e.id));

    // 3. Wait-or-omit (spec CONCURRENCY-AND-RATE-LIMITING §7.2): if the compact
    //    tier is over budget, the ONLY outcomes are (a) use a completed summary,
    //    (b) wait — until the covering job reaches a terminal state, bounded for
    //    interactive-class builds by the wall-clock budget (BuildWaitTimeoutError,
    //    spec LLM-FAILURE-HANDLING §7.1); priority inheritance promotes the job
    //    for the duration — or (c) for a genuinely *failed* job, its failure
    //    placeholder takes over the range (synthesized into the selection above
    //    / by the post-wait re-query).
    //    There is no "truncate oldest to fit" step. Skipped for generation
    //    builds (cutoff AND diary-range — the range is the work product, and
    //    prior chunks' summaries are normally complete because jobs process
    //    oldest-first; a gap simply renders raw — never wait, never fake).
    let compactionInput = timelineEvents;
    if (!generation) {
      const resolved = await this.resolveCompactionOverflow(
        options.timelineKey,
        timelineEvents,
        triggerGroupIds,
        selection,
        options.priority ?? "interactive",
        options.abortSignal,
      );
      compactionInput = resolved.events;
      // Adopt the post-wait selection so the summary layer renders the summary
      // (or failure placeholder) whose arrival just trimmed the raw set —
      // otherwise those events would be dropped from both the raw turns and
      // the layer (a coverage gap).
      selection = resolved.selection;
      // Refresh trigger events from the re-queried set so they reflect any
      // enrichment that landed during the wait (issue #3).
      if (resolved.triggerEvents) {
        triggerEvents = resolved.triggerEvents;
      }
    }

    // Surfaced failures (§7.2): placeholders ride inside the selection; log so
    // a failed range is a visible, recurring signal while it stays failed.
    if (!generation) {
      const placeholderIds = selection.summaries
        .filter((s) => s.id.startsWith("sumfail_"))
        .map((s) => s.id);
      if (placeholderIds.length > 0) {
        this.logger?.warn("summary_failure_placeholder_rendered", {
          timelineKey: options.timelineKey,
          placeholderIds,
        });
      }
    }

    // Passive reaction surfacing (ARCHITECTURE.md §9f). Both views are render-time
    // projections from the reaction store, attached now (after wait-or-omit has
    // finalized the event set) and never persisted into event_json. Off for
    // generation builds — reactions must never leak into summaries or diary
    // entries (§4) — and gated by [reactions] config.
    const rx = this.config.reactions ?? {};
    const reactionsEnabled = !generation && rx.enabled !== false;
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
          // Episode splitting (§9f): a coalesced reaction is split across a seam so
          // temporally-distinct bursts land at their own timeline position.
          splitMessages: rx.discrete_split_messages ?? 5,
          splitGapMs: (rx.discrete_split_minutes ?? 30) * 60_000,
          selfUserId: this.resolveSelfUserId(options.timelineKey),
        });
      }
    }

    // Claim markers (spec DUPLICATE-REPLY-MITIGATION §4): snapshot the OTHER
    // active sessions' claims ONCE here so the frozen context's markers are
    // deterministic for this build's duration (§4.1). Live builds only — never
    // generation builds (no live answering). The marker is rich-tier only: the
    // compact renderer is passed unchanged, keeping the cache-stable compact
    // prefix byte-identical (§4.3).
    const claimSnapshot =
      !generation && this.claims && options.selfSessionId
        ? this.claims.snapshotForBuild(options.timelineKey, options.selfSessionId)
        : undefined;
    const richRenderer =
      claimSnapshot && claimSnapshot.size > 0
        ? (event: CanonicalChatEvent) =>
            renderRichMessage(event, { claimedBy: (externalId) => claimSnapshot.get(externalId) })
        : renderRichMessage;

    const compacted = compactTimelineEvents(
      compactionInput,
      richRenderer,
      renderCompactMessage,
      this.config.context.tiers,
      {
        timelineKey: options.timelineKey,
        // A generation build operates on a re-bounded event set; never persist
        // its derived boundaries into the real compaction state.
        state: generation ? undefined : compactionState,
        reactionLines,
        discreteHorizonMessages: rx.discrete_horizon_messages ?? 0,
        // Inter-user lines use a tighter horizon (the shipped default in
        // 00-defaults.toml is 10 — the live edge — so cross-user reaction chatter
        // stays recent); inert when assistantOnly (§9f). Passed through unresolved so
        // that when the knob is genuinely unset it inherits discrete_horizon_messages
        // (compaction's fallback), per §9f — do NOT default it to a literal here.
        discreteOtherHorizonMessages: rx.discrete_other_horizon_messages,
      },
    );
    if (!generation && compacted.stateChanged && compacted.state) {
      await this.store.saveCompactionState(compacted.state);
    }

    // NOTE: level-1 job creation no longer happens here. The build path is
    // read-only w.r.t. summarization jobs — ingestion writes them eagerly
    // (`SummarizationIndexer`, src/summarization/indexer.ts); builds only
    // consume summaries and wait on / escalate jobs (spec §7.1/§7.3).

    // Proactive's synthetic trigger carries no attachments — no image blocks.
    const imageBlocks =
      generation || proactive
        ? []
        : await this.selectImageBlocks(options.trigger, this.replyModelCanSeeImages(options.sessionType));
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
    const { text: systemPrompt, segments: systemPromptSegments } =
      renderSystemPromptWithSegments(options.workspace, options.fallbackPrompt);
    // The diary session type's session_instruction is a per-job TEMPLATE
    // ({{room}}/{{date}}/{{header}} are substituted by the diary worker) and is
    // delivered, substituted, inside the worker's kickoff turn right after this
    // satellite (spec DIARY-CONTEXT-PARITY §3). Rendering it here too would put
    // the raw, un-substituted template into the context — so the diary-range
    // satellite omits it; everything else (tail instructions) renders as
    // configured.
    const satelliteSessionType =
      diaryRange && options.sessionType
        ? { ...options.sessionType, session_instruction: undefined }
        : options.sessionType;
    // Resolve the human-readable channel descriptor for runtime state. Only for
    // builds that actually render it (generation builds suppress runtime state);
    // null/throw degrades gracefully to the timeline-key-only form.
    let channelContext: { label: string; isDirect: boolean } | null = null;
    if (!generation && this.resolveChannelContext) {
      try {
        channelContext = await this.resolveChannelContext(options.timelineKey);
      } catch (error) {
        this.logger?.debug("resolve_channel_context_failed", {
          timelineKey: options.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const satellite = renderSatelliteBlock(
      {
        ...options,
        suppressRuntimeState: generation,
        channelLabel: channelContext?.label,
        isDirect: channelContext?.isDirect,
      },
      options.workspace,
      satelliteSessionType,
    );
    const triggerContent = triggerEvents.map((e) => renderRichMessage(e)).join("\n\n---\n\n");

    // Failure placeholders (§7.2) are part of the selection itself and render
    // inside the summary layer, in their chronological slot, with the usual
    // envelope — an explicit "couldn't summarize this range" marker, not a
    // silent gap.
    const summaryLayer = await this.buildSummaryLayerMessage(
      options.timelineKey,
      selection.summaries,
      now,
      generation,
    );

    // Recent-diary surfacing (§10a): a layer after the system prompt and before the
    // summaries layer (top-to-bottom: system → diary → summaries), so the agent
    // reads back what it wrote. Omitted from generation builds (summarizer cutoff
    // AND diary-range) — temporally wrong (they operate on past ranges) and a
    // feedback risk. The diary session's own recent-memory window deliberately
    // rides in its final-turn kickoff (worker packaging), NOT here — the "no
    // memory entries in the prefix" rule for generation builds stays clean.
    //
    // The anchor `now` is the trigger's timestamp (set above), used deliberately
    // rather than wall-clock Date.now(): it is deterministic and stable across
    // context rebuilds and replay. It is effectively the latest in-context event day
    // — the trigger (or one of the coalesced triggers) is the last event
    // chronologically. Any cross-midnight divergence from §10a's literal "latest
    // in-context message day" wording is cosmetic: recentMemoryWindow only surfaces
    // existing files ≤ the anchor and never shows empty days.
    const diaryLayer = generation ? null : await this.buildDiaryLayerMessage(now);

    // Auto-retrieval (§8c): a small, cited block of relevant-but-not-recent memory,
    // riding INSIDE the final user turn (cache-safe) BEFORE the trigger messages, so
    // the trigger stays last (most-attended). Deduped against the recency layer.
    // Omitted from generation builds (cutoff and diary-range) — temporally wrong,
    // a feedback risk.
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
    // The user lane (§9d) keys on WHO is talking: the distinct username (or
    // display name when username is absent) of the trigger senders, excluding the
    // bot itself. Using `username ?? displayName` makes the key stable even when a
    // guild nick changes (audit §3.4 finding 13). TODO(phase3b): expand with known
    // prior names via the alias-history map (§6.5) once user_identities is built.
    const triggerUsers = Array.from(
      new Set(
        triggerEvents
          .filter((e) => !e.sender.isSelf)
          .map((e) => (e.sender.username ?? e.sender.displayName)?.trim())
          .filter((n): n is string => n !== undefined && n.length > 0),
      ),
    );
    // Bound the inline auto-retrieval query-embed wait (spec LLM-FAILURE-HANDLING
    // §7.1 / §9d #7): the embed is transitively an inference wait riding inside an
    // interactive build, so it gets the SAME interactive wall-clock budget as the
    // inference request — measured from here, composed with the build's own drain
    // signal. On expiry the search degrades to lexical-only (never blocks the
    // build for minutes during an embed-model outage); the `.catch(…null)` below
    // still omits the whole block on any rejection. The embed query is kept at
    // BACKGROUND scheduler priority (set inside the remote provider) — auto-
    // retrieval is a best-effort enrichment, not a live reply, so it should not
    // outrank real interactive work just because its host build is interactive;
    // only the WAIT is bounded, not the priority.
    const waiterClass = options.priority ?? "interactive";
    const interactiveBuild = waiterClass === "interactive" || waiterClass === "proactive";
    const embedMaxWaitMs = this.config.recovery?.llm_request_max_wait_ms ?? 120_000;
    let retrievalEmbedSignal: AbortSignal | undefined;
    let retrievalEmbedTimer: ReturnType<typeof setTimeout> | undefined;
    let retrievalEmbedAbort: (() => void) | undefined;
    if (!generation && this.autoRetrieval && interactiveBuild) {
      const ctrl = new AbortController();
      retrievalEmbedSignal = ctrl.signal;
      retrievalEmbedTimer = setTimeout(() => ctrl.abort(), embedMaxWaitMs);
      // Shutdown drain also aborts the embed wait (no worker will ever finish it).
      const onDrain = () => ctrl.abort();
      if (options.abortSignal) {
        if (options.abortSignal.aborted) ctrl.abort();
        else options.abortSignal.addEventListener("abort", onDrain, { once: true });
      }
      retrievalEmbedAbort = () => {
        if (retrievalEmbedTimer !== undefined) clearTimeout(retrievalEmbedTimer);
        options.abortSignal?.removeEventListener("abort", onDrain);
      };
    } else if (!generation && this.autoRetrieval && options.abortSignal) {
      // Non-interactive (hypothetical background) build: no wall-clock bound, but
      // the drain signal still aborts the embed wait at shutdown.
      retrievalEmbedSignal = options.abortSignal;
    }
    const retrievedMemory =
      generation || !this.autoRetrieval
        ? null
        : await buildAutoRetrievalBlock(this.autoRetrieval, {
            query: retrievalQuery,
            triggerUsers,
            recencyContent: diaryLayer?.content ?? null,
            now,
            signal: retrievalEmbedSignal,
          })
            .catch((error) => {
              this.logger?.warn("auto_retrieval_failed", {
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            })
            .finally(() => retrievalEmbedAbort?.());

    const systemBlock = `<system>\n${satellite}\n</system>`;
    // For a proactive build there are no trigger events; the immediate "decide now"
    // prompt is the kickoff (§9g). Standing framing (default to silence, don't
    // announce yourself) lives in the proactive session type's session_instruction,
    // rendered inside the satellite block above — two knobs, distinct roles.
    const finalTurnTail = proactive ? this.renderProactiveKickoff(now) : triggerContent;
    const finalUserContent = generation
      ? systemBlock
      : [retrievedMemory, systemBlock, finalTurnTail].filter(Boolean).join("\n\n");

    // Input-addressed integrity (spec SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1):
    // surface exactly what was rendered as "material to reduce" so the worker
    // can assert it equals the job's declared inputs before running the agent.
    // Condense renders the declared child summaries (the summary layer); a
    // level-1 cutoff renders the raw events that survived the cutoff/coverage
    // re-query as the to-summarize turns (`compactionInput`). Every other build
    // has no declared input set.
    const renderedInputIds = condenseInputs
      ? selection.summaries.map((s) => s.id)
      : cutoff
        ? compactionInput.map((e) => e.id)
        : undefined;

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
        type: generation ? "satellite" : "triggerGroup",
        role: "user",
        content: finalUserContent,
        tier: "trigger",
        tokenEstimate: estimateTokens(finalUserContent),
        imageBlocks,
      },
    ];
    // Tool-definition block (out-of-band wire `tools[]`): folded into the estimate
    // so it accounts for what the provider actually charges, and surfaced for the
    // inspector. Not a message — never added to `messages` / sent as content.
    const toolBlock =
      options.tools && options.tools.length > 0 ? renderToolBlock(options.tools) : undefined;
    const messageTokens = messages.reduce((sum, message) => sum + message.tokenEstimate, 0);
    return {
      messages,
      tokenEstimate: messageTokens + (toolBlock?.tokenEstimate ?? 0),
      compactTokens: compacted.compactTokens,
      richTokens: compacted.richTokens,
      imageBlocks,
      renderedInputIds,
      systemPromptSegments,
      toolBlock,
    };
  }

  /**
   * Build the appended user turn for a reply-RESUME (spec RESUMABLE-SESSIONS
   * §9/§11). Returns a single `triggerGroup` AgentMessage that the factory hands
   * to the runner as the kickoff — `agent.prompt(...)` appends it after the
   * resumed transcript and continues the rollout. It is NOT a frozen-prefix build:
   * the frozen prefix is the ORIGINAL snapshot, reused verbatim (§2).
   *
   * Layout (chronological, mirroring the live final turn's
   * `[retrieved_memory, satellite, trigger]` order): the **gap** (older missed
   * context, §9) takes the structural place of retrieved memory, then a **fresh
   * satellite** (`runtime_state` always, tail per the toggle, NO retrieved memory,
   * + the browser note), then the **trigger group** (the actual request). Marking
   * it `triggerGroup` also makes it a real-user-turn boundary for a later
   * `since_last_turn` work-gate scan (§7a).
   */
  async buildResumeTurn(options: {
    timelineKey: string;
    trigger: CanonicalChatEvent;
    activeSessions: AgentSessionRecord[];
    workspace: WorkspaceContent;
    sessionType?: SessionTypeConfig;
    selfSessionId: string;
    /** Satellite tail toggle (spec §11; config `resume.satellite.tail`). */
    tail: boolean;
    /** One-line resume note for runtime_state (the browser tab note, §11). */
    browserNote?: string;
    /**
     * Gap backfill budget (§9). Omitted/inactive → no gap. Both limits must be
     * non-zero to surface anything (0 = include none); -1 = unlimited.
     * `lowerBoundTimestamp` is the newest message the session already has.
     */
    gap?: { maxMessages: number; maxTokens: number; lowerBoundTimestamp: number };
    /**
     * One-line preamble prepended to the rendered trigger group (spec
     * FOLLOWUP-FOLDING §10). Set only for a settled→resume follow-up fold, so the
     * resumed rollout knows the appended turn arrived as a quick same-sender
     * follow-up (and, for a re-`@`, that it was explicitly re-addressed). Absent for
     * an ordinary reply-resume — the reply itself is the address.
     */
    triggerPreamble?: string;
  }): Promise<AgentMessage> {
    const now = options.trigger.timestamp;

    // Trigger group: the reply plus any coalesced members (resolved exactly as a
    // live build), rich-rendered and joined. Looked up individually rather than
    // via a window query — the members are an explicit id set.
    const triggerGroupIds = this.resolveTriggerGroupIds(options.trigger);
    const triggerEvents: CanonicalChatEvent[] = [];
    for (const id of triggerGroupIds) {
      const event = id === options.trigger.id ? options.trigger : this.store.getById(id);
      if (event) triggerEvents.push(event);
    }
    triggerEvents.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const imageBlocks = await this.selectImageBlocks(
      options.trigger,
      this.replyModelCanSeeImages(options.sessionType),
    );
    this.markImageBlocks(triggerEvents, new Set(imageBlocks.map((b) => b.attachmentId)));
    const renderedTrigger = triggerEvents.map((e) => renderRichMessage(e)).join("\n\n---\n\n");
    // A follow-up fold prepends a one-line preamble so the resumed rollout sees the
    // appended turn as a quick same-sender follow-up (§10); a plain reply-resume has none.
    const triggerContent = options.triggerPreamble
      ? `${options.triggerPreamble}\n\n${renderedTrigger}`
      : renderedTrigger;

    // Fresh satellite at the new (volatile) position. runtime_state always; tail
    // per toggle; retrieved_memory never (§11); the browser note rides in
    // runtime_state.
    let channelContext: { label: string; isDirect: boolean } | null = null;
    if (this.resolveChannelContext) {
      try {
        channelContext = await this.resolveChannelContext(options.timelineKey);
      } catch (error) {
        this.logger?.debug("resolve_channel_context_failed", {
          timelineKey: options.timelineKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const satellite = renderSatelliteBlock(
      {
        timelineKey: options.timelineKey,
        trigger: options.trigger,
        activeSessions: options.activeSessions,
        selfSessionId: options.selfSessionId,
        channelLabel: channelContext?.label,
        isDirect: channelContext?.isDirect,
        suppressRuntimeState: false,
        suppressTail: !options.tail,
        resumeNote: options.browserNote,
      },
      options.workspace,
      options.sessionType,
    );
    const systemBlock = `<system>\n${satellite}\n</system>`;

    // Gap backfill (§9): contiguous newest-first run of room messages the session
    // missed, excluding trigger members, claim-marked and budget-truncated.
    const gapActive =
      options.gap !== undefined && options.gap.maxMessages !== 0 && options.gap.maxTokens !== 0;
    const gapRendered = gapActive
      ? this.renderResumeGap(options.timelineKey, options.trigger, triggerGroupIds, options.gap!, options.selfSessionId)
      : null;

    const finalUserContent = [gapRendered, systemBlock, triggerContent].filter(Boolean).join("\n\n");
    return {
      type: "triggerGroup",
      content: finalUserContent,
      imageBlocks,
      timestamp: now,
      tier: "trigger",
      tokenEstimate: estimateTokens(finalUserContent),
    } as AgentMessage;
  }

  /**
   * Render the gap backfill (spec RESUMABLE-SESSIONS §9.2): a CONTIGUOUS,
   * newest-first run of room messages in `(lowerBound, trigger]` — excluding the
   * trigger-group members (rendered separately) — truncated oldest-first to the
   * budget, with a marker reporting the TRUE count of messages the budget cut.
   * Messages another running session has claimed are flagged
   * `<handled_by_session>` so the resumed session does not duplicate-handle them
   * (§9.2 ownership). Never punches holes to fit a budget; truncation is always a
   * contiguous oldest-first cut. The whole window is fetched (no pre-budget cap),
   * so `max_messages = -1` is genuinely unlimited; only a far-above-normal safety
   * ceiling bounds a pathological away-window (and then the marker turns
   * open-ended). Returns null when nothing falls in the window.
   */
  private renderResumeGap(
    timelineKey: string,
    trigger: CanonicalChatEvent,
    triggerGroupIds: Set<string>,
    gap: { maxMessages: number; maxTokens: number; lowerBoundTimestamp: number },
    selfSessionId: string,
  ): string | null {
    // Walk back from the trigger group's latest member (the trigger itself, the
    // chronologically-last event). The query is NOT pre-budget-capped: it fetches
    // the WHOLE window newest-first (up to a high safety ceiling) so the budget
    // alone decides what is dropped, the truncation marker can report the TRUE
    // omitted count, and `max_messages = -1` (unlimited) is honoured rather than
    // silently bounded. `+1` makes the lower bound exclusive (the session already
    // has everything at/below it); the extra `+1` on the fetch limit lets us
    // detect that the safety ceiling itself truncated the window (overflow).
    const windowAsc = this.store.query({
      timelineKey,
      fromTimestamp: gap.lowerBoundTimestamp + 1,
      toTimestamp: trigger.timestamp,
      limit: RESUME_GAP_FETCH_CEILING + 1,
    });
    // `query` returns the NEWEST `limit` rows (then ascending), so an overflow drop
    // is always of the OLDEST window messages — older than anything we will keep.
    const ceilingOverflow = windowAsc.length > RESUME_GAP_FETCH_CEILING;
    const gapEvents = windowAsc.filter((e) => !triggerGroupIds.has(e.id));
    if (gapEvents.length === 0) return null;

    const claimSnapshot = this.claims?.snapshotForBuild(timelineKey, selfSessionId);
    const claimedBy = claimSnapshot
      ? (externalId: string) => claimSnapshot.get(externalId)
      : undefined;

    // Accumulate newest-first until a budget is hit; the remaining older events are
    // truncated (oldest-first). -1 on an axis = unlimited (never the cap). `gapEvents`
    // is the true window (modulo a ceiling overflow tracked above), so `omitted` is
    // the exact count of older messages the budget dropped.
    const kept: string[] = [];
    let totalTokens = 0;
    let omitted = 0;
    for (let i = gapEvents.length - 1; i >= 0; i--) {
      const text = renderRichMessage(gapEvents[i]!, claimedBy ? { claimedBy } : undefined);
      const tokens = estimateTokens(text);
      const messageCapHit = gap.maxMessages > 0 && kept.length >= gap.maxMessages;
      const tokenCapHit = gap.maxTokens > 0 && kept.length > 0 && totalTokens + tokens > gap.maxTokens;
      if (messageCapHit || tokenCapHit) {
        omitted = i + 1;
        break;
      }
      kept.push(text);
      totalTokens += tokens;
    }
    if (kept.length === 0) return null;
    kept.reverse(); // chronological (oldest kept → newest)
    // An exact count when the whole window was fetched; an open-ended `at_least`
    // form when the safety ceiling itself truncated older messages we never saw
    // (so the count can never silently undercount the real gap).
    const marker =
      omitted > 0 || ceilingOverflow
        ? `<earlier_messages_omitted count="${omitted}"${ceilingOverflow ? ' at_least="true"' : ""}/>\n`
        : "";
    return (
      `<messages_while_you_were_away note="These arrived in the room since your last reply; ` +
      `some may already be handled by other sessions (tagged &lt;handled_by_session&gt;).">\n` +
      `${marker}${kept.join("\n\n")}\n</messages_while_you_were_away>`
    );
  }

  /**
   * Render the summary-layer message (§4). For normal builds the recency-label
   * cache is read/written to keep the prefix byte-stable (§5); generation
   * builds (cutoff and diary-range) compute labels directly and never touch
   * the cache (their labels would pollute the shared per-timeline entry).
   */
  private async buildSummaryLayerMessage(
    timelineKey: string,
    summaries: Summary[],
    now: number,
    isGenerationBuild: boolean,
  ): Promise<ContextMessage | null> {
    if (summaries.length === 0) return null;

    let labels: string[];
    if (isGenerationBuild) {
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

    // Live builds wrap the summary blocks in a self-describing envelope so the
    // agent learns, at the point of use, that these are lossy condensations whose
    // `id` it can hand to `expand_summary` (mirrors the §9d `<retrieved_memory>` /
    // §9c `<recent_memory>` note style — the summary layer was the lone unlabeled
    // one). Generation builds (cutoff / condense / diary-range) are deliberately
    // left bare: the note is an instruction to a tool-less worker that operates ON
    // these summaries as input, and `condenseInputs` asserts declared == rendered
    // input ids — an envelope here would be noise at best, a hazard at worst.
    const rendered = renderSummaryLayer(summaries, labels);
    const content = isGenerationBuild
      ? rendered
      : `<conversation_summary note="${SUMMARY_LAYER_NOTE}">\n${rendered}\n</conversation_summary>`;
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
   * - **pending / processing** → escalate it to the waiter's class
   *   (`waiterClass` — the building session's own resolved class, spec §5.5;
   *   priority inheritance) and wait until it reaches a TERMINAL state. No
   *   wall-clock deadline — the wait is bounded by the job itself (Layer-1
   *   mechanical retries + Layer-3 semantic retries always end in `complete`
   *   or `failed`). At terminal, re-select + re-query: a completed summary's
   *   coverage trims the raw set; a failed job's synthesized placeholder
   *   (selectSummaryCoverage) advances the cursor over the range, omitting
   *   its events — a surfaced failure, not a silent gap, and never a
   *   "truncate oldest to fit".
   * - **no covering job at all** → ask the eager indexer for ONE awaited
   *   reconcile and re-check (the indexer may simply not have caught up —
   *   chunk N+1's job is normally created by the pool's fire-and-forget
   *   onComplete reconcile, which this loop's previous wait easily outruns on
   *   deep multi-chunk backlogs). The builder stays read-only w.r.t. job
   *   creation (spec §7.3) — the indexer owns it.
   *
   * Only when even a fresh reconcile leaves nothing covering the oldest events
   * (summarization disabled, or its generation threshold genuinely not
   * crossed) does the set pass through unchanged and compaction's ordinary
   * bounds apply. Cutoff (summarization) builds never enter here.
   *
   * When `abortSignal` fires (shutdown drain) the wait cannot ever finish —
   * the worker pool is about to stop — so this THROWS an `AbortError`, failing
   * the build (and the session creation around it) cleanly.
   */
  private async resolveCompactionOverflow(
    timelineKey: string,
    events: CanonicalChatEvent[],
    triggerGroupIds: Set<string>,
    selection: SummarySelection,
    waiterClass: PriorityClass,
    abortSignal?: AbortSignal,
  ): Promise<{
    events: CanonicalChatEvent[];
    selection: SummarySelection;
    triggerEvents?: CanonicalChatEvent[];
  }> {
    let current: {
      events: CanonicalChatEvent[];
      selection: SummarySelection;
      triggerEvents?: CanonicalChatEvent[];
    } = { events, selection };
    if (this.config.summarization?.enabled === false) return current;
    const compactMax = this.config.context.tiers.compact_max_tokens;
    // Build-wait deadline (spec LLM-FAILURE-HANDLING §7.1): the wait is
    // transitively an inference wait, so it gets the same patience as the
    // inference request itself — the interactive wall-clock budget, measured
    // from wait entry. Every build that can enter this loop today is
    // interactive-class (live chat + proactive; generation builds — cutoff and
    // diary-range — skip wait-or-omit and resume skips the build), but a
    // hypothetical background-class build would wait unboundedly, consistent
    // with §6.
    const interactiveWaiter = waiterClass === "interactive" || waiterClass === "proactive";
    const maxWaitMs = this.config.recovery?.llm_request_max_wait_ms ?? 120_000;
    const waitStart = Date.now();
    const deadline = interactiveWaiter ? waitStart + maxWaitMs : Infinity;

    // Each iteration waits a job to terminal (it leaves the active set, so no
    // job is waited on twice; the requery shrinks the raw set), reconciles at
    // most once per distinct oldest event, or breaks — so the loop terminates.
    let lastReconciledOldestId: string | null = null;
    for (;;) {
      if (abortSignal?.aborted) throw buildAbortError();
      if (current.events.length === 0) break;
      if (this.estimateCompactTierTokens(current.events) <= compactMax) break;

      const oldest = current.events[0]!;
      const oldestCursor = this.storage.getEventCursor(timelineKey, oldest.id);
      if (!oldestCursor) break;

      const covering = this.storage
        .getActiveSummarizationJobs(timelineKey, 1)
        .find((job) => this.jobCoversCursor(timelineKey, job, oldestCursor));
      if (covering) {
        // Priority inheritance (spec §5.5): this build is now waiting on the
        // covering job — promote it to the waiter's OWN class (threaded from
        // the session type via the factory: live builds escalate at
        // `interactive`, proactive builds at `proactive`) so it is claimed
        // next and its LLM request is admitted ahead of lower-priority work
        // without outranking higher-priority sessions.
        this.escalateSummary?.(covering.id, waiterClass);
        this.logger?.info("context_build_waiting_on_summary", {
          timelineKey,
          jobId: covering.id,
          jobStatus: covering.status,
          waiterClass,
        });
        const outcome = await this.waitForJobTerminal(covering.id, abortSignal, deadline);
        if (outcome === "aborted") throw buildAbortError();
        if (outcome === "timeout") {
          this.logger?.warn("context_build_wait_timeout", {
            timelineKey,
            jobId: covering.id,
            waiterClass,
            waitedMs: Date.now() - waitStart,
          });
          throw new BuildWaitTimeoutError(covering.id, Date.now() - waitStart);
        }
        // Terminal either way: re-select + re-query. A completed summary (or a
        // failed job's placeholder) advances the coverage cursor and trims the
        // raw set; the events move from the raw turns into the summary layer
        // together — never dropped from both.
        const requeried = this.requeryAfterCoverageAdvance(timelineKey, triggerGroupIds);
        current = requeried ?? current;
        continue;
      }

      // Nothing covers the oldest at-risk events: run ONE awaited indexer
      // reconcile and re-check (at most once per distinct oldest event, so the
      // loop still terminates when the indexer genuinely has nothing to
      // enqueue).
      if (this.reconcileSummaries && lastReconciledOldestId !== oldest.id) {
        lastReconciledOldestId = oldest.id;
        this.logger?.info("context_build_reconcile_for_coverage", {
          timelineKey,
          oldestEventId: oldest.id,
        });
        await this.reconcileSummaries(timelineKey);
        continue;
      }
      break;
    }

    return current;
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
   * Poll the job until it reaches a terminal state, the abort signal fires, or
   * the wall-clock deadline passes (spec LLM-FAILURE-HANDLING §7.1: under this
   * spec a job is legitimately non-terminal for the whole duration of a model
   * outage, so an interactive build's wait must be bounded; `Infinity` for a
   * background-class waiter). A job row that vanishes is treated as complete
   * (matches the old grace-wait).
   */
  private async waitForJobTerminal(
    jobId: string,
    abortSignal: AbortSignal | undefined,
    deadline: number,
  ): Promise<"complete" | "failed" | "aborted" | "timeout"> {
    for (;;) {
      if (abortSignal?.aborted) return "aborted";
      const job = this.storage.getSummarizationJobById(jobId);
      if (!job || job.status === "complete") return "complete";
      if (job.status === "failed") return "failed";
      if (Date.now() >= deadline) return "timeout";
      await delay(250);
    }
  }

  /**
   * Re-select and re-query against the (possibly advanced) coverage cursor ONCE
   * after a waited job reaches terminal. The raw events AND the summary-layer
   * selection must move together, or the newly-covered events would be dropped
   * from both (a coverage gap). The re-selection includes synthesized failure
   * placeholders, so a job that terminally failed during the wait advances the
   * cursor the same way a completed summary does. Returns null when there is
   * still no coverage cursor (keep the current raw set, adopt the fresh
   * selection via the caller).
   */
  private requeryAfterCoverageAdvance(
    timelineKey: string,
    triggerGroupIds: Set<string>,
  ): {
    events: CanonicalChatEvent[];
    selection: SummarySelection;
    triggerEvents?: CanonicalChatEvent[];
  } | null {
    const reselected = selectSummaryCoverage(this.storage, timelineKey);
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
    // Also union the DURABLE group from the `trigger_group_id` column (FOLLOWUP-FOLDING
    // review #2). The in-memory `groupedEventIds` is authoritative on the live `build`
    // path, but a resume re-reads the trigger from `event_json` (provider-hold group
    // only), dropping backward-lookback members; those survive only in the column.
    // Unioning makes the rendered-TEXT path consistent with the image path
    // (`getMediaAssetsForTriggerGroup`, same key) and immune to the in-memory loss.
    // A no-op for `build`, where the column holds exactly the same member ids
    // `setTriggerGroup` wrote from that group (and is empty until persisted, so it can
    // only ever add ids already present). Synchronous (`read`).
    for (const id of this.storage.getTriggerGroupMemberIds(trigger.id)) {
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
   * line reads "<author>'s message" instead of "your message". Non-self lines are
   * additionally clamped, in compaction, by a tighter horizon. The
   * store is queried for all such targets; compaction injects only the lines whose
   * timestamp falls within the rich tier's time span. Returns [] when there are no
   * targets or no live reactions on them.
   */
  /**
   * Resolve the bot's own user id for a build from its timelineKey. Uses the
   * injected `getSelfUserId` callback (wired by app.ts to
   * `providers.get(provider)?.getSelf(accountId)?.id`) when available, falling
   * back to `config.matrix.accounts` for callers that pre-date Phase 3.
   * Returns undefined when it can't be resolved.
   */
  private resolveSelfUserId(timelineKey: string): string | undefined {
    const parsed = parseTimelineKey(timelineKey);
    if (!parsed) return undefined;
    if (this.getSelfUserId) {
      return this.getSelfUserId(parsed.provider, parsed.accountId);
    }
    // Fallback: Matrix config read for callers / tests that haven't wired getSelfUserId.
    return this.config.matrix.accounts[parsed.accountId]?.user_id;
  }

  private buildDiscreteReactionLines(
    events: CanonicalChatEvent[],
    opts: {
      assistantOnly: boolean;
      nameCap: number;
      splitMessages?: number;
      splitGapMs?: number;
      selfUserId?: string;
    },
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
        // displayName is the friendlier human-facing label; for providers with username
        // (Discord) but no nick, the handle backstops a missing displayName.
        authorDisplay: target.sender.displayName ?? target.sender.username ?? undefined,
      });
    }
    // Ascending message times across the whole rendered set — the seam signal for
    // episode splitting (count of messages between two reactions). §9f.
    const messageTimestamps = events.map((e) => e.timestamp).sort((a, b) => a - b);
    return synthesizeReactionLines(rows, targetInfo, {
      nameCap: opts.nameCap,
      selfUserId: opts.selfUserId,
      messageTimestamps,
      splitMessages: opts.splitMessages,
      splitGapMs: opts.splitGapMs,
    });
  }

  /**
   * Condition a SINGLE event's own image attachments into inference-ready
   * {@link ImageBlock}s (spec FOLLOWUP-FOLDING §5.1). Used by the steer path for a
   * folded **media** follow-up, which has no trigger group of its own (the fold
   * suppresses its accept): `selectImageBlocks` falls through its trigger-group
   * cascade to the event's own `imageAttachments`, so passing the bare event yields
   * exactly its pixels. Empty when the model cannot see images, the image isn't
   * downloaded yet, or `processImageForInference` throws — the caller then steers a
   * caption-only interjection rather than blocking (§5.1 no-pixels branch).
   */
  async conditionEventImages(
    event: CanonicalChatEvent,
    sessionType?: SessionTypeConfig,
  ): Promise<ImageBlock[]> {
    return this.selectImageBlocks(event, this.replyModelCanSeeImages(sessionType));
  }

  /**
   * Mark an event's attachments that were conditioned into {@link ImageBlock}s, so the
   * renderer emits `image_block="true"` on them (renderer.ts) — telling the model the
   * loose vision block and the `<attachment>` are the same image. Public wrapper over
   * the trigger-group-scoped {@link markImageBlocks}, used by the steer path for a
   * folded media follow-up / image co-reply (spec FOLLOWUP-FOLDING §5.1): there the
   * blocks come from {@link conditionEventImages}, not a trigger-group build, so the
   * `build` (live) / `buildResumeTurn` (resume) marking does not run. The passed
   * `events` must be the SAME objects subsequently rendered (the mark mutates them).
   */
  markEventImageBlocks(events: CanonicalChatEvent[], blocks: ImageBlock[]): void {
    this.markImageBlocks(events, new Set(blocks.map((b) => b.attachmentId)));
  }

  /**
   * Whether a session's REPLY MODEL accepts image input — the model that will
   * actually serve the turn, resolved from the session type (`sessionType.model`,
   * falling back to the `default` registry block only when a session type declares
   * no model override, in which case `default` genuinely IS its model). This gates
   * whether trigger images are shipped as pixels; it is a property of the serving
   * model alone — a fallback member's or an unrelated model's modality never
   * influences it. Text-only reply models get captions (always rendered) and no
   * pixel blocks.
   */
  replyModelCanSeeImages(sessionType?: SessionTypeConfig): boolean {
    const modelKey = sessionType?.model ?? "default";
    return this.config.models[modelKey]?.input_modalities?.includes("image") ?? false;
  }

  private async selectImageBlocks(
    trigger: CanonicalChatEvent,
    canSeeImages: boolean,
  ): Promise<ImageBlock[]> {
    if (!canSeeImages) return [];
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

/**
 * Error thrown when a build's wait-or-omit wait is cancelled by
 * `BuildContextOptions.abortSignal` (shutdown drain). Named `AbortError` so
 * callers can distinguish a clean drain cancellation from a real build failure.
 */
function buildAbortError(): Error {
  const error = new Error("context build aborted while waiting on a summarization job (shutdown drain)");
  error.name = "AbortError";
  return error;
}

/**
 * Thrown when an interactive-class build's wait on summary coverage exceeds
 * the wall-clock budget (spec LLM-FAILURE-HANDLING §7.1): during a model
 * outage a covering job is legitimately non-terminal for the whole outage, and
 * an indefinite block would fire the reply hours late on recovery. The build
 * rejects, `launchSession` discards the never-started session (there is no
 * snapshot/transcript yet — genuinely nothing to park), and the JOB IS
 * UNTOUCHED: still queued, completed when its model recovers, improving every
 * later build on the timeline. Coverage is never faked — no degraded context.
 */
export class BuildWaitTimeoutError extends Error {
  constructor(jobId: string, waitedMs: number) {
    super(
      `context build timed out after ${Math.round(waitedMs)}ms waiting on summarization job ${jobId} (llm_request_max_wait_ms)`,
    );
    this.name = "BuildWaitTimeoutError";
  }
}

