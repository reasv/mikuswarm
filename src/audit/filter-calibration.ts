/**
 * Judged memory-filter calibration (the CLI's `--point filter`; core of
 * scripts/calibrate-checks.ts beside src/audit/calibration.ts), the offline
 * evaluation of one judged operator filter (ARCHITECTURE.md §9c "Memory
 * filters", §9i "Calibration tool"). The privacy guarantees are those of the
 * other modes: a read-only database, guarded endpoints, a labeller constrained
 * to enums through the forced `submit_label` tool, and a report of ids, enums
 * and numbers only (never block text).
 *
 * - **Items** are the agent's diary blocks, the unit the filters judge: the
 *   `memory_chunks` rows of each file, stitched back into whole blocks where the
 *   indexer sub-split an oversized one, and split exactly like the filter
 *   surfaces split a file (src/retrieval/filters/blocks.ts), so the date, room
 *   and content hash are the ones the live filter sees. Blocks outside the
 *   filter's time scope, or that miss its mechanical pre-gate, are never judged
 *   live and are excluded (counted).
 * - **Sampling** is stratified: every block that matches the enrichment set
 *   (case-insensitive substrings and/or regular expressions supplied by the
 *   operator; optionally capped, seeded) plus a seeded random sample of the
 *   rest. Precision and recall over the enriched stratum alone are biased, so
 *   the report gives each stratum and a population estimate that weights each
 *   usable row by its stratum's population / usable rows.
 * - **Labeller**: a chat model labels whether the block matches the filter's
 *   description, with the filter's examples as criteria (the live question's
 *   own wording), one call per block.
 * - **Judge**: the decision chain asked exactly what the live filter asks
 *   (`memoryFilterPoint`, the block's cleaned text and date, the filter's
 *   question alone), raw probabilities (no calibration override). Only the
 *   chain head is called unless `chain` is set (then its fallbacks may serve,
 *   as live).
 */
import type Database from "better-sqlite3";
import { parse as parseToml } from "smol-toml";
import type { AppConfig } from "../config/index.js";
import type { BilledAttempt, DecisionClient } from "../decisions/client.js";
import type { PointSettings } from "../decisions/config.js";
import { filterQuestionId, memoryFilterPoint, type MemoryFilterInput, type MemoryFilterQuestion } from "../decisions/points/memory.js";
import { diaryHeaderRegex } from "../diary/header.js";
import { cleanBlockText } from "../retrieval/excerpt.js";
import {
  filterBoundTs,
  mergeFilterTables,
  resolveMemoryFilters,
  type ResolvedMemoryFilter,
  type ResolvedMemoryFilters,
} from "../retrieval/filters/config.js";
import { splitFileBlocks } from "../retrieval/filters/blocks.js";
import type { FilterBlock } from "../retrieval/filters/service.js";
import { toQuestion } from "../retrieval/filters/service.js";
import { agentDateStamp } from "../time/index.js";
import { weightedThresholdTable, type WeightedThresholdRow } from "./any-refusal-calibration.js";
import {
  CalibrationAbortError,
  DEFAULT_CANDIDATE_THRESHOLDS,
  GENERIC_LABEL_REASONS,
  LABELLER_SYSTEM_PROMPT,
  labelTool,
  parseLabelResponse,
  scoreHistogram,
  seededRandom,
  thresholdTable,
  type HistogramBin,
  type Label,
  type Labeller,
  type LabelRequest,
  type ParsedLabel,
  type ThresholdRow,
} from "./calibration.js";

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export const DEFAULT_FILTER_SAMPLE = 150;
export const FILTER_LABEL_REASONS = GENERIC_LABEL_REASONS;
export const STRATA = ["enriched", "rest"] as const;
export type Stratum = (typeof STRATA)[number];

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

/**
 * The agent's effective filters (the global table with the agent's overrides,
 * as live), with an optional side TOML merged over them: a filter defined only
 * there (as `[retrieval.filters.<key>]`, or a top-level `[<key>]` table) is
 * calibrated before it is in the live configuration. Throws on a malformed one.
 */
export function calibrationFilters(
  config: AppConfig,
  agent: string | null,
  side?: { text: string; name: string },
): ResolvedMemoryFilters {
  let table = mergeFilterTables(
    config.retrieval?.filters as Record<string, unknown> | undefined,
    agent ? (config.agents?.[agent]?.retrieval?.filters as Record<string, unknown> | undefined) : undefined,
  );
  if (side) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseToml(side.text) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`${side.name} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
    }
    const retrieval = parsed["retrieval"];
    const sideTable =
      retrieval !== undefined
        ? (((retrieval as Record<string, unknown>)["filters"] ?? {}) as Record<string, unknown>)
        : parsed;
    table = mergeFilterTables(table, sideTable);
  }
  return resolveMemoryFilters(table, side ? `retrieval.filters (with ${side.name})` : "retrieval.filters");
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Join two consecutive sub-chunk windows, dropping their overlap. */
export function joinWindows(a: string, b: string): string {
  for (let k = Math.min(a.length, b.length); k > 0; k--) {
    if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  }
  return a + b;
}

function startsWithHeader(text: string): boolean {
  const m = diaryHeaderRegex().exec(text);
  return m !== null && m.index === 0;
}

export interface LoadedBlocks {
  blocks: FilterBlock[];
  /** `memory_chunks` rows read. */
  chunks: number;
  /** Blocks rebuilt from several sub-chunk windows. */
  stitched: number;
  /** Blocks seen again under another path (same content hash): kept once. */
  duplicates: number;
}

/**
 * The agent's diary blocks from `memory_chunks` (`agent` null = legacy, the
 * NULL-agent rows): per path in ordinal order, a chunk that opens with a diary
 * header starts a block and any other chunk continues the current one (the
 * indexer's sub-split windows of an oversized block, or of a header-less
 * leading/legacy segment). Each rebuilt block is split as the filter surfaces
 * split a file, so its date, room and content hash are the live ones.
 */
export function loadDiaryBlocks(db: Database.Database, agent: string | null): LoadedBlocks {
  const rows = db
    .prepare(
      `select path, text from memory_chunks
        where agent is ? and source = 'memory'
        order by path, ordinal, rowid`,
    )
    .iterate(agent) as IterableIterator<{ path: string; text: string }>;
  const out: LoadedBlocks = { blocks: [], chunks: 0, stitched: 0, duplicates: 0 };
  const seen = new Set<string>();
  let current: { path: string; text: string; windows: number } | null = null;
  const flush = () => {
    if (!current) return;
    if (current.windows > 1) out.stitched += 1;
    for (const b of splitFileBlocks(current.path, current.text)) {
      if (seen.has(b.contentHash)) {
        out.duplicates += 1;
        continue;
      }
      seen.add(b.contentHash);
      // Offsets are relative to the rebuilt block, not the file: dropped.
      const { start: _s, end: _e, ...block } = b;
      out.blocks.push(block);
    }
    current = null;
  };
  for (const row of rows) {
    out.chunks += 1;
    if (current && current.path === row.path && !startsWithHeader(row.text)) {
      current.text = joinWindows(current.text, row.text);
      current.windows += 1;
      continue;
    }
    flush();
    current = { path: row.path, text: row.text, windows: 1 };
  }
  flush();
  return out;
}

/** Time scope, as the filter service applies it (`after` inclusive, `before` exclusive; no entry time = out). */
export function inFilterScope(f: ResolvedMemoryFilter, entryTs: number | null): boolean {
  if (!f.after && !f.before) return true;
  if (entryTs === null) return false;
  if (f.after) {
    const a = filterBoundTs(f.after);
    if (a !== null && entryTs < a) return false;
  }
  if (f.before) {
    const b = filterBoundTs(f.before);
    if (b !== null && entryTs >= b) return false;
  }
  return true;
}

/** The mechanical pre-gate of a judged filter (true when it has none). */
export function passesPreGate(f: ResolvedMemoryFilter, text: string): boolean {
  if (!f.keywordRe && f.patterns.length === 0) return true;
  if (f.keywordRe && text.match(f.keywordRe)) return true;
  return f.patterns.some((p) => text.match(p) !== null);
}

/** The enrichment set: case-insensitive substrings and regular expressions. */
export interface Enrichment {
  keywords: string[];
  patterns: RegExp[];
}

export function matchesEnrichment(enrich: Enrichment, text: string): boolean {
  if (enrich.keywords.length > 0) {
    const lower = text.toLowerCase();
    if (enrich.keywords.some((k) => lower.includes(k.toLowerCase()))) return true;
  }
  return enrich.patterns.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

export interface FilterItem {
  /** `block:<content hash prefix>`: never content. */
  id: string;
  stratum: Stratum;
  block: FilterBlock;
}

export interface FilterSample {
  items: FilterItem[];
  /** Diary blocks of the agent. */
  blocks: number;
  chunks: number;
  stitched: number;
  duplicates: number;
  /** Excluded: outside the filter's time scope / missing its pre-gate (never judged live). */
  outOfScope: number;
  preGateMiss: number;
  /** Blocks the filter judges live (the population). */
  eligible: number;
  /** Stratum populations and how many of each were sampled. */
  population: Record<Stratum, number>;
  sampled: Record<Stratum, number>;
}

/** A seeded sample of `n` (all when n >= length), in a stable order. */
function seededPick<T extends { contentHash: string }>(items: T[], n: number, rand: () => number): T[] {
  const sorted = [...items].sort((a, b) => (a.contentHash < b.contentHash ? -1 : a.contentHash > b.contentHash ? 1 : 0));
  if (n >= sorted.length) return sorted;
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (sorted.length - i));
    [sorted[i], sorted[j]] = [sorted[j]!, sorted[i]!];
  }
  return sorted.slice(0, n);
}

/**
 * Stratified sample over the blocks the filter judges: every enriched block
 * (or a seeded `enrichMax` of them) and a seeded `sample` of the rest.
 */
export function sampleFilterBlocks(
  loaded: LoadedBlocks,
  filter: ResolvedMemoryFilter,
  opts: { enrich: Enrichment; sample: number; seed: number; enrichMax?: number },
): FilterSample {
  let outOfScope = 0;
  let preGateMiss = 0;
  const enriched: FilterBlock[] = [];
  const rest: FilterBlock[] = [];
  for (const b of loaded.blocks) {
    if (!inFilterScope(filter, b.entryTs)) {
      outOfScope += 1;
      continue;
    }
    if (!passesPreGate(filter, b.text)) {
      preGateMiss += 1;
      continue;
    }
    (matchesEnrichment(opts.enrich, b.text) ? enriched : rest).push(b);
  }
  const rand = seededRandom(opts.seed);
  const pickedEnriched = seededPick(enriched, opts.enrichMax && opts.enrichMax > 0 ? opts.enrichMax : enriched.length, rand);
  const pickedRest = seededPick(rest, Math.max(0, opts.sample), rand);
  const item = (stratum: Stratum) => (block: FilterBlock): FilterItem => ({
    id: `block:${block.contentHash.slice(0, 16)}`,
    stratum,
    block,
  });
  return {
    items: [...pickedEnriched.map(item("enriched")), ...pickedRest.map(item("rest"))],
    blocks: loaded.blocks.length,
    chunks: loaded.chunks,
    stitched: loaded.stitched,
    duplicates: loaded.duplicates,
    outOfScope,
    preGateMiss,
    eligible: enriched.length + rest.length,
    population: { enriched: enriched.length, rest: rest.length },
    sampled: { enriched: pickedEnriched.length, rest: pickedRest.length },
  };
}

// ---------------------------------------------------------------------------
// The live question
// ---------------------------------------------------------------------------

/** The point input the live filter service builds for a block (cleaned text, agent-timezone date). */
export function filterInputOf(block: FilterBlock, question: MemoryFilterQuestion): MemoryFilterInput {
  return {
    entry: {
      date: block.entryTs !== null ? agentDateStamp(block.entryTs) : "unknown",
      room: block.room,
      text: cleanBlockText(block.text).lines.join("\n"),
    },
    filters: [question],
    meta: { citation: "", contentHash: block.contentHash, surface: "calibration" },
  };
}

/** Point settings of a calibration call (no calibration overrides: raw probabilities). */
function calibrationSettings(settings: Pick<PointSettings, "timeoutMs" | "stateMaxTokens" | "minStateTokens">, model: string): PointSettings {
  return {
    point: "memory",
    model,
    timeoutMs: settings.timeoutMs,
    stateMaxTokens: settings.stateMaxTokens,
    minStateTokens: settings.minStateTokens,
    minConfidence: 0,
    calibration: {},
    persona: "",
  };
}

/** The labelling call for one block: the live filter question's wording as the definition. */
export function filterLabelRequest(itemId: string, filter: ResolvedMemoryFilter, block: FilterBlock): LabelRequest {
  const question = toQuestion(filter);
  const input = filterInputOf(block, question);
  const q = memoryFilterPoint.questions(input, calibrationSettings({ timeoutMs: 0, stateMaxTokens: 0, minStateTokens: 0 }, "labeller"))[
    filterQuestionId(filter.key)
  ]!;
  // The live question's criteria are the filter's examples (strings).
  const examples = (q.criteria ?? {}) as { true?: unknown; false?: unknown };
  const extra = (v: unknown) => (typeof v === "string" && v ? ` ${v}` : "");
  const criteria =
    `- true: \`entry\` matches the description.${extra(examples.true)}\n` +
    `- false: \`entry\` does not match it, or matches only a word or a loosely related theme.${extra(examples.false)}`;
  const state = { entry: { date: input.entry.date, ...(input.entry.room ? { room: input.entry.room } : {}), text: input.entry.text } };
  const prompt =
    `Check: memory_filter ${filter.key} (memory). Whether an entry from the assistant's own diary matches an ` +
    "operator's filter description (matching entries are kept out of the assistant's context).\n\n" +
    `Statement about the item:\n${q.instructions}\n\nCriteria:\n${criteria}\n\n` +
    "Reasons: when true, matches_definition; when false, near_miss (close to the description but not it) or " +
    "does_not_match; when the entry does not show it either way, label unsure with insufficient_context.\n\n" +
    "The item (JSON; field names refer to it):\n" +
    `${JSON.stringify(state)}\n\n` +
    "Call submit_label now. Do not reproduce any of the item's content.";
  return { itemId, systemPrompt: LABELLER_SYSTEM_PROMPT, prompt, tool: labelTool(FILTER_LABEL_REASONS), reasons: FILTER_LABEL_REASONS };
}

/** Token and cost totals of one side (labeller or judge). */
export interface UsageTotals {
  calls: number;
  /** Calls whose response carried no usage. */
  noUsage: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const emptyUsage = (): UsageTotals => ({ calls: 0, noUsage: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

/** Usage of a pi-ai assistant message (`usage.input`, `usage.output`, `usage.cost.total`); never its text. */
export function addLabellerUsage(totals: UsageTotals, response: unknown): void {
  totals.calls += 1;
  const usage = response && typeof response === "object" ? (response as { usage?: unknown }).usage : undefined;
  if (!usage || typeof usage !== "object") {
    totals.noUsage += 1;
    return;
  }
  const u = usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  totals.inputTokens += n(u.input) + n(u.cacheRead) + n(u.cacheWrite);
  totals.outputTokens += n(u.output);
  totals.costUsd += n(u.cost?.total);
}

export interface JudgeUsage extends UsageTotals {
  /** Billed attempts (a 2xx response, parsed or not), all members. */
  billedAttempts: number;
  /** Answers per serving member (logical id). */
  servedBy: Record<string, number>;
}

/** P(the block matches the filter) from the judge, or undefined (no answer). */
export type FilterJudge = (block: FilterBlock) => Promise<number | undefined>;

/**
 * Ask the live filter question about a block: `memoryFilterPoint` over the
 * cleaned block with only this filter's question, the head's chain (only the
 * head unless `chain`), the point's timeout and state budget. Usage and cost
 * accumulate in `usage`.
 */
export function createFilterJudge(opts: {
  client: DecisionClient;
  chainHead: string;
  filter: ResolvedMemoryFilter;
  settings: Pick<PointSettings, "timeoutMs" | "stateMaxTokens" | "minStateTokens">;
  chain?: boolean;
  usage: JudgeUsage;
}): FilterJudge {
  const settings = calibrationSettings(opts.settings, opts.chainHead);
  const question = toQuestion(opts.filter);
  const usage = opts.usage;
  return async (block) => {
    const input = filterInputOf(block, question);
    usage.calls += 1;
    const result = await opts.client.decide(
      opts.chainHead,
      {
        questions: memoryFilterPoint.questions(input, settings),
        state: (budget) => memoryFilterPoint.state(input, budget),
        stateMaxTokens: settings.stateMaxTokens,
        minStateTokens: settings.minStateTokens,
        stateShape: "object",
      },
      {
        consumer: "decision:calibration",
        priority: "background",
        timeoutMs: settings.timeoutMs,
        ...(opts.chain ? {} : { isModelAvailable: (id: string) => id === opts.chainHead }),
        onBilled: (attempt: BilledAttempt) => {
          usage.billedAttempts += 1;
          usage.inputTokens += attempt.inputTokens;
          usage.outputTokens += attempt.outputTokens;
          usage.costUsd += attempt.costUsd;
        },
      },
    );
    const verdict = memoryFilterPoint.resolve(result.answers, input, (_name, value) => value, settings);
    const p = verdict?.filters?.[opts.filter.key]?.probability;
    if (typeof p === "number") usage.servedBy[result.logicalId] = (usage.servedBy[result.logicalId] ?? 0) + 1;
    return p;
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface FilterRow {
  id: string;
  stratum: Stratum;
  label: Label | "invalid";
  reason: string | null;
  probability: number | null;
}

/** Hidden counts at a threshold: sampled per stratum, and estimated for each stratum's population. */
export interface HiddenRow {
  threshold: number;
  sampled: Record<Stratum, number>;
  estimated: Record<Stratum, number>;
  /** Estimated hidden blocks of the whole population, and their share of it. */
  population: number;
  share: number | null;
}

export interface StratumSummary {
  population: number;
  sampled: number;
  true: number;
  false: number;
  unsure: number;
  invalid: number;
  unscored: number;
  /** population / usable rows (labelled true or false, scored); null when none. */
  weight: number | null;
  /** population / scored rows (any label): the weight of the hidden-count estimate. */
  hiddenWeight: number | null;
}

const usable = (r: FilterRow) => (r.label === "true" || r.label === "false") && r.probability !== null;

export function stratumSummaries(rows: readonly FilterRow[], population: Record<Stratum, number>): Record<Stratum, StratumSummary> {
  const out = {} as Record<Stratum, StratumSummary>;
  for (const s of STRATA) {
    const inS = rows.filter((r) => r.stratum === s);
    const n = inS.filter(usable).length;
    const scored = inS.filter((r) => r.probability !== null).length;
    const pop = population[s];
    out[s] = {
      population: pop,
      sampled: inS.length,
      true: inS.filter((r) => r.label === "true").length,
      false: inS.filter((r) => r.label === "false").length,
      unsure: inS.filter((r) => r.label === "unsure").length,
      invalid: inS.filter((r) => r.label === "invalid").length,
      unscored: inS.filter((r) => r.probability === null).length,
      weight: n > 0 ? pop / n : null,
      hiddenWeight: scored > 0 ? pop / scored : null,
    };
  }
  return out;
}

/** Population-weighted precision/recall/F1 per threshold (stratum weights). */
export function populationThresholds(
  rows: readonly FilterRow[],
  summaries: Record<Stratum, StratumSummary>,
  thresholds: readonly number[],
): WeightedThresholdRow[] {
  const weights = STRATA.map((s) => summaries[s].weight);
  return weightedThresholdTable(
    rows.map((r) => ({ ...r, band: STRATA.indexOf(r.stratum), recorded: 0 })),
    weights,
    thresholds,
  );
}

/** Blocks hidden at each threshold: sampled counts, and estimates over each stratum's population. */
export function hiddenTable(
  rows: readonly FilterRow[],
  summaries: Record<Stratum, StratumSummary>,
  thresholds: readonly number[],
): HiddenRow[] {
  const total = STRATA.reduce((a, s) => a + summaries[s].population, 0);
  return [...new Set(thresholds.map(round3))]
    .sort((a, b) => a - b)
    .map((t) => {
      const sampled = { enriched: 0, rest: 0 } as Record<Stratum, number>;
      for (const r of rows) if (r.probability !== null && r.probability >= t) sampled[r.stratum] += 1;
      const estimated = {} as Record<Stratum, number>;
      for (const s of STRATA) estimated[s] = round3(sampled[s] * (summaries[s].hiddenWeight ?? 0));
      const population = round3(STRATA.reduce((a, s) => a + estimated[s], 0));
      return { threshold: t, sampled, estimated, population, share: total > 0 ? round3(population / total) : null };
    });
}

function bestF1Of<T extends { threshold: number; f1: number | null }>(rows: readonly T[]): T | null {
  let best: T | null = null;
  for (const t of rows) {
    if (t.f1 === null) continue;
    if (!best || t.f1 > best.f1! || (t.f1 === best.f1 && t.threshold > best.threshold)) best = t;
  }
  return best;
}

export interface FilterCalibrationReport {
  mode: "filter";
  filter: string;
  agent: string | null;
  configuredThreshold: number;
  /** Where a calibrated value goes: the filter's `threshold`, or a per-member override. */
  calibrationKey: { member: string; key: string };
  labeller: { model: string; host: string };
  judge: { head: string; host: string; chain: boolean; members: string[] };
  enrichment: { keywords: number; patterns: number; max: number | null };
  population: Omit<FilterSample, "items" | "population" | "sampled">;
  strata: Record<Stratum, StratumSummary>;
  rows: FilterRow[];
  counts: { items: number; true: number; false: number; unsure: number; invalid: number; unscored: number };
  /** Raw tables over each stratum's sampled rows. */
  thresholdsByStratum: Record<Stratum, ThresholdRow[]>;
  /** Population estimates (stratum weights). */
  thresholds: WeightedThresholdRow[];
  hidden: HiddenRow[];
  histograms: Record<Stratum, HistogramBin[]>;
  suggested: {
    bestF1: WeightedThresholdRow | null;
    precisionTarget: number;
    atPrecisionTarget: WeightedThresholdRow | null;
    configured: WeightedThresholdRow;
  };
  usage: { labeller: UsageTotals; judge: JudgeUsage };
}

export interface FilterCalibrationOptions {
  sample: FilterSample;
  filter: ResolvedMemoryFilter;
  agent: string | null;
  /** The head member's effective threshold today (its override, else the filter's). */
  configuredThreshold?: number;
  thresholds?: readonly number[];
  targetPrecision?: number;
  concurrency?: number;
  enrichment: { keywords: number; patterns: number; max: number | null };
  labeller: Labeller;
  judge: FilterJudge;
  /** The judge's usage accumulator (filled by createFilterJudge). */
  judgeUsage: JudgeUsage;
  labellerInfo: { model: string; host: string };
  judgeInfo: { head: string; host: string; chain: boolean; members: string[] };
}

export function newJudgeUsage(): JudgeUsage {
  return { ...emptyUsage(), billedAttempts: 0, servedBy: {} };
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

/** Label, judge and aggregate the sampled blocks. Never returns content. */
export async function runFilterCalibration(opts: FilterCalibrationOptions): Promise<FilterCalibrationReport> {
  const labellerUsage = emptyUsage();
  const rows: FilterRow[] = new Array(opts.sample.items.length);
  await runPool(opts.sample.items, opts.concurrency ?? 2, async (item, index) => {
    let parsed: ParsedLabel;
    try {
      const response = await opts.labeller(filterLabelRequest(item.id, opts.filter, item.block));
      addLabellerUsage(labellerUsage, response);
      parsed = parseLabelResponse(response, FILTER_LABEL_REASONS);
    } catch (error) {
      if (error instanceof CalibrationAbortError) throw error;
      parsed = { label: "invalid", reason: null };
    }
    let probability: number | null = null;
    try {
      const p = await opts.judge(item.block);
      probability = typeof p === "number" && Number.isFinite(p) ? round3(p) : null;
    } catch (error) {
      if (error instanceof CalibrationAbortError) throw error;
      probability = null;
    }
    rows[index] = { id: item.id, stratum: item.stratum, label: parsed.label, reason: parsed.reason, probability };
  });

  const configuredThreshold = round3(opts.configuredThreshold ?? opts.filter.threshold);
  const candidates = [...(opts.thresholds ?? DEFAULT_CANDIDATE_THRESHOLDS), configuredThreshold];
  const strata = stratumSummaries(rows, opts.sample.population);
  const thresholds = populationThresholds(rows, strata, candidates);
  const targetPrecision = opts.targetPrecision ?? 0.9;
  const atPrecisionTarget = thresholds.find((t) => t.wtp > 0 && t.precision !== null && t.precision >= targetPrecision) ?? null;
  const count = (l: Label | "invalid") => rows.filter((r) => r.label === l).length;
  const { items: _items, population: _p, sampled: _s, ...population } = opts.sample;
  const judgeUsage = { ...opts.judgeUsage, costUsd: round6(opts.judgeUsage.costUsd) };
  return {
    mode: "filter",
    filter: opts.filter.key,
    agent: opts.agent,
    configuredThreshold,
    calibrationKey: { member: opts.judgeInfo.head, key: `memory.filter.${opts.filter.key}` },
    labeller: opts.labellerInfo,
    judge: opts.judgeInfo,
    enrichment: opts.enrichment,
    population,
    strata,
    rows,
    counts: {
      items: rows.length,
      true: count("true"),
      false: count("false"),
      unsure: count("unsure"),
      invalid: count("invalid"),
      unscored: rows.filter((r) => r.probability === null).length,
    },
    thresholdsByStratum: {
      enriched: thresholdTable(rows.filter((r) => r.stratum === "enriched").map((r) => ({ ...r, labelSource: "labeller" as const })), candidates),
      rest: thresholdTable(rows.filter((r) => r.stratum === "rest").map((r) => ({ ...r, labelSource: "labeller" as const })), candidates),
    },
    thresholds,
    hidden: hiddenTable(rows, strata, candidates),
    histograms: {
      enriched: scoreHistogram(rows.filter((r) => r.stratum === "enriched").map((r) => ({ ...r, labelSource: "labeller" as const }))),
      rest: scoreHistogram(rows.filter((r) => r.stratum === "rest").map((r) => ({ ...r, labelSource: "labeller" as const }))),
    },
    suggested: {
      bestF1: bestF1Of(thresholds),
      precisionTarget: targetPrecision,
      atPrecisionTarget,
      configured: thresholds.find((t) => t.threshold === configuredThreshold)!,
    },
    usage: { labeller: { ...labellerUsage, costUsd: round6(labellerUsage.costUsd) }, judge: judgeUsage },
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const fmt = (n: number | null) => (n === null ? "-" : n.toFixed(3));

/**
 * The JSON output: ids, strata, labels and probabilities per item, plus the
 * aggregates. No reasons per item, no block text.
 */
export function filterReportJson(report: FilterCalibrationReport): string {
  const { rows, ...aggregates } = report;
  return `${JSON.stringify(
    { ...aggregates, rows: rows.map((r) => ({ id: r.id, stratum: r.stratum, label: r.label, probability: r.probability })) },
    null,
    2,
  )}\n`;
}

function usageLine(name: string, u: UsageTotals): string {
  return `${name}: calls ${u.calls}  input ${u.inputTokens}  output ${u.outputTokens}  cost $${u.costUsd.toFixed(4)}${u.noUsage ? `  no usage ${u.noUsage}` : ""}`;
}

/** The plain-text report: aggregates only (no per-item lines, never block text). */
export function formatFilterReport(report: FilterCalibrationReport): string {
  const lines: string[] = [];
  const p = report.population;
  lines.push(`filter ${report.filter}  agent ${report.agent ?? "-"}  configured threshold ${fmt(report.configuredThreshold)}`);
  lines.push(
    `labeller ${report.labeller.model} @ ${report.labeller.host}  judge ${report.judge.head} @ ${report.judge.host}` +
      (report.judge.chain ? `  chain ${report.judge.members.join(" > ")}` : "  (head only)"),
  );
  lines.push(
    `blocks ${p.blocks} (chunks ${p.chunks}, stitched ${p.stitched}, duplicates ${p.duplicates})  out of time scope ${p.outOfScope}  ` +
      `pre-gate miss ${p.preGateMiss}  eligible ${p.eligible}`,
  );
  const e = report.enrichment;
  lines.push(`enrichment keywords ${e.keywords}  patterns ${e.patterns}${e.max ? `  max ${e.max}` : ""}`);
  lines.push("");
  lines.push("strata (stratum population sampled true false unsure invalid unscored weight)");
  for (const s of STRATA) {
    const x = report.strata[s];
    lines.push(`  ${s} ${x.population} ${x.sampled} ${x.true} ${x.false} ${x.unsure} ${x.invalid} ${x.unscored} ${fmt(x.weight)}`);
  }
  for (const s of STRATA) {
    lines.push("");
    lines.push(`thresholds, ${s} stratum (t tp fp fn tn precision recall f1)`);
    for (const t of report.thresholdsByStratum[s]) {
      lines.push(`  ${t.threshold.toFixed(3)} ${t.tp} ${t.fp} ${t.fn} ${t.tn} ${fmt(t.precision)} ${fmt(t.recall)} ${fmt(t.f1)}`);
    }
  }
  lines.push("");
  lines.push("thresholds, population-weighted (t precision recall f1 | weighted tp fp fn tn)");
  for (const t of report.thresholds) {
    lines.push(
      `  ${t.threshold.toFixed(3)} ${fmt(t.precision)} ${fmt(t.recall)} ${fmt(t.f1)} | ${t.wtp.toFixed(1)} ${t.wfp.toFixed(1)} ${t.wfn.toFixed(1)} ${t.wtn.toFixed(1)}`,
    );
  }
  lines.push("");
  lines.push("hidden blocks (t | sampled enriched rest | estimated enriched rest | population share)");
  for (const h of report.hidden) {
    lines.push(
      `  ${h.threshold.toFixed(3)} | ${h.sampled.enriched} ${h.sampled.rest} | ${h.estimated.enriched.toFixed(1)} ${h.estimated.rest.toFixed(1)} | ` +
        `${h.population.toFixed(1)} ${h.share === null ? "-" : `${(h.share * 100).toFixed(1)}%`}`,
    );
  }
  for (const s of STRATA) {
    lines.push("");
    lines.push(`histogram, ${s} stratum (bin positive negative unsure)`);
    for (const b of report.histograms[s]) lines.push(`  ${b.from.toFixed(1)}-${b.to.toFixed(1)} ${b.positive} ${b.negative} ${b.unsure}`);
  }
  lines.push("");
  const c = report.counts;
  lines.push(`labels true ${c.true}  false ${c.false}  unsure ${c.unsure}  invalid ${c.invalid}  unscored ${c.unscored}  items ${c.items}`);
  const s = report.suggested;
  lines.push(
    `suggested best F1 (population): ${s.bestF1 ? `${s.bestF1.threshold.toFixed(3)} (precision ${fmt(s.bestF1.precision)}, recall ${fmt(s.bestF1.recall)})` : "-"}`,
  );
  lines.push(
    `suggested lowest with precision >= ${s.precisionTarget}: ${s.atPrecisionTarget ? `${s.atPrecisionTarget.threshold.toFixed(3)} (recall ${fmt(s.atPrecisionTarget.recall)})` : "-"}`,
  );
  lines.push(`configured ${s.configured.threshold.toFixed(3)}: precision ${fmt(s.configured.precision)}, recall ${fmt(s.configured.recall)}`);
  const value = s.atPrecisionTarget ? s.atPrecisionTarget.threshold.toFixed(3) : "-";
  lines.push(`set: [retrieval.filters.${report.filter}] threshold = ${value}`);
  const member = /^[A-Za-z0-9_-]+$/.test(report.calibrationKey.member) ? report.calibrationKey.member : JSON.stringify(report.calibrationKey.member);
  lines.push(`  or per member: [decisions.calibration.${member}] "${report.calibrationKey.key}" = ${value}`);
  lines.push("");
  lines.push(usageLine("labeller", report.usage.labeller));
  const j = report.usage.judge;
  lines.push(
    `${usageLine("judge", j)}  billed attempts ${j.billedAttempts}  served ${Object.entries(j.servedBy).map(([k, v]) => `${k}=${v}`).join(" ") || "-"}`,
  );
  return `${lines.join("\n")}\n`;
}
