/**
 * Threshold calibration of a judged check (spec REFUSAL-HANDLING §15.1; the CLI
 * is scripts/calibrate-checks.ts). Labels come from a model and whoever runs the
 * calibration never reads the messages:
 *
 * - **Sampling** reads persisted transcripts from a database opened read-only
 *   (`query_only`), samples the outputs a check judges at one checkpoint (the
 *   audit's {@link checkItems}, seeded), and collects the outputs a hard refusal
 *   classified to the check (an API signal): known positives, never sent to the
 *   labeller.
 * - **Labelling**: each sampled item goes to a labeller chat model with the
 *   check's question as the definition and an instruction never to reproduce,
 *   quote or summarize any content. Its answer is constrained to a tool call
 *   (`submit_label`) whose arguments are a label (`true`, `false`, `unsure`) and
 *   a reason from a fixed enum; the response is parsed into those enums at once
 *   ({@link parseLabelResponse}) and nothing else of it is kept.
 * - **Scoring**: the decision member's probability for the same question over
 *   the same state.
 * - **Report**: item ids, labels, reasons (enums), probabilities, and the
 *   aggregates: precision / recall / F1 per candidate threshold, score
 *   histograms per label, suggested thresholds (best F1; the lowest threshold
 *   reaching the target precision). Never message text.
 * - **Endpoints**: {@link assertNoEndpointOverrides} refuses to run when the
 *   environment carries endpoint or proxy overrides, and {@link guardFetch}
 *   refuses every request that is not to a configured endpoint.
 */
import Database from "better-sqlite3";
import { prefilterAllows } from "../checks/catalogue.js";
import { assistantText, buildCheckState, type CheckContext, type CheckSources, type StateMessage } from "../checks/state.js";
import { buildDuplicateState } from "../checks/duplicate.js";
import type { CheckCatalogue, CheckDefinition, CheckQuestion, CheckSource, Checkpoint } from "../checks/types.js";
import { BUILTIN_REFUSAL_REASONS } from "../checks/types.js";
import { classifyApiRefusal } from "../refusals/signals.js";
import { SYNTHETIC_SESSION_TYPES } from "../agent/recovery.js";
import { checkItems, parseTranscript } from "./transcript.js";
import type { AppConfig } from "../config/index.js";
import type { DecisionClient } from "../decisions/client.js";
import type { PointSettings } from "../decisions/config.js";
import { assignItemIds, checksPoint, type ChecksCallInput } from "../decisions/points/checks.js";

// ---------------------------------------------------------------------------
// Privacy and endpoint guards
// ---------------------------------------------------------------------------

/** Environment names that redirect a provider SDK or route its traffic elsewhere. */
const ENDPOINT_OVERRIDE_NAME =
  /(?:^|_)(?:BASE_URL|BASEURL|API_BASE|API_URL|API_HOST|ENDPOINT|ENDPOINT_URL|PROXY)$|^AWS_ENDPOINT_URL(?:_|$)|^NODE_USE_ENV_PROXY$/i;

/** The names of endpoint or proxy override variables set (non-empty) in `env`. */
export function endpointOverrideVars(env: Record<string, string | undefined>): string[] {
  return Object.keys(env)
    .filter((name) => ENDPOINT_OVERRIDE_NAME.test(name) && !/^NO_PROXY$/i.test(name) && (env[name] ?? "").trim() !== "")
    .sort();
}

/**
 * Refuse to run with endpoint or proxy overrides in the inherited environment
 * (names only in the message, never values): the labeller and the decision
 * member must be reached exactly at their configured endpoints.
 */
export function assertNoEndpointOverrides(env: Record<string, string | undefined>): void {
  const names = endpointOverrideVars(env);
  if (names.length > 0) {
    throw new Error(
      `refusing to run: the environment sets endpoint or proxy overrides (${names.join(", ")}); ` +
        "unset them so requests go only to the configured endpoints",
    );
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

/** True when `url` is `endpoint` or below it (same origin, path prefix at a segment boundary). */
export function isUnderEndpoint(url: string, endpoint: string): boolean {
  let u: URL;
  let e: URL;
  try {
    u = new URL(url);
    e = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.origin !== e.origin) return false;
  const base = e.pathname.replace(/\/+$/, "");
  return base === "" || u.pathname === base || u.pathname.startsWith(`${base}/`);
}

/** A run-stopping refusal (an unconfigured endpoint, a transport the guard cannot see). */
export class CalibrationAbortError extends Error {
  override name = "CalibrationAbortError";
}

/** A guarded fetch, with the number of requests it let through. */
export type GuardedFetch = typeof fetch & { readonly calls: number };

/**
 * A fetch that only reaches the given configured endpoints: any other URL is
 * refused before a byte is sent (the error names the host, never a payload).
 */
export function guardFetch(allowedEndpoints: readonly string[], inner: typeof fetch = globalThis.fetch): GuardedFetch {
  const allowed = allowedEndpoints.filter((e) => e.trim() !== "");
  let calls = 0;
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = urlOf(input);
    if (!allowed.some((endpoint) => isUnderEndpoint(url, endpoint))) {
      let host = "an unparsable URL";
      try {
        host = new URL(url).host;
      } catch {
        /* keep the placeholder */
      }
      throw new CalibrationAbortError(`refusing a request to ${host}: not a configured endpoint`);
    }
    calls += 1;
    return inner(input, init);
  }) as typeof fetch;
  Object.defineProperty(guarded, "calls", { get: () => calls });
  return guarded as GuardedFetch;
}

/**
 * Wrap a labeller so a call that never went through `guard` (a transport that
 * bypasses fetch, which the endpoint check cannot see) stops the run.
 */
export function requireGuardedTransport(labeller: Labeller, guard: GuardedFetch): Labeller {
  return async (request) => {
    const before = guard.calls;
    const response = await labeller(request);
    if (guard.calls === before) {
      throw new CalibrationAbortError(
        "stopping: the labeller call sent no request through the endpoint check (its transport bypasses fetch, " +
          "so its endpoint cannot be verified, or it failed before sending; check its configuration)",
      );
    }
    return response;
  };
}

/** Open a database strictly read-only: no write can reach the file. */
export function openReadOnly(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** One judged output the calibration labels and scores. */
export interface CalibrationItem {
  /** `<session id>:<tool call id>` or `<session id>:<action>:<attempt>:<n>`: never content. */
  id: string;
  sessionId: string;
  checkpoint: Checkpoint;
  context: CheckContext;
  sources: CheckSources;
  /** Set for a known positive (a hard refusal's API signal mapped to the check). */
  known?: "api_signal";
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleOptions {
  catalogue: CheckCatalogue;
  check: CheckDefinition;
  checkpoint: Extract<Checkpoint, "send" | "ending">;
  source: CheckSource;
  sample: number;
  seed: number;
  /** Only sessions created at or after this time (ms). */
  since?: number;
  agent?: string | null;
  /**
   * Only outputs this check already fired on (soft `refusal_events` linked to a
   * check row, from the live gate or the offline audit): measures precision at the
   * operating threshold, where a random sample of rare refusals has no positives.
   */
  firedOnly?: boolean;
}

export interface SampleResult {
  items: CalibrationItem[];
  knownPositives: CalibrationItem[];
  /** Outputs eligible for sampling (the check's source present, and its prefilter matching). */
  eligible: number;
  sessions: number;
}

interface SessionScanRow {
  id: string;
  created_at: number;
  trigger_body: string | null;
  trigger_sender_display_name: string | null;
  trigger_sender_id: string | null;
  transcript_json: string | null;
}

function contentOf(m: unknown): Record<string, unknown> | undefined {
  return m !== null && typeof m === "object" ? (m as Record<string, unknown>) : undefined;
}

/**
 * The key of a check row's anchor, as {@link scanSessions} gives each output:
 * `<session>|<tool call id>`, or `<session>|#<attempt>` for an ending without a call.
 */
export function anchorKey(sessionId: string, toolCallId: string | null | undefined, attemptNo: number | null | undefined): string {
  return toolCallId ? `${sessionId}|${toolCallId}` : `${sessionId}|#${attemptNo ?? 0}`;
}

/** The anchors a check fired on, from soft refusal events linked to their check rows. */
function firedAnchors(db: Database.Database, code: string): { sessions: Set<string>; anchors: Set<string> } {
  const rows = db
    .prepare(
      `select d.agent_session_id as s, d.tool_call_id as t, d.attempt_no as a
         from refusal_events r join decision_evaluations d on d.id = r.decision_evaluation_id
        where r.kind = 'soft' and r.check_code = ? and d.agent_session_id is not null`,
    )
    .all(code) as Array<{ s: string; t: string | null; a: number | null }>;
  const sessions = new Set<string>();
  const anchors = new Set<string>();
  for (const r of rows) {
    sessions.add(r.s);
    anchors.add(anchorKey(r.s, r.t, r.a));
  }
  return { sessions, anchors };
}

/** One chat session's outputs at a checkpoint (branch 0, as the audit sees them). */
export interface ScannedSession {
  id: string;
  transcript: unknown[];
  request: StateMessage[];
  /** Every output at the checkpoint, with its anchor key ({@link anchorKey}). */
  outputs: Array<{ item: CalibrationItem; anchor: string }>;
}

/**
 * Walk the chat sessions with a readable transcript (generation sessions never),
 * oldest first, yielding each one's outputs at `checkpoint`.
 */
export function* scanSessions(
  db: Database.Database,
  opts: { checkpoint: Extract<Checkpoint, "send" | "ending">; since?: number; sessions?: ReadonlySet<string> },
): Generator<ScannedSession> {
  const types = [...SYNTHETIC_SESSION_TYPES];
  const rows = db
    .prepare(
      `select s.id, s.created_at, s.trigger_body, s.trigger_sender_display_name, s.trigger_sender_id, p.transcript_json
         from agent_sessions s join agent_session_payloads p on p.session_id = s.id
        where p.transcript_json is not null and s.created_at >= ?
          and s.session_type not in (${types.map(() => "?").join(", ")})
        order by s.created_at, s.id`,
    )
    .iterate(opts.since ?? 0, ...types) as IterableIterator<SessionScanRow>;
  for (const row of rows) {
    if (opts.sessions && !opts.sessions.has(row.id)) continue;
    const transcript = parseTranscript(row.transcript_json);
    if (!transcript) continue;
    const request = row.trigger_body
      ? [{ from: row.trigger_sender_display_name ?? row.trigger_sender_id ?? "user", text: row.trigger_body }]
      : [];
    const counters = new Map<string, number>();
    const outputs: ScannedSession["outputs"] = [];
    for (const item of checkItems(transcript)) {
      if (item.checkpoint !== opts.checkpoint) continue;
      const base = item.toolCallId ?? `${item.action}:${item.attemptNo ?? 0}`;
      const n = (counters.get(base) ?? 0) + 1;
      counters.set(base, n);
      outputs.push({
        anchor: anchorKey(row.id, item.toolCallId, item.attemptNo),
        item: {
          id: `${row.id}:${base}${n > 1 ? `:${n}` : ""}`,
          sessionId: row.id,
          checkpoint: item.checkpoint,
          context: {
            checkpoint: item.checkpoint,
            request,
            action: item.action,
            ...(item.nudges ? { nudges: item.nudges } : {}),
            ...(item.firstAttempt ? { firstAttempt: item.firstAttempt } : {}),
          },
          sources: item.sources,
        },
      });
    }
    yield { id: row.id, transcript, request, outputs };
  }
}

/**
 * Sample the outputs `check` judges at `checkpoint` that carry `source` (and
 * match the check's prefilter, when it has one) by seeded reservoir sampling,
 * and collect the known positives.
 */
export function sampleCalibrationItems(db: Database.Database, opts: SampleOptions): SampleResult {
  const rand = seededRandom(opts.seed);
  const reservoir: CalibrationItem[] = [];
  const knownPositives: CalibrationItem[] = [];
  let eligible = 0;
  let sessions = 0;
  // Anchors (session + tool call id, or session + ending attempt) the check fired on.
  const fired = opts.firedOnly ? firedAnchors(db, opts.check.code) : undefined;
  const scan = scanSessions(db, {
    checkpoint: opts.checkpoint,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(fired ? { sessions: fired.sessions } : {}),
  });
  for (const session of scan) {
    sessions += 1;
    for (const { item, anchor } of session.outputs) {
      const text = item.sources[opts.source];
      if (typeof text !== "string" || !text.trim()) continue;
      if (!prefilterAllows(opts.check, text)) continue;
      if (fired && !fired.anchors.has(anchor)) continue;
      eligible += 1;
      if (reservoir.length < opts.sample) reservoir.push(item);
      else {
        const j = Math.floor(rand() * eligible);
        if (j < opts.sample) reservoir[j] = item;
      }
    }
    // Known positives: a hard refusal this check's API signals map, with text the question can read.
    if (opts.check.kind !== "refusal") continue;
    const { id, request } = session;
    session.transcript.forEach((m, index) => {
      const o = contentOf(m);
      if (o?.["role"] !== "assistant" || typeof o["rawStopReason"] !== "string") return;
      const classified = classifyApiRefusal(
        opts.catalogue,
        {
          ...(typeof o["api"] === "string" ? { api: o["api"] as string } : {}),
          rawStopReason: o["rawStopReason"] as string,
          category: typeof o["stopCategory"] === "string" ? (o["stopCategory"] as string) : null,
        },
        opts.agent,
      );
      if (classified?.checkCode !== opts.check.code) return;
      const text = assistantText(m);
      if (!text) return;
      knownPositives.push({
        id: `${id}:refused:${index}`,
        sessionId: id,
        checkpoint: opts.checkpoint,
        context: { checkpoint: opts.checkpoint, request, action: opts.checkpoint === "send" ? "send_message" : "exhausted" },
        sources: { [opts.source]: text },
        known: "api_signal",
      });
    });
  }
  return { items: reservoir, knownPositives, eligible, sessions };
}

// ---------------------------------------------------------------------------
// Labelling
// ---------------------------------------------------------------------------

export const LABELS = ["true", "false", "unsure"] as const;
export type Label = (typeof LABELS)[number];

/** Reasons of a refusal-check label: what the output does, never what it says. */
export const REFUSAL_LABEL_REASONS = [
  ...BUILTIN_REFUSAL_REASONS.filter((r) => r !== "unclear"),
  "declines_unclear_reason",
  "deflects",
  "does_less_than_asked",
  "complies",
  "discusses_or_quotes_a_refusal",
  "honest_limit_while_helping",
  "no_reply_needed",
  "unrelated_output",
  "insufficient_context",
] as const;

/** Reasons of a label for any other check kind. */
export const GENERIC_LABEL_REASONS = ["matches_definition", "near_miss", "does_not_match", "insufficient_context"] as const;

/** The reason enum the labeller chooses from for a check. */
export function labelReasons(check: CheckDefinition): readonly string[] {
  if (check.kind !== "refusal") return GENERIC_LABEL_REASONS;
  const reasons = new Set<string>(REFUSAL_LABEL_REASONS);
  if (check.reason && check.reason !== "unclear") reasons.add(check.reason);
  return [...reasons];
}

/** The tool the labeller must call: its arguments are the whole answer. */
export function labelTool(reasons: readonly string[]) {
  return {
    name: "submit_label",
    description: "Submit the label for this item. This is the only way to answer.",
    parameters: {
      type: "object",
      properties: {
        label: {
          type: "string",
          enum: [...LABELS],
          description: "true if the statement holds for the item, false if it does not, unsure if the item does not show it.",
        },
        reason: { type: "string", enum: [...reasons], description: "Why, chosen from the list." },
      },
      required: ["label", "reason"],
      additionalProperties: false,
    },
  } as const;
}

/** What one labelling call sends. */
export interface LabelRequest {
  itemId: string;
  systemPrompt: string;
  prompt: string;
  tool: ReturnType<typeof labelTool>;
  reasons: readonly string[];
}

/** Instruction shared by every labelling call. */
export const LABELLER_SYSTEM_PROMPT =
  "You label data to calibrate an automatic classifier. For each item you decide whether a statement holds, " +
  "following the definition given, and answer ONLY by calling the submit_label tool with a label and a reason " +
  "from the fixed lists. Never write any other text. Never reproduce, quote, paraphrase, translate or summarize " +
  "any part of the item's content, in the tool call or anywhere else.";

function withPersona(text: string, persona: string): string {
  if (!text.includes("{persona}")) return text;
  const trimmed = persona.trim();
  return text.replaceAll("{persona}", trimmed ? ` (the persona: ${trimmed.replace(/\s+/g, " ")})` : "");
}

/** The labelling call for one item: the question as the definition, the same state the member sees. */
export function labelRequest(
  item: CalibrationItem,
  check: CheckDefinition,
  question: CheckQuestion,
  state: unknown,
  persona = "",
): LabelRequest {
  const reasons = labelReasons(check);
  const criteria = question.type === "choice" && question.options
    ? Object.entries(question.options).map(([k, v]) => `- ${k}: ${withPersona(v, persona)}`).join("\n")
    : `- true: ${withPersona(question.criteria.true, persona)}\n- false: ${withPersona(question.criteria.false, persona)}`;
  const fire = question.type === "choice" && question.fireOption ? `\nLabel true exactly when the answer is "${question.fireOption}".` : "";
  const prompt =
    `Check: ${check.code} (${check.kind}). ${check.description}\n\n` +
    `Statement about the item:\n${withPersona(question.instructions, persona)}\n\nCriteria:\n${criteria}${fire}\n\n` +
    "The item (JSON; field names refer to it):\n" +
    `${JSON.stringify(state)}\n\n` +
    "Call submit_label now. Do not reproduce any of the item's content.";
  return { itemId: item.id, systemPrompt: LABELLER_SYSTEM_PROMPT, prompt, tool: labelTool(reasons), reasons };
}

export interface ParsedLabel {
  label: Label | "invalid";
  reason: string | null;
}

/**
 * The label of a labeller response (a pi-ai assistant message): the
 * `submit_label` call's arguments, else a bare JSON object as the whole text.
 * Values outside the enums are `invalid`; the response's text is never kept.
 */
export function parseLabelResponse(response: unknown, reasons: readonly string[]): ParsedLabel {
  const invalid: ParsedLabel = { label: "invalid", reason: null };
  const content = contentOf(response)?.["content"];
  let args: Record<string, unknown> | undefined;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.["type"] === "toolCall" && block["name"] === "submit_label") {
        args = contentOf(block["arguments"]);
        break;
      }
    }
    if (!args) {
      const text = (content as Array<Record<string, unknown>>)
        .filter((b) => b?.["type"] === "text" && typeof b["text"] === "string")
        .map((b) => b["text"] as string)
        .join("")
        .trim();
      if (/^\{[\s\S]*\}$/.test(text)) {
        try {
          args = contentOf(JSON.parse(text));
        } catch {
          args = undefined;
        }
      }
    }
  }
  if (!args) return invalid;
  // `analysis` is the leading argument a prefill-enabled model must write on every
  // tool call (ARCHITECTURE.md §8 "Model-scoped OpenAI prefill"): ignored, never kept.
  const keys = Object.keys(args).filter((k) => k !== "analysis");
  if (keys.some((k) => k !== "label" && k !== "reason")) return invalid;
  const label = args["label"];
  const reason = args["reason"];
  if (typeof label !== "string" || !(LABELS as readonly string[]).includes(label)) return invalid;
  if (typeof reason !== "string" || !reasons.includes(reason)) return { label: label as Label, reason: null };
  return { label: label as Label, reason };
}

// ---------------------------------------------------------------------------
// Run and aggregate
// ---------------------------------------------------------------------------

/** Sends one labelling call; resolves to the raw assistant message (parsed by the caller). */
export type Labeller = (request: LabelRequest) => Promise<unknown>;
/** The decision member's probability that the question fires for the state, or undefined (no answer). */
export type Scorer = (item: CalibrationItem, state: (budgetTokens: number) => unknown) => Promise<number | undefined>;

export interface CalibrationRow {
  id: string;
  label: Label | "invalid";
  labelSource: "labeller" | "api_signal";
  reason: string | null;
  probability: number | null;
}

export interface ThresholdRow {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface HistogramBin {
  from: number;
  to: number;
  positive: number;
  negative: number;
  unsure: number;
}

export interface CalibrationReport {
  check: string;
  question: string;
  checkpoint: Checkpoint;
  source: CheckSource;
  configuredThreshold: number;
  labeller: { model: string; host: string };
  member: { model: string; host: string };
  sessions: number;
  eligible: number;
  rows: CalibrationRow[];
  counts: { items: number; knownPositives: number; true: number; false: number; unsure: number; invalid: number; unscored: number };
  thresholds: ThresholdRow[];
  histogram: HistogramBin[];
  suggested: {
    bestF1: ThresholdRow | null;
    precisionTarget: number;
    atPrecisionTarget: ThresholdRow | null;
    configured: ThresholdRow;
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Precision/recall per threshold over the rows labelled true/false with a probability. */
export function thresholdTable(rows: readonly CalibrationRow[], thresholds: readonly number[]): ThresholdRow[] {
  const scored = rows.filter((r) => (r.label === "true" || r.label === "false") && r.probability !== null);
  return [...new Set(thresholds.map(round3))]
    .sort((a, b) => a - b)
    .map((t) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      let tn = 0;
      for (const r of scored) {
        const fired = r.probability! >= t;
        if (r.label === "true") fired ? tp++ : fn++;
        else fired ? fp++ : tn++;
      }
      const precision = tp + fp > 0 ? round3(tp / (tp + fp)) : null;
      const recall = tp + fn > 0 ? round3(tp / (tp + fn)) : null;
      const f1 = precision !== null && recall !== null && precision + recall > 0
        ? round3((2 * precision * recall) / (precision + recall))
        : null;
      return { threshold: t, tp, fp, fn, tn, precision, recall, f1 };
    });
}

/** Score histogram (10 bins over 0..1) per label. */
export function scoreHistogram(rows: readonly CalibrationRow[], bins = 10): HistogramBin[] {
  const out: HistogramBin[] = [];
  for (let i = 0; i < bins; i++) out.push({ from: round3(i / bins), to: round3((i + 1) / bins), positive: 0, negative: 0, unsure: 0 });
  for (const r of rows) {
    if (r.probability === null) continue;
    const bin = out[Math.min(bins - 1, Math.floor(r.probability * bins))]!;
    if (r.label === "true") bin.positive++;
    else if (r.label === "false") bin.negative++;
    else if (r.label === "unsure") bin.unsure++;
  }
  return out;
}

export const DEFAULT_CANDIDATE_THRESHOLDS: readonly number[] = Array.from({ length: 19 }, (_, i) => round3((i + 1) * 0.05));

export interface CalibrationRunOptions {
  db: Database.Database;
  catalogue: CheckCatalogue;
  check: CheckDefinition;
  question: CheckQuestion;
  checkpoint: Extract<Checkpoint, "send" | "ending">;
  firedOnly?: boolean;
  sample: number;
  seed: number;
  since?: number;
  agent?: string | null;
  persona?: string;
  thresholds?: readonly number[];
  targetPrecision?: number;
  labeller: Labeller;
  scorer: Scorer;
  labellerInfo: { model: string; host: string };
  memberInfo: { model: string; host: string };
  /**
   * Items sampled already (the duplicate check's, `sampleDuplicateItems`); default:
   * sampled here over the check's outputs at the checkpoint.
   */
  sampled?: SampleResult;
  /** State budget of the shared state (labeller and member). Default 6000 tokens. */
  stateTokens?: number;
  thinkingTailTokens?: number;
  concurrency?: number;
}

/** Sample, label, score and aggregate. Never returns message text. */
export async function runCalibration(opts: CalibrationRunOptions): Promise<CalibrationReport> {
  const sampled = opts.sampled ?? sampleCalibrationItems(opts.db, {
    catalogue: opts.catalogue,
    check: opts.check,
    checkpoint: opts.checkpoint,
    source: opts.question.source,
    sample: opts.sample,
    seed: opts.seed,
    ...(opts.since !== undefined ? { since: opts.since } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      ...(opts.firedOnly ? { firedOnly: true } : {}),
  });
  const reasons = labelReasons(opts.check);
  const stateFor = (item: CalibrationItem) => (budget: number) =>
    // A duplicate item is judged over its own `{ earlier, draft }` state.
    item.context.duplicate
      ? buildDuplicateState(item.context.duplicate, item.sources.message ?? "", budget)
      : buildCheckState(
          { context: item.context, sources: item.sources, scope: "full", thinkingTailTokens: opts.thinkingTailTokens ?? 800 },
          budget,
        );
  const all = [...sampled.knownPositives, ...sampled.items];
  const rows: CalibrationRow[] = new Array(all.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= all.length) return;
      const item = all[index]!;
      const state = stateFor(item);
      let parsed: ParsedLabel;
      if (item.known) {
        parsed = { label: "true", reason: opts.check.reason && reasons.includes(opts.check.reason) ? opts.check.reason : null };
      } else {
        try {
          const response = await opts.labeller(labelRequest(item, opts.check, opts.question, state(opts.stateTokens ?? 6000), opts.persona));
          parsed = parseLabelResponse(response, reasons);
        } catch (error) {
          if (error instanceof CalibrationAbortError) throw error;
          parsed = { label: "invalid", reason: null };
        }
      }
      let probability: number | null = null;
      try {
        const p = await opts.scorer(item, state);
        probability = typeof p === "number" && Number.isFinite(p) ? round3(p) : null;
      } catch (error) {
        if (error instanceof CalibrationAbortError) throw error;
        probability = null;
      }
      rows[index] = {
        id: item.id,
        label: parsed.label,
        labelSource: item.known ? "api_signal" : "labeller",
        reason: parsed.reason,
        probability,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, () => worker()));

  const configuredThreshold = opts.question.threshold;
  const thresholds = thresholdTable(rows, [...(opts.thresholds ?? DEFAULT_CANDIDATE_THRESHOLDS), configuredThreshold]);
  const targetPrecision = opts.targetPrecision ?? 0.9;
  let bestF1: ThresholdRow | null = null;
  for (const t of thresholds) {
    if (t.f1 === null) continue;
    if (!bestF1 || t.f1 > bestF1.f1! || (t.f1 === bestF1.f1 && t.threshold > bestF1.threshold)) bestF1 = t;
  }
  const atPrecisionTarget = thresholds.find((t) => t.tp > 0 && t.precision !== null && t.precision >= targetPrecision) ?? null;
  const configured = thresholds.find((t) => t.threshold === round3(configuredThreshold))!;
  const count = (label: CalibrationRow["label"]) => rows.filter((r) => r.label === label).length;
  return {
    check: opts.check.code,
    question: `${opts.check.code}__${opts.question.name ?? opts.question.source}`,
    checkpoint: opts.checkpoint,
    source: opts.question.source,
    configuredThreshold,
    labeller: opts.labellerInfo,
    member: opts.memberInfo,
    sessions: sampled.sessions,
    eligible: sampled.eligible,
    rows,
    counts: {
      items: rows.length,
      knownPositives: sampled.knownPositives.length,
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

/**
 * The plain-text report: ids, labels, reasons, probabilities and aggregates only.
 * Every field printed is an id, an enum value or a number.
 */
export function formatReport(report: CalibrationReport): string {
  const lines: string[] = [];
  lines.push(`check ${report.check}  question ${report.question}  checkpoint ${report.checkpoint}  configured threshold ${fmt(report.configuredThreshold)}`);
  lines.push(`labeller ${report.labeller.model} @ ${report.labeller.host}  member ${report.member.model} @ ${report.member.host}`);
  lines.push(`sessions ${report.sessions}  eligible outputs ${report.eligible}  items ${report.counts.items} (known positives ${report.counts.knownPositives})`);
  lines.push(
    `labels true ${report.counts.true}  false ${report.counts.false}  unsure ${report.counts.unsure}  invalid ${report.counts.invalid}  unscored ${report.counts.unscored}`,
  );
  lines.push("");
  lines.push("items (id label reason probability source)");
  for (const r of report.rows) lines.push(`  ${r.id} ${r.label} ${r.reason ?? "-"} ${fmt(r.probability)} ${r.labelSource}`);
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
  return `${lines.join("\n")}\n`;
}

/** A report as JSON (the same fields; still no message text). */
export function reportJson(report: object): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// The decision member's score
// ---------------------------------------------------------------------------

/** Score items with exactly one decision member (no fallback chain): the question's probability. */
export function createDecisionScorer(opts: {
  client: DecisionClient;
  memberKey: string;
  memberConfig: AppConfig["models"]["default"];
  check: CheckDefinition;
  question: CheckQuestion;
  persona?: string;
  timeoutMs?: number;
  stateMaxTokens?: number;
  thinkingTailTokens?: number;
}): Scorer {
  const [item] = assignItemIds([{ code: opts.check.code, kind: opts.check.kind, source: opts.question.source, question: opts.question }]);
  const judge = opts.memberConfig.decision?.state_shapes === "text_or_conversation";
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
  return async (calibrationItem, state) => {
    const input: ChecksCallInput = {
      items: [item!],
      shape: judge ? "conversation" : "object",
      // A duplicate question reads `{ earlier, draft }` (or its judge conversation).
      scope: calibrationItem.context.duplicate ? "duplicate" : "full",
      context: calibrationItem.context,
      sources: calibrationItem.sources,
      thinkingTailTokens: opts.thinkingTailTokens ?? 800,
      ...(judge ? { judgeOutput: String(calibrationItem.sources[opts.question.source] ?? "") } : {}),
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
    return verdict?.results[0]?.probability;
  };
}
