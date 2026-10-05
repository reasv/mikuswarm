/**
 * SessionRecordService — in-flight registry + record-turn driver
 * (spec SESSION-RECORDS §3, §6, CONTRACT §3/§5).
 *
 * One shared instance in the app; a per-session RecordTurnGate + SummaryDraft
 * are created by the session launcher before buildSessionTools so the tool
 * objects capture them at creation time.
 */

import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Storage } from "../storage/index.js";
import type { SessionRecordsConfig } from "../config/schema.js";
import type { LlmScheduler } from "./scheduler.js";
import type { Logger } from "../observability/logger.js";
import type { SummaryDraft } from "../tools/session-record-tool.js";
import type { RecordTurnGate } from "./record-turn.js";
import type { DynamicToolRegistry } from "./dynamic-tools.js";
import { buildSyntheticCallFromResult, type SyntheticModelInfo } from "./synthetic-calls.js";
import { hasResumableWork } from "./work-gate.js";
import { SYNTHETIC_SESSION_TYPES } from "./recovery.js";

// ── Prompt (spec §3.2) ────────────────────────────────────────────────────────

export const RECORD_TURN_PROMPT =
  "A later session will see only the chat and this record; write what it needs to answer questions about this work and continue it.\n\n" +
  "What to include depends on the work:\n" +
  "- For a lookup: the sources behind what was said (including things only mentioned in passing), and what was found but not used.\n" +
  "- For something made or changed: the artifacts (file paths, message ids), their current state, and how to continue or verify.\n" +
  "- Anything left open or unresolved.\n\n" +
  "Anchor the record to the messages you sent by including their message ids, because users reply to any of them, not only the last.\n" +
  "Record what and where, with one-line reasons where they help. Do not restate your reasoning or chain of thought.\n\n" +
  'Write the record now with session_record_tool. Use finalize when done, or finalize: true on your last edit.\n' +
  'If the session contained no tool work, call session_record_tool with command: "finalize" on the empty draft.';

// ── Config defaults ───────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_MAX_TURNS = 4;
const DEFAULT_TIMEOUT_MS = 60_000;

// ── Eligibility ───────────────────────────────────────────────────────────────

/**
 * Check whether a completed session is eligible for a record turn.
 *
 * Rules (spec §3.1):
 *   - Feature disabled → skip.
 *   - Synthetic session type (summarization, diary, …) → skip.
 *   - Proactive session type when `proactiveSessionType` is provided: only that
 *     specific type is eligible; "default" is always eligible.
 *   - Work gate (any_in_history, exempt = BUILTIN + extra_exempt_tools) → skip
 *     if there was no real tool work at all.
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

// ── In-flight registry ────────────────────────────────────────────────────────

interface InflightEntry {
  done: Promise<void>;
  resolve: () => void;
  deadline: number;
}

// ── Public service ────────────────────────────────────────────────────────────

export interface RunRecordTurnParams {
  sessionId: string;
  timelineKey: string;
  sessionType: string;
  /** The proactive session type string from config (e.g. "proactive"). */
  proactiveSessionType: string | undefined;
  agentName: string | null;
  agent: Agent;
  draft: SummaryDraft;
  gate: RecordTurnGate;
  /** Session IDs whose records were injected at session start. */
  buildsOn: string[];
  config: SessionRecordsConfig | undefined;
  /** Tool names that do NOT count as resumable work (must include builtins). */
  exemptToolNames: Set<string>;
  storage: Storage;
  llmScheduler: LlmScheduler;
  /** Registry — when present, session_record_tool is loaded via record_load. */
  registry?: DynamicToolRegistry;
  logger: Logger;
  /** Wire model info for the synthetic load pair (harness metadata only). */
  modelInfo: SyntheticModelInfo;
  /** Max tokens for the record content. Defaults to 1500. */
  maxTokens?: number;
}

/**
 * Manages in-flight record turns and drives the record-turn prompt sequence.
 *
 * Typical lifecycle per session:
 *  1. After `markCompleted`: caller calls `runRecordTurn(...)`.
 *  2. `runRecordTurn` registers an in-flight entry, escalates to interactive
 *     priority, prompts the agent (loading `session_record_tool` first when
 *     dynamic tools are on), and waits for idle.
 *  3. Other sessions replying to this session wait via `waitFor(sessionId)`.
 *  4. On completion the in-flight entry resolves and is removed.
 */
export class SessionRecordService {
  private readonly inflight = new Map<string, InflightEntry>();

  /** True when a record turn is still running for this session. */
  isInFlight(sessionId: string): boolean {
    return this.inflight.has(sessionId);
  }

  /**
   * Wait for the in-flight record turn to complete, up to its deadline.
   * Resolves immediately when no turn is registered. Never rejects.
   */
  async waitFor(sessionId: string): Promise<void> {
    const entry = this.inflight.get(sessionId);
    if (!entry) return;
    const remaining = Math.max(0, entry.deadline - Date.now());
    if (remaining === 0) return;
    await Promise.race([entry.done, new Promise<void>((r) => setTimeout(r, remaining))]);
  }

  /**
   * Drive the record turn for a just-completed session.
   *
   * Never throws — all errors are absorbed and logged. Eligibility is checked
   * here; callers do not need to gate on it (though pre-checking avoids work).
   */
  async runRecordTurn(params: RunRecordTurnParams): Promise<void> {
    const {
      sessionId,
      sessionType,
      proactiveSessionType,
      config,
      draft,
      gate,
      exemptToolNames,
      storage,
      llmScheduler,
      registry,
      logger,
      modelInfo,
      agent,
      buildsOn,
    } = params;

    const timeoutMs = config?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

    // Register in-flight before the eligibility transcript check so that a
    // concurrent waiter that starts between eligibility and the prompt sees us.
    let resolveEntry!: () => void;
    const donePromise = new Promise<void>((r) => { resolveEntry = r; });
    const entry: InflightEntry = {
      done: donePromise,
      resolve: resolveEntry,
      deadline: Date.now() + timeoutMs,
    };
    this.inflight.set(sessionId, entry);

    try {
      // Eligibility: check NOW (after the session completed) so we have the
      // full transcript.
      const transcript = agent.state.messages;
      if (!isEligibleForRecord(sessionType, proactiveSessionType, config, transcript, exemptToolNames)) {
        return;
      }

      // Raise priority so the record turn doesn't queue behind new work
      // arriving on this timeline right after the session settled.
      llmScheduler.escalate(sessionId, "interactive");

      const maxTokens = config?.max_tokens ?? DEFAULT_MAX_TOKENS;
      const maxTurns = config?.max_turns ?? DEFAULT_MAX_TURNS;

      // Build the user prompt message (harness-marked so the console can label it).
      const userMsg: AgentMessage = {
        role: "user",
        content: [{ type: "text", text: RECORD_TURN_PROMPT }],
        timestamp: Date.now(),
        harness: { kind: "record_turn" },
      } as AgentMessage;

      // When dynamic tools are on, load session_record_tool now.  The load is
      // represented as a synthetic view call that carries addedToolNames so the
      // registry fires onChange and updates agent.state.tools before the prompt.
      const loadMsgs: AgentMessage[] = [];
      if (registry) {
        const loadSpec = {
          name: "session_record_tool",
          params: { command: "view" } as Record<string, unknown>,
          harness: { kind: "record_load" as const },
        };
        const loadResult = {
          content: [{ type: "text" as const, text: `session_record_tool loaded (max ${maxTokens} tokens).` }],
          addedToolNames: ["session_record_tool"],
        };
        const { assistantMessage, toolResultMessage } = buildSyntheticCallFromResult(
          loadSpec,
          loadResult,
          modelInfo,
          registry,
        );
        loadMsgs.push(assistantMessage, toolResultMessage);
      }

      // Activate the gate: session_record_tool is now allowed, everything else
      // is blocked.
      gate.active = true;

      // Set up an abort in case the turn exceeds the deadline.
      const timeout = setTimeout(() => agent.abort(), timeoutMs);

      try {
        await agent.prompt([userMsg, ...loadMsgs]);
        await agent.waitForIdle();
      } finally {
        clearTimeout(timeout);
        gate.active = false;
      }

      // Inspect result: write a row only when the draft was created and has content.
      if (!draft.isCreated() || draft.getContent().trim().length === 0) {
        logger.info("session_record_skipped", { sessionId, reason: "empty_draft" });
        return;
      }
      if (agent.state.errorMessage) {
        logger.warn("session_record_agent_error", {
          sessionId,
          error: agent.state.errorMessage,
        });
        // Still attempt to write the record if the draft was populated before
        // the error (e.g. turn limit hit after finalize).
        if (!draft.isCreated() || draft.getContent().trim().length === 0) return;
      }

      const text = draft.getContent();
      const tokenCount = draft.getTokenCount();

      await storage.upsertSessionRecord({
        session_id: sessionId,
        timeline_key: params.timelineKey,
        agent: params.agentName ?? null,
        text,
        token_count: tokenCount,
        builds_on: buildsOn.length > 0 ? buildsOn : undefined,
        model_id: modelInfo.model,
        created_at: Date.now(),
      });

      logger.info("session_record_written", {
        sessionId,
        timelineKey: params.timelineKey,
        tokenCount,
        buildsOn: buildsOn.length > 0 ? buildsOn : undefined,
      });
    } catch (error) {
      logger.error("session_record_turn_error", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      entry.resolve();
      this.inflight.delete(sessionId);
    }
  }
}
