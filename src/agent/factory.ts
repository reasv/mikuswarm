import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple, completeSimple, createAssistantMessageEventStream, type Model, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/index.js";
import { dumpBuiltContext, CACHE_BOUNDARIES, type BuiltContext, type ContextBuilder } from "../context/index.js";
import type { ContextMessage } from "../context/builder.js";
import type { AgentSessionRecord } from "./session-manager.js";
import { convertToLlm } from "./convert.js";
import { extractLlmRequestClass, withRequestRetry } from "./request-retry.js";
import {
  defaultPriorityForSessionType,
  modelHealthKey,
  withSchedulerAdmission,
  type LlmScheduler,
  type PriorityClass,
} from "./scheduler.js";
import { loadWorkspace, renderSystemPrompt } from "../workspace/index.js";
import type { WorkspaceContent, SessionTypeConfig } from "../workspace/types.js";
import type { Storage } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { SessionLiveEventBus } from "../observability/live-events.js";
import type { LlmRequestRing } from "./request-ring.js";
import type { CanonicalChatEvent } from "../types.js";

const wrapCompleteAsStream: StreamFn = (model, context, options) => {
  const stream = createAssistantMessageEventStream();
  void completeSimple(model, context, options).then(
    (message) => {
      const reason = message.stopReason === "toolUse" ? "toolUse"
        : message.stopReason === "length" ? "length"
        : "stop";
      stream.push({ type: "done", reason, message });
      stream.end(message);
    },
    (err) => {
      const errorMessage: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider ?? "unknown",
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: errorMessage });
      stream.end(errorMessage);
    },
  );
  return stream;
};

/**
 * Pin `maxRetries: 0` onto every stream call so Layer-1 (`withRequestRetry`) is
 * the SOLE retry authority (spec §5.4/§6.1). The provider SDKs pi-ai delegates
 * to (Anthropic, OpenAI) silently default to 2 internal HTTP retries — pi-ai
 * forwards `maxRetries` to them only when defined — whose backoff sleeps would
 * run INSIDE the held scheduler slot and whose absorbed 429s would never reach
 * the group backoff (`noteResult`/`onResponse`), while their attempt count
 * multiplies with Layer-1's. Providers without client-side retries ignore the
 * option, so this is safe for non-SDK providers too.
 */
export function withSdkRetriesDisabled(base: StreamFn): StreamFn {
  return (model, context, options) => base(model, context, { ...options, maxRetries: 0 });
}

export interface AgentFactoryOptions {
  config: AppConfig;
  contextBuilder: ContextBuilder;
  getActiveSessions: (timelineKey: string) => AgentSessionRecord[];
  /**
   * Read access for the room-context preview (spec §9). Used only by
   * {@link AgentSessionFactory.buildPreview} to pick the synthetic trigger
   * (most recent timeline event); the live session path never touches it.
   * Optional so existing tests can construct a factory without a DB; absent =
   * `buildPreview` is unavailable.
   */
  storage?: Storage;
  /**
   * Optional structured logger. Used to surface the tool-call cap being hit
   * (`agent_tool_call_cap_reached`). Optional so tests can construct a factory
   * without one.
   */
  logger?: Logger;
  /**
   * LLM request scheduler (spec CONCURRENCY-AND-RATE-LIMITING §5 / Design A).
   * When set, every session's stream fn acquires a slot in its model's
   * rate-limit group (priority from the session type) before issuing the HTTP
   * call — admission composes INSIDE the Layer-1 retry (§5.4). Optional so
   * tests can construct a factory without one (no scheduling, prior behaviour).
   */
  scheduler?: LlmScheduler;
  /**
   * Per-session tentative-event bus (spec LLM-FAILURE-HANDLING §4.2). When
   * set, the Layer-0 observability tap publishes every raw attempt event (and
   * attempt-discard notices) keyed by session id, so the console SSE can
   * render tokens live even though the authoritative stream is buffered to
   * the terminal event. Optional: absent = no tap (tests, headless).
   */
  liveEvents?: SessionLiveEventBus;
  /**
   * In-memory LLM request ring (spec LLM-FAILURE-HANDLING §9.2): every settled
   * Layer-0 attempt is recorded with session/priority attribution and the
   * admission wait. Optional: absent = no recording (tests, headless).
   */
  requestRing?: LlmRequestRing;
}

/** Result of a room-context preview build (spec §9). */
export interface PreviewContext {
  /** The real `ContextBuilder.build()` output — identical to a live session's. */
  built: BuiltContext;
  /** Canonical id of the event used as the synthetic trigger, or null if the timeline is empty. */
  syntheticTriggerEventId: string | null;
  /**
   * Index into `built.messages` at which the trigger-dependent final user turn
   * begins (the trailing `triggerGroup`/`satellite`, and any `satellite` system
   * block immediately preceding it). Messages from here on are flagged
   * `preview: true` by the endpoint (spec §9). `-1` if the build produced no
   * final user turn.
   */
  finalTurnIndex: number;
  /**
   * Cache-boundary markers for the built context (spec §8 endpoint shape, §11 top
   * bar), copied verbatim from the shared {@link CACHE_BOUNDARIES} const so the
   * preview, the on-disk dump, and the endpoint cannot drift.
   */
  cacheBoundaries: string[];
}

type ModelConfig = AppConfig["models"]["default"];

export interface CreateAgentOptions {
  /** When set, build context for a summarization session cut at this timestamp. */
  summarizationCutoff?: { endTimestamp: number };
  /**
   * When set, build context for a diary session over a level-1 summary range
   * (spec DIARY-CONTEXT-PARITY §3; ARCHITECTURE.md §9c): the summarize-style
   * prefix with coverage bounded at the range START — prior chunks' summaries
   * form the layer, the range's raw events render as real prefix turns, and
   * the range's own summary (`summaryId`) is excluded. Mutually exclusive with
   * `summarizationCutoff`; threaded straight into {@link ContextBuilder.build}.
   */
  diaryRange?: { earliestTimestamp: number; latestTimestamp: number; summaryId: string };
  /**
   * When true, build context in proactive check-in mode (ARCHITECTURE.md §9g): no
   * trigger group, a synthetic kickoff as the final user turn, no image blocks.
   * Threaded straight into {@link ContextBuilder.build}.
   */
  proactive?: boolean;
  /**
   * Resume seam (Layer-2 resume-in-place — ARCHITECTURE.md §8; used by the recovery
   * path in app.ts). When set, `ContextBuilder.build()` is skipped entirely: `snapshot` is reused as the
   * frozen prefix and `transcript` seeds the live message array. The caller is expected
   * to append the awaited input as a new user turn before continuing.
   *
   * IMPORTANT — vocabulary contract: `resume.snapshot` must ALREADY be in the agent
   * message vocabulary, NOT raw `BuiltContext.messages`. The persisted
   * `context_snapshot_json` is serialized from raw `built.messages`, which keeps the
   * leading `system` ContextMessage (the runtime carries it in
   * `AgentState.systemPrompt`, never in the array) and the summary/compact/rich tier
   * shapes with `tier`/`tokenEstimate` metadata. The live frozen prefix, by contrast,
   * is `mapBuiltMessages(built)`: the `system` block dropped and `summaryLayer` folded
   * into a user `chatEvent`. A caller resuming from `context_snapshot_json` MUST run the
   * parsed array through {@link mapBuiltMessages} before passing it here — spreading the
   * raw snapshot verbatim would double the system message and carry tier shapes the
   * runtime prefix never contains. The `create()` resume branch only defensively copies
   * `snapshot`; it does NOT re-project it.
   */
  resume?: { snapshot: AgentMessage[]; transcript?: AgentMessage[] };
  /**
   * LLM-scheduler priority override (spec §5.5/§9.3). When set, replaces the
   * session type's (configured or default) class — the summarization worker
   * passes the job row's possibly-escalated priority here so an escalated job's
   * requests are admitted at the waiter's class.
   */
  priority?: PriorityClass;
  /**
   * Stable scheduler escalation key (spec §5.5). The summarization worker passes
   * `"sumjob:" + job.id` so `LlmScheduler.escalate` can target this session's
   * queued request across attempts (the synthetic session id is regenerated per
   * attempt; the job id is stable).
   */
  escalationKey?: string;
  /**
   * Drain/cancel signal threaded into the context build (spec §7.2 wait-or-omit).
   * When it fires while the build is waiting on a summarization job, the build —
   * and therefore `create()` — rejects with an `AbortError` instead of polling a
   * job that no worker will drive to terminal once the pool stops. `app.ts`
   * passes its drain controller's signal for every `launchSession` create (live,
   * queued, and proactive — the only builds that can enter the wait loop).
   * Synthetic creates need no signal: summarize/condense builds use
   * `summarizationCutoff` and diary builds use `diaryRange` (both skip
   * wait-or-omit entirely); resume creates skip the build altogether.
   */
  abortSignal?: AbortSignal;
}

export interface CreatedAgent {
  agent: Agent;
  /**
   * The final user turn — a rich `triggerGroup` (chat) or the cutoff `satellite`
   * (summarization) — popped off the frozen prefix (§2b). The caller kicks the loop
   * with it via `agent.prompt(...)`, making it the first turn of the live transcript.
   * Undefined in resume mode (the caller appends a new user turn instead).
   */
  finalTurn?: AgentMessage;
  /**
   * Frozen context **prefix** for persistence (spec §3 / §10a): `built.messages`
   * minus the final live user turn (the trailing `triggerGroup`/`satellite`).
   *
   * This DELIBERATELY retains the leading `system` ContextMessage and the
   * summary/compact/rich tiers WITH their `tier`/`tokenEstimate` metadata intact —
   * the verbatim renderer (§10a) needs the system block + tier metadata. Do NOT
   * reuse the runtime `frozenBase` here: that drops the system message and tier
   * metadata. Undefined in resume mode (no fresh build occurred).
   */
  snapshot?: ContextMessage[];
  /** Snapshot-level token totals copied verbatim from `BuiltContext` (§11 top bar). */
  tokenEstimate?: number;
  compactTokens?: number;
  richTokens?: number;
}

export class AgentSessionFactory {
  constructor(private readonly options: AgentFactoryOptions) {}

  /**
   * Resolve the SessionTypeConfig for a given session type name.
   */
  resolveSessionType(sessionType: string): SessionTypeConfig | undefined {
    const types = this.options.config.agent.session_types;
    if (!types) return undefined;
    return types[sessionType] ?? types["default"];
  }

  /** Resolve the model id used by a session type (for summary record provenance). */
  resolveModelId(sessionType: string): string {
    const cfg = this.resolveSessionType(sessionType);
    const modelKey = cfg?.model ?? "default";
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    return modelConfig.id;
  }

  /**
   * Create an Agent for the given session.
   *
   * Loads workspace content from disk (workspace files, tail instructions, skills)
   * and assembles the system prompt from it. The workspace content is also passed
   * to the context builder so the satellite block can be rendered at build time.
   */
  async create(
    session: AgentSessionRecord,
    tools: AgentTool[] = [],
    opts?: CreateAgentOptions,
  ): Promise<CreatedAgent> {
    const workspaceRoot = this.options.config.workspace.root_dir;
    const sessionTypeConfig = this.resolveSessionType(session.sessionType);
    const fallbackPrompt = this.options.config.agent.system.fallback_prompt;

    const modelKey = sessionTypeConfig?.model ?? "default";
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    const model = createModelFromConfig(modelConfig);
    // Layer-0 transparent request retry (spec LLM-FAILURE-HANDLING §4) wraps the
    // chosen stream fn so an environmental failure re-issues the exact same
    // request — buffered to the terminal event, partials discarded — before the
    // run is allowed to fail. The wrapper ALWAYS applies: it owns the Layer-0
    // origin + class tags (`[llm-request:<class>]`) the runner's typed
    // `phase:"llm"` rejection depends on (Decision C / #14).
    const recovery = this.options.config.recovery;
    const baseStreamFn = withSdkRetriesDisabled(
      (modelConfig.streaming ?? true) ? streamSimple : wrapCompleteAsStream,
    );
    // Scheduler admission (spec §5.4): group from the model
    // (`rate_limit_group`, unset = `default`), priority from the session type
    // (override > configured > built-in default). Admission wraps the BASE fn,
    // *inside* the retry, so each Layer-1 attempt re-acquires a fresh slot at
    // the same (group, priority) and no slot is held across backoff sleeps.
    const scheduler = this.options.scheduler;
    const rateLimitGroup = modelConfig.rate_limit_group ?? "default";
    // The session type's OWN class — the workload category. `opts.priority` (a
    // priority-inheritance escalation, e.g. a summarization job raised by a
    // waiting build) overrides the QUEUE RANK only, never the retry budget
    // (spec LLM-FAILURE-HANDLING §6): an escalated background job is still
    // background work and still waits out an outage.
    const basePriority =
      sessionTypeConfig?.priority ?? defaultPriorityForSessionType(session.sessionType);
    const priority = opts?.priority ?? basePriority;
    // Holder for the admission wait of the in-flight attempt (ring
    // attribution, §9.2): the agent issues one request at a time per session,
    // so a single slot per created agent is race-free.
    const admissionWait: { last?: number } = {};
    const admittedStreamFn = scheduler
      ? withSchedulerAdmission(baseStreamFn, scheduler, {
          group: rateLimitGroup,
          priority,
          key: opts?.escalationKey,
          sessionId: session.id,
          sessionType: session.sessionType,
          onAdmissionWait: (waitMs) => {
            admissionWait.last = waitMs;
          },
        })
      : baseStreamFn;
    // Per-class retry budget (spec §6): interactive-class work (live chat +
    // proactive — both time-sensitive, P3) is wall-clock-bounded; background-
    // class work (summaries, diaries — must eventually exist) is unbounded.
    const interactiveBudget = basePriority === "interactive" || basePriority === "proactive";
    const healthKey = modelHealthKey(model);
    const streamFn = withRequestRetry(
      admittedStreamFn,
      {
        maxWaitMs: interactiveBudget ? (recovery?.llm_request_max_wait_ms ?? 120_000) : undefined,
        backoffBaseMs: recovery?.llm_request_backoff_base_ms ?? 500,
        backoffMaxMs: recovery?.llm_request_backoff_max_ms ?? 15_000,
      },
      {
        logger: this.options.logger,
        sessionId: session.id,
        timelineKey: session.timelineKey,
        sessionType: session.sessionType,
        group: rateLimitGroup,
        // No double-waiting (§4.3): once the model is unhealthy or the group
        // throttled, the admission queue paces re-admission and the local
        // inter-attempt backoff collapses to ~0.
        ...(scheduler
          ? { isQueueWaitPoint: () => scheduler.isQueueWaitPoint(rateLimitGroup, healthKey) }
          : {}),
        // Request-ring attribution (spec §9.2).
        priority,
        ...(this.options.requestRing ? { ring: this.options.requestRing } : {}),
        takeAdmissionWaitMs: () => {
          const waited = admissionWait.last;
          admissionWait.last = undefined;
          return waited;
        },
        // Observability tap (spec LLM-FAILURE-HANDLING §4.2): raw attempt
        // events → per-session tentative bus → console SSE. Observe-only.
        ...(this.options.liveEvents
          ? {
              onAttemptEvent: (attempt: number, event: unknown) =>
                this.options.liveEvents!.publish(session.id, { type: "tentative_event", attempt, event }),
              onAttemptDiscarded: (attempt: number, reason: string) =>
                this.options.liveEvents!.publish(session.id, { type: "attempt_discarded", attempt, reason }),
            }
          : {}),
      },
    );

    // Load workspace files from disk at session creation time
    const workspace = await loadWorkspace(workspaceRoot, sessionTypeConfig);

    // Filter tools if the session type specifies a tool allowlist
    const filteredTools = filterTools(tools, sessionTypeConfig);

    // NOTE: System prompt is rendered identically here and in ContextBuilder.build().
    // Both are required: this one sets initialState.systemPrompt (used by pi-agent-core
    // on every API call), and the builder's version populates the system message in
    // transformContext output. They must produce identical results.
    const systemPrompt = renderSystemPrompt(workspace, fallbackPrompt);

    // Phase 0 — frozen sessions (§2b). Build the context ONCE, here at creation, and
    // freeze it. The prefix (`frozenBase`) is append-only thereafter; the final user
    // turn is popped off and returned so the caller can deliver it via
    // `agent.prompt(...)` as the first turn of the transcript. `transformContext`
    // never rebuilds — it only appends live runtime messages onto the frozen prefix.
    //
    // `frozenBase` is assigned exactly once below and then `Object.freeze`d: the
    // append-only/byte-stable invariant (spec §2b) is enforced, not merely observed.
    // `transformContext` only ever spreads it, so freezing is safe.
    let frozenBaseSeed: AgentMessage[];
    let finalTurn: AgentMessage | undefined;
    // Persistence snapshot surfaced to the caller (§3). Undefined in resume mode.
    let snapshot: ContextMessage[] | undefined;
    let snapshotTokenEstimate: number | undefined;
    let snapshotCompactTokens: number | undefined;
    let snapshotRichTokens: number | undefined;
    if (opts?.resume) {
      // Defensive copy: the resume snapshot is a persisted array owned by the caller
      // (parsed `context_snapshot_json`). Copying it keeps the live runtime prefix
      // from aliasing — and freezing — the caller's array (§6).
      frozenBaseSeed = [...opts.resume.snapshot];
    } else {
      const built = await this.buildContext({
        timelineKey: session.timelineKey,
        trigger: session.trigger.event,
        workspace,
        sessionType: sessionTypeConfig,
        fallbackPrompt,
        summarizationCutoff: opts?.summarizationCutoff,
        diaryRange: opts?.diaryRange,
        proactive: opts?.proactive,
        // The session's resolved class doubles as the wait-or-omit escalation
        // class (spec §5.5: the waiting class is the building session's own
        // class), and the drain signal cancels a waiting build cleanly (§7.2).
        priority,
        abortSignal: opts?.abortSignal,
      });
      await dumpBuiltContext(
        this.options.config.app.context_dump_dir,
        session.timelineKey,
        session.id,
        built,
        session.trigger.event.id,
      ).catch(() => undefined);
      // Single source of truth for the prefix/trigger boundary: `splitBuiltContext`
      // computes the trailing-live-turn cut once and returns BOTH the runtime prefix
      // (`frozenBase`) and the raw-`built.messages` persistence prefix (`snapshot`),
      // so the two cannot drift if the terminal-type detection ever changes (§3 / §10a).
      const split = splitBuiltContext(built);
      frozenBaseSeed = split.frozenBase;
      finalTurn = split.finalTurn;
      snapshot = split.snapshot;
      snapshotTokenEstimate = built.tokenEstimate;
      snapshotCompactTokens = built.compactTokens;
      snapshotRichTokens = built.richTokens;
    }

    // Freeze the prefix so accidental reassignment of an element or the array throws
    // in strict mode and any future write-back surfaces immediately (§2b invariant).
    const frozenBase: readonly AgentMessage[] = Object.freeze(frozenBaseSeed);

    // Runaway/cost guardrail (ARCHITECTURE.md §4, §9c): the agent loop runs as long
    // as the model emits tool calls, with no built-in iteration bound. A session
    // type may set its own `max_tool_calls` (and `max_turns`) loop-breaker — worker
    // session types (summarize/condense/diary) do, so a degenerate worker session
    // can't loop unbounded. The session-type cap takes precedence over the global
    // `agent.sessions.max_tool_calls`; chat sessions leave both unset (unbounded).
    // Once a cap is exceeded we abort the run (hard stop, so the model can't keep
    // emitting blocked calls and billing turns). Scoped per `create()` → per session
    // run. `agentRef` is a late-bound holder so the hooks can call `agent.abort()`
    // (the const isn't assigned yet when the option object is built; it is by the
    // time the hook runs).
    const maxToolCalls = sessionTypeConfig?.max_tool_calls ?? this.options.config.agent.sessions.max_tool_calls;
    const maxTurns = sessionTypeConfig?.max_turns;
    const agentRef: { agent?: Agent } = {};
    let toolCallCount = 0;
    const logger = this.options.logger;

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: filteredTools,
      },
      transformContext: async (messages) => [
        ...frozenBase,
        ...messages.filter(isLiveRuntimeMessage),
      ],
      ...(maxToolCalls !== undefined
        ? {
            beforeToolCall: async (ctx) => {
              toolCallCount += 1;
              if (toolCallCount > maxToolCalls) {
                logger?.warn("agent_tool_call_cap_reached", {
                  sessionId: session.id,
                  timelineKey: session.timelineKey,
                  toolCallCount,
                  maxToolCalls,
                  tool: ctx.toolCall?.name,
                });
                agentRef.agent?.abort();
                return { block: true, reason: `Tool-call cap (${maxToolCalls}) reached; run aborted.` };
              }
              return undefined;
            },
          }
        : {}),
      convertToLlm,
      streamFn,
      getApiKey: () => modelConfig.api_key,
      onPayload: (payload) => payload,
      steeringMode: "one-at-a-time",
      sessionId: session.timelineKey,
    });
    agentRef.agent = agent;

    // Turn-count loop-breaker (§8c): NOT a wall-clock timeout — purely a guard
    // against a degenerate loop. We count completed turns (`turn_end`) and abort the
    // run once the cap is hit, so a worker session that never finalizes still
    // settles into the normal catch → failure → retry path. Unset (chat) → no cap.
    if (maxTurns !== undefined) {
      let turnCount = 0;
      agent.subscribe((event) => {
        if (event.type !== "turn_end") return;
        turnCount += 1;
        if (turnCount >= maxTurns) {
          logger?.warn("agent_turn_cap_reached", {
            sessionId: session.id,
            timelineKey: session.timelineKey,
            turnCount,
            maxTurns,
          });
          agent.abort();
        }
      });
    }

    if (opts?.resume?.transcript?.length) {
      // Defensive copy: the agent loop mutates `agent.state.messages` in place every
      // turn. Assigning the caller's persisted transcript array by reference would
      // silently corrupt their parsed `transcript_json` (§6). Copy so live runtime
      // state never aliases a persisted array.
      agent.state.messages = [...opts.resume.transcript];
    }

    return {
      agent,
      finalTurn,
      snapshot,
      tokenEstimate: snapshotTokenEstimate,
      compactTokens: snapshotCompactTokens,
      richTokens: snapshotRichTokens,
    };
  }

  /**
   * The single `ContextBuilder.build()` call, shared by the live session path
   * ({@link create}) and the room-context preview ({@link buildPreview}). Keeping
   * one call site is what guarantees the preview is byte-faithful to what a real
   * session would build (spec §1) — the two cannot drift in their build inputs.
   * `activeSessions` is empty for the generation modes (summarization cutoff
   * and diary range — both suppress runtime state anyway; mirrors the original
   * inline logic).
   */
  private buildContext(args: {
    timelineKey: string;
    trigger: CanonicalChatEvent;
    workspace: WorkspaceContent;
    sessionType: SessionTypeConfig | undefined;
    fallbackPrompt: string | undefined;
    summarizationCutoff?: { endTimestamp: number };
    diaryRange?: { earliestTimestamp: number; latestTimestamp: number; summaryId: string };
    proactive?: boolean;
    priority?: PriorityClass;
    abortSignal?: AbortSignal;
  }): Promise<BuiltContext> {
    return this.options.contextBuilder.build({
      timelineKey: args.timelineKey,
      trigger: args.trigger,
      activeSessions: args.summarizationCutoff || args.diaryRange
        ? []
        : this.options.getActiveSessions(args.timelineKey),
      workspace: args.workspace,
      sessionType: args.sessionType,
      fallbackPrompt: args.fallbackPrompt,
      summarizationCutoff: args.summarizationCutoff,
      diaryRange: args.diaryRange,
      proactive: args.proactive,
      priority: args.priority,
      abortSignal: args.abortSignal,
    });
  }

  /**
   * Build the context a room's *next* session would see (spec §9), for the
   * console room view. Uses the **real** build path (via {@link buildContext}),
   * with the most recent timeline event as a synthetic trigger; builds NO Agent
   * and writes NO dump. The trigger-dependent final user turn (`finalTurnIndex`
   * onward) is what the endpoint flags `preview: true`.
   */
  async buildPreview(timelineKey: string): Promise<PreviewContext> {
    const storage = this.options.storage;
    if (!storage) throw new Error("buildPreview requires a storage-backed factory");
    const workspaceRoot = this.options.config.workspace.root_dir;
    const sessionTypeConfig = this.resolveSessionType("default");
    const fallbackPrompt = this.options.config.agent.system.fallback_prompt;
    const workspace = await loadWorkspace(workspaceRoot, sessionTypeConfig);

    // Synthetic trigger = most recent timeline event (spec §9). `getTimelineEvents`
    // returns ascending order, so the last element is the newest. When the timeline
    // has no events, a minimal placeholder lets the builder still render the prefix
    // tiers; the final user turn is simply sparse.
    const recent = storage.getTimelineEvents(timelineKey, 1);
    const latest = recent[recent.length - 1];
    const trigger = latest ?? syntheticPlaceholderEvent(timelineKey);

    const built = await this.buildContext({
      timelineKey,
      trigger,
      workspace,
      sessionType: sessionTypeConfig,
      fallbackPrompt,
    });

    return {
      built,
      syntheticTriggerEventId: latest ? latest.id : null,
      finalTurnIndex: previewFinalTurnIndex(built),
      cacheBoundaries: [...CACHE_BOUNDARIES],
    };
  }
}

/**
 * Throw if a worker-driven run settled into an aborted/errored state instead of a
 * clean completion.
 *
 * pi-agent-core's `runWithLifecycle` CATCHES a run failure (a cap-driven
 * `agent.abort()` or a stream error) and RESOLVES the run promise — it synthesizes
 * a final assistant message with `stopReason: "aborted"` (abort) or `"error"`
 * (stream error) and records its text in `AgentState.errorMessage`
 * (`agent.js` `handleRunFailure`). So `agent.prompt()`/`waitForIdle()` resolve
 * WITHOUT throwing, and a worker that only catches thrown errors would treat a
 * runaway (cap-aborted) or errored run as a success and commit its partial draft.
 *
 * `AgentState.errorMessage` is the documented seam: "Error message from the most
 * recent failed or aborted assistant turn, if any" (`types.d.ts`). It is cleared
 * (`undefined`) at the start of every run and only set on a failed/aborted turn,
 * so a clean normal completion — including the legitimate empty-draft "nothing to
 * record" finalize — leaves it unset and does NOT throw. Call this immediately
 * after `waitForIdle()`, inside the worker's existing `try` block, so the throw
 * flows into the established failure → retry path (§8c).
 */
export function assertRunSettledCleanly(agent: { state: { errorMessage?: string } }): void {
  const errorMessage = agent.state.errorMessage;
  if (errorMessage && errorMessage.length > 0) {
    throw new Error(`agent run did not complete cleanly: ${errorMessage}`);
  }
}

/**
 * Thrown by a worker pool when a run was aborted BY THE POOL'S OWN DRAIN (spec
 * LLM-FAILURE-HANDLING §7): the job returns to `pending` with the claim-time
 * attempts increment compensated — a drain is not a semantic failure and must
 * not consume the job's retry budget. A cap abort (runaway tool/turn loop,
 * pool still running) deliberately does NOT use this class — a degenerate run
 * is an output problem and stays on the semantic-attempts path.
 */
export class WorkerDrainAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerDrainAbortError";
  }
}

/**
 * True when the settled run's failure is an intentional ABORT (the agent's
 * last assistant turn carries `stopReason:"aborted"`, or the flattened error
 * is class-tagged `aborted` — e.g. a scheduler-stop admission rejection that
 * produced no turn). Worker pools combine this with their own `running` flag
 * to distinguish a drain abort (→ {@link WorkerDrainAbortError}, job back to
 * pending) from a cap abort (→ semantic retry path).
 */
export function wasRunAborted(agent: {
  state: { errorMessage?: string; messages?: unknown[] };
}): boolean {
  const errorMessage = agent.state.errorMessage;
  if (!errorMessage || errorMessage.length === 0) return false;
  const messages = agent.state.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
    if (candidate?.role !== "assistant") continue;
    if (candidate.stopReason === "aborted") return true;
    break;
  }
  return extractLlmRequestClass(errorMessage) === "aborted";
}

/**
 * The single terminal-turn predicate: is this message the trigger-dependent final
 * user turn — a `triggerGroup` (chat) or `satellite` (summarization cutoff)?
 *
 * This is the ONE source of "what counts as the final live turn", reused by
 * {@link splitBuiltContext} (the prefix/turn cut), {@link previewFinalTurnIndex}
 * (the room-preview `preview` flag), and the session-detail `rolloutStartIndex`
 * marker (spec §10). Keeping a single predicate means those classifications cannot
 * drift if the set of final-turn types ever changes.
 */
export function isFinalTurnMessage(message: { type?: string } | undefined | null): boolean {
  return message?.type === "triggerGroup" || message?.type === "satellite";
}

/**
 * Index of the trigger-dependent final user turn in a built context, using the
 * SAME terminal-turn test as {@link splitBuiltContext} so the preview marking
 * and the live prefix/turn split never diverge. Returns the index of the
 * trailing `triggerGroup`/`satellite` message, or `-1` if none.
 */
function previewFinalTurnIndex(built: BuiltContext): number {
  const last = built.messages[built.messages.length - 1];
  if (isFinalTurnMessage(last)) {
    return built.messages.length - 1;
  }
  return -1;
}

/**
 * Minimal synthetic trigger for a room with no timeline events yet (spec §9).
 * Just enough for `ContextBuilder.build()` to render the prefix tiers and an
 * (empty) final turn; never persisted, never sent to a model.
 */
function syntheticPlaceholderEvent(timelineKey: string): CanonicalChatEvent {
  const now = Date.now();
  return {
    id: `preview-synthetic-${now}`,
    timelineKey,
    provider: "preview",
    role: "user",
    sender: { id: "preview" },
    body: "",
    timestamp: now,
    receivedAt: now,
  };
}

/**
 * Filter tools based on session type config.
 * When no tool allowlist is specified, all tools are returned.
 */
export function filterTools(tools: AgentTool[], sessionType?: SessionTypeConfig): AgentTool[] {
  if (!sessionType?.tools) return tools;
  const allowed = new Set(sessionType.tools);
  return tools.filter((tool) => allowed.has(tool.name));
}

/**
 * Map a BuiltContext's messages into the agent's message vocabulary:
 * - `system` is dropped (it lives in `AgentState.systemPrompt`, not the array).
 * - `triggerGroup`/`satellite` are kept as-is, carrying the builder's per-message
 *   `tier`/`tokenEstimate` so the persisted transcript head renders accurate
 *   token counts in the verbatim view (spec §10a/§11).
 * - `summaryLayer` becomes a user `chatEvent`.
 * - historical `chatEvent`s keep their (assistant-or-user) role.
 */
export function mapBuiltMessages(built: BuiltContext): AgentMessage[] {
  return built.messages.flatMap((message): AgentMessage[] => {
    if (message.type === "system") return [];
    if (message.type === "triggerGroup" || message.type === "satellite") {
      return [
        {
          type: message.type,
          content: message.content,
          imageBlocks: message.imageBlocks,
          timestamp: message.timestamp,
          // Carry the builder's per-message tier + token estimate onto the head
          // turn so the persisted transcript head (the default-expanded final
          // user turn) renders the real values rather than 0/`trigger` (#9).
          tier: message.tier,
          tokenEstimate: message.tokenEstimate,
        },
      ];
    }
    if (message.type === "summaryLayer" || message.type === "diaryLayer") {
      return [
        {
          type: "chatEvent",
          role: "user",
          content: message.content,
          timestamp: message.timestamp,
        },
      ];
    }
    if (message.type === "chatEvent") {
      return [
        {
          type: "chatEvent",
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.content,
          imageBlocks: message.imageBlocks,
          timestamp: message.timestamp,
        },
      ];
    }
    return [];
  });
}

/**
 * Split a frozen BuiltContext into the append-only prefix (`frozenBase`) and the
 * final user turn (`finalTurn`) — the last message, which the builder always emits
 * as a `triggerGroup` (chat) or `satellite` (summarization cutoff). The caller
 * delivers `finalTurn` via `agent.prompt(...)` so it becomes the first turn of the
 * live transcript (frozen-context invariant §2b, ARCHITECTURE.md §8), rather than living in the prefix.
 *
 * The "did the build end with a live final turn?" boundary is computed **once** here
 * and applied to both views of the prefix, so they cannot drift (§3 / §10a):
 * - `frozenBase` — the runtime prefix (mapped into the agent message vocabulary,
 *   system dropped), spread by `transformContext` on every turn.
 * - `snapshot` — the persistence prefix: the raw `built.messages` (system + tiers,
 *   with `tier`/`tokenEstimate` metadata intact) minus the same trailing final turn,
 *   surfaced for `context_snapshot_json` and the verbatim renderer.
 *
 * Both `frozenBase` and `snapshot` are trimmed by the **same** terminal-turn test,
 * so changing the set of "final live turn" types updates both in lockstep.
 */
export function splitBuiltContext(built: BuiltContext): {
  frozenBase: AgentMessage[];
  finalTurn: AgentMessage | undefined;
  snapshot: ContextMessage[];
} {
  const mapped = mapBuiltMessages(built);
  const lastSource = built.messages[built.messages.length - 1];
  // The runtime prefix is append-only from the moment it is split (spec §2b), so it is
  // frozen here — its single point of construction — making the invariant observable
  // and enforced regardless of caller. The factory freezes again for the resume path
  // (where the prefix originates from a stored snapshot, not from this helper).
  if (isFinalTurnMessage(lastSource)) {
    return {
      frozenBase: Object.freeze(mapped.slice(0, -1)) as AgentMessage[],
      finalTurn: mapped[mapped.length - 1],
      snapshot: built.messages.slice(0, -1),
    };
  }
  return {
    frozenBase: Object.freeze(mapped) as AgentMessage[],
    finalTurn: undefined,
    snapshot: built.messages.slice(),
  };
}

/**
 * Legacy combined render: the full built context (prefix + final turn) followed by
 * filtered live messages. Retained for tests and any non-frozen call site; the
 * factory uses {@link splitBuiltContext} + an append-only `transformContext` instead.
 */
export function buildAgentContextMessages(
  built: BuiltContext,
  liveMessages: AgentMessage[] = [],
): AgentMessage[] {
  return [...mapBuiltMessages(built), ...liveMessages.filter(isLiveRuntimeMessage)];
}

function isLiveRuntimeMessage(message: AgentMessage): boolean {
  const typed = message as any;
  if (!typed || typeof typed !== "object") return false;
  if (typed.type === "interjection") return true;
  // The trigger/satellite final turn is now delivered live via agent.prompt() as the
  // first transcript turn (§2b), so it must be KEPT. Historical chat events stay in the
  // frozen prefix and are dropped if they ever appear in the live array.
  if (typed.type === "triggerGroup" || typed.type === "satellite") return true;
  if (typed.type === "chatEvent") return false;
  if (typed.role === "toolResult") return true;
  if (typed.role === "user") return true;
  if (typed.role === "assistant") {
    return Array.isArray(typed.content) && typed.content.some((block: any) => block?.type === "toolCall");
  }
  return false;
}

export function createModel(config: AppConfig): Model<"anthropic-messages"> {
  return createModelFromConfig(config.models.default);
}

export function createModelFromConfig(model: ModelConfig): Model<"anthropic-messages"> {
  return {
    id: model.id,
    name: model.id,
    api: "anthropic-messages",
    provider: model.provider,
    baseUrl: model.endpoint,
    reasoning: model.reasoning ?? true,
    input: model.multimodal ? ["text", "image"] : ["text"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cache_read ?? 0,
      cacheWrite: model.cost?.cache_write ?? 0,
    },
    contextWindow: model.context_window ?? 128_000,
    maxTokens: model.max_tokens,
    compat: {
      supportsCacheControlOnTools: model.compat?.supports_cache_control_on_tools ?? false,
      supportsLongCacheRetention: model.compat?.supports_long_cache_retention ?? false,
      supportsEagerToolInputStreaming: model.compat?.supports_eager_tool_input_streaming,
      sendSessionAffinityHeaders: model.compat?.send_session_affinity_headers,
    },
  };
}
