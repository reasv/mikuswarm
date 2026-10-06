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
import { extractLlmRequestClass, isRefusalSignal } from "./request-retry.js";
import { formatLoadedTools } from "../tools/tool-search.js";

// ── Prompt (spec §3.2) ────────────────────────────────────────────────────────

export const RECORD_TURN_PROMPT =
  "This execution is over. Write a record of the work you performed during this execution, so a later execution can answer questions about that work and carry it on.\n" +
  "Record your own tool calls and their useful results, artifacts you created or changed, and the messages you sent in this execution.\n" +
  "The chat history, conversation summaries, and earlier session records supplied to you are background. They are not work you performed in this execution. Do not summarize that background or copy earlier records into this one. Include an earlier fact only when needed to explain your current work.\n" +
  "\n" +
  "What it needs depends on the work:\n" +
  "- a lookup: the sources behind what you said, including things you only mentioned in passing, and what you found but did not use;\n" +
  "- something made or changed: the artifacts (paths, message ids), their current state, and how to continue or check them;\n" +
  "- work you attempted in this execution but did not finish: what remains and where to continue.\n" +
  "\n" +
  "Tie each part to the message you sent in this execution, by its message id when available.\n" +
  "Keep it a handoff note: what and where, with a one-line why where it helps.\n" +
  "\n" +
  'session_record_tool is already loaded: call it directly, without tool_search. ' +
  'Write the record in one call: {"command":"create","file_text":"<the record>","finalize":true}. ' +
  'The create command requires file_text. If nothing is worth recording, call {"command":"finalize"} on the empty draft. ' +
  "No other tool is available in this turn.";

// ── Config defaults (mirror config/00-defaults.toml) ─────────────────────────

const DEFAULT_MAX_TURNS = 4;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

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
  return recordSkipReason(sessionType, proactiveSessionType, config, transcript, exemptToolNames) === undefined;
}

function recordSkipReason(
  sessionType: string, proactiveSessionType: string | undefined, config: SessionRecordsConfig | undefined,
  transcript: AgentMessage[], exemptToolNames: Set<string>,
): string | undefined {
  if (config?.enabled === false) return "disabled";
  if (SYNTHETIC_SESSION_TYPES.has(sessionType) || (sessionType !== "default" && sessionType !== proactiveSessionType)) return "session_type";
  if (!hasResumableWork(transcript, { scope: "any_in_history", exemptToolNames })) return "no_work";
  return undefined;
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
  | "max_turns"
  | "shutdown"
  | "not_finalized";

/**
 * Why a record turn that ended on its own (no abort of ours) wrote nothing. A
 * refusal is Layer 0's `refusal` class (its class marker on the error), or the
 * same provider signals read directly (`isRefusalSignal`: the raw stop reason,
 * else pi-ai's exact refusal text); a budget gate surfaces as the factory's
 * pre-flight message; any other error is an LLM error; no error at all means the
 * model stopped without finalizing.
 */
export function classifyUnfinalizedRecordTurn(
  rawStopReason: string | undefined,
  errorMessage: string | undefined,
): Exclude<RecordTurnFailure, "max_turns" | "shutdown"> {
  if (extractLlmRequestClass(errorMessage) === "refusal" || isRefusalSignal(rawStopReason, errorMessage)) {
    return "refusal";
  }
  if (errorMessage && /cost limit exceeded|budget exhausted/i.test(errorMessage)) return "budget_blocked";
  if (errorMessage && errorMessage.length > 0) return "llm_error";
  return "not_finalized";
}

type AbortReason = "max_turns" | "shutdown";

interface InflightEntry {
  outcome?: { status: string; reason?: string };
  done: Promise<void>;
  waitDeadline: number;
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
   * The created agent's refusal-fallover switch: turned off for the turn, so a
   * refusal fails it at once instead of moving to another chain member (§3.2).
   */
  setRefusalFallover?: (enabled: boolean) => void;
  /**
   * The created agent's refusal-site switch: the turn's requests are refusal site
   * `record_turn`, so a `[[refusal_fallback]]` rule naming it (or naming no sites)
   * redoes a refused record turn on its model (spec REFUSAL-HANDLING §8.1).
   */
  setRefusalSite?: (site: string | undefined) => void;
  /**
   * Persist the turn's messages (the run's transcript capture flush). Awaited
   * before the in-flight entry resolves, so a waiter (a reply-resume loading the
   * transcript, a reply injecting the record) sees the finished turn. Never throws.
   */
  flush?: () => Promise<void>;
  /**
   * Told of every written record (its text): the output gate judges it as an
   * artifact after writing (spec REFUSAL-HANDLING §5.2.3). Awaited before
   * releasing the accounting settle barrier; failures remain observe-only.
   */
  onRecordWritten?: (text: string) => void | Promise<void>;
  /**
   * Judge the finalized record before it is written (spec REFUSAL-HANDLING
   * §5.2.3), when a soft refusal rule could act on it: `rerun` = the record was
   * judged a refusal and the session is now pinned to the rule's entry (the
   * turn is discarded and run again), `exhausted` = every entry refused (no
   * record), `accept` = write it (then `onRecordWritten` is not called again).
   * Absent or undefined result = observe-only (`onRecordWritten`). Never rejects.
   */
  judgeRecord?: (text: string) => Promise<"accept" | "rerun" | "exhausted" | undefined>;
  /**
   * Discard the record turn's messages from `startIndex` on (a fork into a
   * branch, spec §9) before a rerun. Needed with `judgeRecord`.
   */
  discardTurn?: (startIndex: number) => Promise<void>;
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
 * {@link waitFor} it, bounded by the entry's wait deadline (`wait_timeout_ms`).
 *
 * Outcomes: a row only after `session_record_tool` finalized a non-empty draft
 * (`session_record_written`); a finalize on an empty draft is the legitimate
 * skip (`session_record_skipped`); anything else (refusal, LLM error, budget
 * block, `max_turns`, shutdown, a turn that ends without finalizing)
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

  /** Settle barrier for accounting cleanup; unlike trigger waits, it cannot time out. */
  settled(sessionId: string): Promise<void> {
    return this.inflight.get(sessionId)?.done ?? Promise.resolve();
  }

  /**
   * Wait for this session's in-flight record turn, at most until its wait deadline
   * (plus optional `graceMs`). Expiring a wait never aborts record production. Resolves true
   * when none is registered or the turn settled in time, false when the bound
   * elapsed first. Never rejects.
   */
  async waitFor(sessionId: string, opts: { graceMs?: number } = {}): Promise<boolean> {
    const entry = this.inflight.get(sessionId);
    if (!entry) return true;
    const remaining = entry.waitDeadline + (opts.graceMs ?? 0) - Date.now();
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
    const persist = (status: string, reason?: string): Promise<void> =>
      (params.storage.setSessionRecordGeneration?.(sessionId, status, reason ?? null) ?? Promise.resolve())
        .catch(() => params.logger.warn("session_record_status_write_failed", { sessionId }));
    const skip = recordSkipReason(sessionType, proactiveSessionType, config, agent.state.messages, exemptToolNames);
    if (skip) {
      void persist("skipped", skip);
      return undefined;
    }
    // A session-type tools allowlist or disabled_tools can take the record tool out
    // of the session's catalog; the turn could only fail then.
    const inCatalog = params.registry
      ? params.registry.inCatalog(RECORD_TOOL)
      : (agent.state.tools ?? []).some((tool) => tool.name === RECORD_TOOL);
    if (!inCatalog) {
      void persist("skipped", "tool_unavailable");
      params.logger.info("session_record_skipped", { sessionId, reason: "tool_unavailable" });
      return undefined;
    }
    const waitTimeoutMs = config?.wait_timeout_ms ?? config?.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
    let resolveDone!: () => void;
    const entry: InflightEntry = {
      done: new Promise<void>((resolve) => {
        resolveDone = resolve;
      }),
      waitDeadline: Date.now() + waitTimeoutMs,
    };
    this.inflight.set(sessionId, entry);
    void persist("writing");
    return this.run(params, entry)
      .catch((error) => {
        entry.outcome = { status: "failed", reason: "llm_error" };
        params.logger.warn("session_record_failed", {
          sessionId,
          reason: "llm_error" satisfies RecordTurnFailure,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => persist(entry.outcome?.status ?? "failed", entry.outcome?.reason))
      .then(() => params.flush?.())
      .catch(() => undefined)
      .finally(() => {
        if (this.inflight.get(sessionId) === entry) this.inflight.delete(sessionId);
        resolveDone();
      });
  }

  private async run(params: StartRecordTurnParams, entry: InflightEntry): Promise<void> {
    const { sessionId, agent, handles, registry, logger } = params;
    const markOutcome = (status: string, reason?: string): void => {
      entry.outcome = { status, reason };
      const kickoff = [...agent.state.messages].reverse().find((m) =>
        (m as { harness?: { kind?: string } }).harness?.kind === "record_turn",
      ) as { harness?: Record<string, unknown> } | undefined;
      if (kickoff?.harness) Object.assign(kickoff.harness, { status, ...(reason ? { reason } : {}) });
    };
    const fail = (reason: RecordTurnFailure, extra?: Record<string, unknown>): void => {
      markOutcome("failed", reason);
      logger.warn("session_record_failed", { sessionId, reason, ...extra });
    };
    if (this.stopping) {
      fail("shutdown");
      return;
    }

    // It extends the interactive rollout that just finished and must land while
    // that cache is warm; triggers may be waiting on it (§3.2).
    params.setPriority?.("interactive");
    // A refused record turn writes no record (spec §3.2): no fallover to
    // another chain member, so the refusal ends the turn at once.
    params.setRefusalFallover?.(false);
    // The opt-out above disables only the implicit fallover; a refusal rule for
    // this site still applies (spec REFUSAL-HANDLING §8.1).
    params.setRefusalSite?.("record_turn");

    // A steer that landed after the rollout's last turn would otherwise be fed
    // into the record turn's loop. The session is over: clear the queue. The app
    // already handed every unread timeline steer to a fresh session when the run
    // settled (fold-after-settle), so nothing a user sent is lost here.
    if (agent.hasQueuedMessages()) {
      agent.clearAllQueues();
      logger.warn("session_record_queue_cleared", { sessionId });
    }

    // The kickoff: the record prompt, plus the record tool's load when it is
    // not loaded yet. Rebuilt for a rerun (a fork unloads what only the
    // discarded turn loaded).
    const buildKickoff = (): AgentMessage[] => {
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
      return kickoff;
    };

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
    handles.gate.active = true;
    // The record's soft-refusal verdict (spec REFUSAL-HANDLING §5.2.3), when judged.
    let judged: "accept" | "exhausted" | undefined;
    try {
      for (;;) {
        await agent.prompt(buildKickoff());
        await agent.waitForIdle();
        if (!params.judgeRecord || abortReason || !finalized || this.stopping) break;
        const draftText = handles.draft.isCreated() ? handles.draft.getContent() : "";
        if (draftText.trim().length === 0) break;
        const verdict = await params.judgeRecord(draftText);
        if (verdict === undefined) break;
        if (verdict !== "rerun") {
          judged = verdict;
          break;
        }
        // Judged a refusal: discard the turn and write the record again on the
        // rule's model (the session is pinned to it; the site stays `record_turn`
        // so the rule's tries continue across reruns).
        await params.discardTurn?.(startIndex);
        handles.draft.reset();
        finalized = false;
        turns = 0;
        logger.info("session_record_refusal_redo", { sessionId });
      }
    } catch (error) {
      markOutcome("failed", "llm_error");
      throw error;
    } finally {
      unsubscribe();
      handles.gate.active = false;
      entry.abort = undefined;
      params.setRefusalFallover?.(true);
      params.setRefusalSite?.(undefined);
    }

    if (abortReason && !finalized) {
      fail(abortReason, { turns });
      return;
    }
    if (judged === "exhausted") {
      // Never a refusal written as a record (spec §8.2): every rule entry refused.
      fail("refusal", { turns, soft: true });
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
      markOutcome("skipped", "empty");
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
    markOutcome("written");
    logger.info("session_record_written", {
      sessionId,
      timelineKey: params.timelineKey,
      tokenCount,
      turns,
      modelId: served?.model,
      ...(buildsOn.length > 0 ? { buildsOn } : {}),
    });
    if (judged === undefined) {
      try {
        await params.onRecordWritten?.(text);
      } catch {
        /* observe-only */
      }
    }
  }
}
