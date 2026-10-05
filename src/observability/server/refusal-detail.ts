import type {
  AgentSessionRow,
  ContractAttemptRow,
  DecisionEvaluationRow,
  RefusalEventRow,
  SessionAuditRow,
  SessionBranchRow,
  SessionCheckChips,
  Storage,
} from "../../storage/index.js";
import type { ConsoleCheckInfo, ConsoleChecksDeps } from "./types.js";

// =============================================================================
// Session-view refusal-handling projections (spec REFUSAL-HANDLING §9, §12.1,
// §12.2): the discarded branches, refusal events, send-contract attempts and
// the check descriptions the console's branch switcher and cards render, plus
// the offline audit's rows, the decision rows' anchor and the session-list chip
// counters. Wire shapes are camelCase like every other console route; JSON
// columns are parsed here.
// =============================================================================

/** The refusal-handling part of `GET /api/sessions/:id`. */
export interface SessionRefusalDetail {
  branches: Array<Record<string, unknown>>;
  refusalEvents: Array<Record<string, unknown>>;
  contract: {
    outcome: string | null;
    nudges: number | null;
    maxNudges: number | null;
    attempts: Array<Record<string, unknown>>;
  };
  checks: ConsoleCheckInfo[];
  /** The offline audit's rows (`session_audits`), verdicts parsed; [] before the audit ran. */
  audits: Array<Record<string, unknown>>;
}

export function sessionRefusalDetail(
  storage: Storage,
  row: AgentSessionRow,
  decisions: readonly DecisionEvaluationRow[],
  checks: ConsoleChecksDeps | undefined,
): SessionRefusalDetail {
  const branches = storage.listSessionBranches(row.id);
  const events = storage.listRefusalEvents(row.id);
  const attempts = storage.listContractAttempts(row.id);
  const codes = new Set<string>();
  for (const b of branches) if (b.check_code) codes.add(b.check_code);
  for (const e of events) codes.add(e.check_code);
  for (const d of decisions) if (d.point === "checks") for (const code of verdictCodes(d.verdict_json)) codes.add(code);
  const described: ConsoleCheckInfo[] = [];
  if (checks) {
    for (const code of [...codes].sort()) {
      const info = checks.describe(code, row.timeline_key);
      if (info) described.push(info);
    }
  }
  return {
    branches: branches.map(branchWire),
    refusalEvents: events.map(refusalEventWire),
    contract: {
      outcome: row.contract_outcome ?? null,
      nudges: row.contract_nudges ?? null,
      maxNudges: checks?.maxNudges ?? null,
      attempts: attempts.map(contractAttemptWire),
    },
    checks: described,
    audits: typeof storage.listSessionAudits === "function" ? storage.listSessionAudits(row.id).map(auditWire) : [],
  };
}

/** The decision row's anchor (spec §9): where the judged output happened and what the verdict did. */
export function decisionAnchorWire(row: DecisionEvaluationRow): Record<string, unknown> {
  return {
    checkpoint: row.checkpoint ?? null,
    branchNo: row.branch_no ?? null,
    toolCallId: row.tool_call_id ?? null,
    attemptNo: row.attempt_no ?? null,
    consequence: row.consequence ?? null,
  };
}

/** Chip counters for a page of sessions (empty map when the store lacks the tables' reader). */
export function sessionCheckChips(storage: Storage, ids: readonly string[]): Map<string, SessionCheckChips> {
  return typeof storage.getSessionCheckChips === "function" ? storage.getSessionCheckChips(ids) : new Map();
}

function branchWire(row: SessionBranchRow): Record<string, unknown> {
  return {
    branchNo: row.branch_no,
    parentBranchNo: row.parent_branch_no,
    forkIndex: row.fork_index,
    reason: row.reason,
    checkCode: row.check_code,
    decisionEvaluationId: row.decision_evaluation_id,
    fromModel: row.from_model,
    toModel: row.to_model,
    messages: parseArray(row.messages_json),
    costUsd: row.cost_usd,
    createdAt: row.created_at,
  };
}

function refusalEventWire(row: RefusalEventRow): Record<string, unknown> {
  return {
    id: row.id,
    ts: row.ts,
    branchNo: row.branch_no,
    site: row.site,
    servedModel: row.served_model,
    wireModel: row.wire_model,
    kind: row.kind,
    checkCode: row.check_code,
    reason: row.reason,
    subReason: row.sub_reason,
    method: row.method,
    source: row.source,
    probability: row.probability,
    rawStopReason: row.raw_stop_reason,
    category: row.category,
    explanation: row.explanation,
    checkpoint: row.checkpoint,
    ruleName: row.rule_name,
    outcome: row.outcome,
    toModel: row.to_model,
    decisionEvaluationId: row.decision_evaluation_id,
  };
}

function contractAttemptWire(row: ContractAttemptRow): Record<string, unknown> {
  return {
    branchNo: row.branch_no,
    redoNo: row.redo_no,
    attemptNo: row.attempt_no,
    ts: row.ts,
    servedModel: row.served_model,
    wireModel: row.wire_model,
    variant: row.variant,
    failureTypes: parseArray(row.failure_types_json).filter((t): t is string => typeof t === "string"),
    primaryType: row.primary_type,
  };
}

function auditWire(row: SessionAuditRow): Record<string, unknown> {
  return {
    audit: row.audit,
    eventId: row.event_id,
    status: row.status,
    verdict: parseJson(row.verdict_json),
    confidence: row.confidence,
    modelId: row.model_id,
    costUsd: row.cost_usd,
    version: row.version,
    createdAt: row.created_at,
  };
}

function parseJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Check codes a `checks` decision row names: its `fired` list and its
 * question ids (`<code>__<source>`, with `_2`… on repeats).
 */
function verdictCodes(json: string | null): string[] {
  if (!json) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  const o = v as { fired?: unknown; results?: unknown };
  if (Array.isArray(o.fired)) for (const c of o.fired) if (typeof c === "string") out.push(c);
  if (Array.isArray(o.results)) {
    for (const r of o.results) {
      const id = r && typeof r === "object" ? (r as { id?: unknown }).id : undefined;
      if (typeof id !== "string") continue;
      const sep = id.lastIndexOf("__");
      if (sep > 0) out.push(id.slice(0, sep));
    }
  }
  return out;
}

function parseArray(json: string | null | undefined): unknown[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
