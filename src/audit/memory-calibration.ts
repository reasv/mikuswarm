/**
 * Memory-point calibration (the CLI's `--point memory`; core of
 * scripts/calibrate-checks.ts beside src/audit/calibration.ts), the offline
 * evaluation of judged auto-retrieval (ARCHITECTURE.md §9d "Judged retrieval",
 * §8h "Memory"). The privacy guarantees are those of the check modes: a
 * read-only database, guarded endpoints, a labeller constrained to enums
 * through the forced `submit_label` tool, and a report of ids, enums and
 * numbers only.
 *
 * - **Threshold calibration** of `relevance_threshold` per member. The items
 *   are `point = 'memory'` decision rows with a state: `state_json` holds
 *   exactly the `{ conversation, request?, participants, passage }` the member
 *   was sent, so the item is that state. Filter-only rows (the same point asked
 *   only judged-filter questions about an `entry`) are skipped and counted, as
 *   are states cut by the 64 KiB row cap. A labeller labels whether the passage
 *   would help respond in that conversation; one member scores the point's own
 *   questions over the same state in exactly one request (never its fallbacks).
 *   Report: the check modes' threshold table, histograms and suggestions, plus
 *   the calibration key to set.
 * - **Recall ceiling.** Builds (`memory_retrievals` rows) whose report lists a
 *   recall set and whose decision group holds a memory row with a state (the
 *   build's conversation, request and participants). Every item of the recall
 *   set, whatever its stage, is labelled against that conversation with the
 *   block text from `memory_chunks` by content hash (items whose text is gone
 *   are skipped and counted). Report: the share of builds with a
 *   labelled-relevant item anywhere in the recall set that could have been
 *   shown (the ceiling a ranker cannot beat; items already in context through
 *   the recency layer, or hidden by a filter, are not reachable and are
 *   reported as their own share), among the items the judge scored, and among
 *   the kept items, plus label counts per stage (relevant items cut by late
 *   interaction or the re-ranker, dropped by the judge, hidden, not selected).
 */
import type Database from "better-sqlite3";
import { jsonTokens, type DecisionClient } from "../decisions/client.js";
import type { PointSettings } from "../decisions/config.js";
import {
  DEFAULT_MEMORY_RELEVANCE_THRESHOLD,
  memoryPoint,
  type MemoryChatMessage,
  type MemoryPassage,
  type MemoryPassageInput,
  type MemoryRequest,
} from "../decisions/points/memory.js";
import type { ReportItem } from "../retrieval/auto/types.js";
import { cleanBlockText } from "../retrieval/excerpt.js";
import { agentDateStamp } from "../time/index.js";
import {
  CalibrationAbortError,
  DEFAULT_CANDIDATE_THRESHOLDS,
  LABELLER_SYSTEM_PROMPT,
  labelTool,
  parseLabelResponse,
  scoreHistogram,
  seededRandom,
  thresholdTable,
  type CalibrationRow,
  type HistogramBin,
  type Label,
  type Labeller,
  type LabelRequest,
  type ParsedLabel,
  type ThresholdRow,
} from "./calibration.js";

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** The calibration key of the memory threshold (`[decisions.calibration.<member>]`). */
export const MEMORY_CALIBRATION_KEY = "memory.relevance_threshold";

/** Reasons of a memory relevance label: why the passage helps or not, never what it says. */
export const MEMORY_LABEL_REASONS = [
  "answers_request",
  "same_people_history",
  "same_topic_history",
  "unrelated",
  "too_vague",
  "unsure",
] as const;

// ---------------------------------------------------------------------------
// Stored states
// ---------------------------------------------------------------------------

/** The memory point's state, as sent to the member and stored in `state_json`. */
export interface MemoryState {
  conversation: MemoryChatMessage[];
  request?: MemoryRequest;
  participants: string[];
  /** The diary block judged (rows written before the rename name it `passage`; read as this). */
  entry: { date: string; room?: string; text: string };
}

export type ParsedMemoryState =
  | { kind: "passage"; state: MemoryState }
  | { kind: "filter" }
  | { kind: "unreadable" };

function asObj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function chatMessage(value: unknown): MemoryChatMessage | undefined {
  const o = asObj(value);
  if (!o || typeof o["from"] !== "string" || typeof o["text"] !== "string") return undefined;
  return { from: o["from"], text: o["text"], ...(o["self"] === true ? { self: true as const } : {}) };
}

/**
 * A memory decision row's `state_json`: a relevance state (`conversation`
 * plus the judged `entry`; older rows name it `passage`), a filter-only state
 * (`entry`, no `conversation`), or unreadable (absent, cut by the row cap, or
 * not the point's shape).
 */
export function parseMemoryState(json: string | null): ParsedMemoryState {
  if (!json) return { kind: "unreadable" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: "unreadable" };
  }
  const o = asObj(raw);
  if (!o) return { kind: "unreadable" };
  if (o["passage"] === undefined && o["entry"] !== undefined && o["conversation"] === undefined) return { kind: "filter" };
  const passage = asObj(o["entry"] ?? o["passage"]);
  if (!passage || typeof passage["text"] !== "string" || typeof passage["date"] !== "string") return { kind: "unreadable" };
  if (!Array.isArray(o["conversation"])) return { kind: "unreadable" };
  const conversation: MemoryChatMessage[] = [];
  for (const m of o["conversation"]) {
    const parsed = chatMessage(m);
    if (!parsed) return { kind: "unreadable" };
    conversation.push(parsed);
  }
  let request: MemoryRequest | undefined;
  if (o["request"] !== undefined) {
    const r = asObj(o["request"]);
    if (!r || typeof r["from"] !== "string" || typeof r["text"] !== "string") return { kind: "unreadable" };
    const replyTo = chatMessage(r["reply_to"]);
    request = { from: r["from"], text: r["text"], ...(replyTo ? { reply_to: { from: replyTo.from, text: replyTo.text } } : {}) };
  }
  const participants = Array.isArray(o["participants"])
    ? (o["participants"] as unknown[]).filter((p): p is string => typeof p === "string")
    : [];
  return {
    kind: "passage",
    state: {
      conversation,
      ...(request ? { request } : {}),
      participants,
      entry: {
        date: passage["date"],
        ...(typeof passage["room"] === "string" ? { room: passage["room"] } : {}),
        text: passage["text"],
      },
    },
  };
}

/** The point input of a stored state, with its own passage or another one. */
export function memoryInputOf(state: MemoryState, passage?: MemoryPassage): MemoryPassageInput {
  return {
    conversation: state.conversation,
    ...(state.request ? { request: state.request } : {}),
    participants: state.participants,
    passage: passage ?? { date: state.entry.date, room: state.entry.room ?? null, text: state.entry.text },
    filters: [],
    meta: { citation: "", contentHash: "", scores: {} },
  };
}

/** Point settings of a calibration call (no calibration overrides: raw probabilities). */
function memorySettings(model: string, timeoutMs = 30_000, stateMaxTokens = 8000): PointSettings {
  return {
    point: "memory",
    model,
    timeoutMs,
    stateMaxTokens,
    minStateTokens: 1,
    minConfidence: 0,
    calibration: {},
    persona: "",
    threshold: DEFAULT_MEMORY_RELEVANCE_THRESHOLD,
  };
}

// ---------------------------------------------------------------------------
// Labelling
// ---------------------------------------------------------------------------

/** The labelling call for one passage state: the point's own `relevant` statement as the definition. */
export function memoryLabelRequest(itemId: string, state: MemoryState): LabelRequest {
  const relevant = memoryPoint.questions(memoryInputOf(state), memorySettings("labeller"))["relevant"]!;
  const target = state.request ? "what `request` needs" : "what the conversation is about";
  const prompt =
    "Check: memory_relevance (memory). Whether an entry from the assistant's own earlier notes would help it " +
    "respond in a conversation.\n\n" +
    `Statement about the item:\n${relevant.instructions}\n\n` +
    "Criteria:\n" +
    `- true: knowing \`entry\` would help the assistant respond: it answers or supplies ${target}, or it gives ` +
    "earlier interactions or facts about the people in `conversation`, or earlier facts or events about the topic " +
    "being discussed, that bear on the response.\n" +
    "- false: `entry` would not help: it is about other people or topics, or it shares only a word, a name or a " +
    "generic theme with the conversation.\n\n" +
    `Reasons: when true, answers_request (it answers or directly supplies ${target}), same_people_history ` +
    "(earlier interactions or facts about the people in the conversation), same_topic_history (earlier facts or " +
    "events about the topic being discussed); when false, unrelated (other people or topics) or too_vague (only a " +
    "shared word or generic theme); when unsure, unsure.\n\n" +
    "The item (JSON; field names refer to it):\n" +
    `${JSON.stringify(state)}\n\n` +
    "Call submit_label now. Do not reproduce any of the item's content.";
  return { itemId, systemPrompt: LABELLER_SYSTEM_PROMPT, prompt, tool: labelTool(MEMORY_LABEL_REASONS), reasons: MEMORY_LABEL_REASONS };
}

async function label(labeller: Labeller, itemId: string, state: MemoryState): Promise<ParsedLabel> {
  try {
    return parseLabelResponse(await labeller(memoryLabelRequest(itemId, state)), MEMORY_LABEL_REASONS);
  } catch (error) {
    if (error instanceof CalibrationAbortError) throw error;
    return { label: "invalid", reason: null };
  }
}

async function runPool<T>(tasks: readonly T[], concurrency: number, fn: (task: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      await fn(tasks[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
}

// ---------------------------------------------------------------------------
// The member's score
// ---------------------------------------------------------------------------

/** The member's `relevant` probability for a state, or undefined (no answer). */
export type MemoryScorer = (state: MemoryState) => Promise<number | undefined>;

/**
 * Score states with exactly one decision member (never its fallbacks): the
 * memory point's questions (`relevant`, and `about_participant` with
 * participants, as the live request asks them; no filter questions) over the
 * stored state, sent as is when it fits the member's budget and rebuilt by the
 * point otherwise.
 */
export function createMemoryScorer(opts: {
  client: DecisionClient;
  memberKey: string;
  timeoutMs?: number;
  stateMaxTokens?: number;
}): MemoryScorer {
  const settings = memorySettings(opts.memberKey, opts.timeoutMs, opts.stateMaxTokens);
  return async (state) => {
    const input = memoryInputOf(state);
    const result = await opts.client.decide(
      opts.memberKey,
      {
        questions: memoryPoint.questions(input, settings),
        state: (budget) => (jsonTokens(state) <= budget ? state : memoryPoint.state(input, budget)),
        stateMaxTokens: settings.stateMaxTokens,
        minStateTokens: settings.minStateTokens,
        stateShape: "object",
      },
      {
        consumer: "decision:calibration",
        priority: "background",
        timeoutMs: settings.timeoutMs,
        isModelAvailable: (id) => id === opts.memberKey,
      },
    );
    const verdict = memoryPoint.resolve(result.answers, input, (_name, value) => value, settings);
    return verdict?.relevant ?? undefined;
  };
}

// ---------------------------------------------------------------------------
// Threshold calibration
// ---------------------------------------------------------------------------

export interface MemoryItem {
  /** `memory:<decision row id>`: never content. */
  id: string;
  state: MemoryState;
  /** The `relevant` probability recorded on the row (the live member's), if any. */
  recorded: number | null;
}

export interface MemorySample {
  items: MemoryItem[];
  /** Memory decision rows with a state in the window. */
  rows: number;
  /** Rows with a passage state (the sampled population). */
  eligible: number;
  /** Filter-only rows (`entry`, no `conversation`): skipped. */
  filterOnly: number;
  /** States cut by the row cap or not of the point's shape: skipped. */
  unreadable: number;
}

function recordedRelevant(answersJson: string | null): number | null {
  if (!answersJson) return null;
  try {
    const p = asObj(asObj(JSON.parse(answersJson))?.["relevant"])?.["noul"];
    return typeof p === "number" && Number.isFinite(p) ? round3(p) : null;
  } catch {
    return null;
  }
}

/** Seeded reservoir over the memory decision rows with a passage state. */
export function sampleMemoryDecisions(
  db: Database.Database,
  opts: { sample: number; seed: number; since?: number; agent?: string | null },
): MemorySample {
  const params: unknown[] = [opts.since ?? 0];
  let agentClause = "";
  if (opts.agent) {
    agentClause = " and agent = ?";
    params.push(opts.agent);
  }
  const rows = db
    .prepare(
      `select id, state_json as s, answers_json as a from decision_evaluations
        where point = 'memory' and state_json is not null and ts >= ?${agentClause}
        order by ts, id`,
    )
    .iterate(...params) as IterableIterator<{ id: number; s: string | null; a: string | null }>;
  const rand = seededRandom(opts.seed);
  const reservoir: MemoryItem[] = [];
  const out = { rows: 0, eligible: 0, filterOnly: 0, unreadable: 0 };
  for (const row of rows) {
    out.rows += 1;
    const parsed = parseMemoryState(row.s);
    if (parsed.kind === "filter") {
      out.filterOnly += 1;
      continue;
    }
    if (parsed.kind === "unreadable") {
      out.unreadable += 1;
      continue;
    }
    out.eligible += 1;
    const item: MemoryItem = { id: `memory:${row.id}`, state: parsed.state, recorded: recordedRelevant(row.a) };
    if (reservoir.length < opts.sample) reservoir.push(item);
    else {
      const j = Math.floor(rand() * out.eligible);
      if (j < opts.sample) reservoir[j] = item;
    }
  }
  return { items: reservoir, ...out };
}

export interface MemoryCalibrationRow extends CalibrationRow {
  /** The live member's recorded `relevant` probability. */
  recorded: number | null;
}

export interface MemoryCalibrationReport {
  mode: "threshold";
  point: "memory";
  question: "relevant";
  configuredThreshold: number;
  /** Where the calibrated value goes: `[decisions.calibration.<member>]` `"memory.relevance_threshold"`. */
  calibrationKey: { member: string; key: string };
  labeller: { model: string; host: string };
  member: { model: string; host: string };
  population: { rows: number; eligible: number; filterOnly: number; unreadable: number };
  rows: MemoryCalibrationRow[];
  counts: { items: number; true: number; false: number; unsure: number; invalid: number; unscored: number };
  thresholds: ThresholdRow[];
  histogram: HistogramBin[];
  suggested: {
    bestF1: ThresholdRow | null;
    precisionTarget: number;
    atPrecisionTarget: ThresholdRow | null;
    configured: ThresholdRow;
  };
}

export interface MemoryCalibrationOptions {
  db: Database.Database;
  sample: number;
  seed: number;
  since?: number;
  agent?: string | null;
  /** The member's effective threshold today (its calibration override, else `relevance_threshold`). */
  configuredThreshold?: number;
  thresholds?: readonly number[];
  targetPrecision?: number;
  concurrency?: number;
  labeller: Labeller;
  scorer: MemoryScorer;
  labellerInfo: { model: string; host: string };
  memberInfo: { model: string; host: string };
  /** Items sampled already (default: sampled here). */
  sampled?: MemorySample;
}

/** Sample, label, score and aggregate the memory threshold. Never returns content. */
export async function runMemoryCalibration(opts: MemoryCalibrationOptions): Promise<MemoryCalibrationReport> {
  const sampled = opts.sampled ?? sampleMemoryDecisions(opts.db, {
    sample: opts.sample,
    seed: opts.seed,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
  });
  const rows: MemoryCalibrationRow[] = new Array(sampled.items.length);
  await runPool(sampled.items, opts.concurrency ?? 2, async (item, index) => {
    const parsed = await label(opts.labeller, item.id, item.state);
    let probability: number | null = null;
    try {
      const p = await opts.scorer(item.state);
      probability = typeof p === "number" && Number.isFinite(p) ? round3(p) : null;
    } catch (error) {
      if (error instanceof CalibrationAbortError) throw error;
      probability = null;
    }
    rows[index] = { id: item.id, label: parsed.label, labelSource: "labeller", reason: parsed.reason, probability, recorded: item.recorded };
  });

  const configuredThreshold = round3(opts.configuredThreshold ?? DEFAULT_MEMORY_RELEVANCE_THRESHOLD);
  const thresholds = thresholdTable(rows, [...(opts.thresholds ?? DEFAULT_CANDIDATE_THRESHOLDS), configuredThreshold]);
  const targetPrecision = opts.targetPrecision ?? 0.9;
  let bestF1: ThresholdRow | null = null;
  for (const t of thresholds) {
    if (t.f1 === null) continue;
    if (!bestF1 || t.f1 > bestF1.f1! || (t.f1 === bestF1.f1 && t.threshold > bestF1.threshold)) bestF1 = t;
  }
  const atPrecisionTarget = thresholds.find((t) => t.tp > 0 && t.precision !== null && t.precision >= targetPrecision) ?? null;
  const configured = thresholds.find((t) => t.threshold === configuredThreshold)!;
  const count = (l: Label | "invalid") => rows.filter((r) => r.label === l).length;
  return {
    mode: "threshold",
    point: "memory",
    question: "relevant",
    configuredThreshold,
    calibrationKey: { member: opts.memberInfo.model, key: MEMORY_CALIBRATION_KEY },
    labeller: opts.labellerInfo,
    member: opts.memberInfo,
    population: { rows: sampled.rows, eligible: sampled.eligible, filterOnly: sampled.filterOnly, unreadable: sampled.unreadable },
    rows,
    counts: {
      items: rows.length,
      true: count("true"),
      false: count("false"),
      unsure: count("unsure"),
      invalid: count("invalid"),
      unscored: rows.filter((r) => r.probability === null).length,
    },
    thresholds,
    histogram: scoreHistogram(rows),
    suggested: { bestF1, precisionTarget: targetPrecision, atPrecisionTarget, configured },
  };
}

const fmt = (n: number | null) => (n === null ? "-" : n.toFixed(3));
const pct = (n: number | null) => (n === null ? "-" : `${(n * 100).toFixed(1)}%`);

/** A TOML table header for a member key (quoted unless a bare key). */
function calibrationTable(member: string): string {
  return /^[A-Za-z0-9_-]+$/.test(member) ? `[decisions.calibration.${member}]` : `[decisions.calibration.${JSON.stringify(member)}]`;
}

/** The plain-text threshold report: ids, enums and numbers only. */
export function formatMemoryReport(report: MemoryCalibrationReport): string {
  const lines: string[] = [];
  const p = report.population;
  lines.push(`point memory  question relevant  configured threshold ${fmt(report.configuredThreshold)}`);
  lines.push(`labeller ${report.labeller.model} @ ${report.labeller.host}  member ${report.member.model} @ ${report.member.host}`);
  lines.push(
    `memory rows ${p.rows}  eligible ${p.eligible}  filter-only ${p.filterOnly}  unreadable ${p.unreadable}  items ${report.counts.items}`,
  );
  lines.push(
    `labels true ${report.counts.true}  false ${report.counts.false}  unsure ${report.counts.unsure}  invalid ${report.counts.invalid}  unscored ${report.counts.unscored}`,
  );
  lines.push("");
  lines.push("items (id label reason probability recorded)");
  for (const r of report.rows) lines.push(`  ${r.id} ${r.label} ${r.reason ?? "-"} ${fmt(r.probability)} ${fmt(r.recorded)}`);
  lines.push("");
  lines.push("thresholds (t tp fp fn tn precision recall f1)");
  for (const t of report.thresholds) {
    lines.push(`  ${t.threshold.toFixed(3)} ${t.tp} ${t.fp} ${t.fn} ${t.tn} ${fmt(t.precision)} ${fmt(t.recall)} ${fmt(t.f1)}`);
  }
  lines.push("");
  lines.push("histogram (bin positive negative unsure)");
  for (const b of report.histogram) lines.push(`  ${b.from.toFixed(1)}-${b.to.toFixed(1)} ${b.positive} ${b.negative} ${b.unsure}`);
  lines.push("");
  const s = report.suggested;
  lines.push(`suggested best F1: ${s.bestF1 ? `${s.bestF1.threshold.toFixed(3)} (precision ${fmt(s.bestF1.precision)}, recall ${fmt(s.bestF1.recall)})` : "-"}`);
  lines.push(
    `suggested precision >= ${s.precisionTarget}: ${s.atPrecisionTarget ? `${s.atPrecisionTarget.threshold.toFixed(3)} (recall ${fmt(s.atPrecisionTarget.recall)})` : "-"}`,
  );
  lines.push(`configured ${s.configured.threshold.toFixed(3)}: precision ${fmt(s.configured.precision)}, recall ${fmt(s.configured.recall)}`);
  const key = `${calibrationTable(report.calibrationKey.member)} "${report.calibrationKey.key}"`;
  lines.push(
    s.atPrecisionTarget
      ? `set: ${key} = ${s.atPrecisionTarget.threshold.toFixed(3)}`
      : `set: ${key} = - (no threshold reaches precision ${s.precisionTarget})`,
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Recall ceiling
// ---------------------------------------------------------------------------

export const DEFAULT_RECALL_PER_BUILD = 60;

export interface RecallBuild {
  /** The `memory_retrievals` row id. */
  id: string;
  /** The build's selection source (`model`, `fallback`, ...). */
  source: string;
  /** The conversation, request and participants of the build (from a memory decision row). */
  state: MemoryState;
  items: ReportItem[];
}

export interface RecallSample {
  builds: RecallBuild[];
  /** Builds with a report in the window. */
  scanned: number;
  /** Builds whose report lists no item. */
  noItems: number;
  /** Builds with items but no memory decision row with a passage state in their group. */
  noState: number;
  /** Builds with items and a state (the sampled population). */
  eligible: number;
}

function reportItems(json: string | null): ReportItem[] | undefined {
  if (!json) return undefined;
  try {
    const items = asObj(JSON.parse(json))?.["items"];
    if (!Array.isArray(items)) return undefined;
    return (items as unknown[]).filter((i): i is ReportItem => {
      const o = asObj(i);
      return !!o && typeof o["contentHash"] === "string" && typeof o["stage"] === "string";
    });
  } catch {
    return undefined;
  }
}

/** Seeded reservoir over the builds that have a recall set and a recoverable conversation state. */
export function sampleRecallBuilds(
  db: Database.Database,
  opts: { sample: number; seed: number; since?: number; agent?: string | null },
): RecallSample {
  const params: unknown[] = [opts.since ?? 0];
  let agentClause = "";
  if (opts.agent) {
    agentClause = " and agent = ?";
    params.push(opts.agent);
  }
  const builds = db
    .prepare(
      `select id, agent_session_id as s, decision_group as g, source, report_json as r from memory_retrievals
        where report_json is not null and ts >= ?${agentClause}
        order by ts, id`,
    )
    .all(...params) as Array<{ id: string; s: string | null; g: string | null; source: string; r: string | null }>;
  const states = db.prepare(
    `select state_json as s from decision_evaluations
      where point = 'memory' and agent_session_id is ? and decision_group = ? and state_json is not null
      order by id`,
  );
  const rand = seededRandom(opts.seed);
  const reservoir: RecallBuild[] = [];
  const out = { scanned: 0, noItems: 0, noState: 0, eligible: 0 };
  for (const b of builds) {
    out.scanned += 1;
    const items = reportItems(b.r);
    if (!items || items.length === 0) {
      out.noItems += 1;
      continue;
    }
    let state: MemoryState | undefined;
    if (b.g) {
      for (const row of states.iterate(b.s, b.g) as IterableIterator<{ s: string | null }>) {
        const parsed = parseMemoryState(row.s);
        if (parsed.kind === "passage") {
          state = parsed.state;
          break;
        }
      }
    }
    if (!state) {
      out.noState += 1;
      continue;
    }
    out.eligible += 1;
    const build: RecallBuild = { id: b.id, source: b.source, state, items };
    if (reservoir.length < opts.sample) reservoir.push(build);
    else {
      const j = Math.floor(rand() * out.eligible);
      if (j < opts.sample) reservoir[j] = build;
    }
  }
  return { builds: reservoir, ...out };
}

/** True when the judge scored the item (its `relevant` probability is in the report). */
const judgedItem = (item: ReportItem) => typeof item.relevant === "number";

/**
 * The items of a build to label, at most `perBuild`: the items the judge scored
 * or that were kept first (so the judged and kept shares are never cut), then
 * the rest in report order.
 */
export function recallItemsOf(build: RecallBuild, perBuild: number): { items: ReportItem[]; capped: number } {
  const seen = new Set<string>();
  const unique = build.items.filter((i) => (seen.has(i.contentHash) ? false : (seen.add(i.contentHash), true)));
  const first = unique.filter((i) => judgedItem(i) || i.stage === "kept");
  const rest = unique.filter((i) => !(judgedItem(i) || i.stage === "kept"));
  const ordered = [...first, ...rest];
  const cap = Math.max(0, perBuild);
  return { items: ordered.slice(0, cap), capped: Math.max(0, ordered.length - cap) };
}

/** Block text by content hash (any row: the hash is of the text), batched. */
export function chunkTexts(
  db: Database.Database,
  hashes: Iterable<string>,
): Map<string, { text: string; entryTs: number; room: string | null }> {
  const all = [...new Set(hashes)];
  const out = new Map<string, { text: string; entryTs: number; room: string | null }>();
  for (let i = 0; i < all.length; i += 500) {
    const batch = all.slice(i, i + 500);
    const rows = db
      .prepare(
        `select content_hash as h, text, entry_ts as ts, room from memory_chunks
          where content_hash in (${batch.map(() => "?").join(", ")})`,
      )
      .all(...batch) as Array<{ h: string; text: string; ts: number; room: string | null }>;
    for (const r of rows) if (!out.has(r.h)) out.set(r.h, { text: r.text, entryTs: r.ts, room: r.room });
  }
  return out;
}

export interface RecallItemRow {
  build: string;
  contentHash: string;
  stage: string;
  judged: boolean;
  label: Label | "invalid";
  reason: string | null;
}

export interface RecallBuildRow {
  id: string;
  source: string;
  /** Items in the recall set / labelled / skipped (text gone) / beyond the cap. */
  items: number;
  labelled: number;
  missingText: number;
  capped: number;
  /** Relevant items that could have been shown (not in the recency layer, not filter-hidden). */
  relevant: number;
  relevantJudged: number;
  relevantKept: number;
  /** Relevant items already in context (recency layer) or hidden by a filter: outside the ceiling. */
  relevantExcluded: number;
}

export interface StageCounts {
  stage: string;
  items: number;
  true: number;
  false: number;
  unsure: number;
  invalid: number;
}

export interface RecallShare {
  builds: number;
  share: number | null;
}

export interface RecallCeilingReport {
  mode: "recall_ceiling";
  point: "memory";
  labeller: { model: string; host: string };
  population: { scanned: number; noItems: number; noState: number; eligible: number };
  perBuild: number;
  builds: number;
  /** Builds with at least one item labelled true, false or unsure (the shares' denominator). */
  usableBuilds: number;
  items: { listed: number; capped: number; missingText: number; labelled: number; true: number; false: number; unsure: number; invalid: number };
  /** Builds with a labelled-relevant, showable item anywhere in the recall set: the ceiling. */
  ceiling: RecallShare;
  /** Builds with a relevant item already in context (recency layer) or filter-hidden: not counted above. */
  excluded: RecallShare;
  /** ... among the items the judge scored. */
  judged: RecallShare;
  /** ... among the kept items (in the memory block). */
  kept: RecallShare;
  stages: StageCounts[];
  buildRows: RecallBuildRow[];
  rows: RecallItemRow[];
}

export interface RecallCeilingOptions {
  db: Database.Database;
  sample: number;
  seed: number;
  since?: number;
  agent?: string | null;
  perBuild?: number;
  /** State budget of a labelled item. Default 6000 tokens. */
  stateTokens?: number;
  concurrency?: number;
  labeller: Labeller;
  labellerInfo: { model: string; host: string };
  /** Builds sampled already (default: sampled here). */
  sampled?: RecallSample;
}

/** Stages whose items could never be shown: already in context, or hidden by an operator filter. */
const UNREACHABLE_STAGES = new Set(["recency", "hidden"]);

/** The order stages are reported in: the pipeline's, recall to selection. */
const STAGE_ORDER = ["recency", "cut_late", "cut_rerank", "over_cap", "not_judged", "hidden", "dropped", "not_selected", "budget", "kept"];

/** Label every item of the sampled builds' recall sets and aggregate. Never returns content. */
export async function runRecallCeiling(opts: RecallCeilingOptions): Promise<RecallCeilingReport> {
  const sampled = opts.sampled ?? sampleRecallBuilds(opts.db, {
    sample: opts.sample,
    seed: opts.seed,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
  });
  const perBuild = opts.perBuild ?? DEFAULT_RECALL_PER_BUILD;
  const chosen = sampled.builds.map((build) => ({ build, ...recallItemsOf(build, perBuild) }));
  const texts = chunkTexts(opts.db, chosen.flatMap((c) => c.items.map((i) => i.contentHash)));
  const buildRows: RecallBuildRow[] = chosen.map(({ build, items, capped }) => ({
    id: build.id,
    source: build.source,
    items: build.items.length,
    labelled: 0,
    missingText: items.filter((i) => !texts.has(i.contentHash)).length,
    capped,
    relevant: 0,
    relevantJudged: 0,
    relevantKept: 0,
    relevantExcluded: 0,
  }));
  const tasks: Array<{ b: number; item: ReportItem; state: MemoryState | null }> = [];
  chosen.forEach(({ build, items }, b) => {
    for (const item of items) {
      const chunk = texts.get(item.contentHash);
      if (!chunk) continue;
      const passage: MemoryPassage = {
        date: agentDateStamp(chunk.entryTs),
        room: chunk.room,
        text: cleanBlockText(chunk.text).lines.join("\n"),
      };
      let state: MemoryState | null;
      try {
        state = memoryPoint.state(memoryInputOf(build.state, passage), opts.stateTokens ?? 6000) as MemoryState;
      } catch {
        // A passage the state budget cannot hold: labelled invalid below.
        state = null;
      }
      tasks.push({ b, item, state });
    }
  });
  const rows: RecallItemRow[] = new Array(tasks.length);
  await runPool(tasks, opts.concurrency ?? 2, async ({ b, item, state }, index) => {
    const id = `${chosen[b]!.build.id}:${item.contentHash.slice(0, 12)}`;
    const parsed: ParsedLabel = state ? await label(opts.labeller, id, state) : { label: "invalid", reason: null };
    rows[index] = {
      build: chosen[b]!.build.id,
      contentHash: item.contentHash,
      stage: item.stage,
      judged: judgedItem(item),
      label: parsed.label,
      reason: parsed.reason,
    };
  });

  const stageMap = new Map<string, StageCounts>();
  const itemCounts = { true: 0, false: 0, unsure: 0, invalid: 0 };
  const usable = new Set<number>();
  tasks.forEach(({ b }, index) => {
    const row = rows[index]!;
    const stage = stageMap.get(row.stage) ?? { stage: row.stage, items: 0, true: 0, false: 0, unsure: 0, invalid: 0 };
    stage.items += 1;
    stage[row.label] += 1;
    stageMap.set(row.stage, stage);
    itemCounts[row.label] += 1;
    const br = buildRows[b]!;
    if (row.label !== "invalid") {
      br.labelled += 1;
      usable.add(b);
    }
    if (row.label === "true" && UNREACHABLE_STAGES.has(row.stage)) {
      br.relevantExcluded += 1;
    } else if (row.label === "true") {
      br.relevant += 1;
      if (row.judged) br.relevantJudged += 1;
      if (row.stage === "kept") br.relevantKept += 1;
    }
  });
  const share = (pick: (r: RecallBuildRow) => number): RecallShare => {
    const n = buildRows.filter((r, b) => usable.has(b) && pick(r) > 0).length;
    return { builds: n, share: usable.size > 0 ? round3(n / usable.size) : null };
  };
  const rank = (s: string) => {
    const i = STAGE_ORDER.indexOf(s);
    return i < 0 ? STAGE_ORDER.length : i;
  };
  return {
    mode: "recall_ceiling",
    point: "memory",
    labeller: opts.labellerInfo,
    population: { scanned: sampled.scanned, noItems: sampled.noItems, noState: sampled.noState, eligible: sampled.eligible },
    perBuild,
    builds: chosen.length,
    usableBuilds: usable.size,
    items: {
      listed: chosen.reduce((n, c) => n + c.items.length, 0),
      capped: chosen.reduce((n, c) => n + c.capped, 0),
      missingText: buildRows.reduce((n, r) => n + r.missingText, 0),
      labelled: itemCounts.true + itemCounts.false + itemCounts.unsure,
      ...itemCounts,
    },
    ceiling: share((r) => r.relevant),
    excluded: share((r) => r.relevantExcluded),
    judged: share((r) => r.relevantJudged),
    kept: share((r) => r.relevantKept),
    stages: [...stageMap.values()].sort((a, b) => rank(a.stage) - rank(b.stage) || a.stage.localeCompare(b.stage)),
    buildRows,
    rows,
  };
}

/** The plain-text recall-ceiling report: ids, enums and numbers only. */
export function formatRecallCeilingReport(report: RecallCeilingReport): string {
  const lines: string[] = [];
  const p = report.population;
  const it = report.items;
  lines.push(`point memory  recall ceiling  labeller ${report.labeller.model} @ ${report.labeller.host}`);
  lines.push(
    `builds with a report ${p.scanned}  no items ${p.noItems}  no state ${p.noState}  eligible ${p.eligible}  ` +
      `sampled ${report.builds}  usable ${report.usableBuilds}  per build <= ${report.perBuild}`,
  );
  lines.push(
    `items listed ${it.listed}  beyond cap ${it.capped}  text gone ${it.missingText}  labelled ${it.labelled}  ` +
      `(true ${it.true}  false ${it.false}  unsure ${it.unsure}  invalid ${it.invalid})`,
  );
  lines.push("");
  lines.push(`ceiling (a relevant item anywhere in the recall set): ${report.ceiling.builds}/${report.usableBuilds} ${pct(report.ceiling.share)}`);
  lines.push(`  not counted (relevant, but in the recency layer or hidden): ${report.excluded.builds}/${report.usableBuilds} ${pct(report.excluded.share)}`);
  lines.push(`reached the judge (a relevant item the judge scored):  ${report.judged.builds}/${report.usableBuilds} ${pct(report.judged.share)}`);
  lines.push(`kept (a relevant item in the memory block):            ${report.kept.builds}/${report.usableBuilds} ${pct(report.kept.share)}`);
  lines.push("");
  lines.push("stages (stage items true false unsure invalid)");
  for (const s of report.stages) lines.push(`  ${s.stage} ${s.items} ${s.true} ${s.false} ${s.unsure} ${s.invalid}`);
  lines.push("");
  lines.push("builds (id source items labelled text-gone beyond-cap relevant relevant-judged relevant-kept relevant-excluded)");
  for (const b of report.buildRows) {
    lines.push(
      `  ${b.id} ${b.source} ${b.items} ${b.labelled} ${b.missingText} ${b.capped} ${b.relevant} ${b.relevantJudged} ${b.relevantKept} ${b.relevantExcluded}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
