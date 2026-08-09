import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage, AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type Model, type AssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple, completeSimple } from "@earendil-works/pi-ai/compat";
import type { AppConfig } from "../config/index.js";
import type { AgentModelOverrides } from "./agent-model-overrides.js";
import { dumpBuiltContext, CACHE_BOUNDARIES, renderToolBlock, type BuiltContext, type ContextBuilder, type ToolBlockSummary, type ToolDefinitionLike } from "../context/index.js";
import type { ContextMessage } from "../context/builder.js";
import type { AgentSessionRecord } from "./session-manager.js";
import { convertToLlm } from "./convert.js";
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
import type { WorkspaceContent, SessionTypeConfig } from "../workspace/types.js";
import type { Storage, Summary } from "../storage/index.js";
import type { Logger } from "../observability/logger.js";
import type { SessionLiveEventBus } from "../observability/live-events.js";
import type { LlmRequestRing } from "./request-ring.js";
import { SessionUsageTracker, type SessionUsageTotals } from "./usage.js";
import type { AttachmentMeta, CanonicalChatEvent } from "../types.js";
import type {
  BudgetHooks,
  UserLimitContext,
  UserLimitEngine,
  UserLimitResolution,
} from "../budget/index.js";
import { TurnResultBudget } from "./tool-result-budget.js";
import { wrapToolsWithResultBudget } from "./tool-result-wrap.js";

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

    // Per-agent model override (spec PER-AGENT-MODEL-OVERRIDES §4/§8): resolve via
    // the shared private helper so create() and the public resolvers are always
    // one code path — no divergence in guarding logic.
    const modelKey = this.resolveModelKey(session.sessionType, session.timelineKey);
    const modelConfig = this.options.config.models[modelKey];
    if (!modelConfig) throw new Error(`Model "${modelKey}" not found in config`);
    // Extended-thinking level for this session (the head model's config, default off).
    // Fixed for the whole rollout — it flows as pi-ai `options.reasoning` on every
    // request regardless of which per-user model serves — and is the basis for the
    // per-requested-model additive thinking budget the affordability estimate reserves
    // (#4). Resolved once here; also fed verbatim to the Agent's `initialState` below.
    const thinkingLevel: ThinkingLevel = modelConfig.thinking_level ?? "off";
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
    // Per-attempt served-model tracker for the request ring (served-model
    // attribution). Starts undefined; set by onResolve when the fallback fn
    // dispatches; reset to undefined at the start of each retry-loop iteration
    // by ctx.resetServedModel so a stale value is never carried forward. The
    // budget-violation pre-flight calls recordAttempt before the loop runs, so
    // getServedModel() returns undefined there (no dispatch happened). ✓
    let servedModelForAttempt: string | undefined = undefined;
    const budgetEngine = this.options.budget?.engine;
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
    const isModelAvailableFn = budgetEngine ? (id: string) => budgetEngine.isModelAvailable(id) : undefined;
    // Per-user selection (spec PER-USER-LIMITS §6): when an ACTIVE per-user rule is
    // supplied for this human session, the factory builds one composite per PREFERRED
    // model and re-selects per request. `requestedMember` tracks the per-user
    // selector's chosen model (the ledger's `requested_model_id`, §7), distinct from
    // `resolvedMember` (the served chain member, set by the chosen composite's onResolve).
    const userLimit = opts?.userLimit;
    const userSelection = userLimit?.resolution.active === true;
    const requestedMember: { logicalId: string } = { logicalId: modelKey };
    // Shared builder so the default + each preferred composite are built identically
    // (spec MODEL-FALLBACK §3): capability pre-filter + per-member windows fixed
    // once per chain, member chosen per attempt inside the composed fn. Memoized so a
    // preferred model that equals the default key is not built twice (§4.2 build
    // structure: one BuiltModelFallback per preferred model, ceiling resolved once each).
    const builtFallbacks = new Map<string, BuiltModelFallback>();
    const buildFor = (logicalId: string): BuiltModelFallback => {
      const cached = builtFallbacks.get(logicalId);
      if (cached) return cached;
      const built = buildModelFallback(resolveModelChain(logicalId, this.options.config.models), {
        consumer: "agent",
        makeBase: (cfg) =>
          withSdkRetriesDisabled((cfg.streaming ?? true) ? streamSimple : wrapCompleteAsStream),
        makeModel: (cfg, cw) => createModelFromConfig(cfg, cw),
        capability: requiresMultimodal ? (cfg) => cfg.input_modalities.includes("image") : undefined,
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
        isModelAvailable: isModelAvailableFn,
        logger: this.options.logger,
        sessionId: session.id,
        onResolve: (id) => {
          resolvedMember.logicalId = id;
          servedModelForAttempt = id;
        },
        // Feed the §5.3 running counter for per-member fits gating per attempt
        // (spec PER-MEMBER-CONTEXT-FITS §2.1). Guard: return undefined before the
        // counter is seeded (ctxCounter.seenMsgs starts at -1; first observation
        // sets it ≥ 0). Fetch consumers (captioning/embedding) omit this option
        // and always receive undefined → fits skipped, preserving their behavior.
        getObservedContextTokens: () =>
          ctxCounter.seenMsgs < 0 ? undefined : ctxCounter.running,
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
      const preferred = userLimit!.resolution.models ?? [modelKey];
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
    // the prior request for the cache-TTL test. O(delta) per request, not O(context).
    const ctxCounter = { running: 0, seenMsgs: -1, cachedAtLast: 0, lastRequestAtMs: 0 };
    const refreshRunningContext = (): void => {
      const msgs = agentRef.agent?.state.messages;
      if (!msgs) return;
      if (ctxCounter.seenMsgs < 0) {
        // First observation: the built context (incl. the kickoff turn already in
        // state) is `initialContextEstimate`; do not re-tokenize it.
        ctxCounter.running = initialContextEstimate.value;
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
      const withinCacheTtl =
        ctxCounter.lastRequestAtMs > 0 && Date.now() - ctxCounter.lastRequestAtMs < PROMPT_CACHE_TTL_MS;
      const estimate = { cachedTokens: ctxCounter.cachedAtLast, newTokens, withinCacheTtl };
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
        getServedModel: () => servedModelForAttempt,
        resetServedModel: () => { servedModelForAttempt = undefined; },
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
          // Same billed-model expression the ledger row below uses (spec
          // MODEL-FALLBACK §2.2/§6.1): the committed message's own `model` when
          // the provider reports one, else this attempt's descriptor. Feeding it
          // to the tracker is what lets the durable `agent_sessions.model_id`
          // agree with the ledger under fallback / per-user model selection,
          // instead of freezing the session type's configured model.
          usage.record(message.usage, message.model ?? model.id);
          // Tool-result budget reset (spec TOOL-RESULT-BUDGET §4): each committed
          // LLM request starts a fresh tool-result turn; the accumulator resets so
          // the next batch of tool calls gets the full per-turn budget again.
          turnBudget.reset();
          if (userSelectionActive) {
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
          }
          const budget = this.options.budget;
          if (budget?.record) {
            const u = message.usage;
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
              provider: message.provider ?? model.provider ?? null,
              inputTokens: u.input ?? null,
              outputTokens: u.output ?? null,
              cacheReadTokens: u.cacheRead ?? null,
              cacheWriteTokens: u.cacheWrite ?? null,
              costUsd: cost,
            });
          }
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
          if (userSelectionActive) return undefined;
          const observed = usage.snapshot().contextTokens;
          const maxWindow = fallback.maxOperativeContextWindow;
          // Block only when the context exceeds EVERY member's window (fits no member).
          if (observed === null || observed <= maxWindow) return undefined;
          // At this point: observed > maxWindow → no surviving member can serve.
          const skipped = fallback.survivorMembers
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
          if (userSelectionActive) {
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

    // Load workspace files from disk at session creation time
    const workspace = await loadWorkspace(workspaceRoot, sessionTypeConfig);

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
        // Thread the per-agent model's vision capability so the builder's
        // pixel-block gate reflects the actual serving model (spec FIX 5).
        replyModelCanSeeImages,
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
    const logger = this.options.logger;

    // Wrap each filtered tool with the result-shaping layer (spec TOOL-RESULT-BUDGET §2).
    // Simple per-session counter cap for truncation log rate-limiting: no existing
    // rate-limited helper in this codebase fits this use case; 20 events/session
    // prevents log floods while still catching the first burst (spec §6).
    let _truncationLogCount = 0;
    const wrappedTools = wrapToolsWithResultBudget(filteredTools, {
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

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: wrappedTools,
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

    const built = await this.buildContext({
      timelineKey,
      trigger,
      workspace,
      sessionType: sessionTypeConfig,
      fallbackPrompt,
      replyModelCanSeeImages: previewModelConfig?.input_modalities.includes("image"),
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
    const adaptive = model.adaptive_thinking ?? modelUsesAdaptiveThinking(model.id);
    additive = adaptive ? 0 : budget;
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
      // Suppress pi-ai's empty-string `reasoning_content` stamp on reasoning-less
      // assistant turns (auto-enabled for DeepSeek); V4 Pro thinking mode 400s on
      // a present-but-empty value. Undefined = leave auto-detection in place.
      requiresReasoningContentOnAssistantMessages:
        model.compat?.requires_reasoning_content_on_assistant_messages,
    },
  };
}
