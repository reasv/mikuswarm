import type { MemoryPlanTicket } from "../retrieval/auto/types.js";
import { eligibleSkillIndex } from "../workspace/skills.js";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, PrepareNextTurnContext, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type Model, type AssistantMessage, type OpenRouterRouting } from "@earendil-works/pi-ai";
import { streamSimple, completeSimple } from "@earendil-works/pi-ai/compat";
import type { AppConfig } from "../config/index.js";
import type { AgentModelOverrides } from "./agent-model-overrides.js";
import { dumpBuiltContext, CACHE_BOUNDARIES, estimateTokens, renderToolBlock, type BuiltContext, type ContextBuilder, type ToolBlockSummary, type ToolDefinitionLike } from "../context/index.js";
import { makeBreakpointInjector } from "./cache-breakpoints.js";
import { makePrefillInjector, makeDropReasoningInjector, wrapToolWithAnalysisStripping } from "./openai-prefill.js";
import type { ContextMessage } from "../context/builder.js";
import type { SummaryCoveragePin } from "../context/builder.js";
import type { AgentSessionRecord } from "./session-manager.js";
import { convertToLlm } from "./convert.js";
import { withStaleThinkingDropped } from "./stale-thinking.js";
import { makeDeferLoadingInjector, withDeclaredDeferredTools, type DeclaredToolSet } from "./declared-tools.js";
import { executeSyntheticCalls, type SyntheticCallSpec } from "./synthetic-calls.js";
import { wrapToolsWithRecordTurnGate, type RecordTurnGate } from "./record-turn.js";
import { withSeenStamp } from "../checks/duplicate.js";
import { wrapToolsWithOutputGate, type OutputGate } from "../checks/gate.js";
import { createSessionOutputGate, withGateTap, type OutputGateServices } from "../checks/session.js";
import { estimateLiveSliceTokens } from "./live-token-estimate.js";
import { extractLlmRequestClass, withRequestRetry } from "./request-retry.js";
import {
  defaultPriorityForSessionType,
  modelHealthKey,
  type LlmScheduler,
  type PriorityClass,
} from "./scheduler.js";
import {
  buildModelFallback,
  chooseChainMember,
  resolveModelChain,
  type BuiltModelFallback,
} from "./model-fallback.js";
import { loadWorkspace, renderSystemPrompt } from "../workspace/index.js";
import type { WorkspaceContent, SessionTypeConfig, SkillMeta, RoutedSatellite } from "../workspace/types.js";
import { ROUTING_PROACTIVE, routingTasksOf, type RoutingVerdict } from "../decisions/points/routing.js";
import { resolveWorkspacePath } from "../tools/workspace.js";
import { loadModelPrompts, systemPromptHashOf, withModelPrompt, type ResolvedModelPrompt } from "./model-prompts.js";
import { SessionRedoControl } from "./redo-signal.js";
import { stampServedModel } from "./contract.js";
import type { ForkChange, ForkContext } from "./fork.js";
import { readFile } from "node:fs/promises";
import type { Storage, Summary } from "../storage/index.js";
import type { RefusalPin, SessionRoutingState } from "../storage/database.js";
import type { Logger } from "../observability/logger.js";
import type { SessionLiveEventBus } from "../observability/live-events.js";
import type { LlmRequestRing } from "./request-ring.js";
import {
  SessionUsageTracker,
  estimateAbortedRequestUsage,
  type AbortedRequestEstimate,
  type PromptCacheBaseline,
  type SessionUsageTotals,
} from "./usage.js";
import type { AttachmentMeta, CanonicalChatEvent } from "../types.js";
import type {
  BudgetHooks,
  UserLimitContext,
  UserLimitEngine,
  UserLimitResolution,
} from "../budget/index.js";
import { TurnResultBudget } from "./tool-result-budget.js";
import { wrapToolsWithResultBudget } from "./tool-result-wrap.js";
import { RequestProgress, withRequestProgress } from "./request-progress.js";
import type { LateInputSession } from "./late-input.js";
import {
  DynamicToolRegistry,
  matchToolPatterns,
  renderDeferredToolsIndex,
  filterHarnessOnlyFromIndex,
  wrapEditorWithSkillActivation,
  type DeferredIndexMode,
} from "./dynamic-tools.js";
import { createLoadSkillTool, loadSkillToolDefinition } from "../tools/load-skill.js";
import { createToolSearchTool, toolSearchToolDefinition } from "../tools/tool-search.js";
import type { CheckCatalogue, RefusalRule } from "../checks/types.js";
import { isPostingTool } from "../tools/side-effects.js";
import {
  createSessionRefusalController,
  isInternalSite,
  refusalRuleModels,
  type SessionRefusalHandle,
} from "../refusals/session.js";

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

// Prompt-cache TTL (spec PER-USER-LIMITS §5.3): the window within which the prior
// request's prompt is still a cache hit, so the per-user estimate prices that prefix
// at cache-read and only the new material at cache-write. Anthropic's default cache
// retention is ~5 min; conservative outside it (cache-write throughout).
const PROMPT_CACHE_TTL_MS = 300_000;

// Re-export so callers that previously imported estimateLiveSliceTokens from
// factory (the original home) keep compiling without changes. The canonical
// definition is now live-token-estimate.ts.
export { estimateLiveSliceTokens } from "./live-token-estimate.js";

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
  /**
   * Per-session workspace root resolver (spec MULTI-AGENT-SUPPORT §4.1/§4.3).
   * Maps a `timeline_key` to the owning agent's workspace root path.
   * - When **absent** (legacy single-agent mode): `create`/`buildPreview` fall
   *   back to `config.workspace?.root_dir ?? "./workspaces/miku"`.
   * - When **present** (agents mode) and the key resolves: returns the agent's
   *   absolute workspace root.
   * - When **present** and the key is **unresolvable** (§4.3 — account removed
   *   from config): `create`/`buildPreview` throw a descriptive error so
   *   callers can log and discard the session, not fall back to a random root.
   */
  resolveWorkspaceRoot?: (timelineKey: string) => string | undefined;
  /**
  /**
   * Resolve the owning agent name for a timeline key. Shared by TWO features
   * that both need per-session agent identity: the per-agent model-override
   * ladder (spec PER-AGENT-MODEL-OVERRIDES §8) and the per-agent MCP server
   * allowlist (spec PER-AGENT-MCP-SCOPING).
   *
   * Mirrors {@link resolveWorkspaceRoot} — the "__legacy__" sentinel must be
   * normalized to `null` at the wiring site (app.ts:~909), so this resolver
   * always returns either a real agent name or `null`. `null` = legacy /
   * no-scoping: model resolvers fall through to the global-only ladder and MCP
   * scoping is skipped (all tools visible), byte-identical to today's behavior.
   * Absent (legacy single-agent mode) → every session resolves as `null`-agent.
   */
  resolveAgentName?: (timelineKey: string) => string | null;
  /**
   * Per-agent model override table, built once at startup from `AppConfig`
   * (spec PER-AGENT-MODEL-OVERRIDES §8, via {@link buildAgentModelOverrides}).
   * When absent (legacy mode or tests without the override module), the three factory
   * helpers and `create()` fall back to the global-only path (today's behavior).
   */
  agentModelOverrides?: AgentModelOverrides;
  /**
   * Exact tool-name → server-name attribution map built from `adaptMcpTools`
   * at startup. Used by `filterMcpToolsByAllowlist` for O(1) server lookup
   * instead of prefix inference — immune to any server-key naming collision.
   * When absent (tests without MCP wiring), the filter receives an empty map
   * and treats every tool as a non-MCP tool (safe: no scoping applied).
   */
  mcpToolServerMap?: Map<string, string>;
  /**
   * Refusal handling (spec REFUSAL-HANDLING §8): the app's check catalogue (built
   * once, classifies hard refusals) and the normalized `[[refusal_fallback]]`
   * rules. Absent (tests) = no rules; hard refusals are still recorded when
   * storage is wired, as uncategorized.
   */
  refusals?: { catalogue: CheckCatalogue; rules: RefusalRule[] };
  /**
   * Output gate services (spec REFUSAL-HANDLING §6), built once in app.ts.
   * When set, every chat-lane session (fresh, resumed, proactive) gets an
   * {@link OutputGate} on `CreatedAgent.gate`: its gated tools pass the gate and
   * the attempt tap starts evaluations early. Absent = no gate (tests, headless).
   */
  outputChecks?: OutputGateServices;
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
   * Decision-model routing (ARCHITECTURE.md §8h "Routing"). Supplied by the app
   * only for a FRESH, human-triggered chat-lane session whose agent has routing
   * enabled. Called once, after the workspace is loaded and before model
   * selection, with the session's listed skills; its verdict (model preference
   * cascade, thinking level, skill preloads, extra tail files) is applied below.
   * Undefined result or a throw = no routing (today's behaviour).
   */
  route?: (input: { listedSkills: readonly SkillMeta[] }) => Promise<RoutingVerdict | undefined>;
  /**
   * Synthetic tool calls to inject into the start of the live transcript, after
   * the final user turn (spec SESSION-RECORDS §4): the app's `read_session_record`
   * calls. Routing preloads come first; these follow. A promise is awaited after
   * routing and the context build, right before the kickoff is assembled, so the
   * caller's selection runs in parallel with both; a rejection injects nothing.
   * A call to a tool that is still deferred is preceded by a synthetic
   * `tool_search` select call that loads it. Ignored on a resume (the transcript
   * already carries the original injections).
   */
  injections?: SyntheticCallSpec[] | Promise<SyntheticCallSpec[]>;
  /**
   * The session's auto-retrieval plan, started at launch in parallel with routing
   * (ARCHITECTURE.md §9d "Judged retrieval"); the build awaits it when assembling
   * the final user turn. Absent = no retrieval block (a preview runs it inline).
   */
  memoryRetrieval?: MemoryPlanTicket;
  /**
   * The session's record-turn gate (spec SESSION-RECORDS §3.2), applied to the
   * final tool list (the caller's tools plus the loading tools the factory adds),
   * so nothing but `session_record_tool` runs during the record turn and it
   * never runs outside it.
   */
  recordTurnGate?: RecordTurnGate;
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
  /**
   * The session's redo control (spec REFUSAL-HANDLING §8.4), when the caller
   * created it before the agent (e.g. to hand it to tools built earlier).
   * Absent = the factory creates one; either way it is `CreatedAgent.redoControl`.
   */
  redoControl?: SessionRedoControl;
  /**
   * Start the session pinned to a refusal rule's entry (spec REFUSAL-HANDLING
   * §8.3): a mechanical job re-run after its output (or failed rollout) was
   * judged a refusal (§5.2.3–4). Every request goes to this model's chain, with
   * its model prompts, as for a sticky pin. Ignored when the model is unknown.
   */
  refusalPin?: RefusalPin;
  /**
   * Per-user limits selection input (spec PER-USER-LIMITS §6). Supplied ONLY for a
   * human-triggered agent-loop session whose trigger ctx resolved to an ACTIVE
   * per-user rule (the app builds it at Gate A). When present + active, the factory
   * builds one fallback per preferred model and re-selects PER REQUEST (affordable ∧
   * healthy ∧ fits — §4.2), caps output at the remaining headroom (§5.3), attributes
   * the requested model to the ledger (§7), and records the served cost against the
   * partitioned counters. Absent (background/proactive, or feature off) = today's
   * single-model path, unchanged.
   */
  userLimit?: {
    engine: UserLimitEngine;
    resolution: UserLimitResolution;
    ctx: UserLimitContext;
  };
  /**
   * Dynamic §8d ceiling override (spec PER-USER-LIMITS §6.3): when set, replaces the
   * statically-resolved per-session cost ceiling with `min(static, userTotalHeadroom)`
   * computed by the app at launch, so the soft-warn + hard pre-flight reflect the
   * user's REMAINING total headroom. Absent = the static ceiling (today's behavior).
   */
  costCeilingOverride?: number;
  /**
   * Late input (ARCHITECTURE.md §8 "Late input"): the session's controller. The
   * factory routes the raw catalog through its replay store and the final tool
   * list through its irreversibility hold, and tracks request progress for its
   * abort rule. Absent = no late input (internal jobs, proactive).
   */
  lateInput?: LateInputSession;
  /**
   * Redo rebuild: the first build's {@link CreatedAgent.timelineCutoff}, so the
   * rebuilt prefix matches it (ARCHITECTURE.md §8 "Late input").
   */
  timelineCutoff?: number;
  /** Redo rebuild: the first build's {@link CreatedAgent.summaryCoverage} (same reason). */
  summaryCoverage?: SummaryCoveragePin;
}

export interface CreatedAgent {
  agent: Agent;
  /**
   * The final user turn — a rich `triggerGroup` (chat) or the cutoff `satellite`
   * (summarization) — popped off the frozen prefix (§2b). The caller kicks the loop
   * with it via `agent.prompt(...)`, making it the first turn of the live transcript.
   * Undefined in resume mode (the caller appends a new user turn instead).
   *
   * For callers that support synthetic injections (live chat-lane sessions), use
   * {@link kickoff} instead: it is the full kickoff array `[finalTurn,
   * ...syntheticMessages]` already assembled.
   */
  finalTurn?: AgentMessage;
  /**
   * Full kickoff array for the runner: `[finalTurn, ...syntheticMessages]` when
   * there is a final turn (fresh + resume-continuation builds), or `undefined` in
   * failure-recovery continue-mode.  Workers that manage their own prompt calls
   * may use `finalTurn` directly; all live chat-lane callers should use this.
   */
  kickoff?: AgentMessage[];
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
  /** The build's timeline cutoff (latest `receivedAt` it read); a redo rebuild reuses it. */
  timelineCutoff?: number;
  /** The summary coverage the build rendered; a redo rebuild reuses it. */
  summaryCoverage?: SummaryCoveragePin;
  /** Where the in-flight LLM request is (the late-input abort rule). */
  requestProgress: RequestProgress;
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
  /**
   * The per-session dynamic-tool registry, when dynamic tools are enabled
   * (spec DYNAMIC-TOOL-LOADING §7). The record turn loads `session_record_tool`
   * through it (spec SESSION-RECORDS §3.2). Undefined when dynamic tools are off.
   */
  registry?: DynamicToolRegistry;
  /**
   * Change the scheduler admission class of this agent's later requests (read
   * per request). The record turn raises it to `interactive` (spec
   * SESSION-RECORDS §3.2). The retry budget stays the session type's own.
   */
  setPriority: (priority: PriorityClass) => void;
  /**
   * Whether a refused request of this agent may fall over to the next chain
   * member (read per request; default on, ARCHITECTURE.md §8a "Refusals"). The
   * record turn turns it off: a refused record turn writes no record (spec
   * SESSION-RECORDS §3.2).
   */
  setRefusalFallover: (enabled: boolean) => void;
  /**
   * The session's refusal handle (spec REFUSAL-HANDLING §8): rules, the sticky
   * pin a rule redo leaves, refusal statistics. Layer 0 consults it on every
   * hard refusal; the output gate reads it for soft ones.
   */
  refusal: SessionRefusalHandle;
  /**
   * Switch the refusal site of this agent's later requests: the record turn sets
   * `record_turn` (spec REFUSAL-HANDLING §8.1); undefined restores the session type.
   */
  setRefusalSite: (site: string | undefined) => void;
  /** The session's redo control: the gate requests redos, the runner takes them (spec §8.4). */
  redoControl: SessionRedoControl;
  /**
   * The fork core's view of this session (spec REFUSAL-HANDLING §8.4): the
   * caller supplies storage and the session capture's flush; the factory adds
   * the agent and resets what it derived from the append-only transcript (the
   * running context counter, the loaded dynamic tools) after each fork.
   */
  forkContext: (deps: ForkContextDeps) => ForkContext;
  /**
   * The session's output gate (spec REFUSAL-HANDLING §6), when the app wired
   * checks; undefined for internal job builds. The runner's ending hook and the
   * record turn's artifact check use it.
   */
  gate?: OutputGate;
}

/** What the caller adds to {@link CreatedAgent.forkContext}. */
export interface ForkContextDeps {
  storage: ForkContext["storage"];
  /** The session capture's `flushNow`. */
  flushTranscript: () => Promise<void>;
  logger?: Logger;
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

  /**
   * Resolve the upstream model id used by a session type (for summary record provenance).
   *
   * When `timelineKey` is provided and the factory has both {@link AgentFactoryOptions.resolveAgentName}
   * and {@link AgentFactoryOptions.agentModelOverrides} wired, the resolution runs through
   * the per-agent chat-lane ladder (spec PER-AGENT-MODEL-OVERRIDES §4). Without a `timelineKey`
   * (or when either wired option is absent) the global-only path is used — backward-compatible
   * for all legacy callers.
   */
  resolveModelId(sessionType: string, timelineKey?: string): string {
    const modelKey = this.resolveModelKey(sessionType, timelineKey);
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    return modelConfig.id;
  }

  /**
   * Resolve the LOGICAL model id (config block name) a session type's agent-loop
   * spend is scoped under (spec MODEL-FALLBACK §2.2) — the chain head's name, what
   * a `[[limits]].models` selector matches and what the ledger stamps. Distinct
   * from {@link resolveModelId} (the upstream wire id) when block name != wire id.
   *
   * When `timelineKey` is provided and per-agent overrides are wired, resolves through
   * the chat-lane ladder (spec PER-AGENT-MODEL-OVERRIDES §4). Without a `timelineKey`
   * the global-only path is used — backward-compatible for legacy callers.
   */
  resolveLogicalModelId(sessionType: string, timelineKey?: string): string {
    return this.resolveModelKey(sessionType, timelineKey);
  }

  /**
   * Resolve a session type's effective fallback chain as LOGICAL ids (config block
   * names), head first (spec MODEL-FALLBACK §6.1). The launch-admission gate gates
   * on the WHOLE chain — admit when ANY member is in-budget — rather than the bare
   * head, so a model-scoped cap on the primary doesn't wrongly refuse a session for
   * which an in-budget fallback exists. Mirrors `create`'s `resolveModelChain` call.
   *
   * When `timelineKey` is provided and per-agent overrides are wired, resolves through
   * the chat-lane ladder (spec PER-AGENT-MODEL-OVERRIDES §4). Without a `timelineKey`
   * the global-only path is used — backward-compatible for legacy callers.
   */
  resolveModelChainLogicalIds(sessionType: string, timelineKey?: string): string[] {
    const modelKey = this.resolveModelKey(sessionType, timelineKey);
    return resolveModelChain(modelKey, this.options.config.models).map((m) => m.logicalId);
  }

  /**
   * Internal: resolve the logical model key (config block name) for a session type.
   *
   * When `agentModelOverrides` is wired, always resolves through the per-agent
   * chat-lane ladder (spec PER-AGENT-MODEL-OVERRIDES §4/§8): the agent name is
   * obtained from `resolveAgentName(timelineKey)` when both `timelineKey` and the
   * resolver are available, and `null` otherwise (null-agent = global-only path,
   * byte-identical to today's behavior after the rung-2 correction). When
   * `agentModelOverrides` is absent (legacy mode or tests without the module),
   * falls back to `resolveSessionType(sessionType)?.model ?? "default"` directly.
   */
  /**
   * A session's task keys (DECISION-MODEL §5.1a, spec REFUSAL-HANDLING §8.1):
   * a fresh routed session's selected tasks, a resumed session's persisted ones,
   * the built-in `proactive` task for a proactive session (no decision call),
   * else null (taskless: unrouted, routing fell back, bot-triggered, internal
   * jobs).
   */
  private sessionTasksFor(
    session: AgentSessionRecord,
    routing: RoutingVerdict | undefined,
    persisted: SessionRoutingState | undefined,
    opts: CreateAgentOptions | undefined,
  ): string[] | null {
    if (opts?.summarizationCutoff || opts?.condenseInputs || opts?.diaryRange) return null;
    if (routing) return routingTasksOf(routing);
    if (persisted?.tasks && persisted.tasks.length > 0) return [...persisted.tasks];
    const proactiveType = this.options.config.proactive?.session_type ?? "proactive";
    if (opts?.proactive || session.sessionType === proactiveType) return [ROUTING_PROACTIVE];
    return null;
  }

  /**
   * Can a refusal-rule entry serve a mechanical job's re-run now (spec
   * REFUSAL-HANDLING §8.1 "Gates"): the model exists and some member of its
   * chain is healthy (or probe-due) and in budget. Workers use it to walk a
   * rule's entries outside a session.
   */
  refusalEntryViable(logicalId: string, scope: { sessionType: string; timelineKey: string }): boolean {
    if (!this.options.config.models[logicalId]) return false;
    const engine = this.options.budget?.engine;
    return this.chainViable(
      logicalId,
      this.options.scheduler,
      engine ? (id: string) => engine.isModelAvailable(id, { class: "agent_loop", ...scope }) : undefined,
    );
  }

  /**
   * Can `logicalId`'s chain serve a request right now — some member healthy (or
   * probe-due) and in budget? The routed-cascade check (ARCHITECTURE.md §8h); the
   * same `chooseChainMember` predicate the per-attempt resolver applies.
   */
  private chainViable(
    logicalId: string,
    scheduler: LlmScheduler | undefined,
    isModelAvailable: ((id: string) => boolean) | undefined,
  ): boolean {
    let chain;
    try {
      chain = resolveModelChain(logicalId, this.options.config.models);
    } catch {
      return false;
    }
    const members = chain.map((m) => ({
      logicalId: m.logicalId,
      healthKey: `${m.config.endpoint ?? "unknown"}::${m.config.id}`,
      operativeWindow: Number.POSITIVE_INFINITY,
    }));
    return chooseChainMember(members, { scheduler, isModelAvailable }).reason !== "all-unhealthy";
  }

  private resolveModelKey(sessionType: string, timelineKey?: string): string {
    const agentName =
      timelineKey !== undefined && this.options.resolveAgentName
        ? this.options.resolveAgentName(timelineKey)
        : null;
    return this.options.agentModelOverrides
      ? this.options.agentModelOverrides.resolveSessionTypeModelRef(agentName, sessionType)
      : this.resolveSessionType(sessionType)?.model ?? "default";
  }

  /**
   * The UPSTREAM wire id of a specific LOGICAL model (config block name) — the
   * per-user-selected initial model's provenance for the §8e admission gate (spec
   * PER-USER-LIMITS §6.1), distinct from {@link resolveModelId} which keys on a
   * session type. Throws on an unknown id (the per-user normalizer already rejected
   * dangling names, so this only fires on a genuine config bug).
   */
  resolveUpstreamModelId(logicalId: string): string {
    const m = this.options.config.models[logicalId];
    if (!m) throw new Error(`Model "${logicalId}" not found in config`);
    return m.id;
  }

  /** A specific LOGICAL model's fallback chain as logical ids, head-first (§6.1). */
  resolveModelChainLogicalIdsForModel(logicalId: string): string[] {
    return resolveModelChain(logicalId, this.options.config.models).map((m) => m.logicalId);
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
    // §4.3: in agents mode (resolver provided) an unresolvable account must not
    // fall back to a guessed root — surface a descriptive error so the caller
    // (launchSession's catch block) logs + discards cleanly.
    let workspaceRoot: string;
    if (this.options.resolveWorkspaceRoot) {
      const resolved = this.options.resolveWorkspaceRoot(session.timelineKey);
      if (resolved === undefined) {
        throw new Error(
          `§4.3: timeline "${session.timelineKey}" maps to an account not in config — ` +
          "workspace root unresolvable in agents mode",
        );
      }
      workspaceRoot = resolved;
    } else {
      workspaceRoot = this.options.config.workspace?.root_dir ?? "./workspaces/miku";
    }
    const sessionTypeConfig = this.resolveSessionType(session.sessionType);
    const fallbackPrompt = this.options.config.agent.system.fallback_prompt;

    // Decision-model routing (ARCHITECTURE.md §8h): the workspace is loaded early
    // (and reused below) so the router sees the session's listed skills. Fresh
    // sessions only — a resume keeps the model and context it was built for.
    let routing: RoutingVerdict | undefined;
    let earlyWorkspace: WorkspaceContent | undefined;
    if (opts?.route && !opts.resume) {
      earlyWorkspace = await loadWorkspace(workspaceRoot, sessionTypeConfig);
      const routingAgent = this.options.resolveAgentName?.(session.timelineKey) ?? null;
      const routingCatalog = filterTools(filterMcpToolsByAllowlist(tools,
        routingAgent !== null ? this.options.config.agents?.[routingAgent]?.mcp_servers : undefined,
        this.options.mcpToolServerMap ?? new Map()), sessionTypeConfig);
      earlyWorkspace.skills = eligibleSkillIndex(earlyWorkspace.skills, routingCatalog.map(tool => tool.name));
      try {
        routing = await opts.route({ listedSkills: earlyWorkspace.skills.listed });
      } catch (error) {
        this.options.logger?.warn("routing_failed", {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // A resumed routed session keeps what routing chose when it was created (its
    // model, effort and preloads): the rollout was built for them (§8h).
    const persistedRouting = opts?.resume ? this.options.storage?.getSessionInitialPreloads(session.id) : undefined;
    // The session's tasks (DECISION-MODEL §5.1a; spec REFUSAL-HANDLING §8.1):
    // the routed labels (kept on resume), the built-in `proactive` task of a
    // proactive session, else none (bot-triggered, unrouted, internal jobs).
    const sessionTasks = this.sessionTasksFor(session, routing, persistedRouting, opts);
    const scheduler = this.options.scheduler;
    const budgetEngine = this.options.budget?.engine;
    const isModelAvailableFn = budgetEngine ? (id: string) => budgetEngine.isModelAvailable(id, { class: "agent_loop", sessionType: session.sessionType, timelineKey: session.timelineKey }) : undefined;
    const userLimit = opts?.userLimit;
    const userSelection = userLimit?.resolution.active === true;

    // Per-agent model override (spec PER-AGENT-MODEL-OVERRIDES §4/§8): resolve via
    // the shared private helper so create() and the public resolvers are always
    // one code path — no divergence in guarding logic.
    const defaultModelKey = this.resolveModelKey(session.sessionType, session.timelineKey);
    // A routed model cascade (§8h) is tried before normal selection. Under per-user
    // limits it is prepended to the user's preference list below (each entry gets
    // the same per-request affordable ∧ healthy ∧ fits check); without them the
    // first entry whose chain has a healthy, in-budget member heads the session,
    // and with every entry exhausted selection is exactly today's.
    const routedCascade = (routing?.models ?? persistedRouting?.cascade ?? []).filter((key) => {
      const known = this.options.config.models[key] !== undefined;
      if (!known) this.options.logger?.warn("routing_model_missing", { sessionId: session.id, model: key });
      return known;
    });
    const persistedHead =
      persistedRouting?.model && this.options.config.models[persistedRouting.model] ? persistedRouting.model : undefined;
    const routedHead =
      persistedHead ??
      (routedCascade.length > 0 && !userSelection && !opts?.resume
        ? routedCascade.find((key) => this.chainViable(key, scheduler, isModelAvailableFn))
        : undefined);
    const modelKey = routedHead ?? defaultModelKey;
    if (routing && routedCascade.length > 0) {
      this.options.logger?.info("routing_model_selected", {
        sessionId: session.id,
        task: routing.task,
        cascade: routedCascade,
        chosen: userSelection ? "per_user_selection" : routedHead ?? null,
        fallback: userSelection || routedHead ? undefined : defaultModelKey,
      });
    }
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    // Extended-thinking level for this session (the head model's config, default off;
    // a routed task's level overrides it, §8h — ignored by a model declared not
    // thinking-capable). Fixed for the whole rollout — it flows as pi-ai
    // `options.reasoning` on every request regardless of which per-user model serves —
    // and is the basis for the per-requested-model additive thinking budget the
    // affordability estimate reserves (#4). Resolved once here; also fed verbatim to
    // the Agent's `initialState` below.
    const requestedThinking = (routing?.thinkingLevel ?? persistedRouting?.thinkingLevel) as ThinkingLevel | undefined;
    const routedThinking = requestedThinking && modelConfig.reasoning !== false ? requestedThinking : undefined;
    const thinkingLevel: ThinkingLevel = routedThinking ?? modelConfig.thinking_level ?? "off";
    // Per-session-run USD cost ceiling (spec SESSION-COST-LIMITS §3), resolved
    // once and fed to the hard-cap pre-flight below. `undefined` = unlimited. The
    // per-user dynamic-ceiling override (PER-USER-LIMITS §6.3) replaces the static
    // value with `min(static, userTotalHeadroom)` the app computed at launch.
    const costCeiling = opts?.costCeilingOverride ?? this.resolveSessionCostCeiling(session.sessionType);
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
    const rateLimitGroup = modelConfig.rate_limit_group ?? "default";
    // The session type's OWN class — the workload category. `opts.priority` (a
    // priority-inheritance escalation, e.g. a summarization job raised by a
    // waiting build) overrides the QUEUE RANK only, never the retry budget
    // (spec LLM-FAILURE-HANDLING §6): an escalated background job is still
    // background work and still waits out an outage.
    const basePriority =
      sessionTypeConfig?.priority ?? defaultPriorityForSessionType(session.sessionType);
    const priority = opts?.priority ?? basePriority;
    // Admission class of the next request; `setPriority` on the created agent
    // changes it for the requests that follow (the record turn, §3.2).
    const admissionPriority: { current: PriorityClass } = { current: priority };
    // Refusal fallover of the next request; `setRefusalFallover` on the created
    // agent changes it (the record turn turns it off, §8a "Refusals").
    const refusalFallover: { enabled: boolean } = { enabled: true };
    // Holder for the admission wait of the in-flight attempt (ring
    // attribution, §9.2): the agent issues one request at a time per session,
    // so a single slot per created agent is race-free.
    const admissionWait: { last?: number } = {};
    // Per-attempt resolved member (spec MODEL-FALLBACK §6.1): the logical id the
    // composite chose for the in-flight attempt, so the ledger row is attributed
    // to the member actually billed even when the head fell to a fallback.
    const resolvedMember: { logicalId: string } = { logicalId: modelKey };
    // The output gate (spec REFUSAL-HANDLING §6): chat-lane sessions only; it
    // reads the live messages through the late-bound `agentRef` below.
    const outputGate = createSessionOutputGate(this.options.outputChecks, {
      session,
      agentName: this.options.resolveAgentName?.(session.timelineKey) ?? null,
      triggerSenderId,
      internalJob: Boolean(opts?.summarizationCutoff || opts?.condenseInputs || opts?.diaryRange),
      getMessages: () => agentRef.agent?.state.messages ?? [],
      servingModel: () => resolvedMember.logicalId,
      tasks: sessionTasks,
    });
    // Per-attempt served-model tracker for the request ring (served-model
    // attribution). Starts undefined; set by onResolve when the fallback fn
    // dispatches; reset to undefined at the start of each retry-loop iteration
    // by ctx.resetServedModel so a stale value is never carried forward. The
    // budget-violation pre-flight calls recordAttempt before the loop runs, so
    // getServedModel() returns undefined there (no dispatch happened). ✓
    let servedModelForAttempt: string | undefined = undefined;
    // Capability pre-filter (spec MODEL-FALLBACK §3 #1): pixels are shipped for a
    // session ONLY when its own reply model (`modelConfig` — the per-agent resolved
    // model key above) accepts image input. `replyModelCanSeeImages` is threaded
    // explicitly to both `buildContext` (fresh) and `buildResumeTurn` (resume) so
    // the builder's pixel-block gate uses the per-agent model's actual capability
    // rather than re-deriving from the global session-type config
    // (spec PER-AGENT-MODEL-OVERRIDES FIX 5). So the requirement is "the reply model
    // can see images AND the raw inputs carry one" — a model's own capability, never
    // `[models.default]`'s or a fallback's. When it holds, every viable chain member
    // must also accept image input so a fall-over never ships pixels to a text-only
    // member (the head is never dropped). Derived from the raw inputs (trigger
    // attachments / resume snapshot imageBlocks) because this runs BEFORE buildContext
    // — a SAFE over-approximation (any raw image ⇒ require multimodal). The
    // head-never-dropped rule ensures every surviving member in `memberWindows` is
    // capability-compatible. Per-member fits are enforced at select time by
    // `chooseChainMember` using each member's individual `operativeWindow`; the
    // planning ceiling is the head's own window (`fallback.memberWindows[modelKey]`,
    // used at `contextCeiling` below), not the chain min.
    const replyModelCanSeeImages = modelConfig.input_modalities.includes("image");
    const requiresMultimodal = replyModelCanSeeImages && rawInputsRequireMultimodal(session, opts);
    // Per-user selection (spec PER-USER-LIMITS §6): when an ACTIVE per-user rule is
    // supplied for this human session, the factory builds one composite per PREFERRED
    // model and re-selects per request. `requestedMember` tracks the per-user
    // selector's chosen model (the ledger's `requested_model_id`, §7), distinct from
    // `resolvedMember` (the served chain member, set by the chosen composite's onResolve).
    const requestedMember: { logicalId: string } = { logicalId: modelKey };
    // Shared builder so the default + each preferred composite are built identically
    // (spec MODEL-FALLBACK §3): capability pre-filter + per-member windows fixed
    // once per chain, member chosen per attempt inside the composed fn. Memoized so a
    // preferred model that equals the default key is not built twice (§4.2 build
    // structure: one BuiltModelFallback per preferred model, ceiling resolved once each).
    const builtFallbacks = new Map<string, BuiltModelFallback>();
    // The transcript a resumed session starts from (spec RESUMABLE-SESSIONS). Its
    // turns were produced under a prefix this session no longer sends verbatim
    // (the system prompt is re-rendered), so members with `drop_stale_thinking`
    // leave their thinking blocks out. See stale-thinking.ts.
    // Late-bound: the dynamic-tool registry is built after the model chain. Stays
    // unset for a session without dynamic loading (the transport is then a no-op).
    const declaredRef: { set?: DeclaredToolSet } = {};
    const resumedMessages = new WeakSet<object>(
      (opts?.resume?.transcript ?? []).filter((m): m is AgentMessage & object => typeof m === "object" && m !== null),
    );
    // Refusal rules (spec REFUSAL-HANDLING §8): the session's site is its type
    // (the record turn switches it to `record_turn`); a resumed session keeps the
    // pin a rule redo left (§8.3). Every model a rule can switch the session to
    // joins the model-prompt heads below, so a redo is served with its own
    // preamble and tail (§8.3, owner decision 27).
    const refusalRules = this.options.refusals?.rules ?? [];
    const refusalAgent = this.options.resolveAgentName?.(session.timelineKey) ?? null;
    const resumedPin =
      opts?.refusalPin ?? (opts?.resume ? this.options.storage?.getAgentSessionRefusalPin?.(session.id) : undefined);
    const refusalHeads = [
      ...refusalRuleModels(refusalRules, {
        // A chat session may end in a record turn (site `record_turn`); a job never does.
        sites: isInternalSite(session.sessionType) ? [session.sessionType] : [session.sessionType, "record_turn"],
        agent: refusalAgent,
        tasks: sessionTasks,
      }),
      ...(resumedPin && this.options.config.models[resumedPin.model] ? [resumedPin.model] : []),
    ];
    // Model prompts (ARCHITECTURE.md §8 "Model prompts"): resolved and read once
    // for every member this session can reach, held for its lifetime, and applied
    // per attempt to whichever member serves.
    const modelPrompts = await this.loadSessionModelPrompts({
      heads: [
        modelKey,
        ...(userSelection ? [...routedCascade, ...(userLimit!.resolution.models ?? [])] : []),
        ...refusalHeads,
      ],
      sessionType: sessionTypeConfig,
      sessionTypeName: session.sessionType,
      workspaceRoot,
      sessionId: session.id,
    });
    const buildFor = (logicalId: string): BuiltModelFallback => {
      const cached = builtFallbacks.get(logicalId);
      if (cached) return cached;
      const built = buildModelFallback(resolveModelChain(logicalId, this.options.config.models), {
        consumer: "agent",
        makeBase: (cfg) => {
          const base = withSdkRetriesDisabled((cfg.streaming ?? true) ? streamSimple : wrapCompleteAsStream);
          // Gated per serving member, like the onPayload injectors below.
          // `declare_deferred_tools` makes a tool load append-only for the member
          // (declared-tools.ts), so its prefix then changes only on a resume.
          const declared = cfg.compat?.declare_deferred_tools === true;
          const loading = declared
            ? withDeclaredDeferredTools(base, () => declaredRef.set, { references: cfg.compat?.supports_tool_references === true })
            : base;
          return cfg.compat?.drop_stale_thinking
            ? withStaleThinkingDropped(loading, { resumed: resumedMessages, atToolLoads: !declared })
            : loading;
        },
        makeModel: (cfg, cw) => createModelFromConfig(cfg, cw),
        wrapMember: (id, dispatch) => {
          const prompt = modelPrompts.get(id);
          return prompt ? withModelPrompt(dispatch, prompt) : dispatch;
        },
        memberOverheadTokens: (id) => modelPrompts.get(id)?.tokens ?? 0,
        capability: requiresMultimodal ? (cfg) => cfg.input_modalities.includes("image") : undefined,
        contextOverride: sessionTypeConfig?.max_context_tokens,
        scheduler,
        admission: scheduler
          ? {
              priority: () => admissionPriority.current,
              key: opts?.escalationKey,
              sessionId: session.id,
              sessionType: session.sessionType,
              onAdmissionWait: (waitMs) => {
                admissionWait.last = waitMs;
                requestProgress.noteAdmitted();
              },
            }
          : undefined,
        isModelAvailable: isModelAvailableFn,
        logger: this.options.logger,
        sessionId: session.id,
        onResolve: (id) => {
          resolvedMember.logicalId = id;
          servedModelForAttempt = id;
          refusal.noteServing(id);
        },
        // Feed the §5.3 running counter for per-member fits gating per attempt
        // (spec PER-MEMBER-CONTEXT-FITS §2.1). Guard: return undefined before the
        // counter is seeded (ctxCounter.seenMsgs starts at -1; first observation
        // sets it ≥ 0). Fetch consumers (captioning/embedding) omit this option
        // and always receive undefined → fits skipped, preserving their behavior.
        getObservedContextTokens: () =>
          ctxCounter.seenMsgs < 0 ? undefined : ctxCounter.running,
        // One pass per request + out-of-band recovery (ARCHITECTURE.md §8a).
        primaryAttemptsPerRequest: recovery?.llm_primary_attempts_per_request,
        backgroundProbe: true,
      });
      builtFallbacks.set(logicalId, built);
      return built;
    };
    // The default (session-type head) composite — also the representative descriptor
    // source and the dispatch when per-user selection is inactive or collapses.
    const fallback = buildFor(modelKey);
    // Planning ceiling (spec PER-MEMBER-CONTEXT-FITS §2.3): the head's own operative
    // window — min(head.context_window, session_type.max_context_tokens). The chain
    // min is gone: fallback members are fits-checked per attempt by chooseChainMember
    // (which uses their individual operativeWindow). Enforcement uses
    // fallback.maxOperativeContextWindow (the largest member's window) so termination
    // occurs only when NO member can serve. Fed to the head model descriptor so any
    // window-keyed SDK mechanism sees the head's real ceiling, not the fallback floor.
    const contextCeiling = fallback.memberWindows[modelKey] ?? fallback.operativeContextWindow;
    // Tool-result budget knobs (spec TOOL-RESULT-BUDGET §7).
    // Defaults match 00-defaults.toml; resolved once per session at creation.
    const _toolsConfig = this.options.config.agent.tools;
    const resultMaxTokens = _toolsConfig?.result_max_tokens ?? 16384;
    const resultReserveTokens = _toolsConfig?.result_reserve_tokens ?? 32768;
    const resultMinTokens = _toolsConfig?.result_min_tokens ?? 1024;
    // Representative (head) descriptor — initialState.model, the isQueueWaitPoint
    // key, and the ledger-fallback model id. The composite substitutes the chosen
    // member's descriptor + key per attempt.
    const model = createModelFromConfig(modelConfig, contextCeiling);

    // Per-user selectable set (spec §4.2): each preferred model whose chain can serve
    // the request's capability needs (an entirely-incapable model is ABSENT). Empty
    // (or no per-user rule) ⇒ the single default composite, today's behavior.
    interface Selectable {
      requestedLogicalId: string;
      fallback: BuiltModelFallback;
      /**
       * Additive extended-thinking budget the provider bills on top of this requested
       * model's issued `max_tokens` at the session thinking level (#4). Folded into the
       * affordability output basis and reserved inside the issued cap so the wire
       * `max_tokens` (post-pi-ai) never exceeds the authorized budget. 0 for adaptive /
       * OpenAI-effort / thinking-off models.
       */
      thinkingBudgetTokens: number;
    }
    const selectables: Selectable[] = [];
    if (userSelection) {
      // Routed cascade first (§8h), then the user's normal preference list.
      const preferred = [
        ...new Set([...routedCascade, ...(userLimit!.resolution.models ?? [modelKey])]),
      ];
      for (const logicalId of preferred) {
        const requestedConfig = this.options.config.models[logicalId];
        if (!requestedConfig) {
          this.options.logger?.warn("user_limit_model_missing", { sessionId: session.id, model: logicalId });
          continue;
        }
        const chainEntries = resolveModelChain(logicalId, this.options.config.models);
        if (requiresMultimodal && !chainEntries.some((m) => m.config.input_modalities.includes("image"))) {
          continue; // whole chain lacks the needed modality → absent from the set
        }
        selectables.push({
          requestedLogicalId: logicalId,
          fallback: buildFor(logicalId),
          thinkingBudgetTokens: additiveThinkingBudgetTokens(requestedConfig, thinkingLevel),
        });
      }
      if (selectables.length === 0) {
        // Rare (image session + an all-text-only user model set): the capability filter
        // emptied the preference set. Per spec §4.2 a capability-missing model is ABSENT
        // from the set, so when NONE qualifies the outcome is TERMINAL — a per-user
        // content-class deny — NOT a fall-through to the ungated session-type default
        // (which would let an image trigger bypass the per-user gate, #3). Flagged here
        // and enforced as the first-request terminal in `checkCostBudget` below; the
        // §8d ceiling (`costCeilingOverride`) and per-user counting still apply.
        this.options.logger?.warn("user_limit_selection_empty", {
          sessionId: session.id,
          timelineKey: session.timelineKey,
        });
      }
    }
    const userSelectionActive = userSelection && selectables.length > 0;
    // The capability filter emptied an ACTIVE per-user preference set (#3): a terminal
    // per-user deny, distinct from "no per-user rule" — never an ungated default path.
    const userSelectionCapabilityDenied = userSelection && selectables.length === 0;
    // servingWindow (spec TOOL-RESULT-BUDGET §4): the largest operative window any
    // serving member offers — the bound that matters for tool-result shaping, because
    // the agent may land on ANY member within the candidate set. When per-user
    // selection is active, the candidate set spans all preferred-model composites and
    // the bound is their maximum; otherwise the single default composite governs.
    // maxOperativeContextWindow is the largest context_window (after session-type
    // override) across ALL surviving members of a given composite's chain.
    const servingWindow = userSelectionActive
      ? Math.max(...selectables.map((s) => s.fallback.maxOperativeContextWindow))  // §4: max across all preferred-model composites
      : fallback.maxOperativeContextWindow;
    const turnBudget = new TurnResultBudget(servingWindow, resultReserveTokens, resultMinTokens);
    // Initial context-token estimate for the FIRST request (the built context size;
    // §5.3). Assigned after buildContext; seeds the exact running counter below.
    const initialContextEstimate = { value: 0 };
    // Exact running input-token counter (spec §5.3): `agent.state.messages` holds only
    // the LIVE rollout (the frozen base is prepended by transformContext + already in
    // `initialContextEstimate`), so we seed from the built size and add the EXACT
    // tokenization of each new live message ONCE. `cachedTokensAtLastRequest` is the
    // prior request's prompt size (cache-read within the TTL); `lastRequestAtMs` dates
    // the prior request for the cache-TTL test; `cacheDomainAtLast` is the served
    // member's health key (endpoint::wire-model) — the upstream identity the prompt
    // cache is scoped to, so the cache-read discount is credited only to a candidate
    // served from the SAME domain ("" = no baseline). O(delta) per request.
    const ctxCounter = { running: 0, seenMsgs: -1, cachedAtLast: 0, lastRequestAtMs: 0, cacheDomainAtLast: "" };
    // Dynamic-tool-loading charge parking (spec DYNAMIC-TOOL-LOADING §9): a load
    // event that fires BEFORE the counter's first observation (load_skill as the
    // session's first tool call) parks its definition-token charge here; the
    // seeding branch below folds it in. Without this, the charge would be lost
    // permanently on the non-per-user path (no actuals reconciliation).
    const pendingToolDefTokens = { value: 0 };
    const refreshRunningContext = (): void => {
      const msgs = agentRef.agent?.state.messages;
      if (!msgs) return;
      if (ctxCounter.seenMsgs < 0) {
        // First observation: the built context (incl. the kickoff turn already in
        // state) is `initialContextEstimate`; do not re-tokenize it.
        ctxCounter.running = initialContextEstimate.value + pendingToolDefTokens.value;
        pendingToolDefTokens.value = 0;
        ctxCounter.seenMsgs = msgs.length;
        return;
      }
      if (msgs.length > ctxCounter.seenMsgs) {
        try {
          // Tokenize only the slice that the wire context actually carries: mirror
          // `transformContext`'s `.filter(isLiveRuntimeMessage)` so the running counter
          // matches what is sent (chatEvents / text-only assistant turns are dropped on
          // the wire) rather than over-counting them (#10). `seenMsgs` still advances by
          // the full observed length — a dropped message is permanently accounted as
          // "seen, contributes nothing", never re-tokenized on a later refresh.
          // Image blocks are charged flat, never as their base64 (see
          // `estimateLiveSliceTokens`).
          const slice = msgs.slice(ctxCounter.seenMsgs).filter(isLiveRuntimeMessage);
          if (slice.length > 0) ctxCounter.running += estimateLiveSliceTokens(slice);
        } catch {
          /* tokenization is best-effort; leave the prior running total (conservative) */
        }
        ctxCounter.seenMsgs = msgs.length;
      }
    };
    // Count of §5.4 budget-capped re-drives so far (bounds the re-drive to one per
    // preferred model — once each tier has degraded, the floor is reached).
    let budgetTruncationCount = 0;
    // Per-request selection state the outer selector dispatches — re-resolved by the
    // pre-flight before each request (§6.2); defaults to the first AFFORDABLE model.
    // DEFENSIVE initial cap (#13/#5): the per-user pre-flight (`checkCostBudget` →
    // `resolveUserSelection`) overwrites `activeSelection` with the precise per-request
    // selection before request 1 — but `withRequestRetry` SWALLOWS a throw in that
    // pre-flight (degrades to "no local block"), and request 1 — the most expensive —
    // would then ship on whatever the seed holds. So mirror Gate A's `initialModel`
    // pick: the FIRST selectable affordable at a ≈0 prior-context estimate
    // (`affordable(…, {})`, additive thinking reserved (#4)), capped at its affordable
    // output. When NONE is affordable (user already over budget at request 1) seed the
    // most-preferred selectable with NO local cap — never a `maxTokens: 0`, which would
    // draw a provider 400 — letting the swallowed-throw fallback dispatch uncapped
    // (the pre-flight normally blocks; this is the degenerate degrade-to-no-block path).
    // `initialContextEstimate.value` is still 0 here (the build/resume branch runs
    // later), so this is a zero-context cap by construction. A non-per-user session
    // keeps no cap (today's behavior).
    let activeSelection: { fallback: BuiltModelFallback; requestedLogicalId: string; maxTokens?: number };
    if (userSelectionActive) {
      const seed =
        selectables.find(
          (s) =>
            userLimit!.engine.affordable(
              userLimit!.resolution,
              s.requestedLogicalId,
              {},
              s.thinkingBudgetTokens,
            ).ok,
        ) ?? selectables[0]!;
      const aff = userLimit!.engine.affordable(
        userLimit!.resolution,
        seed.requestedLogicalId,
        {},
        seed.thinkingBudgetTokens,
      );
      activeSelection = {
        fallback: seed.fallback,
        requestedLogicalId: seed.requestedLogicalId,
        // Omit the cap when nothing is affordable rather than ship a 0-token cap.
        maxTokens: aff.ok ? aff.maxOutput : undefined,
      };
    } else {
      activeSelection = { fallback, requestedLogicalId: modelKey };
    }
    // The §4.2 resolver (affordable ∧ healthy ∧ fits). Builds the §5.3 estimate from
    // the exact running counter: the cache-read prior prompt + the cache-write new
    // material, split at the prompt-cache TTL (PROMPT_CACHE_TTL_MS).
    // Fits+health is delegated uniformly to chooseChainMember with observedContextTokens
    // (spec PER-MEMBER-CONTEXT-FITS §2.4) — the independent fits comparison is removed.
    // Terminal-cause attribution is extended (§2.4): "nothing fits context" is now
    // distinguished from "nothing healthy" in the parked-session error message.
    const resolveUserSelection = (): { ok: true; selection: typeof activeSelection } | { ok: false; budget: boolean; contextDenied: boolean } => {
      refreshRunningContext();
      const observed = ctxCounter.running;
      const newTokens = Math.max(0, observed - ctxCounter.cachedAtLast);
      const withinTtl =
        ctxCounter.lastRequestAtMs > 0 && Date.now() - ctxCounter.lastRequestAtMs < PROMPT_CACHE_TTL_MS;
      let sawHealthyFit = false; // found a fits+healthy selectable (unaffordable) → budget cause
      let sawFit = false;        // found a selectable whose chain can fit the context at all
      for (const s of selectables) {
        // Fits-any check (ignoring health): the largest member's window accommodates the context?
        if (s.fallback.maxOperativeContextWindow >= observed) sawFit = true;
        // Delegate fits+health jointly to chooseChainMember with the observed context size.
        // A result of anything other than "all-unhealthy" means the chain has a viable
        // member (healthy ∧ in-budget ∧ fits).
        const probe = chooseChainMember(s.fallback.survivorMembers, {
          scheduler,
          isModelAvailable: isModelAvailableFn,
          observedContextTokens: observed,
        });
        const viable = probe.reason !== "all-unhealthy";
        // Prompt caches do not cross upstreams: the credited prefix exists only at
        // the (endpoint, wire-model) domain that served the prior committed request.
        // Credit the cache-read discount only when THIS candidate's predicted serving
        // member is that same domain; otherwise price the whole input at cache-write,
        // exactly as if the TTL had lapsed (the §5.3 conservative default — a
        // cross-domain candidate's first request re-establishes the cache upstream).
        const servingDomain = s.fallback.survivorMembers[probe.index]?.healthKey;
        const withinCacheTtl =
          withinTtl &&
          ctxCounter.cacheDomainAtLast !== "" &&
          servingDomain === ctxCounter.cacheDomainAtLast;
        const estimate = { cachedTokens: ctxCounter.cachedAtLast, newTokens, withinCacheTtl };
        const aff = userLimit!.engine.affordable(
          userLimit!.resolution,
          s.requestedLogicalId,
          estimate,
          s.thinkingBudgetTokens,
        );
        if (viable && aff.ok) {
          return {
            ok: true,
            selection: {
              fallback: s.fallback,
              requestedLogicalId: s.requestedLogicalId,
              maxTokens: aff.maxOutput,
            },
          };
        }
        if (viable) sawHealthyFit = true; // fits+healthy but unaffordable → budget cause
      }
      return { ok: false, budget: sawHealthyFit, contextDenied: !sawFit };
    };
    // The admitted stream fn: when per-user selection is active, an OUTER selector
    // that dispatches the per-request-chosen composite with the budget-derived output
    // cap (§5.3); otherwise the bare default composite (today's behavior).
    const admittedStreamFn: StreamFn = userSelectionActive
      ? (m, context, streamOptions) => {
          const sel = activeSelection;
          requestedMember.logicalId = sel.requestedLogicalId;
          const opts2 =
            sel.maxTokens !== undefined
              ? ({ ...(streamOptions ?? {}), maxTokens: sel.maxTokens } as typeof streamOptions)
              : streamOptions;
          return sel.fallback.streamFn(m, context, opts2);
        }
      : fallback.streamFn;
    // Per-user affordability of a specific model now (spec PER-USER-LIMITS §5.3),
    // for a refusal rule's entry and the pin that follows (REFUSAL-HANDLING §8.1/
    // §8.3): the same estimate the per-user resolver builds, priced at that model.
    const affordableNow = (logicalId: string) => {
      refreshRunningContext();
      const observed = ctxCounter.running;
      const withinTtl =
        ctxCounter.lastRequestAtMs > 0 && Date.now() - ctxCounter.lastRequestAtMs < PROMPT_CACHE_TTL_MS;
      const built = buildFor(logicalId);
      const probe = chooseChainMember(built.survivorMembers, { scheduler, isModelAvailable: isModelAvailableFn });
      const withinCacheTtl =
        withinTtl &&
        ctxCounter.cacheDomainAtLast !== "" &&
        built.survivorMembers[probe.index]?.healthKey === ctxCounter.cacheDomainAtLast;
      const cfg = this.options.config.models[logicalId];
      return userLimit!.engine.affordable(
        userLimit!.resolution,
        logicalId,
        { cachedTokens: ctxCounter.cachedAtLast, newTokens: Math.max(0, observed - ctxCounter.cachedAtLast), withinCacheTtl },
        cfg ? additiveThinkingBudgetTokens(cfg, thinkingLevel) : 0,
      );
    };
    // The session's refusal handle (spec REFUSAL-HANDLING §8). A rule entry is
    // usable when the session's gates pass for it: capability (the reply's image
    // needs), health + budget + context fits over its own chain, and the user's
    // per-user limits. A model that refused is not excluded: explicit entries may
    // retry it (§8.1 tries).
    // The session's redo control (spec REFUSAL-HANDLING §8.4): the gate files a
    // redo, the run stops after the current tool batch (`shouldStopAfterTurn`
    // below), and the runner takes it.
    const redoControl = opts?.redoControl ?? new SessionRedoControl();
    const refusal = createSessionRefusalController({
      sessionType: session.sessionType,
      agent: refusalAgent,
      tasks: sessionTasks,
      sessionId: session.id,
      timelineKey: session.timelineKey,
      rules: refusalRules,
      catalogue: this.options.refusals?.catalogue,
      headModel: modelKey,
      knownModel: (id) => this.options.config.models[id] !== undefined,
      chainOf: (id) => {
        try {
          return resolveModelChain(id, this.options.config.models).map((m) => m.logicalId);
        } catch {
          return [id];
        }
      },
      isUsable: (logicalId) => {
        const cfg = this.options.config.models[logicalId];
        if (!cfg) return false;
        if (requiresMultimodal && !cfg.input_modalities.includes("image")) return false;
        const built = buildFor(logicalId);
        refreshRunningContext();
        const pick = chooseChainMember(built.survivorMembers, {
          scheduler,
          isModelAvailable: isModelAvailableFn,
          observedContextTokens: ctxCounter.seenMsgs < 0 ? undefined : ctxCounter.running,
        });
        if (pick.reason === "all-unhealthy") return false;
        return !userSelectionActive || affordableNow(logicalId).ok;
      },
      initialPin: resumedPin,
      persistPin: this.options.storage?.setAgentSessionRefusalPin
        ? (pin) => this.options.storage!.setAgentSessionRefusalPin(session.id, pin)
        : undefined,
      insertEvent: this.options.storage?.insertRefusalEvent
        ? (row) => this.options.storage!.insertRefusalEvent(row)
        : undefined,
      logger: this.options.logger,
    });
    // The acting gate policy (spec REFUSAL-HANDLING §6.3–§6.4): built once the
    // refusal handle and the redo control exist; observe-only without it.
    if (outputGate && this.options.outputChecks?.actingPolicy) {
      const acting = this.options.outputChecks.actingPolicy(session, { refusal, redoControl });
      if (acting) outputGate.policy = acting;
    }
    // Sticky refusal redo (spec REFUSAL-HANDLING §8.3): once a rule pinned the
    // session to an entry, every later request (the record turn included) goes to
    // that entry with its own fallback chain, over the routed cascade and the
    // per-user preference list. Under per-user limits the entry is the requested
    // model: billed to the session's payee, counted on its caps, output capped at
    // its affordable headroom.
    const sessionStreamFn: StreamFn = (m, context, streamOptions) => {
      // The pin, or a same-model retry's target for the rest of this request.
      const pinned = refusal.dispatchModel();
      if (pinned === undefined) return admittedStreamFn(m, context, streamOptions);
      requestedMember.logicalId = pinned;
      let opts2 = streamOptions;
      if (userSelectionActive) {
        const aff = affordableNow(pinned);
        if (aff.ok) opts2 = { ...(streamOptions ?? {}), maxTokens: aff.maxOutput } as typeof streamOptions;
      }
      return buildFor(pinned).streamFn(m, context, opts2);
    };
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
    usage.setPaidServiceCeiling(costCeiling);
    // Request progress (§8 "Late input" abort rule): call → admission → first event → end.
    const requestProgress = new RequestProgress(scheduler !== undefined);
    // The last billed request's prompt (any session, per-user or not): the cache
    // read an aborted request's input estimate credits (§8b "Aborted requests").
    const lastPromptBaseline: PromptCacheBaseline = { tokens: 0, atMs: 0, healthKey: "" };
    const healthKeyOf = (logicalId: string): string => {
      const cfg = this.options.config.models[logicalId];
      return cfg ? modelHealthKey({ baseUrl: cfg.endpoint, id: cfg.id }) : logicalId;
    };
    // The Layer-0 commit of one billed request (spec TOKEN-USAGE-TRACKING §3.1):
    // feeds the tracker AND (spec USAGE-COST-LIMITS §3.1) emits one per-request
    // agent-loop row to the unified `usage_events` ledger + increments the
    // BudgetEngine. The ledger write is additive — the §8b
    // `agent_sessions.usage_*` aggregate is still maintained by the tracker's
    // persistence subscriber. `est` is set for a request the run aborted on the
    // wire (§8b "Aborted requests"): its estimated usage replaces the message's,
    // and the row is flagged `estimated`.
    const commitRequest = (message: AssistantMessage, est?: AbortedRequestEstimate): void => {
      // A clean commit ends the request: the models that refused it may serve
      // the next one (a refused attempt's usage arrives here too, §10.3).
      if (message.stopReason !== "error" && message.stopReason !== "aborted") refusal.noteCommitted();
      // Same billed-model expression the ledger row below uses (spec
      // MODEL-FALLBACK §2.2/§6.1): the committed message's own `model` when
      // the provider reports one, else this attempt's descriptor. Feeding it
      // to the tracker is what lets the durable `agent_sessions.model_id`
      // agree with the ledger under fallback / per-user model selection,
      // instead of freezing the session type's configured model.
      usage.record(est?.usage ?? message.usage, message.model ?? model.id);
      // Served-member attribution on the transcript (spec REFUSAL-HANDLING
      // §7.1): the committed message is the object the agent stores.
      stampServedModel(message, resolvedMember.logicalId);
      // Tool-result budget reset (spec TOOL-RESULT-BUDGET §4): each committed
      // LLM request starts a fresh tool-result turn; the accumulator resets so
      // the next batch of tool calls gets the full per-turn budget again.
      turnBudget.reset();
      if (userSelectionActive && est) {
        // An aborted request (§8b "Aborted requests") wrote the prompt cache only
        // when its stream started (LATE-INPUT §3): only then does it advance the
        // baseline, from its (reported or estimated) prompt size. The running
        // counter is reconciled only against a provider-reported input.
        if (est.firstEventSeen) {
          refreshRunningContext();
          if (est.inputReported) ctxCounter.running = est.promptTokens;
          ctxCounter.cachedAtLast = est.promptTokens;
          ctxCounter.lastRequestAtMs = Date.now();
          ctxCounter.cacheDomainAtLast = est.healthKey;
        }
      } else if (userSelectionActive) {
        // Advance the prompt-cache baseline (spec §5.3): the just-committed
        // request's prompt is now the cached prefix for the NEXT request's
        // estimate, dated for the cache-TTL test.
        refreshRunningContext();
        // Reconcile the running estimate against the provider-reported actual —
        // the committed request's totalTokens, the same authority the resume
        // seed and the (non-per-user) context gate use. Without this the counter
        // only ever accumulates estimator error, and once the drift crossed a
        // model's operative window the §4.2 fits check terminated a healthy
        // rollout ("no healthy model fits") at a real context far below the
        // ceiling — recoverable only by a manual resume (whose seed IS this
        // actual). The committed assistant turn is not yet in `state.messages`;
        // its later re-estimate overlaps the output already inside the actual —
        // a small over-count (one turn's output), erased at the next commit.
        const actual = usage.snapshot().contextTokens;
        if (actual !== null) ctxCounter.running = actual;
        ctxCounter.cachedAtLast = ctxCounter.running;
        ctxCounter.lastRequestAtMs = Date.now();
        // Stamp the cache domain this commit established: the served chain
        // member's health key (endpoint::wire-model — the upstream identity a
        // prompt cache is scoped to). The next pre-flight credits the cache-read
        // discount only to candidates predicted to be served from this same
        // domain; any other candidate is priced as a cache miss. The logical-id
        // fallback (member not found in the dispatched composite — shouldn't
        // happen) can only mismatch, i.e. deny credit: conservative.
        ctxCounter.cacheDomainAtLast =
          activeSelection.fallback.survivorMembers.find(
            (m) => m.logicalId === resolvedMember.logicalId,
          )?.healthKey ?? resolvedMember.logicalId;
      }
      const budget = this.options.budget;
      if (budget?.record) {
        const u = est?.usage ?? message.usage;
        const cost = u.cost?.total ?? 0;
        // Per-user limits attribution (spec PER-USER-LIMITS §7): the REQUESTED
        // virtual model the per-user selector chose for this request (distinct from
        // `logical_model_id` under active fallback), null when per-user selection is
        // inactive. The SHARED-POOL key set (spec MULTI-SHARED-POOL §4) is NOT
        // computed here: app.ts's `recordUsageEvent` fan-in owns it for BOTH the
        // agent loop and the tool lane, model-aware via `sharedPoolKeys`, so the
        // stamping lives in exactly one place. The in-memory partitioned counter
        // records the ACTUAL served cost against the requested model's covering
        // meters (incl. every shared pool) before the ledger write.
        const requestedModelId = userSelectionActive ? requestedMember.logicalId : null;
        // The partitioned per-user counter is incremented centrally in app.ts's
        // `recordUsageEvent` fan-in (the single place that covers BOTH the agent
        // loop AND its tool lane, §6), keyed off the stamped `requestedModelId`.
        // Here we only surface a budget-capped (output-truncated) turn — a
        // degradation signal, not an organic completion (spec §5.4/§14).
        if (userSelectionActive && message.stopReason === "length") {
          this.options.logger?.info("user_limit_output_capped", {
            sessionId: session.id,
            timelineKey: session.timelineKey,
            requestedModel: requestedMember.logicalId,
            servedModel: resolvedMember.logicalId,
            maxTokens: activeSelection.maxTokens,
            outputTokens: u.output ?? null,
          });
        }
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
          requestedModelId,
          // The model prompt the served member sent (ARCHITECTURE.md §8 "Model prompts").
          modelPrompt: modelPrompts.get(resolvedMember.logicalId)?.profile ?? null,
          modelPromptHash: modelPrompts.get(resolvedMember.logicalId)?.hash ?? null,
          // The frozen, model-neutral system prompt (spec REFUSAL-HANDLING §12.4).
          systemPromptHash,
          provider: message.provider ?? model.provider ?? null,
          inputTokens: u.input ?? null,
          outputTokens: u.output ?? null,
          cacheReadTokens: u.cacheRead ?? null,
          cacheWriteTokens: u.cacheWrite ?? null,
          costUsd: cost,
          ...(est ? { estimated: true } : {}),
        });
      }
      if (!est) {
        const u = message.usage;
        lastPromptBaseline.tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        lastPromptBaseline.atMs = Date.now();
        lastPromptBaseline.healthKey = healthKeyOf(resolvedMember.logicalId);
      } else if (est.firstEventSeen) {
        lastPromptBaseline.tokens = est.promptTokens;
        lastPromptBaseline.atMs = Date.now();
        lastPromptBaseline.healthKey = est.healthKey;
      }
    };
    const retryingStreamFn = withRequestRetry(
      sessionStreamFn,
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
        // Served-model attribution (per-attempt ring, served-model attribution):
        // getRequestedModel reads requestedMember.logicalId (modelKey for
        // non-per-user; per-user selected id for per-user sessions — set by
        // admittedStreamFn before dispatch). getServedModel reads
        // servedModelForAttempt, which onResolve sets synchronously inside
        // base() BEFORE the attempt stream is returned, so the value at settle
        // time always belongs to THIS attempt. resetServedModel clears it at the
        // start of each loop iteration so no stale value from a prior attempt
        // survives (budget-violation pre-flight never calls resetServedModel →
        // getServedModel() returns undefined there as desired).
        getRequestedModel: () => requestedMember.logicalId,
        refusalFallover: () => refusalFallover.enabled,
        // Refusal rules replace the implicit fallover when one matches (spec
        // REFUSAL-HANDLING §8.1); every refused attempt is recorded.
        onRefusal: (info) => refusal.onHardRefusal(info),
        getServedModel: () => servedModelForAttempt,
        resetServedModel: () => { servedModelForAttempt = undefined; },
        // Observability tap (spec LLM-FAILURE-HANDLING §4.2): raw attempt
        // events → per-session tentative bus → console SSE. Observe-only.
        // The output gate joins the same tap to start judging a send at
        // `toolcall_end` (spec REFUSAL-HANDLING §6.3).
        ...withGateTap(
          {
            onAttemptEvent: (attempt: number, event: unknown) => {
              requestProgress.noteAttemptEvent();
              this.options.liveEvents?.publish(session.id, { type: "tentative_event", attempt, event });
            },
            ...(this.options.liveEvents
              ? {
                  onAttemptDiscarded: (attempt: number, reason: string) =>
                    this.options.liveEvents!.publish(session.id, { type: "attempt_discarded", attempt, reason }),
                }
              : {}),
          },
          outputGate,
        ),
        // Per-request usage capture (spec TOKEN-USAGE-TRACKING §3.1): the
        // committed `done` message's authoritative usage (see `commitRequest`).
        onRequestCommitted: (message: AssistantMessage) => commitRequest(message),
        // A request the run aborted on the wire is billed by the provider (§8b
        // "Aborted requests"): one estimated ledger row through the same commit.
        onRequestAborted: (info) => {
          const servedId = servedModelForAttempt ?? resolvedMember.logicalId;
          refreshRunningContext();
          const est = estimateAbortedRequestUsage(info, {
            costRates: this.options.config.models[servedId]?.cost,
            healthKey: healthKeyOf(servedId),
            promptEstimate: ctxCounter.running + (modelPrompts.get(servedId)?.tokens ?? 0),
            cacheBaseline: lastPromptBaseline,
            now: Date.now(),
          });
          commitRequest(info.message, est);
          this.options.logger?.info("llm_request_aborted", {
            sessionId: session.id,
            model: servedId,
            inputTokens: est.usage.input + est.usage.cacheRead + est.usage.cacheWrite,
            outputTokens: est.usage.output,
            estimated: true,
            inputReported: est.inputReported,
            costUsd: est.usage.cost.total,
            firstEventSeen: info.firstEventSeen,
          });
          return est.usage;
        },
        // Pre-flight context-budget enforcement (spec CONTEXT-LIMIT-UNIFICATION
        // §2.3 / PER-MEMBER-CONTEXT-FITS §2.3). Terminates only when the observed
        // context fits NO surviving member (observed > maxOperativeContextWindow —
        // the largest member's window). Until then, per-member fits in
        // chooseChainMember routes to a larger member as needed. The first request
        // is never blocked (no actuals yet — the provider is authority on an
        // oversized seed). D3 from TOKEN-USAGE-TRACKING is preserved verbatim.
        checkContextBudget: () => {
          // Per-user selection owns the context "fits" check per attempt (spec §6.2):
          // resolveUserSelection delegates to chooseChainMember with observedContextTokens,
          // and terminates via checkCostBudget when no selectable fits. Defer here.
          // A session pinned by a refusal rule (§8.3) is checked against the pinned
          // entry's chain, per-user or not.
          const pinnedModel = refusal.pinnedModel();
          if (userSelectionActive && pinnedModel === undefined) return undefined;
          const checked = pinnedModel !== undefined ? buildFor(pinnedModel) : fallback;
          const observed = usage.snapshot().contextTokens;
          const maxWindow = checked.maxOperativeContextWindow;
          // Block only when the context exceeds EVERY member's window (fits no member).
          if (observed === null || observed <= maxWindow) return undefined;
          // At this point: observed > maxWindow → no surviving member can serve.
          const skipped = checked.survivorMembers
            .filter((m) => m.operativeWindow < observed)
            .map((m) => m.logicalId);
          this.options.logger?.warn("session_context_limit_exceeded", {
            sessionId: session.id,
            timelineKey: session.timelineKey,
            sessionType: session.sessionType,
            model: model.id,
            observed,
            limit: maxWindow,
            membersSkippedOnFits: skipped,
          });
          const skipNote =
            skipped.length > 0 ? `; members skipped on fits: ${skipped.join(", ")}` : "";
          return (
            `context token limit exceeded: observed context ${observed} tokens > ` +
            `max member window ${maxWindow} (model ${model.id}, session type ${session.sessionType}${skipNote})`
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
              timelineKey: session.timelineKey ?? undefined,
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
          // Capability-deny terminal (#3, spec §4.2): an ACTIVE per-user rule whose
          // entire preference set was emptied by the capability pre-filter (e.g. an
          // image trigger against a text-only user model set) is a TERMINAL per-user
          // outcome — a content-class deny (no retry burn) — not a fall-through to the
          // ungated default. Enforced on every request (the mismatch is structural).
          if (userSelectionCapabilityDenied) {
            this.options.logger?.warn("usage_limit_blocked", {
              gate: "user_preflight",
              sessionId: session.id,
              timelineKey: session.timelineKey,
              userId: userLimit!.ctx.userId,
              cause: "capability",
            });
            return (
              `per-user selection: no model in the user's set can serve this request's ` +
              `content (capability mismatch) for ${userLimit!.ctx.userId}`
            );
          }
          // Per-user selection + estimation (spec PER-USER-LIMITS §6.2): re-resolve the
          // preferred model PER REQUEST against the live partitioned counters, stash
          // the chosen composite + budget-derived output cap for the outer selector,
          // and terminate (content-class, no retry burn) only when NO preference
          // qualifies — degradation finishes the rollout on a cheaper model rather than
          // guillotining it. The resolver reads the exact running context counter and
          // the prompt-cache split internally (§5.3).
          // A session pinned by a refusal rule (REFUSAL-HANDLING §8.3) stays on the
          // pinned entry: it is the requested model, and only its affordability
          // decides; the preference list is not consulted again.
          const pinnedForUser = userSelectionActive ? refusal.pinnedModel() : undefined;
          if (pinnedForUser !== undefined) {
            if (!affordableNow(pinnedForUser).ok) {
              this.options.logger?.warn("usage_limit_blocked", {
                gate: "user_preflight",
                sessionId: session.id,
                timelineKey: session.timelineKey,
                userId: userLimit!.ctx.userId,
                cause: "budget",
                pinnedModel: pinnedForUser,
              });
              return `per-user budget exhausted: the pinned refusal-redo model ${pinnedForUser} is not affordable for ${userLimit!.ctx.userId}`;
            }
            userLimit!.engine.noteSelection(session.id, userLimit!.ctx.userId, userLimit!.ctx.roomId, pinnedForUser);
          } else if (userSelectionActive) {
            const picked = resolveUserSelection();
            if (picked.ok) {
              activeSelection = picked.selection;
              // Surface the live selection for the console (spec §14).
              userLimit!.engine.noteSelection(
                session.id,
                userLimit!.ctx.userId,
                userLimit!.ctx.roomId,
                picked.selection.requestedLogicalId,
              );
            } else {
              const binding = userLimit!.engine.bindingConstraint(userLimit!.resolution);
              // Distinguish terminal cause: budget (fits+healthy but unaffordable),
              // context (no selectable fits the accumulated context at all), or
              // outage (something fits context-wise but all healthy members are down).
              const terminalCause = picked.budget ? "budget" : picked.contextDenied ? "context" : "outage";
              this.options.logger?.warn("usage_limit_blocked", {
                gate: "user_preflight",
                sessionId: session.id,
                timelineKey: session.timelineKey,
                userId: userLimit!.ctx.userId,
                cause: terminalCause,
                binding: binding
                  ? { partitionKey: binding.partitionKey, capUsd: binding.cap, models: binding.modelScope }
                  : undefined,
              });
              return picked.budget
                ? `per-user budget exhausted: no affordable model remains for ${userLimit!.ctx.userId}`
                : picked.contextDenied
                ? `per-user selection: context exceeds all model windows for ${userLimit!.ctx.userId}`
                : `per-user selection: no healthy model is available for ${userLimit!.ctx.userId}`;
            }
          }
          return undefined;
        },
        // §5.4 budget-capped re-drive: a `length`-truncated turn that hit the per-user
        // output cap (below the served model's own `max_tokens`) is failed-not-
        // delivered. The counter was just incremented by the truncated spend, so
        // re-running the resolver picks the next-cheaper model (its reserved
        // headroom). Bounded by the preference-set size. Only wired for per-user
        // sessions (so non-per-user truncations deliver normally).
        ...(userSelectionActive
          ? {
              onBudgetTruncation: (committed: AssistantMessage): "reselect" | "accept" => {
                // A pinned session (refusal redo, §8.3) has no cheaper model to move to.
                if (refusal.pinnedModel() !== undefined) return "accept";
                const cap = activeSelection.maxTokens;
                // Disambiguate budget-cap vs legitimate length stop against the
                // REQUESTED model's OWN `max_tokens` — the value `cap` was derived from
                // (`affordable` returns `min(requestedModelMax, affordableBase)`), NOT
                // the SERVED fallback member's max (#9). Using the served member's max
                // mis-compares a requested-derived cap against a different model under
                // active fallback. This stays correct after #4: when the budget did not
                // bind, `cap == requestedModelMax` (≥ the natural max) → a genuine long
                // answer, deliver; when it bound, `cap < requestedModelMax` → a budget
                // cap, re-drive on a cheaper model with reserved headroom.
                const requestedDefault =
                  this.options.config.models[requestedMember.logicalId]?.max_tokens ?? Number.POSITIVE_INFINITY;
                if (cap === undefined || cap >= requestedDefault) return "accept";
                // Bound re-drives by the number of distinct preferred models — once
                // each has had a turn, the floor is reached; deliver what we have.
                if (budgetTruncationCount >= selectables.length) return "accept";
                const prev = requestedMember.logicalId;
                const picked = resolveUserSelection();
                if (picked.ok && picked.selection.requestedLogicalId !== prev) {
                  budgetTruncationCount++;
                  activeSelection = picked.selection;
                  userLimit!.engine.noteSelection(
                    session.id,
                    userLimit!.ctx.userId,
                    userLimit!.ctx.roomId,
                    picked.selection.requestedLogicalId,
                  );
                  this.options.logger?.info("user_limit_redrive", {
                    sessionId: session.id,
                    timelineKey: session.timelineKey,
                    from: prev,
                    to: picked.selection.requestedLogicalId,
                    truncatedOutputTokens: committed.usage?.output ?? null,
                  });
                  return "reselect";
                }
                return "accept"; // no cheaper model remains (the floor) → deliver
              },
            }
          : {}),
      },
    );
    const streamFn = withRequestProgress(retryingStreamFn, () => requestProgress);

    // Load workspace files from disk at session creation time
    const workspace = earlyWorkspace ?? (await loadWorkspace(workspaceRoot, sessionTypeConfig));

    // Per-agent MCP server allowlist (spec PER-AGENT-MCP-SCOPING): drop tools
    // from MCP servers not in this agent's allowlist, then apply the session-type
    // tool allowlist. Both filters compose as an intersection: a session type
    // that allowlists an MCP tool excluded by the agent's mcp_servers simply
    // doesn't get it (silent no-op, same as allowlisting a server the deploy
    // doesn't configure). Non-MCP tools are never affected.
    const agentName = this.options.resolveAgentName?.(session.timelineKey) ?? null;
    const agentMcpServers =
      agentName !== null ? this.options.config.agents?.[agentName]?.mcp_servers : undefined;
    const mcpToolServerMap = this.options.mcpToolServerMap ?? new Map<string, string>();
    const mcpFilteredTools = filterMcpToolsByAllowlist(tools, agentMcpServers, mcpToolServerMap);
    const filteredTools = filterTools(mcpFilteredTools, sessionTypeConfig);
    workspace.skills = eligibleSkillIndex(workspace.skills, filteredTools.map(tool => tool.name));
    workspace.runtimeNotices = [...new Set(filteredTools.map((tool) => (tool as AgentTool & { availabilityNotice?: string }).availabilityNotice).filter((notice): notice is string => !!notice))];
    const logger = this.options.logger;

    // Dynamic tool loading (spec DYNAMIC-TOOL-LOADING). Gate: the global config
    // switch AND the session type's stance — unset defaults to "dynamic only
    // for session types WITHOUT an explicit tools allowlist" (a hand-picked set
    // is already the operator's chosen full set; deferring it would only strand
    // tools they explicitly asked for, §4).
    const dynCfg = this.options.config.agent.tools?.dynamic;
    const dynamicEnabled =
      (dynCfg?.enabled ?? false) &&
      (sessionTypeConfig?.tools_dynamic ?? sessionTypeConfig?.tools === undefined);
    // Late-bound registry holder: the loading tools close over it, but the
    // registry itself wraps the WRAPPED catalog (which includes those tools).
    const dynRef: { registry?: DynamicToolRegistry } = {};
    const sessionCatalog: AgentTool[] = dynamicEnabled
      ? [
          ...filteredTools.map((tool) =>
            tool.name === "str_replace_based_edit_tool"
              ? wrapEditorWithSkillActivation(tool, {
                  workspaceRoot,
                  getRegistry: () => dynRef.registry,
                  logger,
                  sessionId: session.id,
                })
              : tool,
          ),
          // load_skill only when the skill filter yields at least one listed
          // skill (spec §5) — with none, the tool could only ever error.
          ...(workspace.skills.listed.length > 0
            ? [
                createLoadSkillTool({
                  workspaceRoot,
                  skills: workspace.skills,
                  getRegistry: () => dynRef.registry,
                  logger,
                  sessionId: session.id,
                }),
              ]
            : []),
          createToolSearchTool({
            getRegistry: () => dynRef.registry,
            logger,
            sessionId: session.id,
          }),
        ]
      : filteredTools;

    // Prefill: if any chain member has prefill enabled, wrap all catalog tools to
    // accept an optional analysis argument (so canonical schema validation passes
    // and transcripts keep the argument). Silence is the catalog's no_reply tool,
    // present in every chat session, so nothing is added here.
    const chain = resolveModelChain(modelKey, this.options.config.models);
    const prefillText = chain.find(
      (m) => m.config.prefill?.enabled && m.config.prefill.text,
    )?.config.prefill?.text;
    // Late input (§8 "Late input"): redo-safe results are replayed from the
    // session's store innermost, so the stored result is the raw one; the key
    // is the call's arguments as the transcript holds them.
    const replayCatalog = opts?.lateInput
      ? opts.lateInput.wrapReplayTools(sessionCatalog, () => agentRef.agent?.state.messages ?? [])
      : sessionCatalog;
    const prefillCatalog = prefillText
      ? replayCatalog.map(wrapToolWithAnalysisStripping)
      : replayCatalog;

    // Wrap each catalog tool with the result-shaping layer (spec TOOL-RESULT-BUDGET
    // §2) BEFORE the dynamic split, so dynamically loaded tools get result shaping
    // identically to immediate ones (the wrapper spreads the result, preserving
    // `addedToolNames`). Simple per-session counter cap for truncation log
    // rate-limiting: 20 events/session prevents log floods while still catching
    // the first burst (spec §6).
    let _truncationLogCount = 0;
    const budgetedTools = wrapToolsWithResultBudget(prefillCatalog, {
      resultMaxTokens,
      turnBudget,
      getRunningContext: () => {
        // refreshRunningContext() is synchronous; calling it here ensures the
        // counter reflects any live messages appended since the last LLM request.
        refreshRunningContext();
        return ctxCounter.running;
      },
      onTruncation: logger
        ? (info) => {
            _truncationLogCount++;
            if (_truncationLogCount <= 20) {
              logger.info("tool_result_truncated", {
                sessionId: session.id,
                tool: info.tool,
                layer: info.layer,
                fromTokens: info.fromTokens,
                toTokens: info.toTokens,
                turnAccumulated: info.turnAccumulated,
              });
            }
          }
        : undefined,
    });
    // The record-turn gate (spec SESSION-RECORDS §3.2) wraps the FINAL tool list,
    // so the loading tools created above obey it like the app's own tools: while
    // the record turn runs only session_record_tool executes, outside it
    // session_record_tool never does. Definitions are untouched (wire-stable).
    // The output gate (spec REFUSAL-HANDLING §6.1) wraps inside the record-turn
    // gate, so a call the record turn blocks is never judged, and outside the
    // prefill stripping, so it sees the call's `analysis` argument.
    const outputGatedTools = outputGate ? wrapToolsWithOutputGate(budgetedTools, outputGate) : budgetedTools;
    // The irreversibility hold (§8 "Late input") wraps outside the output gate, so
    // the gate's evaluation (started at toolcall_end) runs during the hold.
    const gatedTools = opts?.lateInput ? opts.lateInput.wrapHoldTools(outputGatedTools) : outputGatedTools;
    const wrappedTools = opts?.recordTurnGate
      ? wrapToolsWithRecordTurnGate(gatedTools, opts.recordTurnGate)
      : gatedTools;

    // The per-session registry (spec §7): immediate = config patterns ∪ the
    // loading tools ∪ any always_loaded skill's declared tools. Resume recomputes
    // the loaded set from the persisted transcript — the transcript is the single
    // source of truth (immediate ∪ every addedToolNames on any tool result),
    // definitionally consistent with what pi-ai's serializers derive from the
    // same messages.
    let registry: DynamicToolRegistry | undefined;
    if (dynamicEnabled) {
      const catalogNames = wrappedTools.map((t) => t.name);
      const immediate = new Set(matchToolPatterns(catalogNames, dynCfg?.immediate ?? []));
      for (const tool of wrappedTools) {
        const loading = (tool as AgentTool & { initialLoading?: string }).initialLoading;
        if (loading === "immediate") immediate.add(tool.name);
        if (loading === "deferred") immediate.delete(tool.name);
      }
      // The prefill `no_reply` tool (spec OPENAI-PREFILL) exists so a session under
      // tool_choice = "required" can end a turn silently; deferred behind
      // tool_search it could not, so it is always in the initial wire set.
      if (catalogNames.includes("no_reply")) immediate.add("no_reply");
      immediate.add("load_skill");
      immediate.add("tool_search");
      for (const skill of workspace.skills.inlined) {
        if (!skill.tools) continue;
        for (const name of matchToolPatterns(catalogNames, skill.tools)) immediate.add(name);
      }
      // read_session_record is reactive (spec SESSION-RECORDS §5: a user points at
      // a bot message with no other cue) and the target of every record injection,
      // so it is immediate whenever wired, like the loading tools; deployments
      // replace `immediate` wholesale and must not be able to drop it.
      if (catalogNames.includes("read_session_record")) immediate.add("read_session_record");
      // Harness-only tools are never immediate, whatever the config patterns or an
      // inlined skill say (spec SESSION-RECORDS §3.2): the record turn loads them.
      for (const tool of wrappedTools) {
        if (tool.harnessOnly) immediate.delete(tool.name);
      }
      // §4: a skill whose tools patterns match nothing in this session's catalog —
      // not an error (catalogs legitimately vary per agent/session type), but
      // worth one warning per session.
      for (const skill of [...workspace.skills.listed, ...workspace.skills.inlined]) {
        if (skill.tools && matchToolPatterns(catalogNames, skill.tools).length === 0) {
          logger?.warn("skill_tools_unmatched", {
            sessionId: session.id,
            skill: skill.name,
            patterns: skill.tools,
          });
        }
      }
      registry = new DynamicToolRegistry(wrappedTools, immediate);
      dynRef.registry = registry;
      declaredRef.set = { catalog: registry.catalogTools, immediate: registry.immediateNames };
      // I3 legacy compat: old rows written before W5 stored the preloaded tool names
      // directly in initial_preloads.tools.  Load them before seedFromTranscript so
      // the transcript-derived addedToolNames layer on top of, not instead of, the
      // tools the session was originally created with.  Read-only — never persisted.
      if (opts?.resume && persistedRouting?.legacyTools?.length) {
        registry.load(persistedRouting.legacyTools);
      }
      if (opts?.resume?.transcript?.length) {
        registry.seedFromTranscript(opts.resume.transcript);
      }
      // §5/§8 prompt state: hidden skill paths + the deferred-tools index. Set on
      // the shared `workspace` object BEFORE either system-prompt render (here and
      // inside ContextBuilder.build) so both stay byte-identical.
      const deferred = registry.deferredTools();
      workspace.dynamicTools = {
        // Harness-only tools are excluded from the rendered index (CONTRACT §2):
        // they are deferred for wire-array stability but must not be shown.
        indexText: renderDeferredToolsIndex(
          filterHarnessOnlyFromIndex(deferred),
          [...workspace.skills.listed, ...workspace.skills.inlined],
          dynCfg?.index ?? "orphans",
        ),
      };
    }
    // Decision-model routing preloads (ARCHITECTURE.md §8h). Applied AFTER the
    // deferred-tools index above, so the system prompt (and the cached prefix) is
    // byte-identical to an unrouted session's. Skill preloads now enter the
    // transcript as synthetic load_skill calls (W5) rather than as satellite text
    // or registry.loadInitial().  On resume, seedFromTranscript picks up the
    // addedToolNames from those synthetic toolResult messages and re-derives the
    // loaded set without any explicit loadInitial call.
    const routingSkillSpecs: SyntheticCallSpec[] = [];
    let routedSatellite: RoutedSatellite | undefined;
    // A task without a routing verdict (a proactive session's built-in task) is
    // persisted too, so the model behaviour statistics and the audit see it.
    if (!opts?.resume && !routing && sessionTasks && sessionTasks.length > 0) {
      void this.options.storage
        ?.setSessionInitialPreloads(session.id, { skills: [], tasks: sessionTasks })
        .catch((error) =>
          logger?.warn("routing_preloads_persist_failed", {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
    }
    if (!opts?.resume && routing) {
      // Tail files only — skills are no longer inlined into the satellite.
      routedSatellite =
        routing.tailFiles.length > 0
          ? await this.buildRoutedSatellite(routing, { workspace, workspaceRoot, sessionId: session.id })
          : { preloadedSkills: [], tailFiles: [] };
      const state: SessionRoutingState = {
        skills: routing.skills.filter(name => workspace.skills.listed.some(skill => skill.name === name)),
        ...(routedHead ? { model: routedHead } : {}),
        ...(userSelection && routedCascade.length > 0 ? { cascade: routedCascade } : {}),
        ...(routedThinking ? { thinkingLevel: routedThinking } : {}),
        ...(sessionTasks && sessionTasks.length > 0 ? { tasks: sessionTasks } : {}),
      };
      if (state.skills.length > 0 || state.model || state.cascade || state.thinkingLevel || state.tasks) {
        void this.options.storage
          ?.setSessionInitialPreloads(session.id, state)
          .catch((error) =>
            logger?.warn("routing_preloads_persist_failed", {
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      }
      logger?.info("routing_applied", {
        sessionId: session.id,
        task: routing.task,
        tasks: sessionTasks,
        skills: routing.skills,
        tailFiles: routing.tailFiles,
        thinkingLevel: routedThinking,
      });
      // One synthetic load_skill spec per preloaded skill.  They are executed
      // below (after agent + registry.onChange are both wired) so the registry
      // load, tool-definition charge, and harness marker all land correctly.
      for (const name of state.skills) {
        routingSkillSpecs.push({
          name: "load_skill",
          params: { name },
          harness: {
            kind: "injection",
            ...(routing.decisionGroup ? { decisionGroup: routing.decisionGroup } : {}),
          },
        });
      }
    }
    // The session's initial wire tool set: immediate-only under dynamic loading,
    // the full wrapped catalog otherwise.
    const initialTools = registry ? registry.current : wrappedTools;

    // NOTE: System prompt is rendered identically here and in ContextBuilder.build().
    // Both are required: this one sets initialState.systemPrompt (used by pi-agent-core
    // on every API call), and the builder's version populates the system message in
    // transformContext output. They must produce identical results.
    const systemPrompt = renderSystemPrompt(workspace, fallbackPrompt);
    // Short hash of it for the ledger rows (observed prompt changes, spec
    // REFUSAL-HANDLING §12.4); the per-model preamble is covered by model_prompt_hash.
    const systemPromptHash = systemPromptHashOf(systemPrompt);

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
    let builtTimelineCutoff: number | undefined;
    let builtSummaryCoverage: SummaryCoveragePin | undefined;
    if (opts?.resume) {
      // Defensive copy: the resume snapshot is a persisted array owned by the caller
      // (parsed `context_snapshot_json`). Copying it keeps the live runtime prefix
      // from aliasing — and freezing — the caller's array (§6).
      frozenBaseSeed = [...opts.resume.snapshot];
      // Seed the per-user running-input estimate from the RESUMED context size (#1).
      // The fresh-build branch sets `initialContextEstimate` from `built.tokenEstimate`;
      // the resume branch never builds, so without this the first
      // `refreshRunningContext()` would mark the whole resumed transcript+snapshot as
      // already-counted against a 0 baseline → input_cost ≈ $0 → the §5.3 output cap is
      // removed and §5.4 degradation never fires (uncapped overshoot on every reply-
      // resume / follow-up-resume / continue-mode recovery). Prefer the last committed
      // request's actual context size (`usage.snapshot().contextTokens`, already loaded
      // for continue-mode via `usageSeedFromRow`); fall back to the summed snapshot +
      // transcript `tokenEstimate`s when no actuals exist (a fresh-mode resume that
      // never committed — though that path rebuilds and does not enter this branch).
      initialContextEstimate.value =
        usage.snapshot().contextTokens ??
        sumMessageTokenEstimates(opts.resume.snapshot) +
          sumMessageTokenEstimates(opts.resume.transcript ?? []);
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
          // Thread the per-agent model's vision capability (spec FIX 5 — resume path).
          replyModelCanSeeImages,
        });
      }
    } else {
      const built = await this.buildContext({
        timelineKey: session.timelineKey,
        trigger: session.trigger.event,
        workspace,
        sessionType: sessionTypeConfig,
        fallbackPrompt,
        // The session's real, post-allowlist INITIAL tool set — so the frozen
        // estimate accounts for the tool-definition block the provider charges
        // for (the dominant estimate-vs-actual gap). Under dynamic loading this
        // is the immediate set (deferred definitions are charged at load time by
        // the registry's onChange hook, spec DYNAMIC-TOOL-LOADING §9).
        // `initialTools` (AgentTool[]) structurally satisfies the wire subset.
        tools: initialTools,
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
        // Thread the per-agent model's vision capability so the builder's
        // pixel-block gate reflects the actual serving model (spec FIX 5).
        replyModelCanSeeImages,
        routedSatellite,
        timelineCutoff: opts?.timelineCutoff,
        summaryCoverage: opts?.summaryCoverage,
        memoryRetrieval: opts?.memoryRetrieval,
      });
      builtTimelineCutoff = built.timelineCutoff;
      builtSummaryCoverage = built.summaryCoverage;
      await dumpBuiltContext(
        this.options.config.app.context_dump_dir,
        session.timelineKey,
        session.id,
        built,
        session.trigger.event.id,
        (() => {
          const head = modelPrompts.get(modelKey);
          return head
            ? { member: modelKey, profile: head.profile, hash: head.hash, preamble: head.preamble, tail: head.tail }
            : undefined;
        })(),
      ).catch(() => undefined);
      // Single source of truth for the prefix/trigger boundary: `splitBuiltContext`
      // computes the trailing-live-turn cut once and returns BOTH the runtime prefix
      // (`frozenBase`) and the raw-`built.messages` persistence prefix (`snapshot`),
      // so the two cannot drift if the terminal-type detection ever changes (§3 / §10a).
      const split = splitBuiltContext(built);
      frozenBaseSeed = split.frozenBase;
      // The build's cutoff rides on the transcript head: the duplicate check's
      // last-seen point, read back after a resume, revival or redo (§8j).
      finalTurn =
        split.finalTurn && built.timelineCutoff !== undefined
          ? withSeenStamp(split.finalTurn, { timelineKey: session.timelineKey, upTo: built.timelineCutoff })
          : split.finalTurn;
      snapshot = split.snapshot;
      snapshotTokenEstimate = built.tokenEstimate;
      snapshotCompactTokens = built.compactTokens;
      snapshotRichTokens = built.richTokens;
      renderedInputIds = built.renderedInputIds;
      // Seed the per-user first-request affordability estimate (§5.3) with the built
      // context size — the only input basis before any request commits actuals.
      initialContextEstimate.value = built.tokenEstimate ?? 0;
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

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: initialTools,
        // Extended thinking (config `thinking_level`, default off): flows per
        // request as pi-ai `options.reasoning` through the whole streamFn chain
        // (retry → admission → streamSimple). The model descriptor's
        // `reasoning` flag above only declares capability; this is what
        // actually requests thinking.
        thinkingLevel,
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
      // Explicit prompt-cache breakpoints (Bedrock's checkpoint-based cache for
      // OpenAI models; extra Anthropic cache_control markers on the stable
      // timeline).  The injector is installed for every
      // session; it gates on the serving member's Model descriptor
      // (compat.cacheBreakpoints === "explicit", set in createModelFromConfig) so
      // fallback members without the option — e.g. a direct-OpenAI model in the
      // same chain as a Bedrock head — pass their payloads through unchanged.
      // pi-ai passes the wire Model as the second arg to onPayload, so the gate
      // follows whichever chain member is actually serving the attempt.
      // See ARCHITECTURE.md §8 "Cache control".
      onPayload: (() => {
        const breakpoints = makeBreakpointInjector(estimateTokens);
        const prefill = makePrefillInjector();
        const dropReasoning = makeDropReasoningInjector();
        const deferLoading = makeDeferLoadingInjector(() => declaredRef.set);
        return (payload: unknown, model: unknown) =>
          deferLoading(dropReasoning(prefill(breakpoints(payload, model), model), model), model);
      })(),
      steeringMode: "one-at-a-time",
      sessionId: session.timelineKey,
      // A pending redo (spec REFUSAL-HANDLING §8.4) stops the run once the
      // current tool batch settled: sibling calls finish (their results belong
      // to the message a sibling-edit fork keeps), and no further request is
      // made on the output about to be discarded. The runner then takes it.
      shouldStopAfterTurn: () => redoControl.peek() !== undefined,
      // Dynamic tool loading (spec DYNAMIC-TOOL-LOADING §7): a load event mid-run
      // must reach the CURRENT run's next provider request — the loop snapshots
      // tools at run start, so this hook swaps in the registry's current array.
      // The loaded set only grows, so a length comparison detects change.
      ...(registry
        ? {
            prepareNextTurnWithContext: (ctx: PrepareNextTurnContext) => {
              const current = registry.current;
              if ((ctx.context.tools?.length ?? 0) >= current.length) return undefined;
              return { context: { ...ctx.context, tools: current } };
            },
          }
        : {}),
    });
    agentRef.agent = agent;
    // Late input (§8 "Late input"): bind the controller to this agent, and record
    // each held call's wait on its tool result (shown on the console's card).
    if (opts?.lateInput) {
      const lateInput = opts.lateInput;
      lateInput.bind(agent, requestProgress);
      agent.subscribe((event) => {
        if (event.type !== "message_end") return;
        const message = event.message as { role?: unknown; toolCallId?: unknown };
        if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return;
        const hold = lateInput.holdRecordFor(message.toolCallId);
        if (hold) (message as { lateInputHold?: unknown }).lateInputHold = hold;
      });
    }
    // A delivered message ends the refusal point: a later refusal starts its rule
    // from the first entry (spec REFUSAL-HANDLING §8.1 "Tries and same-model retries").
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end" && !event.isError && isPostingTool(event.toolName)) {
        refusal.noteDelivered();
      }
    });
    if (registry) {
      // Between-run pickup + accounting (spec §7/§9): reassert `agent.state.tools`
      // so the NEXT run's snapshot sees the loaded set (steering/follow-up/forced-
      // completion runs), and charge the running context counter with the added
      // definitions — they enter the wire tools channel from the next request on.
      // Assigned here (after `agent` exists) so the closure never touches the
      // binding before initialization; load events only fire during tool
      // execution, which is always after this point.
      registry.onChange = (added) => {
        agent.state.tools = registry.current;
        const estimate = renderToolBlock(added).tokenEstimate;
        if (ctxCounter.seenMsgs >= 0) {
          ctxCounter.running += estimate;
        } else {
          // Counter not yet seeded (load event during the very first turn): park
          // the charge; the seeding branch of refreshRunningContext folds it in.
          pendingToolDefTokens.value += estimate;
        }
      };
    }

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

    // Synthetic injections (spec SESSION-RECORDS §4): routing skill preloads plus
    // the caller's injections, executed as real tool calls with the session's own
    // wrapped tools and stamped with the head model's api/provider/model, then
    // appended to the kickoff after the final user turn. Fresh sessions only — a
    // resumed session already carries its pairs in the transcript, and
    // seedFromTranscript re-derives the loaded set from their addedToolNames.
    //
    // Execution happens AFTER registry.onChange is wired, so a load updates
    // agent.state.tools and parks its tool-definition charge in
    // pendingToolDefTokens before the first request. The caller's injections may
    // be a promise (record selection running in parallel with routing and the
    // build); it is awaited only here.
    let syntheticMessages: AgentMessage[] = [];
    if (!opts?.resume && finalTurn !== undefined) {
      let injections: SyntheticCallSpec[] = [];
      if (opts?.injections) {
        try {
          injections = await opts.injections;
        } catch (error) {
          logger?.warn("synthetic_injections_failed", {
            sessionId: session.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const allSpecs = [...routingSkillSpecs, ...withDeferredLoads(injections, registry)];
      if (allSpecs.length > 0) {
        const synthModelInfo = { api: model.api, provider: model.provider, model: model.id };
        syntheticMessages = await executeSyntheticCalls(allSpecs, wrappedTools, synthModelInfo, {
          registry,
          logger,
          sessionId: session.id,
        });
        // Account for synthetic message tokens in the initial context estimate so
        // refreshRunningContext's first-observation seed covers the full kickoff.
        // (built.tokenEstimate already covers finalTurn; synthetics are new.)
        const synthSlice = syntheticMessages.filter(isLiveRuntimeMessage);
        if (synthSlice.length > 0) {
          try {
            initialContextEstimate.value += estimateLiveSliceTokens(synthSlice);
          } catch {
            /* best-effort; conservative: under-counting only */
          }
        }
      }
    }

    // Build the kickoff array.  Workers that use finalTurn directly keep working;
    // live chat-lane callers should use kickoff (= finalTurn + synthetics).
    const kickoff =
      finalTurn !== undefined
        ? syntheticMessages.length > 0
          ? [finalTurn, ...syntheticMessages]
          : [finalTurn]
        : undefined;

    return {
      agent,
      finalTurn,
      kickoff,
      snapshot,
      tokenEstimate: snapshotTokenEstimate,
      timelineCutoff: builtTimelineCutoff,
      summaryCoverage: builtSummaryCoverage,
      requestProgress,
      compactTokens: snapshotCompactTokens,
      richTokens: snapshotRichTokens,
      usage,
      renderedInputIds,
      registry,
      setPriority: (next: PriorityClass) => {
        admissionPriority.current = next;
      },
      setRefusalFallover: (enabled: boolean) => {
        refusalFallover.enabled = enabled;
      },
      refusal,
      setRefusalSite: (site: string | undefined) => {
        refusal.setSite(site);
      },
      redoControl,
      forkContext: (deps: ForkContextDeps): ForkContext => ({
        sessionId: session.id,
        agent,
        storage: deps.storage,
        flushTranscript: deps.flushTranscript,
        liveEvents: this.options.liveEvents,
        logger: deps.logger ?? logger,
        onForked: (change: ForkChange) => {
          // Dynamic tools (spec DYNAMIC-TOOL-LOADING §7): loads that rode only a
          // discarded message are undone, so the next request's tools match the
          // live transcript; their definition charge leaves the counter too.
          let removedToolTokens = 0;
          if (registry) {
            const removed = registry.unloadDiscarded(change.discarded, change.kept);
            if (removed.length > 0) {
              agent.state.tools = registry.current;
              removedToolTokens = renderToolBlock(removed).tokenEstimate;
            }
          }
          rewindRunningContext(ctxCounter, change, removedToolTokens);
        },
      }),
      ...(outputGate ? { gate: outputGate } : {}),
    };
  }

  /**
   * Resolve a session's operative context-token ceiling from CURRENT config
   * (spec CONTEXT-LIMIT-UNIFICATION §2.4 / PER-MEMBER-CONTEXT-FITS §2.3):
   * `min(context_window, session_type.max_context_tokens)` for the HEAD model —
   * the planning number used by the text-editor read budget, the console's
   * `maxContextTokens` display, and the resume-gate capability check. The limit
   * is operator config and is NOT persisted per session. Always returns a number
   * (`context_window` is mandatory for session-resolved models, §2.5). Throws (a
   * defensive backstop, never reached in normal operation since app-wiring
   * validation requires the window) if the resolved model has no `context_window`.
   *
   * The former min-over-chain behavior (spec MODEL-FALLBACK §3 #2) is replaced by
   * per-member fits at selection time (PER-MEMBER-CONTEXT-FITS §2.3): each member
   * is checked against its OWN window inside `chooseChainMember`, so the planning
   * ceiling is now the HEAD's own window, not the fallback floor. Enforcement
   * (in `create`'s `checkContextBudget`) uses `fallback.maxOperativeContextWindow`
   * (the largest member's window) and terminates only when NO member can serve.
   */
  resolveSessionContextCeiling(sessionType: string, timelineKey?: string): number {
    const cfg = this.resolveSessionType(sessionType);
    // Model key resolved via the per-agent ladder when timelineKey is provided
    // (spec PER-AGENT-MODEL-OVERRIDES §4/§8 FIX 7). Behavioral session-type settings
    // (cfg.max_context_tokens) remain global per the spec non-goal.
    const modelKey = this.resolveModelKey(sessionType, timelineKey);
    const modelConfig = this.options.config.models[modelKey];
    const contextWindow = modelConfig?.context_window;
    if (contextWindow === undefined) {
      throw new Error(
        `model "${modelKey}" (session type "${sessionType}") has no context_window; ` +
          `it is required to resolve the session context ceiling`,
      );
    }
    // Head's own operative ceiling: min(context_window, override). The chain min
    // is removed — fallback members are fits-checked per attempt by chooseChainMember.
    return composeSessionContextCeiling(contextWindow, cfg?.max_context_tokens);
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
    /**
     * Per-agent vision capability override (spec PER-AGENT-MODEL-OVERRIDES FIX 5).
     * Threaded from `create()` where the per-agent model key is already resolved —
     * the builder must not re-derive from the global `sessionType.model`.
     */
    replyModelCanSeeImages?: boolean;
    /** Decision-model routing additions to the satellite (§8h). */
    routedSatellite?: RoutedSatellite;
    timelineCutoff?: number;
    summaryCoverage?: SummaryCoveragePin;
    memoryRetrieval?: MemoryPlanTicket;
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
      replyModelCanSeeImages: args.replyModelCanSeeImages,
      routedSatellite: args.routedSatellite,
      timelineCutoff: args.timelineCutoff,
      summaryCoverage: args.summaryCoverage,
      memoryRetrieval: args.memoryRetrieval,
    });
  }

  /**
   * Resolve and read the model prompts (ARCHITECTURE.md §8 "Model prompts") of
   * every chain member reachable from the given heads. Empty when no profile is
   * configured.
   */
  private async loadSessionModelPrompts(params: {
    heads: string[];
    sessionType: SessionTypeConfig | undefined;
    sessionTypeName: string;
    workspaceRoot: string;
    sessionId: string;
  }): Promise<Map<string, ResolvedModelPrompt>> {
    const config = this.options.config;
    if (!config.model_prompts || Object.keys(config.model_prompts).length === 0) return new Map();
    const reachable = params.heads
      .filter((key) => config.models[key] !== undefined)
      .flatMap((key) => resolveModelChain(key, config.models).map((entry) => entry.logicalId));
    return loadModelPrompts({
      config,
      sessionType: params.sessionType,
      sessionTypeName: params.sessionTypeName,
      logicalIds: reachable,
      workspaceRoot: params.workspaceRoot,
      estimateTokens,
      logger: this.options.logger,
      sessionId: params.sessionId,
    });
  }

  /**
   * Resolve a routing verdict's tail files (ARCHITECTURE.md §8h).
   *
   * Skill preloads moved to synthetic load_skill calls (W5): this method now only
   * reads and returns the tail files; the `preloadedSkills` field is always empty
   * (`never[]`).  Tail files that cannot be read are skipped with a warning.
   */
  private async buildRoutedSatellite(
    routing: RoutingVerdict,
    ctx: {
      workspace: WorkspaceContent;
      workspaceRoot: string;
      sessionId: string;
    },
  ): Promise<RoutedSatellite> {
    const logger = this.options.logger;
    const tailFiles: RoutedSatellite["tailFiles"] = [];
    for (const source of routing.tailFiles) {
      try {
        const absolute = resolveWorkspacePath(ctx.workspaceRoot, source);
        if (absolute === null) throw new Error("outside workspace");
        tailFiles.push({ source, content: (await readFile(absolute, "utf-8")).trim() });
      } catch (error) {
        logger?.warn("routing_tail_file_unreadable", {
          sessionId: ctx.sessionId,
          file: source,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { preloadedSkills: [], tailFiles };
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
    // §4.3: same rule as create() — agents mode must never guess a root.
    let workspaceRoot: string;
    if (this.options.resolveWorkspaceRoot) {
      const resolved = this.options.resolveWorkspaceRoot(timelineKey);
      if (resolved === undefined) {
        throw new Error(
          `§4.3: timeline "${timelineKey}" maps to an account not in config — ` +
          "workspace root unresolvable in agents mode",
        );
      }
      workspaceRoot = resolved;
    } else {
      workspaceRoot = this.options.config.workspace?.root_dir ?? "./workspaces/miku";
    }
    const sessionTypeConfig = this.resolveSessionType("default");
    const fallbackPrompt = this.options.config.agent.system.fallback_prompt;
    const workspace = await loadWorkspace(workspaceRoot, sessionTypeConfig);

    // Per-agent model override (spec PER-AGENT-MODEL-OVERRIDES §4): mirror
    // create()'s vision derivation so the preview's image-block inclusion matches
    // what the next real session for this timeline would send.
    const previewModelKey = this.resolveModelKey("default", timelineKey);
    const previewModelConfig = this.options.config.models[previewModelKey];

    // Synthetic trigger = most recent timeline event (spec §9). `getTimelineEvents`
    // returns ascending order, so the last element is the newest. When the timeline
    // has no events, a minimal placeholder lets the builder still render the prefix
    // tiers; the final user turn is simply sparse.
    const recent = storage.getTimelineEvents(timelineKey, 1);
    const latest = recent[recent.length - 1];
    const trigger = latest ?? syntheticPlaceholderEvent(timelineKey);

    // The default session type's tool set, so the preview's estimate + tool
    // block match what the next real session would send. Absent hook (tests) →
    // no tool block, identical to the prior preview behaviour. Under dynamic
    // tool loading, mirror create(): the wire set is the initial (immediate)
    // split and `workspace.dynamicTools` drives the same prompt rendering —
    // the preview has the workspace in hand, so always_loaded promotions and
    // the load_skill gate are exact here.
    const previewDefs = this.options.buildToolDefs?.(timelineKey, "default");
    let previewTools = previewDefs;
    if (previewDefs) {
      workspace.skills = eligibleSkillIndex(workspace.skills, previewDefs.map(definition => definition.name));
      workspace.runtimeNotices = [...new Set(previewDefs.map((definition) => definition.availabilityNotice).filter((notice): notice is string => !!notice))];
      const split = this.splitDefsForDynamic(previewDefs, sessionTypeConfig, workspace);
      if (split) {
        previewTools = split.initial;
        workspace.dynamicTools = {
          indexText: renderDeferredToolsIndex(
            filterHarnessOnlyFromIndex(split.deferred),
            [...workspace.skills.listed, ...workspace.skills.inlined],
            split.index,
          ),
        };
      }
    }

    const built = await this.buildContext({
      timelineKey,
      trigger,
      workspace,
      sessionType: sessionTypeConfig,
      fallbackPrompt,
      replyModelCanSeeImages: previewModelConfig?.input_modalities.includes("image"),
      tools: previewTools,
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
    if (!tools || tools.length === 0) return undefined;
    // Under dynamic loading show the INITIAL wire set (spec DYNAMIC-TOOL-LOADING
    // §9). No workspace here (sync path): always_loaded promotions are skipped
    // and load_skill is assumed present — a documented display approximation.
    const split = this.splitDefsForDynamic(tools, this.resolveSessionType(sessionType));
    return renderToolBlock(split ? split.initial : tools);
  }

  /**
   * Dynamic-loading split for tool DEFINITIONS (spec DYNAMIC-TOOL-LOADING §9):
   * the initial wire set + the deferred remainder for a session type, given the
   * full post-filter catalog. Returns undefined when dynamic loading is off for
   * the type (the same gate `create()` applies). `workspace`, when provided,
   * enables always_loaded-skill promotion and the listed-skills `load_skill`
   * gate; without it (the sync inspector path) promotions are skipped and
   * `load_skill` is assumed present.
   */
  private splitDefsForDynamic(
    defs: ToolDefinitionLike[],
    sessionTypeConfig: SessionTypeConfig | undefined,
    workspace?: WorkspaceContent,
  ):
    | { initial: ToolDefinitionLike[]; deferred: ToolDefinitionLike[]; index: DeferredIndexMode }
    | undefined {
    const dynCfg = this.options.config.agent.tools?.dynamic;
    const enabled =
      (dynCfg?.enabled ?? false) &&
      (sessionTypeConfig?.tools_dynamic ?? sessionTypeConfig?.tools === undefined);
    if (!enabled) return undefined;
    const names = defs.map((d) => d.name);
    const immediate = new Set(matchToolPatterns(names, dynCfg?.immediate ?? []));
    for (const definition of defs) {
      if (definition.initialLoading === "immediate") immediate.add(definition.name);
      if (definition.initialLoading === "deferred") immediate.delete(definition.name);
    }
    // The prefill `no_reply` tool (spec OPENAI-PREFILL) only exists so a session
    // under tool_choice = "required" can end a turn silently; deferring it behind
    // tool_search would defeat that, so it is always in the initial wire set.
    if (names.includes("no_reply")) immediate.add("no_reply");
    if (workspace) {
      for (const skill of workspace.skills.inlined) {
        if (!skill.tools) continue;
        for (const name of matchToolPatterns(names, skill.tools)) immediate.add(name);
      }
    }
    // Mirrors create(): read_session_record is immediate whenever wired, and
    // harness-only tools are never immediate (the record turn loads them).
    if (names.includes("read_session_record")) immediate.add("read_session_record");
    for (const d of defs) {
      if ((d as { harnessOnly?: boolean }).harnessOnly) immediate.delete(d.name);
    }
    const loaders: ToolDefinitionLike[] = [];
    if (!workspace || workspace.skills.listed.length > 0) loaders.push(loadSkillToolDefinition());
    loaders.push(toolSearchToolDefinition());
    return {
      initial: [...defs.filter((d) => immediate.has(d.name)), ...loaders],
      deferred: defs.filter((d) => !immediate.has(d.name)),
      index: dynCfg?.index ?? "orphans",
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
 * Injected synthetic calls must reach tools the session has on the wire. A call to
 * a tool that is still deferred is preceded by one synthetic `tool_search` select
 * call that loads it, exactly as the agent itself would have to, so each
 * transport serializes the load at its native load point. Without dynamic loading
 * (no registry) every tool is already present and the specs pass through. Today's
 * targets never need it (`read_session_record` is always immediate, `load_skill` is
 * a loading tool); it keeps any future injection target correct.
 */
export function withDeferredLoads(
  specs: readonly SyntheticCallSpec[],
  registry: DynamicToolRegistry | undefined,
): SyntheticCallSpec[] {
  if (!registry || specs.length === 0) return [...specs];
  const deferred = [
    ...new Set(
      specs
        .map((spec) => spec.name)
        .filter((name) => registry.inCatalog(name) && !registry.isLoaded(name)),
    ),
  ];
  if (deferred.length === 0) return [...specs];
  return [
    { name: "tool_search", params: { query: `select:${deferred.join(",")}` }, harness: specs[0]!.harness },
    ...specs,
  ];
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
 * This detects only whether an image is PRESENT in the raw inputs; whether that
 * image is actually shipped as pixels (vs captioned) is the reply model's own
 * capability, applied by the caller (`create` ANDs this with the resolved reply
 * model's `input_modalities`). Generation modes (summarize / condense / diary) and
 * proactive sessions never send image pixels, so they short-circuit to false.
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
 * Σ of the per-message `tokenEstimate`s carried on a persisted message array (the
 * builder stamps it on the tier/trigger messages). Used only as the FALLBACK seed
 * for a resumed session's running-input estimate when no committed-request actuals
 * exist (#1) — actuals (`usage.snapshot().contextTokens`) are preferred. Messages
 * without an estimate contribute 0 (conservative under-count, the same basis the
 * verbatim renderer uses).
 */
function sumMessageTokenEstimates(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const est = (m as { tokenEstimate?: unknown }).tokenEstimate;
    if (typeof est === "number" && est > 0) total += est;
  }
  return total;
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
 * Apply a per-agent MCP server allowlist to a tool array (spec PER-AGENT-MCP-SCOPING).
 *
 * Drops any tool whose server is NOT in the agent's `mcp_servers` allowlist.
 * Server attribution is exact: `mcpToolServerMap` maps each adapted tool name
 * (e.g. `mcp_foo_bar_action`) to the server name that produced it (e.g. `foo_bar`)
 * — built at startup from `adaptMcpTools` call sites where the true server name
 * is always known. This avoids all prefix-inference ambiguity (e.g. when `foo`
 * and `foo_bar` are both configured, `mcp_foo_bar_action` cannot be attributed
 * to `foo` by any prefix rule alone). Tools absent from the map are not MCP tools
 * and are never filtered.
 *
 * - `agentMcpServers` undefined → absent in config → keep all (default behavior,
 *   identical to pre-feature mode and legacy single-agent mode).
 * - `agentMcpServers` is an array → only tools from those servers pass through.
 *   An empty array is valid: this agent gets no MCP tools at all.
 *
 * Composes with `filterTools` (session-type allowlist) as an intersection: apply
 * this filter first, then `filterTools`, so only tools that survive BOTH gates
 * reach the session.
 */
export function filterMcpToolsByAllowlist(
  tools: AgentTool[],
  agentMcpServers: string[] | undefined,
  mcpToolServerMap: Map<string, string>,
): AgentTool[] {
  if (agentMcpServers === undefined) return tools; // absent → no filter
  const allowedServers = new Set(agentMcpServers);
  return tools.filter((tool) => {
    const serverName = mcpToolServerMap.get(tool.name);
    if (serverName === undefined) return true; // not an MCP tool → keep
    return allowedServers.has(serverName);
  });
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
          // The model tail's slot (metadata, ARCHITECTURE.md §8 "Model prompts").
          ...(message.modelTailAt ? { modelTailAt: message.modelTailAt } : {}),
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
 * Rewind the exact running input-token counter (spec PER-USER-LIMITS §5.3)
 * after a fork (spec REFUSAL-HANDLING §8.4). The counter only ever added new
 * live messages, so the discarded span's counted share (the messages before
 * `seenMsgs`) and the definitions of tools the fork unloaded are taken back
 * out; `seenMsgs` moves back to the fork index, so the kept tail past it (an
 * edited message, redelivered interjections) is tokenized by the next refresh.
 * The cached prefix can be no longer than what is left. No-op before the
 * counter's first observation.
 */
export function rewindRunningContext(
  counter: { running: number; seenMsgs: number; cachedAtLast: number },
  change: Pick<ForkChange, "forkIndex" | "discarded">,
  removedToolTokens = 0,
  estimate: (slice: AgentMessage[]) => number = estimateLiveSliceTokens,
): void {
  if (counter.seenMsgs < 0) return;
  const counted = change.discarded
    .slice(0, Math.max(0, counter.seenMsgs - change.forkIndex))
    .filter(isLiveRuntimeMessage);
  try {
    if (counted.length > 0) counter.running -= estimate(counted);
  } catch {
    /* best-effort, like the refresh itself */
  }
  counter.running = Math.max(0, counter.running - removedToolTokens);
  counter.seenMsgs = Math.min(counter.seenMsgs, change.forkIndex);
  counter.cachedAtLast = Math.min(counter.cachedAtLast, counter.running);
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

/** Effective extended-thinking level for a model (config, default off). */
type ThinkingLevel = NonNullable<ModelConfig["thinking_level"]>;

/**
 * Per-level extended-thinking token budgets (#4) — the SAME mapping pi-ai's
 * `adjustMaxTokensForThinking` uses (`simple-options.js`): the additive budget a
 * provider reserves/bills on top of the base `max_tokens` for thinking. `xhigh`
 * clamps to `high` exactly as pi-ai's `clampReasoning` does. No custom
 * `thinking_budgets` are wired in this app's config, so this fixed map is
 * authoritative; if that ever changes, thread the override through here.
 */
const THINKING_BUDGET_BY_LEVEL: Record<Exclude<ThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 16384, // clampReasoning("xhigh") === "high" → 16384
};

/**
 * Does this Anthropic model use ADAPTIVE thinking (Opus 4.6+/4.7, Sonnet 4.6)?
 * Mirrors pi-ai's `supportsAdaptiveThinking` (`anthropic.js`). Adaptive models
 * take an effort HINT with no additive `max_tokens` budget — the wire cap stays at
 * the requested `max_tokens` and billed output never exceeds it — so they must NOT
 * be penalized in the affordability output basis (#4).
 *
 * This is only the FALLBACK heuristic: a hand-copied substring list cannot mirror
 * an upstream list that grows, so it has already drifted past the models it knows.
 * `additiveThinkingBudgetTokens` consults the model config's `adaptive_thinking`
 * flag FIRST and defers here only when that flag is unset. Operators declare newer
 * adaptive Anthropic models (Opus 4.8+, future Sonnet/Opus) explicitly via the flag
 * rather than extend this list.
 */
function modelUsesAdaptiveThinking(modelId: string): boolean {
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4.6") ||
    modelId.includes("opus-4-7") ||
    modelId.includes("opus-4.7") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-4.6")
  );
}

/**
 * Whether requests to this model use ADAPTIVE thinking on the anthropic-messages
 * path: the config flag when set (authoritative), else the id heuristic. False on
 * every other wire API. Feeds both the wire descriptor (`forceAdaptiveThinking`)
 * and the affordability basis, so the two can never disagree.
 */
function anthropicUsesAdaptiveThinking(model: ModelConfig): boolean {
  if ((model.api ?? "anthropic-messages") !== "anthropic-messages") return false;
  return model.adaptive_thinking ?? modelUsesAdaptiveThinking(model.id);
}

/**
 * Gemini's NATIVE per-(model, level) thinking-budget tokens — a faithful mirror of
 * pi-ai's `getGoogleBudget` (`providers/google.js`) (#4). Gemini bills thinking in a
 * SEPARATE lane on top of `maxOutputTokens` (= our base `max_tokens`), and unlike the
 * flat Anthropic map the budget is MODEL-FAMILY-specific (2.5-pro high=32768, not the
 * Anthropic 16384). We mirror it rather than import it because pi-ai exports it only
 * internally; keep this in lock-step with `getGoogleBudget` if pi-ai ever revises the
 * tables. Our `ThinkingLevel` maps onto pi-ai's `effort` exactly as `clampReasoning`
 * does: `xhigh → high`; all other non-off levels pass through 1:1 (`off` is handled by
 * the caller before we get here, so it never reaches this function).
 *
 * `getGoogleBudget` returns -1 for any model id it doesn't recognize (Gemini 3 /
 * Gemma 4 take an enum `thinkingLevel`, NOT a token budget, so there is no fixed
 * additive token count for them). For those unmatched ids we fall back to the flat
 * `THINKING_BUDGET_BY_LEVEL` value — a conservative non-negative reservation — rather
 * than propagate the -1 sentinel into the affordability basis.
 */
function geminiThinkingBudgetTokens(modelId: string, level: Exclude<ThinkingLevel, "off">): number {
  // clampReasoning: xhigh → high; everything else 1:1 onto pi-ai's effort scale.
  const effort: "minimal" | "low" | "medium" | "high" = level === "xhigh" ? "high" : level;
  // Mirrors pi-ai getGoogleBudget's per-family tables (no custom thinking_budgets are
  // wired in this app's config, so the default tables are authoritative). Order matters:
  // 2.5-flash-lite is checked before 2.5-flash (the latter substring-matches the former).
  if (modelId.includes("2.5-pro")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 32768 }[effort];
  }
  if (modelId.includes("2.5-flash-lite")) {
    return { minimal: 512, low: 2048, medium: 8192, high: 24576 }[effort];
  }
  if (modelId.includes("2.5-flash")) {
    return { minimal: 128, low: 2048, medium: 8192, high: 24576 }[effort];
  }
  // Unrecognized id (getGoogleBudget would return -1): no fixed token budget — fall
  // back to the flat per-level map as a conservative non-negative reservation.
  return THINKING_BUDGET_BY_LEVEL[level];
}

/**
 * The extended-thinking token budget the provider will ADD on top of the issued
 * base `max_tokens` (and bill) for this model at `level` (#4). Returns 0 when no
 * additive budget applies, so folding it into the per-user affordability basis and
 * reserving it within the issued cap is a no-op for non-additive paths:
 *
 * - thinking off / capability absent → 0.
 * - Anthropic non-adaptive (older models) → pi-ai `adjustMaxTokensForThinking`
 *   sets the wire cap to `min(base + thinkingBudget, modelMax)` → ADDITIVE.
 * - Anthropic ADAPTIVE → effort hint, base unchanged → 0. Adaptivity is taken
 *   from the model config's `adaptive_thinking` flag when set (AUTHORITATIVE:
 *   `true` ⇒ 0, `false` ⇒ the flat additive budget); when unset it falls back to
 *   the {@link modelUsesAdaptiveThinking} id heuristic (Opus 4.6/4.7, Sonnet 4.6).
 *   Declare newer adaptive models (Opus 4.8+) via the flag — see schema docs.
 * - Google/Gemini → thinking runs in a SEPARATE lane billed on top of
 *   `maxOutputTokens` (= base) → ADDITIVE. The reserved amount is Gemini's
 *   model-specific native budget (e.g. 2.5-pro high=32768), NOT the flat Anthropic
 *   map — see {@link geminiThinkingBudgetTokens} (mirrors pi-ai `getGoogleBudget`).
 * - OpenAI completions/responses (incl. Together/OpenRouter) → reasoning effort,
 *   thinking fits WITHIN `max_tokens`; pi-ai does not inflate the cap → 0.
 *
 * The budget is also capped at the model's own `max_tokens` (pi-ai itself clamps
 * the wire cap to `modelMax`, so the additive portion can never exceed it).
 */
export function additiveThinkingBudgetTokens(model: ModelConfig, level: ThinkingLevel): number {
  if (level === "off" || model.reasoning === false) return 0;
  const budget = THINKING_BUDGET_BY_LEVEL[level];
  const api = model.api ?? "anthropic-messages";
  let additive: number;
  if (api === "anthropic-messages") {
    // The config flag is AUTHORITATIVE when set (operators declare adaptive models
    // explicitly); only the unset case falls back to the drifting id heuristic.
    additive = anthropicUsesAdaptiveThinking(model) ? 0 : budget;
  } else if (api === "google-generative-ai") {
    // Gemini bills thinking in a separate lane on top of max_tokens, at a
    // MODEL-SPECIFIC budget (pi-ai getGoogleBudget) — not the flat Anthropic map.
    additive = geminiThinkingBudgetTokens(model.id, level);
  } else {
    // openai-completions / openai-responses: reasoning effort, no max_tokens inflation.
    additive = 0;
  }
  return Math.min(additive, model.max_tokens);
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
    // pi-ai's Model.input only accepts ("text"|"image")[]; the agent loop /
    // provider adapter cannot consume video/audio, so map the broader config
    // `input_modalities` down to the supported subset (text baseline + image when
    // the model accepts it). Per-lane video/audio capability is enforced upstream
    // in the captioning fetch consumer, never threaded through this descriptor.
    input: model.input_modalities.includes("image") ? ["text", "image"] : ["text"],
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
      // anthropic-messages only. pi-ai requests adaptive thinking (an effort level,
      // no token budget) only when this flag is set on the descriptor; otherwise it
      // sends a budget-based `thinking` block, which adaptive-only models reject.
      // Same source of truth as the affordability basis: the config's
      // `adaptive_thinking` flag, else the id heuristic. Undefined elsewhere.
      forceAdaptiveThinking: anthropicUsesAdaptiveThinking(model) ? true : undefined,
      // anthropic-messages only. Whether a dynamic tool load is serialized as a
      // `tool_reference` block (prefix-stable) or as plain growth of `tools`.
      // Undefined = leave pi-ai's per-model auto-detection in place. Under the
      // declared-deferred transport the choice is explicit (the load point is the
      // block only when asked for, text otherwise), never auto-detected.
      supportsToolReferences: model.compat?.declare_deferred_tools
        ? model.compat.supports_tool_references === true
        : model.compat?.supports_tool_references,
      // Carried on the wire descriptor so the onPayload injector marks deferred
      // tools only for the member that uses the declared-deferred transport.
      declareDeferredTools: model.compat?.declare_deferred_tools ? true : undefined,
      sendSessionAffinityHeaders: model.compat?.send_session_affinity_headers,
      // Override pi-ai's auto-detection (false for provider="together") so the
      // reasoning-effort level is forwarded as `reasoning_effort`. Undefined =
      // leave auto-detection in place.
      supportsReasoningEffort: model.compat?.supports_reasoning_effort,
      // Override whether the system prompt uses the OpenAI `developer` role.
      // pi-ai enables it when reasoning is on for most providers; a proxied
      // DeepSeek upstream rejects `developer`, so set false to force `system`.
      // Undefined = leave auto-detection in place.
      supportsDeveloperRole: model.compat?.supports_developer_role,
      // Prefix-stable dynamic tool loading on the Responses API (§10): loaded
      // tools ride in-transcript `tool_search_*` items with `defer_loading`
      // instead of growing `params.tools`, so a load event never invalidates the
      // prompt cache. Default ON (pi-ai defaults off) — a bust re-bills the whole
      // context at the uncached price on every provider. Only read by the
      // openai-responses driver; inert elsewhere.
      supportsToolSearch: model.compat?.supports_tool_search ?? true,
      // Suppress pi-ai's empty-string `reasoning_content` stamp on reasoning-less
      // assistant turns (auto-enabled for DeepSeek); V4 Pro thinking mode 400s on
      // a present-but-empty value. Undefined = leave auto-detection in place.
      requiresReasoningContentOnAssistantMessages:
        model.compat?.requires_reasoning_content_on_assistant_messages,
      // OpenRouter provider-routing preferences, sent verbatim as `provider` by the
      // openai-completions driver. Undefined = no `provider` object on the wire.
      openRouterRouting: model.compat?.openrouter_routing as OpenRouterRouting | undefined,
      // Carry the explicit cache_breakpoints preference on the wire Model
      // descriptor so the onPayload injector can gate per serving member (not per
      // chain head).  Read for openai-responses and anthropic-messages members;
      // undefined on all other models so the injector passes their payloads through.
      cacheBreakpoints: model.cache_breakpoints,
      // Carry the prefill text on the wire Model descriptor so the onPayload
      // injector can gate per serving member (not per chain head). null means
      // prefill is disabled for this member.
      prefillText: model.prefill?.enabled && model.prefill.text ? model.prefill.text : null,
      // When true, strip native thinking blocks from outgoing assistant history.
      dropReasoning: model.prefill?.enabled && model.prefill.drop_reasoning ? true : undefined,
    },
  };
}
