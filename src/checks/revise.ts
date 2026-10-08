/**
 * The revise remedy (spec REFUSAL-HANDLING §6.4, §5.4): a held output whose
 * evaluation fired one or more `revise` checks, and no refusal a rule acts on,
 * is not sent. The tool returns an error listing each fired check's code and
 * agent-facing explanation (`{matched}` filled) and how to override; the same
 * agent and model revise and call again. Nothing is discarded.
 *
 * - **Bounds** (an unnoticed, unbounded token spend is worse than a style
 *   issue): after `revise_max_consecutive` rejections since the last output
 *   that went through, the next call goes through regardless (consequence
 *   `sent`); after `revise_max_per_session` rejections in the session,
 *   revisable checks stop holding and blocking for the rest of it (they keep
 *   recording, consequence `sent`). The counters live on the part, one per
 *   session, so they survive a refusal redo (a fork changes the branch, not the
 *   session); {@link priorRejections} seeds the session total on resume.
 * - **Override**: every gated tool exposing {@link OVERRIDE_CHECKS_ARG} (only
 *   when a revisable check can fire at its checkpoint for the agent, see
 *   {@link overrideArgumentCodes}) may name check codes to skip for this call.
 *   Only codes fired in the immediately preceding rejection are honoured, so a
 *   refusal check (never revisable) can never be overridden. A call that passes
 *   thanks to the override records `overridden`; the codes are in the stored
 *   call arguments and the `check_revise_overridden` log line.
 *
 * {@link createRevisePolicyPart} is the revise half of the session's acting
 * gate policy (`RevisePolicyPart`, policy-parts.ts); the refusal half wins over
 * it (§6.4).
 */
import type { Logger } from "../observability/logger.js";
import type { DecisionEvaluationRow } from "../storage/database.js";
import type { CheckEvaluator, FiredCheck } from "./evaluator.js";
import type { GateCallInfo, GateVerdict } from "./gate.js";
import type { RevisePolicyPart } from "./policy-parts.js";
import type { CheckDefinition, Checkpoint } from "./types.js";

/** The gated tools' optional argument naming check codes to skip for one call. */
export const OVERRIDE_CHECKS_ARG = "override_checks";

/** Agent-facing description of {@link OVERRIDE_CHECKS_ARG} (always-on tokens: keep it short). */
const OVERRIDE_DESCRIPTION =
  "Only after this tool was blocked by an output check: codes from that error to skip (a clear false positive, or a deliberate quotation or example).";

/**
 * The override codes of a call's arguments. Tolerant of the naive forms: an
 * array of codes, one code or a comma/space separated string, `null` (a
 * strict-mode wire schema makes the optional argument nullable).
 */
export function readOverrideChecks(args: Record<string, unknown> | undefined): string[] {
  const raw = args?.[OVERRIDE_CHECKS_ARG];
  const items = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  const codes = items
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.trim().replace(/^[`"']+|[`"']+$/g, ""))
    .filter((c) => c.length > 0);
  return [...new Set(codes)];
}

/** The call's arguments without {@link OVERRIDE_CHECKS_ARG} (what the tool itself receives). */
export function withoutOverrideArgument<T>(params: T): T {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  if (!(OVERRIDE_CHECKS_ARG in (params as Record<string, unknown>))) return params;
  const { [OVERRIDE_CHECKS_ARG]: _dropped, ...rest } = params as Record<string, unknown>;
  return rest as T;
}

/**
 * A tool's parameter schema with the optional {@link OVERRIDE_CHECKS_ARG}
 * appended (last, so existing properties keep their wire order). The prefill
 * transform's `strictify` turns it into a required nullable property like any
 * other optional one; pi's validation drops the `null` again.
 */
export function addOverrideArgumentToSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  if (s["type"] !== "object" && !s["properties"]) return schema;
  const props = (s["properties"] as Record<string, unknown> | undefined) ?? {};
  if (OVERRIDE_CHECKS_ARG in props) return schema;
  // Plain JSON Schema (like the prefill's `analysis`): the tools mix TypeBox
  // builds, and pi's validator compiles either.
  const property = { type: "array", items: { type: "string" }, description: OVERRIDE_DESCRIPTION };
  return { ...s, properties: { ...props, [OVERRIDE_CHECKS_ARG]: property } };
}

/** Whether a check can fire for the agent: it has patterns, or questions and judged checks are on. */
function canFire(check: CheckDefinition, judgedOn: boolean): boolean {
  return check.patterns.length > 0 || check.words.length > 0 || (judgedOn && check.questions.length > 0);
}

/**
 * The enabled `revise` checks that can fire at `checkpoint` for the agent.
 * Empty = the gated tools of that checkpoint carry no override argument
 * (token economy: nothing could ever be overridden).
 */
export function overrideArgumentCodes(
  evaluator: Pick<CheckEvaluator, "catalogue" | "judgedEnabled">,
  checkpoint: Checkpoint,
  agent: string | null,
): string[] {
  const judgedOn = evaluator.judgedEnabled(agent);
  return evaluator.catalogue
    .enabledFor(checkpoint, agent)
    .filter((c) => c.remedy === "revise" && canFire(c, judgedOn))
    .map((c) => c.code);
}

/** Longest `{matched}` text quoted back to the agent. */
const MATCHED_MAX_CHARS = 80;

/**
 * A check's agent-facing explanation with `{matched}` filled. Without a match
 * (a judged hit) the placeholder and the quotes or parentheses around it are
 * dropped.
 */
export function fillMatched(explanation: string, matched: string | undefined): string {
  if (!explanation.includes("{matched}")) return explanation;
  if (matched !== undefined) {
    let text = matched.replace(/\s+/g, " ").trim();
    if (text.length > MATCHED_MAX_CHARS) text = `${text.slice(0, MATCHED_MAX_CHARS - 1)}…`;
    return explanation.split("{matched}").join(text);
  }
  return explanation
    .replace(/\s*\(\s*["“'`]?\{matched\}["”'`]?\s*\)/g, "")
    .replace(/\s*["“'`]\{matched\}["”'`]/g, "")
    .replace(/\s*\{matched\}/g, "");
}

/**
 * The tool error of a rejection: each blocking check's code and explanation,
 * then how to revise and how to override (spec §6.4, §5.4). `overridable` are
 * every revisable code fired in this evaluation, the ones the next call may
 * name in {@link OVERRIDE_CHECKS_ARG}.
 */
export function reviseErrorMessage(
  info: Pick<GateCallInfo, "action" | "checkpoint">,
  blocking: readonly { code: string; explanation: string; standalone?: string }[],
  overridable: readonly string[],
): string {
  // A check that writes its own whole error (the duplicate check) uses it when it blocks alone.
  if (blocking.length === 1 && blocking[0]!.standalone) return blocking[0]!.standalone;
  const lines = blocking.map((b) => `- ${b.code}: ${b.explanation}`);
  const codes = JSON.stringify([...overridable]);
  if (info.checkpoint === "ending") {
    return [
      `Blocked: ${info.action} did not end your turn. Output checks flagged it:`,
      ...lines,
      `If not replying is intended, call ${info.action} again with ${OVERRIDE_CHECKS_ARG}: ${codes}.`,
    ].join("\n");
  }
  return [
    `Blocked: nothing was sent. Output checks flagged this ${info.action} call:`,
    ...lines,
    `Revise it and call ${info.action} again. If a flag is a clear false positive, or the text deliberately shows it ` +
      `(a quotation, an example), call ${info.action} again with ${OVERRIDE_CHECKS_ARG} listing those codes ` +
      `(accepted: ${codes}).`,
  ].join("\n");
}

/** How many gated calls of a session were rejected for revise (its decision rows), to seed the bound on resume. */
export function priorRejections(rows: readonly Pick<DecisionEvaluationRow, "point" | "consequence" | "tool_call_id">[]): number {
  const calls = new Set<string>();
  for (const row of rows) {
    if (row.point === "checks" && row.consequence === "revise" && row.tool_call_id) calls.add(row.tool_call_id);
  }
  return calls.size;
}

export interface RevisePolicyPartOptions {
  /** The bounds (`[decisions.checks].revise_max_*`, per agent) and the explanations (the catalogue). */
  evaluator: Pick<CheckEvaluator, "knobs" | "catalogue">;
  /** Rejections already counted in this session (a resumed session, {@link priorRejections}). */
  priorRejections?: number;
  logger?: Logger;
}

type ReviseDecision = ReturnType<RevisePolicyPart["decide"]>;

/** The part's counters, for tests and diagnostics. */
export interface ReviseState {
  /** Rejections since the last output that went through. */
  consecutive: number;
  /** Rejections in the session. */
  sessionTotal: number;
  /** Revisable codes fired in the immediately preceding rejection (the honourable overrides). */
  lastRejected: readonly string[];
}

export interface RevisePart extends RevisePolicyPart {
  state(): ReviseState;
}

/**
 * The revise half of one session's acting gate policy. One instance per
 * session (never per branch), so the counters persist across a refusal redo.
 *
 * Contract with the composing policy:
 * - `shouldHold` once per gated call (the gate asks it at execute). It
 *   declines for an output with no tool call to reject (a `NO_REPLY` text
 *   ending), when no `revise` check took part, and when a bound is exhausted;
 *   in the last case it remembers that the call went through unheld.
 * - `decide` may be called more than once per call (from the policy's
 *   `consequence` when the verdict is recorded, and from `act`): it decides
 *   once per tool call id and returns the same answer after, so the counters
 *   move once. For an unheld call it never blocks: `overridden` when the
 *   override covered every fired revisable check, else `sent` when one fired. The composing policy calls it only when no refusal
 *   acts (refusal wins, §6.4).
 * - `onDelivered` after a gated call that went through (a delivered message or
 *   an accepted `no_reply`): the consecutive counter and the honourable
 *   override codes restart.
 */
export function createRevisePolicyPart(options: RevisePolicyPartOptions): RevisePart {
  const { evaluator, logger } = options;
  let consecutive = 0;
  let sessionTotal = Math.max(0, options.priorRejections ?? 0);
  let lastRejected: string[] = [];
  /**
   * Per tool call id: the decision made, or the state when a bound let the
   * call through without holding (decided when its verdict is recorded, after
   * the delivery already reset the per-message state).
   */
  const decided = new Map<string, ReviseDecision | Unheld>();

  const bounds = (agent: string | null) => {
    const knobs = evaluator.knobs(agent);
    return { maxConsecutive: knobs.reviseMaxConsecutive, maxPerSession: knobs.reviseMaxPerSession };
  };
  /** Which bound lets the next revisable flag through, if any. */
  const exhausted = (agent: string | null): "session" | "consecutive" | undefined => {
    const b = bounds(agent);
    if (sessionTotal >= b.maxPerSession) return "session";
    if (consecutive >= b.maxConsecutive) return "consecutive";
    return undefined;
  };
  const logFields = (info: GateCallInfo) => ({
    sessionId: info.scope.sessionId ?? undefined,
    toolCallId: info.toolCallId,
    action: info.action,
    checkpoint: info.checkpoint,
  });

  const decideOnce = (info: GateCallInfo, verdict: GateVerdict, unheld?: Unheld): ReviseDecision => {
    const fired = verdict.revise.filter((f) => f.remedy === "revise");
    if (fired.length === 0) return { kind: "pass" };
    const agent = info.scope.agent;
    const rejected = unheld?.lastRejected ?? lastRejected;
    const honoured = honouredOverrides(info, fired, rejected);
    const requested = new Set(info.overrideChecks ?? []);
    const blocking = fired.filter((f) => !honoured.has(f.code));
    if (blocking.length === 0) {
      logger?.info("check_revise_overridden", { ...logFields(info), codes: [...honoured] });
      return { kind: "pass", consequence: "overridden" };
    }
    const bound = unheld?.bound ?? exhausted(agent);
    if (bound) {
      logger?.info("check_revise_bound_passed", {
        ...logFields(info),
        bound,
        codes: fired.map((f) => f.code),
        consecutive,
        sessionTotal,
      });
      return { kind: "pass", consequence: "sent" };
    }
    consecutive += 1;
    sessionTotal += 1;
    lastRejected = [...new Set(fired.map((f) => f.code))];
    const lines = uniqueByCode(blocking).map((f) => ({
      code: f.code,
      explanation: explanationOf(f, agent),
      ...(f.standalone ? { standalone: f.standalone } : {}),
    }));
    logger?.info("check_revise_blocked", {
      ...logFields(info),
      codes: lines.map((l) => l.code),
      ...(honoured.size > 0 ? { overridden: [...honoured] } : {}),
      ...(requested.size > honoured.size ? { overrideRejected: [...requested].filter((c) => !honoured.has(c)) } : {}),
      consecutive,
      sessionTotal,
    });
    return { kind: "block", message: reviseErrorMessage(info, lines, lastRejected), consequence: "revise" };
  };

  const explanationOf = (fired: FiredCheck, agent: string | null): string => {
    // Written from the verdict (a duplicate check quotes what it compared against).
    if (fired.explanation) return fired.explanation;
    const check = evaluator.catalogue.get(fired.code, agent);
    return fillMatched(check?.agentExplanation ?? check?.description ?? fired.code, fired.matched);
  };

  return {
    shouldHold(info, checks) {
      if (!info.toolCallId) return false;
      if (!checks.some((c) => c.remedy === "revise")) return false;
      const bound = exhausted(info.scope.agent);
      if (bound) {
        decided.set(info.toolCallId, { bound, lastRejected: [...lastRejected] });
        return false;
      }
      return true;
    },
    decide(info, verdict) {
      // An output with no tool call (a text ending) has nothing to reject.
      if (!info.toolCallId) return { kind: "pass" };
      const prior = decided.get(info.toolCallId);
      if (prior && "kind" in prior) return prior;
      const decision = decideOnce(info, verdict, prior);
      decided.set(info.toolCallId, decision);
      return decision;
    },
    wouldBlock(info, verdict) {
      if (!info.toolCallId) return false;
      const prior = decided.get(info.toolCallId);
      if (prior) return "kind" in prior && prior.kind === "block";
      const fired = verdict.revise.filter((f) => f.remedy === "revise");
      if (fired.length === 0) return false;
      const honoured = honouredOverrides(info, fired, lastRejected);
      if (fired.every((f) => honoured.has(f.code))) return false;
      return exhausted(info.scope.agent) === undefined;
    },
    onDelivered() {
      consecutive = 0;
      lastRejected = [];
    },
    state: () => ({ consecutive, sessionTotal, lastRejected: [...lastRejected] }),
  };
}

/** A call a bound let through unheld: which bound, and the rejection it followed. */
interface Unheld {
  bound: "session" | "consecutive";
  lastRejected: readonly string[];
}

/** The fired codes the call's override honours: named in it and fired in the immediately preceding rejection. */
function honouredOverrides(info: GateCallInfo, fired: readonly FiredCheck[], rejected: readonly string[]): Set<string> {
  const requested = new Set(info.overrideChecks ?? []);
  return new Set(fired.filter((f) => requested.has(f.code) && rejected.includes(f.code)).map((f) => f.code));
}

function uniqueByCode(fired: readonly FiredCheck[]): FiredCheck[] {
  const seen = new Set<string>();
  return fired.filter((f) => (seen.has(f.code) ? false : (seen.add(f.code), true)));
}
