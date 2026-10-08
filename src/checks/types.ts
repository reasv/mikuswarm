/**
 * Check catalogue types (spec REFUSAL-HANDLING §4). A check is the unit of
 * detection: refusal reasons, style issues and send-contract diagnostics share
 * one catalogue, one judging machinery and one statistics path.
 */

export type CheckKind = "refusal" | "style" | "contract" | "duplicate";
export type CheckRemedy = "redo" | "revise" | "observe";
export type CheckSource = "message" | "analysis" | "text" | "thinking" | "artifact" | "rollout";
export type Checkpoint = "send" | "ending" | "artifact" | "rollout";
export type RefusalDetectionMethod = "stop_reason" | "provider_category" | "pattern" | "judged";

export const CHECK_KINDS: readonly CheckKind[] = ["refusal", "style", "contract", "duplicate"];
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
  "sexual_content",
  "privacy",
  "copyright",
  "persona",
  "capability",
  "unclear",
] as const;

export interface CheckQuestion {
  /**
   * Stable question name (e.g. `repeats`). Optional; when set it replaces the
   * source in the question id (`<code>__<name>`), names the question in
   * `thresholds` and in per-member calibration (`"checks.<code>.<name>"`), and
   * tells a check's several questions over one source apart.
   */
  name?: string;
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
  /**
   * Gates the questions: a question is asked only when one of these matches its
   * source text (no match = the check is skipped, not fired). Never decides the
   * check by itself, unlike `patterns`. Empty or undefined = no gate.
   */
  prefilter?: RegExp[];
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

/** Reserved rule-entry key: the model that refused (spec §8.1 "Tries and same-model retries"). */
export const SAME_MODEL_KEY = "@same";

/** Maximum `tries` of one rule entry. */
export const MAX_RULE_ENTRY_TRIES = 10;

/** One entry of a rule's `models`: a `[models.*]` key or {@link SAME_MODEL_KEY}, tried `tries` times. */
export interface RefusalRuleEntry {
  model: string;
  tries: number;
}

/** A normalized `[[refusal_fallback]]` rule (spec §8.1). */
export interface RefusalRule {
  name: string;
  sites?: string[];
  reasons?: string[];
  /** Veto this rule when any detected refusal reason is listed. */
  excludeReasons?: string[];
  fromModels?: string[];
  agents?: string[];
  tasks?: string[];
  /** Entries in order; repeated keys allowed. */
  models: RefusalRuleEntry[];
  soft: "redo" | "observe";
  onExhausted: "send_last" | "withhold" | "park";
  /** Position in the authored list (precedence: first match wins). */
  index: number;
}
