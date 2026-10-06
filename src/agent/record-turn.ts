import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SummaryDraft } from "../tools/session-record-tool.js";

/**
 * Record-turn gate (spec SESSION-RECORDS, CONTRACT §3).
 *
 * One `RecordTurnGate` per session controls access to `session_record_tool`:
 *   - While `active` is false (the normal run): `session_record_tool` is blocked.
 *   - While `active` is true (the record turn): every OTHER tool is blocked.
 *
 * This is enforced by the wrapper returned from `wrapToolsWithRecordTurnGate`;
 * the gate itself is a plain mutable object the launcher (W6) flips when it
 * starts the record turn.
 */
export interface RecordTurnGate {
  active: boolean;
}

/**
 * Per-session handles for the session record machinery (CONTRACT §3).
 * Created by the session tool-assembly caller and threaded through so that W6
 * (the app-integration layer) can:
 *   1. Flip `gate.active = true` when starting the record turn.
 *   2. Read `draft` after finalize to obtain the finalized text for storage.
 *
 * How W6 obtains these handles:
 *   - W6 allocates `new SummaryDraft()` and `{ active: false }` before calling
 *     `buildSessionTools` (or equivalent session assembly entry point).
 *   - W6 passes the `SessionRecordHandles` to the tool-assembly function, which
 *     forwards `draft` to `createSessionRecordTool` and passes `gate` to
 *     `wrapToolsWithRecordTurnGate`.
 *   - After `agent.prompt()` returns for the record turn, W6 reads
 *     `handles.draft.isCreated()` and `handles.draft.getContent()` to decide
 *     whether to write a `session_records` row.
 */
export interface SessionRecordHandles {
  gate: RecordTurnGate;
  draft: SummaryDraft;
}

/**
 * Wrap a session's full tool list with the record-turn gate (CONTRACT §3):
 *
 * - Outside the record turn (`gate.active === false`): `session_record_tool`
 *   throws before doing anything; the message tells the agent it is only for
 *   the harness.
 * - During the record turn (`gate.active === true`): every tool EXCEPT
 *   `session_record_tool` throws, naming the record tool.
 *
 * The wrappers are thin — they short-circuit only on the blocked side; the
 * original `execute` runs unchanged on the allowed side. Tool definitions
 * (descriptions, parameters) are preserved so the wire channel stays
 * byte-stable when `gate.active` changes.
 */
export function wrapToolsWithRecordTurnGate(
  tools: readonly AgentTool[],
  gate: RecordTurnGate,
): AgentTool[] {
  return tools.map((tool) => {
    const original = tool.execute;
    const isRecordTool = tool.name === "session_record_tool";

    // Blocked calls THROW: pi-agent-core marks a tool result `isError` only on a
    // throw (a returned result is a success on the wire), and a throw also stops
    // any outer wrapper (e.g. the editor's skill activation) from acting on it.
    const wrappedExecute: typeof original = async (toolCallId, params, signal, onUpdate) => {
      if (isRecordTool && !gate.active) {
        throw new Error(
          "session_record_tool is only used by the harness at the end of a session. " +
            "Carry on with your other tools.",
        );
      }
      if (!isRecordTool && gate.active) {
        throw new Error(
          "Only session_record_tool is available while writing the session record. " +
            "Write it with session_record_tool (command \"create\", file_text: the record, finalize: true), or call " +
            "session_record_tool(command: \"finalize\") on the empty draft if nothing is worth recording.",
        );
      }
      return original.call(tool, toolCallId, params, signal, onUpdate);
    };

    return { ...tool, execute: wrappedExecute };
  });
}
