/**
 * `[decisions.audit]` knobs (spec REFUSAL-HANDLING §7.6, §10.2; DECISION-MODEL
 * §5.8). The common point fields (`enabled`, `model`, `timeout_ms`,
 * `state_max_tokens`, `min_state_tokens`, `min_confidence`) resolve through
 * `pointSettings(…, "audit")` like every other point.
 */
import type { CheckKind } from "../checks/types.js";
import type { DecisionsRawConfig } from "../config/schema.js";

/** The audits the worker runs. */
export const AUDIT_NAMES = ["send_contract", "refusal"] as const;
export type AuditName = (typeof AUDIT_NAMES)[number];

/**
 * Bump when an audit's result for the same session would change (questions,
 * state, mechanical metrics). Stored on every `session_audits` row; nothing
 * re-runs automatically on a bump (a re-audit is an operator decision: delete
 * the rows).
 */
export const AUDIT_VERSION = 1;

export const DEFAULT_AUDIT_CHECK_KINDS: readonly CheckKind[] = ["refusal", "contract"];
export const DEFAULT_SAMPLE_CLEAN_SESSIONS = 1;
export const DEFAULT_AUDIT_WORKERS = 1;
export const DEFAULT_BACKLOG_PACE_MS = 1000;
export const DEFAULT_SETTLE_MS = 60_000;
export const DEFAULT_AUDIT_MAX_RETRIES = 3;
export const DEFAULT_SELF_TALK_THRESHOLD = 0.7;
export const DEFAULT_TEXTUAL_TOOL_CALL_THRESHOLD = 0.8;
/** `[decisions.audit].timeout_ms` when unset: audits are background work over long state. */
export const DEFAULT_AUDIT_TIMEOUT_MS = 60_000;

/** The resolved audit knobs for an effective decisions table. */
export interface AuditKnobs {
  audits: AuditName[];
  checkKinds: CheckKind[];
  sampleCleanSessions: number;
  /** 0 = unlimited (the whole history). */
  backlogMaxAgeMs: number;
  workers: number;
  backlogPaceMs: number;
  settleMs: number;
  maxRetries: number;
  selfTalkThreshold: number;
  textualToolCallThreshold: number;
}

export function auditKnobs(decisions: DecisionsRawConfig): AuditKnobs {
  const raw = decisions.audit ?? {};
  return {
    audits: [...new Set(raw.audits ?? AUDIT_NAMES)],
    checkKinds: [...new Set(raw.check_kinds ?? DEFAULT_AUDIT_CHECK_KINDS)],
    sampleCleanSessions: raw.sample_clean_sessions ?? DEFAULT_SAMPLE_CLEAN_SESSIONS,
    backlogMaxAgeMs: raw.audit_backlog_max_age_ms ?? 0,
    workers: raw.workers ?? DEFAULT_AUDIT_WORKERS,
    backlogPaceMs: raw.backlog_pace_ms ?? DEFAULT_BACKLOG_PACE_MS,
    settleMs: raw.settle_ms ?? DEFAULT_SETTLE_MS,
    maxRetries: raw.max_retries ?? DEFAULT_AUDIT_MAX_RETRIES,
    selfTalkThreshold: raw.self_talk_threshold ?? DEFAULT_SELF_TALK_THRESHOLD,
    textualToolCallThreshold: raw.textual_tool_call_threshold ?? DEFAULT_TEXTUAL_TOOL_CALL_THRESHOLD,
  };
}

/**
 * Deterministic sample membership of a session (seeded by its id, so a re-run
 * picks the same sample): FNV-1a of the id mapped to [0, 1).
 */
export function inSample(sessionId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000 < rate;
}
