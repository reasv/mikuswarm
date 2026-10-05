/**
 * SessionRecordService — in-flight registry + record-turn driver
 * (spec SESSION-RECORDS §3, CONTRACT §3/§5/§7).
 *
 * One shared instance in the app. Each run creates its own
 * {@link SessionRecordHandles} (gate + draft) before it assembles the tools, so
 * the tool objects capture them at creation time.
 */

import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Storage } from "../storage/index.js";
import type { SessionRecordsConfig } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import type { SessionRecordHandles } from "./record-turn.js";
import type { DynamicToolRegistry } from "./dynamic-tools.js";
import type { PriorityClass } from "./scheduler.js";
import { buildSyntheticCallFromResult, type HarnessMarker } from "./synthetic-calls.js";
import { hasResumableWork } from "./work-gate.js";
import { SYNTHETIC_SESSION_TYPES } from "./recovery.js";
import { formatLoadedTools } from "../tools/tool-search.js";

// ── Prompt (spec §3.2) ────────────────────────────────────────────────────────

export const RECORD_TURN_PROMPT =
  "This session is over. Write its session record: a later session will see only the chat and this record, and must be able to answer questions about this work and carry it on.\n" +
  "\n" +
  "What it needs depends on the work:\n" +
  "- a lookup: the sources behind what you said, including things you only mentioned in passing, and what you found but did not use;\n" +
  "- something made or changed: the artifacts (paths, message ids), their current state, and how to continue or check them;\n" +
  "- anything left open.\n" +
  "\n" +
  "People reply to any of your messages, so tie each part to the message it belongs to by its message id.\n" +
  "Keep it a handoff note: what and where, with a one-line why where it helps.\n" +
  "\n" +
  "Write it with session_record_tool, then finalize. No other tool is available in this turn.";

// ── Config defaults (mirror config/00-defaults.toml) ─────────────────────────

const DEFAULT_MAX_TURNS = 4;
const DEFAULT_TIMEOUT_MS = 60_000;

const RECORD_TOOL = "session_record_tool";

// ── Eligibility ───────────────────────────────────────────────────────────────

/**
 * Does a completed session write a record (spec §3.1)?
 *
 *   - Feature disabled → no.
 *   - Synthetic session type (summarize, condense, diary) → no.
 *   - Only the chat lane (`default`) and the proactive session type write one.
 *   - Work gate (a tool call in the rollout outside `exemptToolNames`) → no
 *     record for pure conversation.
 */
export function isEligibleForRecord(
  sessionType: string,
  proactiveSessionType: string | undefined,
  config: SessionRecordsConfig | undefined,
  transcript: AgentMessage[],
  exemptToolNames: Set<string>,
): boolean {
  if (config?.enabled === false) return false;
  if (SYNTHETIC_SESSION_TYPES.has(sessionType)) return false;
  if (sessionType !== "default" && sessionType !== proactiveSessionType) return false;
  return hasResumableWork(transcript, { scope: "any_in_history", exemptToolNames });
}

/**
 * The `builds_on` of a session (spec §3.3): the session ids whose records were
 * injected into it and actually delivered. Read from the transcript's harness
 * injection pairs, so every run path (fresh, reply-resume, manual resume) derives
 * it the same way. A `read_session_record` injection whose result was an error
 * or "no record" (no `details.session_id`) delivered nothing and is left out.
 */
export function buildsOnFromTranscript(messages: readonly AgentMessage[]): string[] {
  const injectedCalls = new Set<string>();
  const ids: string[] = [];
  for (const message of messages) {
    const m = message as {
      role?: string;
      harness?: HarnessMarker;
      content?: unknown;
      toolCallId?: string;
      isError?: boolean;
      details?: unknown;
    };
    if (m.harness?.kind !== "injection") continue;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type?: string; id?: string; name?: string }>) {
        if (block.type === "toolCall" && block.name === "read_session_record" && block.id) injectedCalls.add(block.id);
      }
    } else if (m.role === "toolResult" && m.toolCallId && injectedCalls.has(m.toolCallId)) {
      const delivered = (m.details as { session_id?: unknown } | null | undefined)?.session_id;
      if (m.isError !== true && typeof delivered === "string" && !ids.includes(delivered)) ids.push(delivered);
    }
  }
  return ids;
}

// ── Record-turn outcome ───────────────────────────────────────────────────────

/** Why a record turn produced no row (logged as `session_record_failed`). */
export type RecordTurnFailure =
  | "refusal"
  | "budget_blocked"
  | "llm_error"
  | "timeout"
  | "max_turns"
  | "shutdown"
  | "not_finalized";

/**
 * Why a record turn that ended on its own (no abort of ours) wrote nothing. A
 * hard refusal is the `refusal` stop reason (Anthropic; pi-ai maps it to an
 * error and keeps the raw reason) or a provider content filter; a budget gate
 * surfaces as the factory's pre-flight message; any other error is an LLM error;
 * no error at all means the model stopped without finalizing.
 */
export function classifyUnfinalizedRecordTurn(
  rawStopReason: string | undefined,
  errorMessage: string | undefined,
): Exclude<RecordTurnFailure, "timeout" | "max_turns" | "shutdown"> {
  if (rawStopReason === "refusal" || (errorMessage && /refus|content_filter/i.test(errorMessage))) return "refusal";
  if (errorMessage && /cost limit exceeded|budget exhausted/i.test(errorMessage)) return "budget_blocked";
  if (errorMessage && errorMessage.length > 0) return "llm_error";
  return "not_finalized";
}

type AbortReason = "timeout" | "max_turns" | "shutdown";

interface InflightEntry {
  done: Promise<void>;
  deadline: number;
  /** Abort the running record turn. Set only while its prompt runs. */
  abort?: (reason: AbortReason) => void;
}

export interface StartRecordTurnParams {
  sessionId: string;
  timelineKey: string;
  sessionType: string;
  /** The proactive session type name from config (default "proactive"). */
  proactiveSessionType: string | undefined;
  agentName: string | null;
  /** The session's agent, after its run settled. */
  agent: Agent;
  /** This run's handles (the same ones its tools captured). */
  handles: SessionRecordHandles;
  config: SessionRecordsConfig | undefined;
  /** Tool names that do NOT count as work (builtins + the context's extras). */
  exemptToolNames: Set<string>;
  storage: Storage;
  /** The session's registry under dynamic loading: the record tool loads through it. */
  registry?: DynamicToolRegistry;
  /** The created agent's admission-class setter (raised to interactive). */
  setPriority?: (priority: PriorityClass) => void;
  /**
   * Persist the turn's messages (the run's transcript capture flush). Awaited
   * before the in-flight entry resolves, so a waiter (a reply-resume loading the
   * transcript, a reply injecting the record) sees the finished turn. Never throws.
   */
  flush?: () => Promise<void>;
  logger: Logger;
}

/**
 * Owns the in-flight registry (who is writing a record right now, and until
 * when) and drives the record turn.
 *
 * Lifecycle per run: right after the run settles, and BEFORE the caller frees
 * the timeline slot (so a trigger launched by that drain already sees the
 * entry), the caller calls {@link start}. It checks eligibility and registers the
 * entry synchronously, then runs the turn; the returned promise settles when
 * the turn is over and never rejects. Triggers that need the record
 * {@link waitFor} it, bounded by the entry's deadline (`timeout_ms`).
 *
 * Outcomes: a row only after `session_record_tool` finalized a non-empty draft
 * (`session_record_written`); a finalize on an empty draft is the legitimate
 * skip (`session_record_skipped`); anything else (refusal, LLM error, budget
 * block, timeout, `max_turns`, shutdown, a turn that ends without finalizing)
 * writes nothing and logs `session_record_failed` with the reason.
 */
export class SessionRecordService {
  private readonly inflight = new Map<string, InflightEntry>();
  private stopping = false;

  /** Number of record turns in flight (callers over-fetch candidates by it). */
  get inFlightCount(): number {
    return this.inflight.size;
  }

  /** True when a record turn is registered for this session. */
  isInFlight(sessionId: string): boolean {
    return this.inflight.has(sessionId);
  }

  /**
   * Wait for this session's in-flight record turn, at most until its deadline
   * (plus `graceMs`, for a caller that must see the turn actually over: the turn
   * aborts itself at the deadline, and settling takes a moment). Resolves true
   * when none is registered or the turn settled in time, false when the bound
   * elapsed first. Never rejects.
   */
  async waitFor(sessionId: string, opts: { graceMs?: number } = {}): Promise<boolean> {
    const entry = this.inflight.get(sessionId);
    if (!entry) return true;
    const remaining = entry.deadline + (opts.graceMs ?? 0) - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      entry.done.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      }),
    ]);
    clearTimeout(timer);
    return settled;
  }

  /**
   * Drain: refuse new record turns and abort the running ones. Each aborted turn
   * logs `session_record_failed` {reason:"shutdown"} and writes nothing; the
   * runtime's drain awaits the runs that carry them.
   */
  shutdown(): void {
    this.stopping = true;
    for (const entry of this.inflight.values()) entry.abort?.("shutdown");
  }

  /**
   * Start the record turn of a just-settled run. Returns undefined (nothing
   * registered) when the session is not eligible or `session_record_tool` is not
   * in its catalog (logged `session_record_skipped` {reason:"tool_unavailable"});
   * otherwise the in-flight entry
   * is registered before this returns, and the promise resolves when the turn
   * is over.
   */
  start(params: StartRecordTurnParams): Promise<void> | undefined {
    const { sessionId, sessionType, proactiveSessionType, config, agent, exemptToolNames } = params;
    if (!isEligibleForRecord(sessionType, proactiveSessionType, config, agent.state.messages, exemptToolNames)) {
      return undefined;
    }
    // A session-type tools allowlist or disabled_tools can take the record tool out
    // of the session's catalog; the turn could only fail then.
    const inCatalog = params.registry
      ? params.registry.inCatalog(RECORD_TOOL)
      : (agent.state.tools ?? []).some((tool) => tool.name === RECORD_TOOL);
    if (!inCatalog) {
      params.logger.info("session_record_skipped", { sessionId, reason: "tool_unavailable" });
      return undefined;
    }
    const timeoutMs = config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    let resolveDone!: () => void;
    const entry: InflightEntry = {
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      deadline: Date.now() + timeoutMs,
    };
    this.inflight.set(sessionId, entry);
    return this.run(params, entry, timeoutMs)
      .catch((error) => {
        params.logger.warn("session_record_failed", {
          sessionId,
          reason: "llm_error" satisfies RecordTurnFailure,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => params.flush?.())
      .catch(() => undefined)
      .finally(() => {
        if (this.inflight.get(sessionId) === entry) this.inflight.delete(sessionId);
        resolveDone();
      });
  }

  private async run(params: StartRecordTurnParams, entry: InflightEntry, timeoutMs: number): Promise<void> {
    const { sessionId, agent, handles, registry, logger } = params;
    const fail = (reason: RecordTurnFailure, extra?: Record<string, unknown>): void => {
      logger.warn("session_record_failed", { sessionId, reason, ...extra });
    };
    if (this.stopping) {
      fail("shutdown");
      return;
    }

    // It extends the interactive rollout that just finished and must land while
    // that cache is warm; triggers may be waiting on it (§3.2).
    params.setPriority?.("interactive");

    // A steer that landed after the rollout's last turn would otherwise be fed
    // into the record turn's loop. The session is over: clear the queue. The app
    // already handed every unread timeline steer to a fresh session when the run
    // settled (fold-after-settle), so nothing a user sent is lost here.
    if (agent.hasQueuedMessages()) {
      agent.clearAllQueues();
      logger.warn("session_record_queue_cleared", { sessionId });
    }

    const kickoff: AgentMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: RECORD_TURN_PROMPT }],
        timestamp: Date.now(),
        harness: { kind: "record_turn" },
      } as AgentMessage,
    ];
    // Under dynamic loading the record tool is deferred (never immediate, never
    // findable): load it at the native load point with a synthetic tool_search
    // select call, so the wire `tools` array never changes and each transport
    // serializes the load in its cache-friendly form. The result is supplied here
    // (tool_search itself refuses harness-only tools); loading the registry fires
    // onChange, which updates agent.state.tools before the prompt. Without dynamic
    // loading, or on a resumed rollout that loaded it already, it is in tools.
    if (registry && registry.inCatalog(RECORD_TOOL) && !registry.isLoaded(RECORD_TOOL)) {
      const tool = registry.catalogTools.find((t) => t.name === RECORD_TOOL)!;
      const model = agent.state.model;
      const { assistantMessage, toolResultMessage } = buildSyntheticCallFromResult(
        { name: "tool_search", params: { query: `select:${RECORD_TOOL}` }, harness: { kind: "record_load" } },
        { content: [{ type: "text", text: formatLoadedTools([tool]) }], addedToolNames: [RECORD_TOOL] },
        { api: model.api, provider: model.provider, model: model.id },
        registry,
      );
      kickoff.push(assistantMessage, toolResultMessage);
    }

    const maxTurns = params.config?.max_turns ?? DEFAULT_MAX_TURNS;
    const startIndex = agent.state.messages.length;
    let abortReason: AbortReason | undefined;
    entry.abort = (reason) => {
      if (abortReason) return;
      abortReason = reason;
      agent.abort();
    };
    let turns = 0;
    // Finalized = a session_record_tool call that ran (did not throw) and ended
    // the loop (`terminate`). A draft never finalized is abandoned (§3.2).
    let finalized = false;
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "tool_execution_end") {
        const result = event.result as { terminate?: unknown } | undefined;
        if (event.toolName === RECORD_TOOL && !event.isError && result?.terminate === true) finalized = true;
        return;
      }
      if (event.type !== "turn_end") return;
      turns += 1;
      if (turns >= maxTurns && !finalized) entry.abort?.("max_turns");
    });
    const timer = setTimeout(() => entry.abort?.("timeout"), timeoutMs);
    handles.gate.active = true;
    try {
      await agent.prompt(kickoff);
      await agent.waitForIdle();
    } finally {
      clearTimeout(timer);
      unsubscribe();
      handles.gate.active = false;
      entry.abort = undefined;
    }

    if (abortReason && !finalized) {
      fail(abortReason, { turns });
      return;
    }
    const turnMessages = agent.state.messages.slice(startIndex);
    const lastAssistant = [...turnMessages].reverse().find((m) => (m as { role?: string }).role === "assistant") as
      | { stopReason?: string; rawStopReason?: string; errorMessage?: string }
      | undefined;
    if (!finalized) {
      const error = agent.state.errorMessage ?? lastAssistant?.errorMessage;
      fail(classifyUnfinalizedRecordTurn(lastAssistant?.rawStopReason, error), {
        turns,
        stopReason: lastAssistant?.stopReason,
        ...(error ? { error } : {}),
      });
      return;
    }
    const text = handles.draft.isCreated() ? handles.draft.getContent() : "";
    if (text.trim().length === 0) {
      logger.info("session_record_skipped", { sessionId, reason: "empty" });
      return;
    }
    if (this.stopping) {
      fail("shutdown");
      return;
    }
    const buildsOn = buildsOnFromTranscript(agent.state.messages);
    const tokenCount = handles.draft.getTokenCount();
    // The member that served the record turn: its last real (non-synthetic)
    // assistant message carries the wire model id, like agent_sessions.model_id.
    const served = [...turnMessages]
      .reverse()
      .find((m) => (m as { role?: string }).role === "assistant" && !(m as { harness?: unknown }).harness) as { model?: string } | undefined;
    await params.storage.upsertSessionRecord({
      session_id: sessionId,
      timeline_key: params.timelineKey,
      agent: params.agentName,
      text,
      token_count: tokenCount,
      builds_on: buildsOn,
      model_id: served?.model ?? null,
      created_at: Date.now(),
    });
    logger.info("session_record_written", {
      sessionId,
      timelineKey: params.timelineKey,
      tokenCount,
      turns,
      modelId: served?.model,
      ...(buildsOn.length > 0 ? { buildsOn } : {}),
    });
  }
}
