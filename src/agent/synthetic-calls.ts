/**
 * Shared types for harness-made synthetic messages (spec SESSION-RECORDS,
 * CONTRACT decision 5). Synthetic messages are ordinary pi-agent-core transcript
 * entries with an added `harness` field — pi ignores unknown fields so they
 * persist across serialization/deserialization and are inspectable in the console.
 *
 * The three kinds:
 *   - `injection`: a synthetic `load_skill` or `read_session_record` call
 *     appended to the start of a fresh session's live transcript. Carries an
 *     optional `decisionGroup` so the console can link the call to the decision
 *     that produced it.
 *   - `record_turn`: the harness user turn that initiates the record turn.
 *   - `record_load`: the synthetic `load_skill`/tool-load call that makes
 *     `session_record_tool` available for the record turn.
 *
 * W5 (injection mechanism) will add factory helpers for `injection` messages.
 * This file is the single source of truth for the discriminated union.
 */

export type HarnessMarker =
  | { kind: "injection"; decisionGroup?: string }  // synthetic call/result at session start
  | { kind: "record_turn" }                         // the record-turn user prompt
  | { kind: "record_load" };                        // synthetic load of session_record_tool
