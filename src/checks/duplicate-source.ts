/**
 * The duplicate check's reads for one session (ARCHITECTURE.md §8j "Duplicate
 * sends"), over storage: where a posting call lands, which bot messages the
 * same agent's other sessions stored there, what each one (and this session's
 * draft) was answering, and the duplicate rejections a resumed session already
 * received. Built in app.ts and handed to the factory with the gate services.
 */
import type { AgentSessionRecord } from "../agent/session-manager.js";
import { hydrateEvents, type EnrichmentDataSource } from "../context/hydrate.js";
import { senderName } from "../decisions/transcript.js";
import type { DecisionEvaluationRow, SessionMessageRow } from "../storage/database.js";
import { parseTimelineKey } from "../storage/timeline-key.js";
import { sessionReadDenial, type SessionReadGate } from "../tools/read-session-record.js";
import type { CanonicalChatEvent } from "../types.js";
import { duplicateTarget, messageText, type Answering, type DuplicateRow } from "./duplicate.js";
import type { GateDuplicateSource } from "./gate.js";

export interface DuplicateSourceDeps {
  storage: EnrichmentDataSource & {
    listSessionMessagesSince(opts: { timelineKey: string; after: number; excludeSessionId: string; limit: number }): SessionMessageRow[];
    dmTimelineKeysForPeer(provider: string, accountId: string, userId: string): string[];
    getDecisionEvaluationsForSession(sessionId: string): DecisionEvaluationRow[];
  };
  /** The agent owning a timeline (null = legacy single-agent mode). */
  agentFor: (timelineKey: string) => string | null;
  /** The proactive session type (`[proactive].session_type`, default `proactive`). */
  proactiveSessionType: string;
  /**
   * The session read gate of a session in `timelineKey` (channel visibility and
   * own agent, the one `read_session_record` applies). Absent = everything is
   * readable (no visibility config).
   */
  readGate?: (timelineKey: string, agentName: string | null) => SessionReadGate;
}

/**
 * What the drafting session may see of another session's messages in
 * `targetTimelineKey` (ARCHITECTURE.md §8j "Duplicate sends", §9h): nothing
 * when it may not read that timeline (an isolated channel other than its own);
 * otherwise each message, with what it was answering only when the posting
 * session's timeline is readable too (else `private`, a neutral marker). The
 * gate is `sessionReadDenial`, shared with the session-record read tools.
 */
export function visibleDuplicateRows(
  rows: readonly DuplicateRow[],
  targetTimelineKey: string,
  gate: SessionReadGate | undefined,
): DuplicateRow[] {
  if (!gate) return [...rows];
  if (sessionReadDenial({ timeline_key: targetTimelineKey }, gate) !== undefined) return [];
  return rows.map((row) => {
    if (row.sessionTimelineKey === undefined || sessionReadDenial({ timeline_key: row.sessionTimelineKey }, gate) === undefined) {
      return row;
    }
    const { sessionTimelineKey: _hidden, ...rest } = row;
    return { ...rest, answering: "private" };
  });
}

/** A proactive session's synthetic trigger id prefix (src/proactive/scheduler.ts). */
const PROACTIVE_TRIGGER_PREFIX = "proactive-";

function isProactive(sessionType: string | null | undefined, triggerEventId: string | null | undefined, proactiveType: string): boolean {
  return sessionType === proactiveType || (triggerEventId ?? "").startsWith(PROACTIVE_TRIGGER_PREFIX);
}

/** What a stored session was answering: its trigger, or nothing (proactive). */
export function answeringOfSession(session: SessionMessageRow["session"], proactiveType: string): Answering {
  if (!session) return { from: "unknown", text: "" };
  if (isProactive(session.sessionType, session.triggerEventId, proactiveType)) return "unprompted";
  return {
    from: session.triggerSenderDisplayName ?? session.triggerSenderId ?? "unknown",
    text: session.triggerBody ?? "",
  };
}

/** The draft's request: the session's (hydrated) trigger, or nothing for a proactive session. */
function answeringOfTrigger(event: CanonicalChatEvent, sessionType: string, proactiveType: string): Answering {
  if (isProactive(sessionType, event.id, proactiveType) || event.trigger?.reason === "proactive") return "unprompted";
  return { from: senderName(event.sender), text: messageText(event) };
}

/**
 * Duplicate rejections on a session's decision rows (live branch): the call's
 * tool call id and the unseen messages its duplicate call judged against
 * (`verdict_json.earlier_ids`), for calls where a duplicate check fired.
 */
export function priorDuplicateRejections(
  rows: readonly Pick<DecisionEvaluationRow, "point" | "tool_call_id" | "branch_no" | "verdict_json">[],
  duplicateCodes: ReadonlySet<string>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) {
    if (row.point !== "checks" || !row.tool_call_id || (row.branch_no ?? 0) !== 0 || !row.verdict_json) continue;
    let verdict: { fired?: unknown; earlier_ids?: unknown };
    try {
      verdict = JSON.parse(row.verdict_json) as typeof verdict;
    } catch {
      continue;
    }
    const fired = Array.isArray(verdict.fired) ? verdict.fired : [];
    if (!fired.some((code) => typeof code === "string" && duplicateCodes.has(code))) continue;
    if (!Array.isArray(verdict.earlier_ids)) continue;
    const ids = verdict.earlier_ids.filter((id): id is string => typeof id === "string");
    if (ids.length > 0) out.set(row.tool_call_id, ids);
  }
  return out;
}

/** The per-session reads of the duplicate stage. */
export function createDuplicateSource(
  deps: DuplicateSourceDeps,
  duplicateCodes: (agent: string | null) => ReadonlySet<string>,
): (session: AgentSessionRecord, agentName: string | null) => GateDuplicateSource {
  return (session, agentName) => {
    const gate = deps.readGate?.(session.timelineKey, agentName);
    return {
      target: (toolName, args) =>
        duplicateTarget(toolName, args, session.timelineKey, (userId) => {
          const parsed = parseTimelineKey(session.timelineKey);
          if (!parsed) return undefined;
          // The newest DM with that user on this session's account (none = nothing to compare).
          return deps.storage.dmTimelineKeysForPeer(parsed.provider, parsed.accountId, userId)[0];
        }),
      messages: (timelineKey, after, limit): DuplicateRow[] => {
        const rows = deps.storage
          .listSessionMessagesSince({ timelineKey, after, excludeSessionId: session.id, limit })
          // Only the same agent's sessions: another agent is a separate participant.
          .filter((row) => !row.session || deps.agentFor(row.session.timelineKey) === agentName);
        const hydrated = hydrateEvents(deps.storage, rows.map((row) => row.event));
        const out: DuplicateRow[] = rows.map((row, i) => ({
          event: hydrated[i] ?? row.event,
          sessionId: row.sessionId,
          receivedAt: row.receivedAt,
          answering: answeringOfSession(row.session, deps.proactiveSessionType),
          ...(row.session ? { sessionTimelineKey: row.session.timelineKey } : {}),
        }));
        return visibleDuplicateRows(out, timelineKey, gate);
      },
      answering: () => {
        const [trigger] = hydrateEvents(deps.storage, [session.trigger.event]);
        return answeringOfTrigger(trigger ?? session.trigger.event, session.sessionType, deps.proactiveSessionType);
      },
      priorRejections: () =>
        priorDuplicateRejections(deps.storage.getDecisionEvaluationsForSession(session.id), duplicateCodes(agentName)),
    };
  };
}
