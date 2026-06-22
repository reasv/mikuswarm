import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple, completeSimple, createAssistantMessageEventStream, type Api, type Model, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AppConfig } from "../config/index.js";
import { dumpBuiltContext, CACHE_BOUNDARIES, renderToolBlock, type BuiltContext, type ContextBuilder, type ToolBlockSummary, type ToolDefinitionLike } from "../context/index.js";
import type { ContextMessage } from "../context/builder.js";
import type { AgentSessionRecord } from "./session-manager.js";
import { convertToLlm } from "./convert.js";
import { extractLlmRequestClass, withRequestRetry } from "./request-retry.js";
import {
  defaultPriorityForSessionType,
  modelHealthKey,
  type LlmScheduler,
  type PriorityClass,
} from "./scheduler.js";
import { buildModelFallback, resolveModelChain } from "./model-fallback.js";
import { loadWorkspace, renderSystemPrompt } from "../workspace/index.js";
import type { WorkspaceContent, SessionTypeConfig } from "../workspace/types.js";
import type { Storage, Summary } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { SessionLiveEventBus } from "../observability/live-events.js";
import type { LlmRequestRing } from "./request-ring.js";
import { SessionUsageTracker, type SessionUsageTotals } from "./usage.js";
import type { AttachmentMeta, CanonicalChatEvent } from "../types.js";
import type { BudgetHooks } from "../budget/index.js";

/**
 * Compose a session's operative context-token ceiling (spec
 * CONTEXT-LIMIT-UNIFICATION §2.2): `min(context_window, override)`, considering
 * the per-session-type override only when set. `context_window` is the model
 * ceiling and is always present (§2.5 makes it mandatory for any model a session
 * type resolves to), so this ALWAYS returns a number — enforcement is never
 * unwired. min() because the override can only TIGHTEN the model ceiling, never
 * raise it; cross-validation enforces `override <= context_window`, so min() and
 * "the override substitutes the window" are equivalent — min() is the defensive
 * form.
 */
export function composeSessionContextCeiling(
  contextWindow: number,
  override?: number,
): number {
  return typeof override === "number" ? Math.min(contextWindow, override) : contextWindow;
}

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
   * Resolve a session type's tool set (structural wire subset) for a given
   * timeline — injected by app wiring (it owns `buildSessionTools`). Used ONLY by
   * the read-only inspector surfaces: the room-context preview ({@link buildPreview})
   * folds the result into its estimate + tool block, and the session-detail view
   * recomputes the block for display ({@link toolBlockFor}). The live session path
   * never uses it — `create()` already has the real per-session tools. Absent
   * (tests/headless) → no tool block (estimate is the message sum, as before).
   */
  buildToolDefs?: (timelineKey: string, sessionType: string) => ToolDefinitionLike[] | undefined;
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
  /**
   * Period cost limits (spec USAGE-COST-LIMITS §6). A holder filled during app
   * wiring: `engine` powers the per-request pre-flight, `record` emits the
   * per-request agent-loop ledger row. Absent = no period budgeting (tests).
   */
  budget?: BudgetHooks;
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
  /** When set, build context for a level-1 summarization session cut at this timestamp. */
  summarizationCutoff?: { endTimestamp: number };
  /**
   * When set, build context for a condensation (level 2+) session over an
   * explicit, pre-resolved child-summary list (spec
   * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1, Fix B — input-addressed
   * generation): the builder renders exactly these summaries, no coverage
   * selection / timeline query / raw events, and surfaces the rendered IDs as
   * {@link CreatedAgent.renderedInputIds} for the worker's declared-vs-rendered
   * assertion. Mutually exclusive with `summarizationCutoff` and `diaryRange`;
   * threaded straight into {@link ContextBuilder.build}.
   */
  condenseInputs?: { summaries: Summary[] };
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
   * Reply-resume continuation (spec RESUMABLE-SESSIONS §9/§11). Set ALONGSIDE
   * `resume` when continuing a COMPLETED session because a user replied to it:
   * instead of `continue()`-ing the seeded transcript (the failure-recovery
   * shape, which re-issues the last un-answered request), the factory builds a
   * FRESH appended user turn — gap backfill + a fresh satellite + the trigger
   * group — via {@link ContextBuilder.buildResumeTurn} and returns it as
   * `finalTurn`, so the runner `prompt()`s it onto the end of the rollout. Absent
   * (failure-recovery resume) → no `finalTurn`, runner continue-mode. The frozen
   * prefix is still the original `resume.snapshot`, reused verbatim (never rebuilt).
   */
  resumeContinuation?: {
    /** Satellite tail toggle (config `agent.sessions.resume.satellite.tail`). */
    tail: boolean;
    /** One-line browser note for runtime_state (§11). */
    browserNote?: string;
    /** Gap backfill budget (§9); omitted/inactive → no gap. */
    gap?: { maxMessages: number; maxTokens: number; lowerBoundTimestamp: number };
    /**
     * One-line preamble prepended to the rendered trigger (spec FOLLOWUP-FOLDING
     * §10) — set only for a settled→resume follow-up fold, so the resumed rollout
     * knows the appended turn arrived as a quick same-sender follow-up.
     */
    triggerPreamble?: string;
  };
  /**
   * Usage-tracker seed for resume-in-place (spec TOKEN-USAGE-TRACKING §4.3): the
   * persisted session totals, so a resumed session continues accumulating from
   * where it left off instead of resetting. Built from the durable row's usage
   * columns by the resume caller. Absent (fresh launch / fresh-mode resume that
   * never committed a request) = start from zero.
   */
  usageSeed?: SessionUsageTotals;
  /**
   * Pre-constructed usage tracker (spec SESSION-COST-LIMITS §5). When provided,
   * the factory uses it verbatim and ignores {@link usageSeed} — the caller
   * (app.ts) builds the tracker up front (seeded) so the same instance also
   * receives the tool-cost feed wired into `recordToolUsage`. Absent (worker
   * pools / tests, no tool-cost lane) = the factory constructs one from the seed.
   */
  usage?: SessionUsageTracker;
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
  /**
   * Per-session-run actuals accumulator (spec TOKEN-USAGE-TRACKING §3.3/§4.1):
   * fed at the Layer-0 commit point, read by `attachSessionCapture` to persist
   * session totals. One instance per created agent, owned here.
   */
  usage: SessionUsageTracker;
  /**
   * Input-addressed generation builds only (spec
   * SUMMARIZATION-JOB-INPUT-INTEGRITY §3.1): the IDs the builder actually
   * rendered as the inputs to reduce — child-summary IDs for a `condenseInputs`
   * build, raw-event IDs for a `summarizationCutoff` build. The summarization
   * worker asserts these equal the job's declared input set before kicking the
   * agent. Undefined for resume / live / proactive / diary builds.
   */
  renderedInputIds?: string[];
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

  /** Resolve the upstream model id used by a session type (for summary record provenance). */
  resolveModelId(sessionType: string): string {
    const cfg = this.resolveSessionType(sessionType);
    const modelKey = cfg?.model ?? "default";
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    return modelConfig.id;
  }

  /**
   * Resolve the LOGICAL model id (config block name) a session type's agent-loop
   * spend is scoped under (spec MODEL-FALLBACK §2.2) — the chain head's name, what
   * a `[[limits]].models` selector matches and what the ledger stamps. Distinct
   * from {@link resolveModelId} (the upstream wire id) when block name != wire id.
   */
  resolveLogicalModelId(sessionType: string): string {
    return this.resolveSessionType(sessionType)?.model ?? "default";
  }

  /**
   * Resolve a session type's effective fallback chain as LOGICAL ids (config block
   * names), head first (spec MODEL-FALLBACK §6.1). The launch-admission gate gates
   * on the WHOLE chain — admit when ANY member is in-budget — rather than the bare
   * head, so a model-scoped cap on the primary doesn't wrongly refuse a session for
   * which an in-budget fallback exists. Mirrors `create`'s `resolveModelChain` call.
   */
  resolveModelChainLogicalIds(sessionType: string): string[] {
    const modelKey = this.resolveSessionType(sessionType)?.model ?? "default";
    return resolveModelChain(modelKey, this.options.config.models).map((m) => m.logicalId);
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
    // Effective fallback chain (spec MODEL-FALLBACK §2.1/§9): the head plus the
    // logical ids named in its `fallback`. A request is served by the first
    // chain member that is up — resolved per Layer-0 attempt, transparently.
    const chain = resolveModelChain(modelKey, this.options.config.models);
    // Per-session-run USD cost ceiling (spec SESSION-COST-LIMITS §3), resolved
    // once and fed to the hard-cap pre-flight below. `undefined` = unlimited.
    const costCeiling = this.resolveSessionCostCeiling(session.sessionType);
    // Triggering user for the unified usage ledger (spec USAGE-COST-LIMITS §3):
    // the explicit trigger origin, else the inbound event's sender, else null
    // (background/proactive). Resolved once for every per-request ledger row.
    const triggerSenderId =
      session.trigger.trigger?.triggeredBy?.id ?? session.trigger.event.sender?.id ?? null;
    // Layer-0 transparent request retry (spec LLM-FAILURE-HANDLING §4) wraps the
    // chosen stream fn so an environmental failure re-issues the exact same
    // request — buffered to the terminal event, partials discarded — before the
    // run is allowed to fail. The wrapper ALWAYS applies: it owns the Layer-0
    // origin + class tags (`[llm-request:<class>]`) the runner's typed
    // `phase:"llm"` rejection depends on (Decision C / #14).
    const recovery = this.options.config.recovery;
    // Scheduler admission (spec §5.4): group from the model
    // (`rate_limit_group`, unset = `default`), priority from the session type
    // (override > configured > built-in default).
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
    // Per-attempt resolved member (spec MODEL-FALLBACK §6.1): the logical id the
    // composite chose for the in-flight attempt, so the ledger row is attributed
    // to the member actually billed even when the head fell to a fallback.
    const resolvedMember: { logicalId: string } = { logicalId: modelKey };
    const budgetEngine = this.options.budget?.engine;
    // Capability pre-filter (spec MODEL-FALLBACK §3 #1): when the session's RAW
    // inputs carry image content, every viable member must be `multimodal` so a
    // fall-over never ships image blocks to a text-only fallback. Derived from the
    // raw inputs (trigger attachments / resume snapshot imageBlocks) because this
    // runs BEFORE buildContext — a SAFE over-approximation (any raw image ⇒
    // require multimodal for the whole session). The head is never dropped, so the
    // enforcement ceiling is still resolved ONCE over the surviving chain; it can
    // only be EQUAL OR LARGER than the full-chain `resolveSessionContextCeiling`
    // (which has no image info), so both stay ≤ every serving member's window — the
    // "ceiling resolved once" invariant holds (see that method's comment below).
    const requiresMultimodal = rawInputsRequireMultimodal(session, opts);
    // Transparent composite stream fn (spec MODEL-FALLBACK §3): capability
    // pre-filter + min-over-chain ceiling fixed once at build, member chosen per
    // attempt inside the composed fn. Admission composes per-candidate INSIDE
    // this and outside it sits Layer-0 retry — each attempt re-resolves + re-
    // acquires a fresh slot at the same (group, priority). A single-member chain
    // degrades to the bare admitted stream (no health reads, no resolution log).
    const fallback = buildModelFallback(chain, {
      consumer: "agent",
      makeBase: (cfg) =>
        withSdkRetriesDisabled((cfg.streaming ?? true) ? streamSimple : wrapCompleteAsStream),
      makeModel: (cfg, cw) => createModelFromConfig(cfg, cw),
      capability: requiresMultimodal ? (cfg) => cfg.multimodal === true : undefined,
      contextOverride: sessionTypeConfig?.max_context_tokens,
      scheduler,
      admission: scheduler
        ? {
            priority,
            key: opts?.escalationKey,
            sessionId: session.id,
            sessionType: session.sessionType,
            onAdmissionWait: (waitMs) => {
              admissionWait.last = waitMs;
            },
          }
        : undefined,
      isModelAvailable: budgetEngine ? (id) => budgetEngine.isModelAvailable(id) : undefined,
      logger: this.options.logger,
      sessionId: session.id,
      onResolve: (id) => {
        resolvedMember.logicalId = id;
      },
    });
    // Operative per-session context ceiling (spec CONTEXT-LIMIT-UNIFICATION §2.4
    // + MODEL-FALLBACK §3 #2): the MINIMUM `context_window` across the surviving
    // chain (min'd with the session-type override), valid for whichever member
    // serves a given attempt — so the "ceiling resolved once" invariant holds.
    // Fed to enforcement (below), the head model descriptor, and the text-editor
    // read budget (app.ts buildSessionTools, via the chain-aware resolver).
    const contextCeiling = fallback.operativeContextWindow;
    // Representative (head) descriptor — initialState.model, the isQueueWaitPoint
    // key, and the ledger-fallback model id. The composite substitutes the chosen
    // member's descriptor + key per attempt.
    const model = createModelFromConfig(modelConfig, contextCeiling);
    const admittedStreamFn = fallback.streamFn;
    // Per-class retry budget (spec §6): interactive-class work (live chat +
    // proactive — both time-sensitive, P3) is wall-clock-bounded; background-
    // class work (summaries, diaries — must eventually exist) is unbounded.
    const interactiveBudget = basePriority === "interactive" || basePriority === "proactive";
    const healthKey = modelHealthKey(model);
    // Per-model override of the interactive wall-clock budget (spec §6): a model
    // slow to FIRST token can be granted a larger pre-first-token budget on its
    // model config entry; unset falls back to the global recovery value. The
    // budget only bounds waiting + a zero-token attempt, never a streaming one.
    const interactiveMaxWaitMs =
      modelConfig.llm_request_max_wait_ms ?? recovery?.llm_request_max_wait_ms ?? 120_000;
    // Per-session-run usage accumulator (spec TOKEN-USAGE-TRACKING §3.3/§4.1).
    // Seeded from persisted totals on resume so consumption continues rather
    // than resets (§4.3). Fed at the Layer-0 commit point via onRequestCommitted.
    // A caller that must share the tracker with the tool-cost feed (app.ts, spec
    // SESSION-COST-LIMITS §5) constructs it up front and passes it via `opts.usage`;
    // otherwise the factory constructs one from the seed (worker pools / tests,
    // which have no tool-cost lane).
    const usage = opts?.usage ?? new SessionUsageTracker(opts?.usageSeed);
    const streamFn = withRequestRetry(
      admittedStreamFn,
      {
        maxWaitMs: interactiveBudget ? interactiveMaxWaitMs : undefined,
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
        // Per-request usage capture (spec TOKEN-USAGE-TRACKING §3.1): the
        // committed `done` message's authoritative usage feeds the tracker AND
        // (spec USAGE-COST-LIMITS §3.1) emits one per-request agent-loop row to
        // the unified `usage_events` ledger + increments the BudgetEngine. The
        // ledger write is additive — the §8b `agent_sessions.usage_*` aggregate
        // is still maintained by the tracker's persistence subscriber.
        onRequestCommitted: (message: AssistantMessage) => {
          usage.record(message.usage);
          const budget = this.options.budget;
          if (budget?.record) {
            const u = message.usage;
            // Exact attribution under fallback (spec MODEL-FALLBACK §2.2/§6.1):
            // `model_id` is the UPSTREAM wire id actually billed (the committed
            // message's `model`/`provider`), `logical_model_id` is the chain
            // member chosen for this attempt — so a request that fell to `Y` is
            // billed and budget-scoped to `Y`, not the head.
            budget.record({
              class: "agent_loop",
              agentSessionId: session.id,
              sessionType: session.sessionType,
              timelineKey: session.timelineKey,
              triggerSenderId,
              modelId: message.model ?? model.id,
              logicalModelId: resolvedMember.logicalId,
              provider: message.provider ?? model.provider ?? null,
              inputTokens: u.input ?? null,
              outputTokens: u.output ?? null,
              cacheReadTokens: u.cacheRead ?? null,
              cacheWriteTokens: u.cacheWrite ?? null,
              costUsd: u.cost?.total ?? 0,
            });
          }
        },
        // Pre-flight context-budget enforcement (spec CONTEXT-LIMIT-UNIFICATION
        // §2.3). The operative ceiling is never null (context_window is always
        // present), so enforcement is ALWAYS wired — interactive sessions now
        // gain the model's `context_window` ceiling where they previously had
        // none. Compares the LAST committed request's actual context size against
        // the ceiling; the first request is never blocked (no actuals yet — the
        // provider is authority on an oversized seed). D3 from TOKEN-USAGE-TRACKING
        // is preserved verbatim.
        checkContextBudget: () => {
          const observed = usage.snapshot().contextTokens;
          if (observed === null || observed < contextCeiling) return undefined;
          this.options.logger?.warn("session_context_limit_exceeded", {
            sessionId: session.id,
            timelineKey: session.timelineKey,
            sessionType: session.sessionType,
            model: model.id,
            observed,
            limit: contextCeiling,
          });
          return (
            `context token limit exceeded: observed context ${observed} tokens >= ` +
            `limit ${contextCeiling} (model ${model.id}, session type ${session.sessionType})`
          );
        },
        // Per-request hard-cap pre-flight for the per-session cost ceiling (spec
        // SESSION-COST-LIMITS §2.2). Same shape as checkContextBudget: compares the
        // combined (agent-loop + tool) actual spend against the operative ceiling;
        // a violation synthesizes a `content`-class terminal error WITHOUT
        // consuming retry budget. Inert when no ceiling resolves (unlimited). The
        // first request is never blocked (combined cost is 0 before any commit).
        checkCostBudget: () => {
          // §8d per-run ceiling (unchanged). Evaluated first; either it or the §6
          // period rules below can synthesize the same `content`-class terminal.
          if (costCeiling !== undefined) {
            const observed = usage.combinedCost();
            if (observed >= costCeiling) {
              this.options.logger?.warn("session_cost_limit_exceeded", {
                sessionId: session.id,
                timelineKey: session.timelineKey,
                sessionType: session.sessionType,
                model: model.id,
                observedCostUsd: observed,
                limitUsd: costCeiling,
              });
              return (
                `session cost limit exceeded: observed combined cost $${observed.toFixed(4)} >= ` +
                `limit $${costCeiling.toFixed(4)} (session type ${session.sessionType})`
              );
            }
          }
          // §6 period limits (spec USAGE-COST-LIMITS §6.3 per-request pre-flight):
          // a covering period rule over budget blocks the next request the same
          // way — a `content`-class terminal that burns no retry budget. The
          // zero-cost short-circuit (§2.2) is inside `check`.
          const engine = this.options.budget?.engine;
          if (engine) {
            const descriptor = {
              class: "agent_loop" as const,
              sessionType: session.sessionType,
              modelId: model.id,
              provider: model.provider ?? undefined,
            };
            const result = engine.check(descriptor);
            if (!result.allowed) {
              engine.logBlocked("request_preflight", result.blockingRules, descriptor, {
                sessionId: session.id,
                timelineKey: session.timelineKey,
              });
              const resetsAt = result.primary?.resetsAt;
              const when = resetsAt ? new Date(resetsAt).toISOString() : "unknown";
              return (
                `period cost limit exceeded (${result.primary?.name ?? "unknown"}); ` +
                `resets at ${when} (session type ${session.sessionType})`
              );
            }
          }
          return undefined;
        },
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
    // Input-addressed integrity surface (spec SUMMARIZATION-JOB-INPUT-INTEGRITY
    // §3.1): the builder's rendered input IDs, passed back to the worker for the
    // declared-vs-rendered assertion. Undefined in resume mode (no fresh build).
    let renderedInputIds: string[] | undefined;
    if (opts?.resume) {
      // Defensive copy: the resume snapshot is a persisted array owned by the caller
      // (parsed `context_snapshot_json`). Copying it keeps the live runtime prefix
      // from aliasing — and freezing — the caller's array (§6).
      frozenBaseSeed = [...opts.resume.snapshot];
      // Reply-resume of a COMPLETED session (spec RESUMABLE-SESSIONS §9/§11): build
      // the fresh appended turn (gap + fresh satellite + trigger group) and return
      // it as the kickoff. The frozen prefix above is the ORIGINAL snapshot, reused
      // verbatim — never rebuilt (the freeze invariant, §2). Absent → failure-
      // recovery continue-mode (no kickoff; runner re-issues the seeded tail).
      if (opts.resumeContinuation) {
        finalTurn = await this.options.contextBuilder.buildResumeTurn({
          timelineKey: session.timelineKey,
          trigger: session.trigger.event,
          activeSessions: this.options.getActiveSessions(session.timelineKey),
          workspace,
          sessionType: sessionTypeConfig,
          selfSessionId: session.id,
          tail: opts.resumeContinuation.tail,
          browserNote: opts.resumeContinuation.browserNote,
          gap: opts.resumeContinuation.gap,
          triggerPreamble: opts.resumeContinuation.triggerPreamble,
        });
      }
    } else {
      const built = await this.buildContext({
        timelineKey: session.timelineKey,
        trigger: session.trigger.event,
        workspace,
        sessionType: sessionTypeConfig,
        fallbackPrompt,
        // The session's real, post-allowlist tool set — so the frozen estimate
        // accounts for the tool-definition block the provider charges for (the
        // dominant estimate-vs-actual gap). `filteredTools` (AgentTool[])
        // structurally satisfies the wire subset.
        tools: filteredTools,
        // The building session's id, for claim markers + the coordination gate
        // (spec DUPLICATE-REPLY-MITIGATION §4). `buildContext` drops it for the
        // generation modes (cutoff/condense/diary), which have no live answering.
        selfSessionId: session.id,
        summarizationCutoff: opts?.summarizationCutoff,
        condenseInputs: opts?.condenseInputs,
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
      renderedInputIds = built.renderedInputIds;
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
        // Extended thinking (config `thinking_level`, default off): flows per
        // request as pi-ai `options.reasoning` through the whole streamFn chain
        // (retry → admission → streamSimple). The model descriptor's
        // `reasoning` flag above only declares capability; this is what
        // actually requests thinking.
        thinkingLevel: modelConfig.thinking_level ?? "off",
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
      usage,
      renderedInputIds,
    };
  }

  /**
   * Resolve a session's operative context-token ceiling from CURRENT config
   * (spec CONTEXT-LIMIT-UNIFICATION §2.4; D7 from TOKEN-USAGE-TRACKING preserved):
   * `min(context_window, session_type.max_context_tokens)`. The limit is operator
   * config and is NOT persisted per session, so the console shows today's config
   * for a given session type. The single resolver feeding enforcement, the model
   * descriptor, and the text-editor read budget (U3) — always returns a number
   * (context_window is mandatory for session-resolved models, §2.5). Throws (a
   * defensive backstop, never reached in normal operation since app-wiring
   * validation requires the window) if the resolved model has no `context_window`.
   */
  resolveSessionContextCeiling(sessionType: string): number {
    const cfg = this.resolveSessionType(sessionType);
    const modelKey = cfg?.model ?? "default";
    const modelConfig = this.options.config.models[modelKey];
    const contextWindow = modelConfig?.context_window;
    if (contextWindow === undefined) {
      throw new Error(
        `model "${modelKey}" (session type "${sessionType}") has no context_window; ` +
          `it is required to resolve the session context ceiling`,
      );
    }
    // Min-over-chain ceiling (spec MODEL-FALLBACK §3 #2): the operative ceiling
    // must be valid for WHICHEVER fallback member serves an attempt, so it is the
    // minimum `context_window` across the chain. This is the FULL-chain min — the
    // conservative value used by the text-editor read budget and the console,
    // which have no per-session image-presence info. The create-path enforcement
    // ceiling (`buildModelFallback`'s `operativeContextWindow`) is the min over the
    // capability-SURVIVING chain: for an image-bearing session a text-only member
    // is dropped from selection, so that ceiling can only be EQUAL OR LARGER than
    // this one (never smaller). Both are resolved once and both stay ≤ the
    // `context_window` of every member that can actually serve, so neither can
    // overflow a serving model — the "ceiling resolved once" invariant holds.
    const chain = resolveModelChain(modelKey, this.options.config.models);
    let minWindow = contextWindow;
    for (const entry of chain) {
      const w = entry.config.context_window;
      if (typeof w === "number") minWindow = Math.min(minWindow, w);
    }
    return composeSessionContextCeiling(minWindow, cfg?.max_context_tokens);
  }

  /**
   * Resolve a session's operative USD cost ceiling from CURRENT config (spec
   * SESSION-COST-LIMITS §3): the session type's `max_session_cost_usd` override
   * when set, else the global `agent.max_session_cost_usd` default. A resolved
   * value of `0` (at either level) means "no cap" — so a session type can set
   * `0` to opt out even when a global default exists. Returns `undefined` when
   * unlimited. Like the context ceiling, this is operator config, NOT persisted
   * per session, so the console reflects today's config. Fed to the hard-cap
   * pre-flight and surfaced as the console's spend denominator.
   */
  resolveSessionCostCeiling(sessionType: string): number | undefined {
    const cfg = this.resolveSessionType(sessionType);
    const resolved =
      cfg?.max_session_cost_usd !== undefined
        ? cfg.max_session_cost_usd
        : this.options.config.agent.max_session_cost_usd;
    return resolved !== undefined && resolved > 0 ? resolved : undefined;
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
    selfSessionId?: string;
    /** The session's resolved tool set (wire subset), for the estimate + tool block. */
    tools?: ToolDefinitionLike[];
    summarizationCutoff?: { endTimestamp: number };
    condenseInputs?: { summaries: Summary[] };
    diaryRange?: { earliestTimestamp: number; latestTimestamp: number; summaryId: string };
    proactive?: boolean;
    priority?: PriorityClass;
    abortSignal?: AbortSignal;
  }): Promise<BuiltContext> {
    const generation = Boolean(args.summarizationCutoff || args.condenseInputs || args.diaryRange);
    return this.options.contextBuilder.build({
      timelineKey: args.timelineKey,
      trigger: args.trigger,
      activeSessions: generation ? [] : this.options.getActiveSessions(args.timelineKey),
      workspace: args.workspace,
      sessionType: args.sessionType,
      fallbackPrompt: args.fallbackPrompt,
      tools: args.tools,
      // Generation builds have no live answering → no claim markers / coordination.
      selfSessionId: generation ? undefined : args.selfSessionId,
      summarizationCutoff: args.summarizationCutoff,
      condenseInputs: args.condenseInputs,
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
      // The default session type's tool set, so the preview's estimate + tool
      // block match what the next real session would send. Absent hook (tests) →
      // no tool block, identical to the prior preview behaviour.
      tools: this.options.buildToolDefs?.(timelineKey, "default"),
    });

    return {
      built,
      syntheticTriggerEventId: latest ? latest.id : null,
      finalTurnIndex: previewFinalTurnIndex(built),
      cacheBoundaries: [...CACHE_BOUNDARIES],
    };
  }

  /**
   * Recompute the tool-definition block for a given timeline + session type, for
   * the session-detail inspector (the persisted snapshot stores only the frozen
   * estimate number, not the breakdown). Tool definitions are config-static within
   * a process run, so this live recompute matches the block that session actually
   * sent. Returns `undefined` when no tool-resolver is wired (tests/headless).
   */
  toolBlockFor(timelineKey: string, sessionType: string): ToolBlockSummary | undefined {
    const tools = this.options.buildToolDefs?.(timelineKey, sessionType);
    return tools && tools.length > 0 ? renderToolBlock(tools) : undefined;
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
 * Will this session's raw inputs send image content to the model? (spec
 * MODEL-FALLBACK §3 #1, the agent-path capability pre-filter.)
 *
 * `buildModelFallback` runs at create time BEFORE `buildContext`, so the frozen
 * post-compaction content is not yet available — image presence is read from the
 * RAW inputs the session is built from:
 *
 * - Fresh launch: the trigger event's own image attachments and any reply-quoted
 *   image attachments. (Grouped-event / trigger-group-asset images are not
 *   chased here — a store walk the builder owns — but the common image cases ride
 *   on the trigger or its reply.)
 * - Resume: any message in the persisted prefix snapshot that carries
 *   `imageBlocks`, plus the trigger-event attachments of the fresh appended turn.
 *
 * This is a deliberate, SAFE over-approximation (#6): "any image in the raw
 * inputs ⇒ require multimodal for the WHOLE session", so a session that carries a
 * picture is never allowed to fall over to a text-only fallback member (which
 * would receive image blocks it cannot serve). Generation modes (summarize /
 * condense / diary) and proactive sessions never send image pixels, so they
 * impose no requirement and keep the full fallback chain.
 */
export function rawInputsRequireMultimodal(
  session: AgentSessionRecord,
  opts?: CreateAgentOptions,
): boolean {
  // Generation + proactive sessions never carry image pixels (builder forces
  // `imageBlocks = []` for both), so they impose no multimodal requirement.
  if (opts?.summarizationCutoff || opts?.condenseInputs || opts?.diaryRange || opts?.proactive) {
    return false;
  }
  if (opts?.resume) {
    if (opts.resume.snapshot.some(messageHasImageBlock)) return true;
    if (opts.resume.transcript?.some(messageHasImageBlock)) return true;
    // Reply-resume appends a fresh trigger turn; failure-recovery resume re-issues
    // the seeded tail. Either way the trigger event's own images count.
  }
  return triggerEventCarriesImage(session.trigger.event);
}

/** Does this agent message carry at least one image content block? */
function messageHasImageBlock(message: AgentMessage): boolean {
  const blocks = (message as { imageBlocks?: unknown }).imageBlocks;
  return Array.isArray(blocks) && blocks.length > 0;
}

/**
 * Does this trigger event (or its quoted reply) carry an image attachment? Mirrors
 * the builder's own `mediaType === "image" && localPath` predicate
 * (`selectImageAttachments`), kept cheap (no store walk) for the create-time
 * over-approximation.
 */
function triggerEventCarriesImage(event: CanonicalChatEvent): boolean {
  const isImage = (a: AttachmentMeta): boolean => a.mediaType === "image" && Boolean(a.localPath);
  if ((event.attachments ?? []).some(isImage)) return true;
  if ((event.replyTo?.attachments ?? []).some(isImage)) return true;
  return false;
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

export function createModel(config: AppConfig): Model<Api> {
  return createModelFromConfig(config.models.default);
}

/**
 * Build the pi-ai `Model` descriptor from a model config entry. `contextWindow`
 * is fed the resolved OPERATIVE per-session ceiling when supplied (spec
 * CONTEXT-LIMIT-UNIFICATION §2.4 consumer 2 / U3) — so any future window-keyed
 * mechanism (compaction, SDK overflow math) triggers against the ceiling the
 * session is actually judged against, not the raw model window. When omitted
 * (the `createModel` convenience path, no session context), it falls back to the
 * model's own `context_window`, which is mandatory for any model a session type
 * resolves to (§2.5) — hence the throw rather than a silent literal default.
 */
export function createModelFromConfig(model: ModelConfig, contextWindow?: number): Model<Api> {
  const resolvedContextWindow = contextWindow ?? model.context_window;
  if (resolvedContextWindow === undefined) {
    throw new Error(`model "${model.id}" has no context_window`);
  }
  return {
    id: model.id,
    name: model.id,
    // Wire API of the endpoint (config `api`, default anthropic-messages).
    // pi-ai's streamSimple dispatches on this via its api registry; the
    // provider string further selects the request dialect within the OAI
    // implementation (compat auto-detection, e.g. provider = "together").
    api: model.api ?? "anthropic-messages",
    provider: model.provider,
    baseUrl: model.endpoint,
    reasoning: model.reasoning ?? true,
    // Per-level remap of the requested thinking level → the provider's wire
    // effort value (e.g. GLM-5.2 on Together: xhigh → "max"). Undefined for
    // models that use pi-ai's native effort vocabulary. See ModelSchema.
    thinkingLevelMap: model.thinking_level_map,
    input: model.multimodal ? ["text", "image"] : ["text"],
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cache_read ?? 0,
      cacheWrite: model.cost?.cache_write ?? 0,
    },
    contextWindow: resolvedContextWindow,
    maxTokens: model.max_tokens,
    compat: {
      supportsCacheControlOnTools: model.compat?.supports_cache_control_on_tools ?? false,
      supportsLongCacheRetention: model.compat?.supports_long_cache_retention ?? false,
      supportsEagerToolInputStreaming: model.compat?.supports_eager_tool_input_streaming,
      sendSessionAffinityHeaders: model.compat?.send_session_affinity_headers,
      // Override pi-ai's auto-detection (false for provider="together") so the
      // reasoning-effort level is forwarded as `reasoning_effort`. Undefined =
      // leave auto-detection in place.
      supportsReasoningEffort: model.compat?.supports_reasoning_effort,
    },
  };
}
