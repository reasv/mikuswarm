/**
 * Check catalogue types (spec REFUSAL-HANDLING §4). A check is the unit of
 * detection: refusal reasons, style issues and send-contract diagnostics share
 * one catalogue, one judging machinery and one statistics path.
 */

export type CheckKind = "refusal" | "style" | "contract";
export type CheckRemedy = "redo" | "revise" | "observe";
export type CheckSource = "message" | "analysis" | "text" | "thinking" | "artifact" | "rollout";
export type Checkpoint = "send" | "ending" | "artifact" | "rollout";
export type RefusalDetectionMethod = "stop_reason" | "provider_category" | "pattern" | "judged";

export const CHECK_KINDS: readonly CheckKind[] = ["refusal", "style", "contract"];
export const CHECK_REMEDIES: readonly CheckRemedy[] = ["redo", "revise", "observe"];
export const CHECK_SOURCES: readonly CheckSource[] = ["message", "analysis", "text", "thinking", "artifact", "rollout"];
export const CHECKPOINTS: readonly Checkpoint[] = ["send", "ending", "artifact", "rollout"];

/** Sites of internal (sessionless or mechanical) jobs; chat sessions use their session type name. */
export const INTERNAL_SITES = ["record_turn", "summarize", "condense", "diary", "caption"] as const;
export type InternalSite = (typeof INTERNAL_SITES)[number];

/** The built-in refusal reasons (spec §5.3); operators may add their own. */
export const BUILTIN_REFUSAL_REASONS = [
  "distillation",
  "safety",
  "privacy",
  "copyright",
  "persona",
  "capability",
  "unclear",
] as const;

export interface CheckQuestion {
  source: CheckSource;
  instructions: string;
  criteria: { true: string; false: string };
  /**
   * The question fires at or above this `noul` probability (a `choice`
   * question: when it picks `fireOption` with at least this confidence).
   */
  threshold: number;
  /**
   * Answer type; undefined = `noul`. `choice` is used by built-in contract
   * checks only (config questions are `noul`); `criteria` then documents what
   * firing means and `options` is what the decision model is asked.
   */
  type?: "noul" | "choice";
  /** `choice` questions: option key → description. */
  options?: Record<string, string>;
  /** `choice` questions: the option that counts as the check firing. */
  fireOption?: string;
  /**
   * Asked only after at least one forced-completion nudge in the current turn,
   * whether or not the question's source has text (spec §7.4).
   */
  afterNudge?: boolean;
  /**
   * Asked only for these actions (the judged tool name, `NO_REPLY` for the
   * text marker, `exhausted` for forced-completion exhaustion); undefined = any.
   */
  actions?: string[];
}

/** A provider refusal signal mapped to a check (hard refusals, spec §4.2). */
export interface ApiSignal {
  /** pi-ai api name; undefined = any api. */
  api?: string;
  /** Raw provider stop reason, compared case-insensitively. */
  stopReason: string;
  /** Refusal category: undefined = any; null = the response carried none. */
  category?: string | null;
}

export interface CheckDefinition {
  code: string;
  kind: CheckKind;
  enabled: boolean;
  remedy: CheckRemedy;
  /** Refusal checks only: built-in or operator-defined reason. */
  reason?: string;
  description: string;
  /** Revisable checks: shown to the agent next to the code; may use `{matched}`. */
  agentExplanation?: string;
  checkpoints: Checkpoint[];
  apiSignals: ApiSignal[];
  patterns: RegExp[];
  /** Word list (word boundaries, case-insensitive); see `compileWordList`. */
  words: string[];
  /** Style checks: skip messages shorter than this (overrides `[decisions.checks].style_min_chars`). */
  minChars?: number;
  questions: CheckQuestion[];
  builtin: boolean;
}

export interface CheckCatalogue {
  /** Every check for the agent (null = global), enabled and disabled. */
  all(agent?: string | null): CheckDefinition[];
  get(code: string, agent?: string | null): CheckDefinition | undefined;
  /** Enabled checks that apply at `checkpoint` for the agent. */
  enabledFor(checkpoint: Checkpoint, agent?: string | null): CheckDefinition[];
}

/** A normalized `[[refusal_fallback]]` rule (spec §8.1). */
export interface RefusalRule {
  name: string;
  sites?: string[];
  reasons?: string[];
  fromModels?: string[];
  agents?: string[];
  tasks?: string[];
  models: string[];
  soft: "redo" | "observe";
  onExhausted: "send_last" | "withhold" | "park";
  /** Position in the authored list (precedence: first match wins). */
  index: number;
}
