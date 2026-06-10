import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionRow } from "../storage/index.js";
import type { ContextMessage } from "../context/builder.js";
import { mapBuiltMessages } from "./factory.js";

// =============================================================================
// Layer 2 — session resume-in-place (spec CONCURRENCY-AND-RATE-LIMITING §6.2).
//
// When Layer-1 request retry exhausts (or a run dies mechanically mid-stream),
// the session is NOT discarded: the persisted `agent_sessions` row already
// holds everything needed to redo the failed request — the frozen context
// snapshot (`context_snapshot_json`, written once at creation) and the
// transcript flushed up to and including the in-progress turn
// (`transcript_json`, captured by the failure-path `flushNow()`).
//
// This module prepares that material for `factory.create({ resume })`:
//
// - The snapshot is persisted as raw `ContextMessage[]` (system block + tier
//   metadata intact, for the verbatim renderer). The live runtime prefix is a
//   DIFFERENT projection — `mapBuiltMessages` drops the system block and folds
//   the summary layer into a user chatEvent — so the parsed snapshot MUST run
//   through `mapBuiltMessages` before seeding `resume.snapshot` (the factory's
//   documented vocabulary contract).
// - The transcript's tail may carry the synthetic `stopReason:"error"` assistant
//   message pi-agent-core appended when the run failed (and, for a mid-stream
//   death, a partial assistant turn). Those are STRIPPED so the transcript ends
//   at the user/tool-result message whose answer never committed —
//   `agent.continue()` then re-issues exactly that request.
// =============================================================================

export interface ResumeMaterial {
  /** Frozen prefix in the agent message vocabulary (mapBuiltMessages-projected). */
  snapshot: AgentMessage[];
  /** Live transcript, stripped of the failed tail; ends user/tool-result-side. */
  transcript: AgentMessage[];
}

/**
 * Load and project a session row's persisted snapshot + transcript into the
 * shape `factory.create({ resume })` expects. Returns null when the row cannot
 * be resumed: missing/corrupt snapshot or transcript, or a transcript that —
 * after stripping the failed tail — no longer ends at a user/tool-result
 * message (nothing to re-issue).
 */
export function loadResumeMaterial(row: AgentSessionRow): ResumeMaterial | null {
  if (!row.context_snapshot_json || !row.transcript_json) return null;

  let snapshotRaw: ContextMessage[];
  let transcriptRaw: AgentMessage[];
  try {
    snapshotRaw = JSON.parse(row.context_snapshot_json) as ContextMessage[];
    transcriptRaw = JSON.parse(row.transcript_json) as AgentMessage[];
  } catch {
    return null;
  }
  if (!Array.isArray(snapshotRaw) || !Array.isArray(transcriptRaw)) return null;

  // Vocabulary contract (factory `resume` docs): project the raw ContextMessage
  // snapshot into the runtime prefix shape. Token totals are irrelevant here.
  const snapshot = mapBuiltMessages({
    messages: snapshotRaw,
    tokenEstimate: 0,
    compactTokens: 0,
    richTokens: 0,
    imageBlocks: [],
  });

  const transcript = stripFailedTail(transcriptRaw);
  if (transcript.length === 0) return null;
  if (!endsAwaitingAssistant(transcript)) return null;

  return { snapshot, transcript };
}

/**
 * Drop the failed tail: trailing assistant messages that are the synthetic
 * error/aborted turn (or a partial that died mid-stream and carries an error
 * stopReason). A CLEAN trailing assistant message is left alone — that run
 * committed, and `endsAwaitingAssistant` will then reject the material (there
 * is no failed request to redo).
 */
export function stripFailedTail(transcript: AgentMessage[]): AgentMessage[] {
  const out = [...transcript];
  while (out.length > 0) {
    const last = out[out.length - 1] as { role?: string; stopReason?: string };
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

/**
 * `agent.continue()` requires the transcript to end at a user or tool-result
 * message (an un-answered request). The transcript head can also be the typed
 * final-turn shapes (`triggerGroup`/`satellite`/`interjection`), which convert
 * to user turns — accept those too.
 */
function endsAwaitingAssistant(transcript: AgentMessage[]): boolean {
  const last = transcript[transcript.length - 1] as { role?: string; type?: string };
  if (!last) return false;
  if (last.role === "user" || last.role === "toolResult") return true;
  return last.type === "triggerGroup" || last.type === "satellite" || last.type === "interjection";
}
