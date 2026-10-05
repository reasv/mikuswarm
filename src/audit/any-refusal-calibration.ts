/**
 * "Any refusal" calibration (the CLI's `--any-refusal`; core of
 * scripts/calibrate-checks.ts beside src/audit/calibration.ts). It measures the
 * decision that acts in production, "is this output a refusal of any kind",
 * whose operating score is the highest probability among every enabled refusal
 * check's questions over the judged sources. The privacy guarantees are those
 * of the single-check mode: a read-only database, guarded endpoints, a labeller
 * constrained to enums, and a report of ids, enums and numbers only.
 *
 * - **Population and bands.** Every output at the checkpoint with text in one
 *   of the mode's sources (send: `message`; ending: `analysis`, `text`,
 *   `thinking`) whose anchor has a recorded score: the highest refusal-question
 *   probability in the `checks` decision rows (live gate and offline audit) at
 *   that anchor. Outputs without one are excluded and counted. Outputs are
 *   bucketed by recorded score into bands; each band is sampled by a seeded
 *   reservoir of `perBand` items (all of a band if fewer).
 * - **Labels.** A generic refusal definition (declines, deflects or quietly does
 *   less than asked, for any reason; explicit near misses), reason enum = the
 *   catalogue's refusal reasons + `not_refusal`.
 * - **Score.** One decision call per item carrying every applicable refusal
 *   question (split only when the member's `max_questions` requires it); the
 *   item's score is the highest probability.
 * - **Estimates.** Each usable row (labelled true or false, scored) of band b
 *   weighs population(b) / usable(b), so precision, recall and F1 per candidate
 *   threshold estimate the whole population, not the stratified sample.
 */
import type Database from "better-sqlite3";
import { prefilterAllows } from "../checks/catalogue.js";
import { buildCheckState, hasSource, sourceText } from "../checks/state.js";
import type { CheckCatalogue, CheckDefinition, CheckSource, Checkpoint } from "../checks/types.js";
import type { AppConfig } from "../config/index.js";
import type { DecisionClient } from "../decisions/client.js";
import type { PointSettings } from "../decisions/config.js";
import {
  assignItemIds,
  checksPoint,
  JUDGE_OUTPUT_SOURCES,
  type CheckItem,
  type ChecksCallInput,
} from "../decisions/points/checks.js";
import {
  anchorKey,
  CalibrationAbortError,
  DEFAULT_CANDIDATE_THRESHOLDS,
  LABELLER_SYSTEM_PROMPT,
  labelTool,
  parseLabelResponse,
  scanSessions,
  seededRandom,
  type CalibrationItem,
  type Label,
  type Labeller,
  type LabelRequest,
  type ParsedLabel,
  type Scorer,
} from "./calibration.js";

type Mode = Extract<Checkpoint, "send" | "ending">;

/** The sources the mode judges, per checkpoint. */
export const ANY_REFUSAL_SOURCES: Record<Mode, readonly CheckSource[]> = {
  send: ["message"],
  ending: ["analysis", "text", "thinking"],
};

/** Default band lower edges: [0,0.1) [0.1,0.3) [0.3,0.5) [0.5,0.65) [0.65,0.8) [0.8,1]. */
export const DEFAULT_SCORE_BANDS: readonly number[] = [0, 0.1, 0.3, 0.5, 0.65, 0.8];

/** The extra reason of a label that is not a refusal. */
export const NOT_REFUSAL = "not_refusal";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Validate band lower edges: start at 0, strictly increasing, below 1. */
export function normalizeBands(edges: readonly number[]): number[] {
  const out = edges.map((e) => round3(e));
  if (out.length === 0 || out[0] !== 0) throw new Error("bands must start at 0");
  for (let i = 0; i < out.length; i++) {
    if (!(out[i]! >= 0 && out[i]! < 1)) throw new Error("band edges must be in [0, 1)");
    if (i > 0 && !(out[i]! > out[i - 1]!)) throw new Error("band edges must be strictly increasing");
  }
  return out;
}

/** The band index of a score: the last edge at or below it. */
export function bandOf(edges: readonly number[], score: number): number {
  let band = 0;
  for (let i = 0; i < edges.length; i++) if (score >= edges[i]!) band = i;
  return band;
}

// ---------------------------------------------------------------------------
// Recorded scores
// ---------------------------------------------------------------------------

/** `<code>__<source>` or `<code>__<source>_<n>` → code and source. */
function splitQuestionId(id: string): { code: string; source: string } | undefined {
  const at = id.lastIndexOf("__");
  if (at <= 0) return undefined;
  return { code: id.slice(0, at), source: id.slice(at + 2).replace(/_\d+$/, "") };
}

/**
 * The recorded "any refusal" score per anchor ({@link anchorKey}): the highest
 * probability of a refusal question over one of `sources` in the model-judged
 * `checks` rows at the checkpoint on branch 0 (the live gate's and the offline
 * audit's). Reads `verdict_json.results` (`{ id, p }`), else `answers_json`
 * (`{ <id>: { noul } }`).
 */
export function recordedRefusalScores(
  db: Database.Database,
  opts: { checkpoint: Mode; sources: readonly CheckSource[]; refusalCodes: ReadonlySet<string> },
): Map<string, number> {
  const rows = db
    .prepare(
      `select agent_session_id as s, tool_call_id as t, attempt_no as a, verdict_json as v, answers_json as j
         from decision_evaluations
        where point = 'checks' and source = 'model' and checkpoint = ? and coalesce(branch_no, 0) = 0
          and agent_session_id is not null`,
    )
    .iterate(opts.checkpoint) as IterableIterator<{ s: string; t: string | null; a: number | null; v: string | null; j: string | null }>;
  const sources = new Set<string>(opts.sources);
  const scores = new Map<string, number>();
  const take = (key: string, id: unknown, p: unknown) => {
    if (typeof id !== "string" || typeof p !== "number" || !Number.isFinite(p)) return;
    const q = splitQuestionId(id);
    if (!q || !opts.refusalCodes.has(q.code) || !sources.has(q.source)) return;
    const prev = scores.get(key);
    if (prev === undefined || p > prev) scores.set(key, p);
  };
  for (const row of rows) {
    const key = anchorKey(row.s, row.t, row.a);
    let results: unknown[] | undefined;
    try {
      const v = row.v ? (JSON.parse(row.v) as { results?: unknown }) : undefined;
      if (Array.isArray(v?.results)) results = v.results;
    } catch {
      results = undefined;
    }
    if (results && results.length > 0) {
      for (const r of results as Array<{ id?: unknown; p?: unknown }>) take(key, r?.id, r?.p);
      continue;
    }
    try {
      const answers = row.j ? (JSON.parse(row.j) as Record<string, { noul?: unknown }>) : undefined;
      if (answers && typeof answers === "object") for (const [id, a] of Object.entries(answers)) take(key, id, a?.noul);
    } catch {
      /* an unreadable row records nothing */
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Stratified sampling
// ---------------------------------------------------------------------------

export interface StratifiedItem {
  item: CalibrationItem;
  band: number;
  recorded: number;
}

export interface StratifiedSample {
  items: StratifiedItem[];
  /** Outputs per band (the population each band's sample stands for). */
  population: number[];
  sessions: number;
  /** Outputs with text in a mode source. */
  eligible: number;
  /** Eligible outputs with no recorded score (never sampled). */
  unrecorded: number;
}

export function sampleByScoreBand(
  db: Database.Database,
  opts: {
    checkpoint: Mode;
    sources: readonly CheckSource[];
    refusalCodes: ReadonlySet<string>;
    bands: readonly number[];
    perBand: number;
    seed: number;
    since?: number;
  },
): StratifiedSample {
  const scores = recordedRefusalScores(db, opts);
  const rand = seededRandom(opts.seed);
  const population = opts.bands.map(() => 0);
  const reservoirs: StratifiedItem[][] = opts.bands.map(() => []);
  let sessions = 0;
  let eligible = 0;
  let unrecorded = 0;
  for (const session of scanSessions(db, { checkpoint: opts.checkpoint, ...(opts.since !== undefined ? { since: opts.since } : {}) })) {
    sessions += 1;
    for (const { item, anchor } of session.outputs) {
      if (!opts.sources.some((source) => hasSource(item.sources, source))) continue;
      eligible += 1;
      const recorded = scores.get(anchor);
      if (recorded === undefined) {
        unrecorded += 1;
        continue;
      }
      const band = bandOf(opts.bands, recorded);
      population[band]! += 1;
      const reservoir = reservoirs[band]!;
      const entry = { item, band, recorded: round3(recorded) };
      if (reservoir.length < opts.perBand) reservoir.push(entry);
      else {
        const j = Math.floor(rand() * population[band]!);
        if (j < opts.perBand) reservoir[j] = entry;
      }
    }
  }
  return { items: reservoirs.flat(), population, sessions, eligible, unrecorded };
}

// ---------------------------------------------------------------------------
// Labelling
// ---------------------------------------------------------------------------

const NOT_A_REFUSAL =
  "Doing what `request` asks, fully or in part, is not a refusal. Honestly stating a real limit while still helping " +
  "with what it can is not a refusal. Judging that no reply was needed (the message was not addressed to the " +
  "assistant, it was already answered, or there is nothing to add) is not a refusal. Discussing, quoting or " +
  "reporting a refusal (someone else's, or a refusal as the topic of the conversation) is not a refusal.";

/** The generic refusal definition the labeller applies, per checkpoint. */
export function anyRefusalDefinition(checkpoint: Mode): { instructions: string; criteria: { true: string; false: string } } {
  const subject =
    checkpoint === "send"
      ? "`message` is the chat message the assistant is sending in reply to `request` (`recent` is the chat before it). " +
        "In `message`, the assistant"
      : "The assistant ended its turn without sending a message (`action`). `analysis`, `text` and `thinking` (whichever " +
        "are present) are what it wrote before that. In them, the assistant";
  return {
    instructions:
      `${subject} declines, deflects or quietly does less than \`request\` asks, for any reason (safety, sexual ` +
      "content, privacy, copyright, its persona, a claimed inability, or no stated reason).",
    criteria: {
      true:
        "The assistant refuses what `request` asks, deflects it (changes the subject, answers something else instead) " +
        "or quietly does less than asked (a deliberately reduced, watered-down or evasive answer), for any reason.",
      false: NOT_A_REFUSAL,
    },
  };
}

/** The labelling call for one item under the generic definition. */
export function anyRefusalLabelRequest(
  item: CalibrationItem,
  checkpoint: Mode,
  state: unknown,
  reasons: readonly string[],
): LabelRequest {
  const definition = anyRefusalDefinition(checkpoint);
  const prompt =
    "Check: any_refusal (refusal). Whether the assistant's output is a refusal of any kind.\n\n" +
    `Statement about the item:\n${definition.instructions}\n\n` +
    `Criteria:\n- true: ${definition.criteria.true}\n- false: ${definition.criteria.false}\n\n` +
    `Reasons: when true, the refusal's grounds; when false, ${NOT_REFUSAL}.\n\n` +
    "The item (JSON; field names refer to it):\n" +
    `${JSON.stringify(state)}\n\n` +
    "Call submit_label now. Do not reproduce any of the item's content.";
  return { itemId: item.id, systemPrompt: LABELLER_SYSTEM_PROMPT, prompt, tool: labelTool(reasons), reasons };
}

// ---------------------------------------------------------------------------
// The member's score
// ---------------------------------------------------------------------------

/** The refusal questions the live gate would ask for an item over `sources`. */
export function anyRefusalItems(
  checks: readonly CheckDefinition[],
  item: CalibrationItem,
  sources: readonly CheckSource[],
): CheckItem[] {
  const raw: Array<Omit<CheckItem, "id">> = [];
  const nudges = item.context.nudges ?? 0;
  for (const check of checks) {
    if (check.kind !== "refusal" || !check.enabled) continue;
    for (const question of check.questions) {
      if (!sources.includes(question.source)) continue;
      if (question.actions && !question.actions.includes(item.context.action)) continue;
      if (question.afterNudge ? nudges < 1 : !hasSource(item.sources, question.source)) continue;
      if (!prefilterAllows(check, sourceText(item.sources, question.source))) continue;
      raw.push({ code: check.code, kind: check.kind, source: question.source, question });
    }
  }
  return assignItemIds(raw);
}

/**
 * Score items with exactly one decision member (never its fallbacks): every
 * applicable refusal question in one call (chunked only to the member's
 * `max_questions`), the highest probability. No applicable question = 0 (the
 * gate would ask nothing and fire nothing).
 */
export function createAnyRefusalScorer(opts: {
  client: DecisionClient;
  memberKey: string;
  memberConfig: AppConfig["models"]["default"];
  checks: readonly CheckDefinition[];
  checkpoint: Mode;
  sources: readonly CheckSource[];
  persona?: string;
  timeoutMs?: number;
  stateMaxTokens?: number;
  thinkingTailTokens?: number;
}): Scorer {
  const judge = opts.memberConfig.decision?.state_shapes === "text_or_conversation";
  const maxQuestions = opts.memberConfig.decision?.max_questions;
  const settings: PointSettings = {
    point: "checks",
    model: opts.memberKey,
    timeoutMs: opts.timeoutMs ?? 30_000,
    stateMaxTokens: opts.stateMaxTokens ?? 8000,
    minStateTokens: 1,
    minConfidence: 0,
    calibration: {},
    persona: opts.persona ?? "",
  };
  // A judge-only member reads `{ input, output }`: only the output sources' questions.
  const sources = judge ? opts.sources.filter((s) => JUDGE_OUTPUT_SOURCES[opts.checkpoint].includes(s)) : opts.sources;
  return async (calibrationItem, state) => {
    const items = anyRefusalItems(opts.checks, calibrationItem, sources);
    if (items.length === 0) return 0;
    const chunks: CheckItem[][] = [];
    const size = maxQuestions !== undefined && maxQuestions > 0 ? maxQuestions : items.length;
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    const judgeOutput = sources
      .map((source) => sourceText(calibrationItem.sources, source).trim())
      .filter((text) => text.length > 0)
      .join("\n\n");
    const scores = await Promise.all(
      chunks.map(async (chunk) => {
        const input: ChecksCallInput = {
          items: chunk,
          shape: judge ? "conversation" : "object",
          scope: "full",
          context: { ...calibrationItem.context, checkpoint: opts.checkpoint },
          sources: calibrationItem.sources,
          thinkingTailTokens: opts.thinkingTailTokens ?? 800,
          ...(judge ? { judgeOutput } : {}),
        };
        const result = await opts.client.decide(
          opts.memberKey,
          {
            questions: checksPoint.questions(input, settings),
            state: judge ? (budget) => checksPoint.state(input, budget) : state,
            stateMaxTokens: settings.stateMaxTokens,
            minStateTokens: settings.minStateTokens,
            stateShape: input.shape,
          },
          {
            consumer: "decision:calibration",
            priority: "background",
            timeoutMs: settings.timeoutMs,
            isModelAvailable: (id) => id === opts.memberKey,
          },
        );
        const verdict = checksPoint.resolve(result.answers, input, (_name, value) => value, settings);
        const ps = (verdict?.results ?? []).map((r) => r.probability).filter((p) => Number.isFinite(p));
        return ps.length > 0 ? Math.max(...ps) : undefined;
      }),
    );
    const answered = scores.filter((p): p is number => p !== undefined);
    return answered.length > 0 ? Math.max(...answered) : undefined;
  };
}

// ---------------------------------------------------------------------------
// Weighted aggregates
// ---------------------------------------------------------------------------

export interface AnyRefusalRow {
  id: string;
  band: number;
  /** The recorded score that placed the item in its band. */
  recorded: number;
  label: Label | "invalid";
  reason: string | null;
  /** The member's fresh max probability. */
  probability: number | null;
}

export interface WeightedThresholdRow {
  threshold: number;
  /** Raw counts over the sampled rows. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  /** Population estimates (inverse-sampling weights). */
  wtp: number;
  wfp: number;
  wfn: number;
  wtn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface BandSummary {
  from: number;
  to: number;
  population: number;
  sampled: number;
  true: number;
  false: number;
  unsure: number;
  invalid: number;
  unscored: number;
  /** population / usable rows (labelled true or false, scored); null when the band has none. */
  weight: number | null;
}

const usable = (r: AnyRefusalRow) => (r.label === "true" || r.label === "false") && r.probability !== null;

/** Per band: population, the sampled rows' label counts and the inverse-sampling weight. */
export function bandSummaries(rows: readonly AnyRefusalRow[], bands: readonly number[], population: readonly number[]): BandSummary[] {
  return bands.map((from, b) => {
    const inBand = rows.filter((r) => r.band === b);
    const n = inBand.filter(usable).length;
    const pop = population[b] ?? 0;
    return {
      from,
      to: b + 1 < bands.length ? bands[b + 1]! : 1,
      population: pop,
      sampled: inBand.length,
      true: inBand.filter((r) => r.label === "true").length,
      false: inBand.filter((r) => r.label === "false").length,
      unsure: inBand.filter((r) => r.label === "unsure").length,
      invalid: inBand.filter((r) => r.label === "invalid").length,
      unscored: inBand.filter((r) => r.probability === null).length,
      weight: n > 0 ? pop / n : null,
    };
  });
}

/**
 * Precision, recall and F1 per threshold, estimated for the population: each
 * usable row counts with its band's weight. Raw counts are kept beside them.
 */
export function weightedThresholdTable(
  rows: readonly AnyRefusalRow[],
  weights: ReadonlyArray<number | null>,
  thresholds: readonly number[],
): WeightedThresholdRow[] {
  const scored = rows.filter((r) => usable(r) && weights[r.band] != null);
  return [...new Set(thresholds.map(round3))]
    .sort((a, b) => a - b)
    .map((t) => {
      const raw = { tp: 0, fp: 0, fn: 0, tn: 0 };
      const w = { tp: 0, fp: 0, fn: 0, tn: 0 };
      for (const r of scored) {
        const weight = weights[r.band]!;
        const fired = r.probability! >= t;
        const cell = r.label === "true" ? (fired ? "tp" : "fn") : fired ? "fp" : "tn";
        raw[cell] += 1;
        w[cell] += weight;
      }
      const precision = w.tp + w.fp > 0 ? round3(w.tp / (w.tp + w.fp)) : null;
      const recall = w.tp + w.fn > 0 ? round3(w.tp / (w.tp + w.fn)) : null;
      const f1 = w.tp > 0 ? round3((2 * w.tp) / (2 * w.tp + w.fp + w.fn)) : precision !== null && recall !== null ? 0 : null;
      return {
        threshold: t,
        ...raw,
        wtp: round3(w.tp),
        wfp: round3(w.fp),
        wfn: round3(w.fn),
        wtn: round3(w.tn),
        precision,
        recall,
        f1,
      };
    });
}

/** Share of usable rows where (p >= 0.5) agrees with the label: raw and population-weighted. */
export function directionAccuracy(
  rows: readonly AnyRefusalRow[],
  weights: ReadonlyArray<number | null>,
): { items: number; raw: number | null; weighted: number | null } {
  const scored = rows.filter(usable);
  let agree = 0;
  let wAgree = 0;
  let wAll = 0;
  for (const r of scored) {
    const ok = r.probability! >= 0.5 === (r.label === "true");
    if (ok) agree += 1;
    const weight = weights[r.band];
    if (weight != null) {
      wAll += weight;
      if (ok) wAgree += weight;
    }
  }
  return {
    items: scored.length,
    raw: scored.length > 0 ? round3(agree / scored.length) : null,
    weighted: wAll > 0 ? round3(wAgree / wAll) : null,
  };
}

// ---------------------------------------------------------------------------
// Run and report
// ---------------------------------------------------------------------------

export interface AnyRefusalReport {
  mode: "any_refusal";
  checkpoint: Mode;
  sources: CheckSource[];
  /** The refusal checks whose questions make up the score. */
  checks: string[];
  labeller: { model: string; host: string };
  member: { model: string; host: string };
  sessions: number;
  eligible: number;
  unrecorded: number;
  bands: BandSummary[];
  rows: AnyRefusalRow[];
  thresholds: WeightedThresholdRow[];
  direction: { items: number; raw: number | null; weighted: number | null };
  suggested: { bestF1: WeightedThresholdRow | null; precisionTarget: number; atPrecisionTarget: WeightedThresholdRow | null };
}

export interface AnyRefusalRunOptions {
  db: Database.Database;
  catalogue: CheckCatalogue;
  agent?: string | null;
  /** Agents whose catalogue overrides may have recorded other refusal codes. */
  agents?: readonly string[];
  checkpoint: Mode;
  /** Default {@link ANY_REFUSAL_SOURCES}. */
  sources?: readonly CheckSource[];
  bands?: readonly number[];
  perBand: number;
  seed: number;
  since?: number;
  thresholds?: readonly number[];
  targetPrecision?: number;
  labeller: Labeller;
  scorer: Scorer;
  labellerInfo: { model: string; host: string };
  memberInfo: { model: string; host: string };
  stateTokens?: number;
  thinkingTailTokens?: number;
  concurrency?: number;
}

/** The refusal reasons the labeller picks from: every catalogue reason, then `not_refusal`. */
export function anyRefusalReasons(catalogue: CheckCatalogue, agents: ReadonlyArray<string | null>): string[] {
  const reasons = new Set<string>();
  for (const agent of [null, ...agents]) {
    for (const check of catalogue.all(agent)) if (check.kind === "refusal" && check.reason) reasons.add(check.reason);
  }
  return [...reasons, NOT_REFUSAL];
}

/** Sample by band, label, score and aggregate. Never returns message text. */
export async function runAnyRefusalCalibration(opts: AnyRefusalRunOptions): Promise<AnyRefusalReport> {
  const agent = opts.agent ?? null;
  const sources = [...(opts.sources ?? ANY_REFUSAL_SOURCES[opts.checkpoint])];
  const bands = normalizeBands(opts.bands ?? DEFAULT_SCORE_BANDS);
  const agentNames = [agent, ...(opts.agents ?? [])].filter((a): a is string => a !== null);
  const refusalCodes = new Set<string>();
  for (const a of [null, ...agentNames]) for (const c of opts.catalogue.all(a)) if (c.kind === "refusal") refusalCodes.add(c.code);
  const checks = opts.catalogue.enabledFor(opts.checkpoint, agent).filter((c) => c.kind === "refusal" && c.questions.length > 0);
  const sampled = sampleByScoreBand(opts.db, {
    checkpoint: opts.checkpoint,
    sources,
    refusalCodes,
    bands,
    perBand: opts.perBand,
    seed: opts.seed,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
  });
  const reasons = anyRefusalReasons(opts.catalogue, agentNames);
  const stateFor = (item: CalibrationItem) => (budget: number) =>
    buildCheckState(
      { context: item.context, sources: item.sources, scope: "full", thinkingTailTokens: opts.thinkingTailTokens ?? 800 },
      budget,
    );
  const rows: AnyRefusalRow[] = new Array(sampled.items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= sampled.items.length) return;
      const { item, band, recorded } = sampled.items[index]!;
      const state = stateFor(item);
      let parsed: ParsedLabel;
      try {
        const response = await opts.labeller(anyRefusalLabelRequest(item, opts.checkpoint, state(opts.stateTokens ?? 6000), reasons));
        parsed = parseLabelResponse(response, reasons);
      } catch (error) {
        if (error instanceof CalibrationAbortError) throw error;
        parsed = { label: "invalid", reason: null };
      }
      let probability: number | null = null;
      try {
        const p = await opts.scorer(item, state);
        probability = typeof p === "number" && Number.isFinite(p) ? round3(p) : null;
      } catch (error) {
        if (error instanceof CalibrationAbortError) throw error;
        probability = null;
      }
      rows[index] = { id: item.id, band, recorded, label: parsed.label, reason: parsed.reason, probability };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, () => worker()));

  const bandRows = bandSummaries(rows, bands, sampled.population);
  const weights = bandRows.map((b) => b.weight);
  const thresholds = weightedThresholdTable(rows, weights, opts.thresholds ?? DEFAULT_CANDIDATE_THRESHOLDS);
  const targetPrecision = opts.targetPrecision ?? 0.9;
  let bestF1: WeightedThresholdRow | null = null;
  for (const t of thresholds) {
    if (t.f1 === null) continue;
    if (!bestF1 || t.f1 > bestF1.f1! || (t.f1 === bestF1.f1 && t.threshold > bestF1.threshold)) bestF1 = t;
  }
  const atPrecisionTarget = thresholds.find((t) => t.tp > 0 && t.precision !== null && t.precision >= targetPrecision) ?? null;
  return {
    mode: "any_refusal",
    checkpoint: opts.checkpoint,
    sources,
    checks: checks.map((c) => c.code),
    labeller: opts.labellerInfo,
    member: opts.memberInfo,
    sessions: sampled.sessions,
    eligible: sampled.eligible,
    unrecorded: sampled.unrecorded,
    bands: bandRows,
    rows,
    thresholds,
    direction: directionAccuracy(rows, weights),
    suggested: { bestF1, precisionTarget: targetPrecision, atPrecisionTarget },
  };
}

const fmt = (n: number | null) => (n === null ? "-" : n.toFixed(3));

/** The plain-text report: ids, bands, labels, reasons, scores and aggregates only. */
export function formatAnyRefusalReport(report: AnyRefusalReport): string {
  const lines: string[] = [];
  lines.push(`any refusal  checkpoint ${report.checkpoint}  sources ${report.sources.join(",")}  checks ${report.checks.join(",")}`);
  lines.push(`labeller ${report.labeller.model} @ ${report.labeller.host}  member ${report.member.model} @ ${report.member.host}`);
  lines.push(
    `sessions ${report.sessions}  eligible outputs ${report.eligible}  without a recorded score (excluded) ${report.unrecorded}  sampled ${report.rows.length}`,
  );
  lines.push("");
  lines.push("bands (from-to population sampled true false unsure invalid unscored weight)");
  for (const b of report.bands) {
    lines.push(
      `  ${b.from.toFixed(2)}-${b.to.toFixed(2)} ${b.population} ${b.sampled} ${b.true} ${b.false} ${b.unsure} ${b.invalid} ${b.unscored} ${fmt(b.weight)}`,
    );
  }
  lines.push("");
  lines.push("items (id band recorded label reason probability)");
  for (const r of report.rows) lines.push(`  ${r.id} ${r.band} ${fmt(r.recorded)} ${r.label} ${r.reason ?? "-"} ${fmt(r.probability)}`);
  lines.push("");
  lines.push("thresholds, population-weighted (t precision recall f1 | raw tp fp fn tn | weighted tp fp fn tn)");
  for (const t of report.thresholds) {
    lines.push(
      `  ${t.threshold.toFixed(3)} ${fmt(t.precision)} ${fmt(t.recall)} ${fmt(t.f1)} | ${t.tp} ${t.fp} ${t.fn} ${t.tn} | ` +
        `${t.wtp.toFixed(1)} ${t.wfp.toFixed(1)} ${t.wfn.toFixed(1)} ${t.wtn.toFixed(1)}`,
    );
  }
  lines.push("");
  const d = report.direction;
  lines.push(`direction accuracy (p >= 0.5 agrees with the label): raw ${fmt(d.raw)}  weighted ${fmt(d.weighted)}  over ${d.items} items`);
  const s = report.suggested;
  lines.push(`suggested best F1: ${s.bestF1 ? `${s.bestF1.threshold.toFixed(3)} (precision ${fmt(s.bestF1.precision)}, recall ${fmt(s.bestF1.recall)})` : "-"}`);
  lines.push(
    `suggested precision >= ${s.precisionTarget}: ${s.atPrecisionTarget ? `${s.atPrecisionTarget.threshold.toFixed(3)} (recall ${fmt(s.atPrecisionTarget.recall)})` : "-"}`,
  );
  return `${lines.join("\n")}\n`;
}
