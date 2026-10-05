/**
 * The send-contract audit (spec REFUSAL-HANDLING §7.2–§7.3, §7.6;
 * DECISION-MODEL §5.8): the decision-model diagnosis of a nudged session,
 * offline. One decision call per nudged run (failure point), questions only
 * where the mechanics cannot decide:
 *
 * - **`had_user_message`** (`noul`, per failed attempt whose only mechanical type
 *   is `text_only`): does the text hold a message written for the users? When
 *   it does not (`1 - p ≥ self_talk_threshold`), the attempt gains `self_talk`
 *   (§7.2), which outranks `text_only` by precedence.
 * - **`textual_tool_call`** (`noul`, ambiguous text: names a tool but matched no
 *   pattern): the attempt gains `textual_tool_call` at `p ≥
 *   textual_tool_call_threshold`.
 * - **`after_correction`** (`choice`, §7.3), only when the run sent something
 *   after the nudges and the texts are not mechanically equal: `same`,
 *   `minor_rewording`, `parts_removed`, `rewritten_same_substance`,
 *   `different_substance`. The other outcomes are mechanical facts and never
 *   asked: normalized equality → `same`, a silent ending → `switched_to_no_reply`,
 *   no valid ending → `nothing`. A choice below `min_confidence` is kept with
 *   its probabilities and counted as `uncertain`.
 *
 * The mechanical comparison (normalized equality, edit similarity, length
 * ratio) is always computed when there is a first attempt and a sent message.
 */
import type { StateMessage } from "../checks/state.js";
import { CONTRACT_FAILURE_TYPES, KNOWN_TOOL_NAMES, primaryContractFailure } from "../agent/contract.js";
import { clipText } from "../decisions/state.js";
import { estimateTokens } from "../context/tokens.js";
import type { DecisionPoint } from "../decisions/registry.js";
import type { DecisionAnswers, DecisionQuestion } from "../decisions/types.js";
import type { ContractAttemptRow, ContractAttemptTypesUpdate } from "../storage/index.js";
import { compareMessages, type MessageComparison } from "./compare.js";
import { mentionsToolName, type ContractRun } from "./transcript.js";

/** `after_correction` options (spec §7.3). */
export const AFTER_CORRECTION_CHOICES = [
  "same",
  "minor_rewording",
  "parts_removed",
  "rewritten_same_substance",
  "different_substance",
  "switched_to_no_reply",
  "nothing",
] as const;
export type AfterCorrectionChoice = (typeof AFTER_CORRECTION_CHOICES)[number];

/** The options the decision model chooses among (something was sent). */
export const AFTER_CORRECTION_ASKED: Record<Exclude<AfterCorrectionChoice, "switched_to_no_reply" | "nothing">, string> = {
  same: "`sent` is essentially the same text as `first_attempt`.",
  minor_rewording: "`sent` has the same content as `first_attempt`, with minor wording changes.",
  parts_removed: "`sent` is `first_attempt` with a significant part removed.",
  rewritten_same_substance: "`sent` says the same things as `first_attempt` in substantially different words.",
  different_substance: "`sent` has different content from `first_attempt`.",
};

/** The key the rollups count a below-`min_confidence` choice under. */
export const AFTER_CORRECTION_UNCERTAIN = "uncertain";

const CLIP = { request: 1200, attempt: 3000, sent: 4000 } as const;

/** One failed attempt the call asks about. */
export interface AttemptQuestion {
  /** Question-id prefix (`a<n>`). */
  id: string;
  text: string;
  askUserMessage: boolean;
  askTextual: boolean;
}

export interface ContractAuditInput {
  request: StateMessage[];
  nudges: number;
  /** How the run ended (`sent`, `switched_to_no_reply`, `nothing`). */
  ending: string;
  attempts: AttemptQuestion[];
  firstAttempt?: string;
  sent?: string;
  askAfterCorrection: boolean;
}

export interface ContractAuditVerdict {
  answers: DecisionAnswers;
  unjudged?: true;
}

function headChars(text: string, chars: number): string {
  return clipText(text, Math.max(40, chars));
}

/** The state, packed to the member's budget by shrinking every text evenly. */
function contractState(input: ContractAuditInput, budgetTokens: number): Record<string, unknown> {
  const build = (scale: number): Record<string, unknown> => {
    const state: Record<string, unknown> = {
      request: input.request.map((m) => ({ from: m.from, text: headChars(m.text, CLIP.request * scale) })),
      nudges: input.nudges,
      ending: input.ending,
    };
    if (input.attempts.length > 0) {
      const attempts: Record<string, string> = {};
      for (const a of input.attempts) attempts[a.id] = headChars(a.text, CLIP.attempt * scale);
      state["attempts"] = attempts;
    }
    if (input.firstAttempt !== undefined) state["first_attempt"] = headChars(input.firstAttempt, CLIP.attempt * scale);
    if (input.sent !== undefined) state["sent"] = headChars(input.sent, CLIP.sent * scale);
    return state;
  };
  let scale = 1;
  let state = build(scale);
  while (estimateTokens(JSON.stringify(state)) > budgetTokens && scale > 0.02) {
    scale /= 2;
    state = build(scale);
  }
  return state;
}

export const contractAuditPoint: DecisionPoint<ContractAuditInput, ContractAuditVerdict> = {
  name: "audit",

  questions(input: ContractAuditInput): Record<string, DecisionQuestion> {
    const out: Record<string, DecisionQuestion> = {};
    const preface =
      "The assistant answers in a chat by calling a send tool; text it writes outside that tool is never shown to " +
      "the users. This turn it ended without sending, and was reminded (`nudges` times).";
    for (const a of input.attempts) {
      if (a.askUserMessage) {
        out[`${a.id}__had_user_message`] = {
          type: "noul",
          instructions:
            `${preface} \`attempts.${a.id}\` is text it wrote outside the send tool before a reminder. It contains a ` +
            "message written to be read by the users.",
          criteria: {
            true: "It holds a reply or message addressed to the users, even if surrounded by notes.",
            false: "It is only reasoning, planning or narration the assistant wrote to itself, with nothing addressed to the users.",
          },
        };
      }
      if (a.askTextual) {
        out[`${a.id}__textual_tool_call`] = {
          type: "noul",
          instructions:
            `${preface} \`attempts.${a.id}\` tries to call a tool (for example the send tool) by writing the call as ` +
            "text: function-call syntax, JSON or markup naming the tool with its arguments.",
          criteria: {
            true: "It is a tool call written out as text, with the tool's name and arguments.",
            false: "It is a message or a note that only mentions a tool by name, or ordinary text.",
          },
        };
      }
    }
    if (input.askAfterCorrection) {
      out["after_correction"] = {
        type: "choice",
        instructions:
          `${preface} \`first_attempt\` is the message it first tried to deliver; \`sent\` is what it actually sent ` +
          "after the reminders. How does `sent` relate to `first_attempt`?",
        criteria: { ...AFTER_CORRECTION_ASKED },
      };
    }
    return out;
  },

  state(input: ContractAuditInput, budgetTokens: number): unknown {
    return contractState(input, budgetTokens);
  },

  resolve(answers: DecisionAnswers): ContractAuditVerdict {
    return { answers };
  },

  fallback(): ContractAuditVerdict {
    return { answers: {}, unjudged: true };
  },

  describe(verdict: ContractAuditVerdict): unknown {
    if (verdict.unjudged) return { unjudged: true };
    const out: Record<string, unknown> = {};
    for (const [id, a] of Object.entries(verdict.answers)) {
      out[id] = a.type === "noul" ? Math.round(a.noul * 1000) / 1000 : a.type === "choice" ? a.choice : a.score;
    }
    return out;
  },
};

/** A failed attempt of a run, with its stored row and ending text. */
export interface RunAttempt {
  row: ContractAttemptRow;
  text: string;
}

/** The per-attempt diagnosis recorded in the audit verdict. */
export interface AttemptDiagnosis {
  branchNo: number;
  redoNo: number;
  attemptNo: number;
  /** `had_user_message` probability, when asked. */
  userMessage?: number;
  selfTalk?: boolean;
  /** Ambiguous textual tool call probability, when asked. */
  textualToolCall?: number;
  textual?: boolean;
}

/** The recorded diagnosis of one nudged run (`session_audits.verdict_json.runs[]`). */
export interface RunDiagnosis {
  run: number;
  ts: number | null;
  servedModel: string | null;
  wireModel: string | null;
  nudges: number;
  result: ContractRun["result"];
  firstAttemptSource: ContractRun["firstAttemptSource"];
  /** Null when there was no first attempt to compare (an empty ending). */
  afterCorrection: {
    choice: AfterCorrectionChoice | typeof AFTER_CORRECTION_UNCERTAIN;
    source: "model" | "mechanical";
    confidence?: number;
    picked?: string;
    probabilities?: Record<string, number>;
  } | null;
  mechanical: MessageComparison | null;
  attempts: AttemptDiagnosis[];
}

/** What to ask for one run; undefined input = nothing to ask (mechanics decide everything). */
export function planRun(
  run: ContractRun,
  attempts: readonly RunAttempt[],
  request: StateMessage[],
  toolNames: readonly string[] = KNOWN_TOOL_NAMES,
): { input?: ContractAuditInput; comparison: MessageComparison | null } {
  const questions: AttemptQuestion[] = [];
  for (const a of attempts) {
    const types = parseTypes(a.row.failure_types_json);
    const text = a.text.trim();
    if (!text) continue;
    const askTextual = !types.includes("textual_tool_call") && types.includes("text_only") && mentionsToolName(text, toolNames);
    const askUserMessage =
      types.includes("text_only") && !types.includes("textual_tool_call") && !types.includes("self_talk");
    if (!askTextual && !askUserMessage) continue;
    questions.push({ id: `a${questions.length}`, text, askUserMessage, askTextual });
  }
  const sent = run.sent.join("\n\n");
  const comparison = run.firstAttempt.trim() && sent.trim() ? compareMessages(run.firstAttempt, sent) : null;
  const askAfterCorrection = run.result === "sent" && comparison !== null && !comparison.normalizedEqual;
  if (questions.length === 0 && !askAfterCorrection) return { comparison };
  return {
    comparison,
    input: {
      request,
      nudges: run.nudges,
      ending: run.result,
      attempts: questions,
      ...(askAfterCorrection ? { firstAttempt: run.firstAttempt, sent } : {}),
      askAfterCorrection,
    },
  };
}

/** Thresholds and the confidence floor the diagnosis applies. */
export interface ContractAuditThresholds {
  selfTalk: number;
  textual: number;
  minConfidence: number;
}

/**
 * Turn a run's answers (absent = nothing asked) into its diagnosis and the
 * attempt rows whose failure types change.
 */
export function diagnoseRun(
  run: ContractRun,
  attempts: readonly RunAttempt[],
  plan: { input?: ContractAuditInput; comparison: MessageComparison | null },
  answers: DecisionAnswers | undefined,
  thresholds: ContractAuditThresholds,
): { diagnosis: RunDiagnosis; updates: ContractAttemptTypesUpdate[] } {
  const updates: ContractAttemptTypesUpdate[] = [];
  const diagnoses: AttemptDiagnosis[] = [];
  const asked = new Map((plan.input?.attempts ?? []).map((q) => [q.text, q]));
  for (const a of attempts) {
    const d: AttemptDiagnosis = { branchNo: a.row.branch_no, redoNo: a.row.redo_no, attemptNo: a.row.attempt_no };
    const q = asked.get(a.text.trim());
    const types = parseTypes(a.row.failure_types_json);
    const added: string[] = [];
    if (q && answers) {
      const user = answers[`${q.id}__had_user_message`];
      if (q.askUserMessage && user?.type === "noul") {
        d.userMessage = round3(user.noul);
        d.selfTalk = 1 - user.noul >= thresholds.selfTalk;
        if (d.selfTalk) added.push("self_talk");
      }
      const textual = answers[`${q.id}__textual_tool_call`];
      if (q.askTextual && textual?.type === "noul") {
        d.textualToolCall = round3(textual.noul);
        d.textual = textual.noul >= thresholds.textual;
        if (d.textual) added.push("textual_tool_call");
      }
    }
    // A textual tool call is an attempt to message the users: never self-talk too.
    const next = added.includes("textual_tool_call") ? added.filter((t) => t !== "self_talk") : added;
    if (next.length > 0) {
      const merged = CONTRACT_FAILURE_TYPES.filter((t) => types.includes(t) || next.includes(t));
      updates.push({
        branchNo: a.row.branch_no,
        redoNo: a.row.redo_no,
        attemptNo: a.row.attempt_no,
        failureTypes: merged,
        primaryType: primaryContractFailure(merged),
      });
      if (next.includes("textual_tool_call")) d.selfTalk = false;
    }
    diagnoses.push(d);
  }

  let afterCorrection: RunDiagnosis["afterCorrection"] = null;
  if (run.result === "switched_to_no_reply" || run.result === "nothing") {
    afterCorrection = { choice: run.result, source: "mechanical" };
  } else if (plan.comparison?.normalizedEqual) {
    afterCorrection = { choice: "same", source: "mechanical" };
  } else if (plan.input?.askAfterCorrection) {
    const answer = answers?.["after_correction"];
    if (answer?.type === "choice") {
      const confident = answer.confidence >= thresholds.minConfidence;
      afterCorrection = {
        choice: confident ? (answer.choice as AfterCorrectionChoice) : AFTER_CORRECTION_UNCERTAIN,
        source: "model",
        confidence: round3(answer.confidence),
        picked: answer.choice,
        probabilities: answer.probabilities,
      };
    }
  }
  return {
    diagnosis: {
      run: run.run,
      ts: run.ts,
      servedModel: run.servedModel,
      wireModel: run.wireModel,
      nudges: run.nudges,
      result: run.result,
      firstAttemptSource: run.firstAttemptSource,
      afterCorrection,
      mechanical: plan.comparison,
      attempts: diagnoses,
    },
    updates,
  };
}

function parseTypes(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
