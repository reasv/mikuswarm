/**
 * The checks decision point (spec REFUSAL-HANDLING §5.2, §6.2; ARCHITECTURE.md
 * §8h): the judged half of the check catalogue. One evaluation per judged
 * output carries every applicable question of every enabled check; this module
 * turns those questions into decision calls and their answers into per-question
 * results. The gate (src/checks/) decides which questions apply, combines the
 * results per check and records them.
 *
 * - **One call by default.** All questions go in one request over one state.
 * - **Split only when the fits require it** ({@link planCheckCalls}): for the
 *   member the evaluation would reach first, a call it cannot take is split
 *   into parallel calls grouped by state shape (style questions over the message
 *   alone, the rest over the full state), chunked to its `max_questions`. A
 *   judge-only member (`state_shapes = "text_or_conversation"`) gets the
 *   judge-shaped `{ input, output }` call for the questions over its output
 *   sources; questions over other sources go in an object call that the fits
 *   route past it.
 * - **Thresholds** are per question; `[decisions.calibration.<member>]` may
 *   override them per check with `"checks.<code>"` (or a bare `<code>`).
 */
import type { CheckDefinition, CheckKind, CheckQuestion, CheckSource, Checkpoint } from "../../checks/types.js";
import {
  buildCheckState,
  buildJudgeState,
  sourceText,
  type CheckContext,
  type CheckSources,
  type CheckStateScope,
} from "../../checks/state.js";
import type { PointSettings } from "../config.js";
import type { DecisionChainMember, DecisionPoint } from "../registry.js";
import type { DecisionAnswers, DecisionQuestion } from "../types.js";

/** One question of one check, as asked in one evaluation. */
export interface CheckItem {
  /** Question id in the request (`<code>__<source>`, suffixed when repeated). */
  id: string;
  code: string;
  kind: CheckKind;
  source: CheckSource;
  question: CheckQuestion;
}

/** The input of one decision call of a check evaluation. */
export interface ChecksCallInput {
  items: CheckItem[];
  shape: "object" | "conversation";
  /** Object shape: the full state, or the message alone (style split). */
  scope: CheckStateScope;
  context: CheckContext;
  sources: CheckSources;
  thinkingTailTokens: number;
  /** Conversation shape: the judged output. */
  judgeOutput?: string;
}

/** One question's answer against its (calibrated) threshold. */
export interface QuestionResult {
  id: string;
  code: string;
  source: CheckSource;
  /** `noul` probability; for a `choice` question the fire option's probability. */
  probability: number;
  threshold: number;
  fired: boolean;
  /** `choice` questions: the option picked. */
  choice?: string;
}

export interface ChecksCallVerdict {
  results: QuestionResult[];
  /** True for the fallback verdict (no answers). */
  unjudged?: true;
}

/** The sources a judge-only member reads as its `output`, per checkpoint (§5.5). */
export const JUDGE_OUTPUT_SOURCES: Record<Checkpoint, readonly CheckSource[]> = {
  send: ["message"],
  ending: ["analysis", "text"],
  artifact: ["artifact"],
  rollout: ["rollout"],
};

const FIELD_REF = /`([a-z_]+)`/g;

/** Rewrite field references for the judge shape, where state paths do not exist. */
function judgeText(text: string, outputSources: readonly CheckSource[]): string {
  return text.replace(FIELD_REF, (_match, field: string) => {
    if ((outputSources as readonly string[]).includes(field)) return "the assistant's output";
    if (field === "request") return "the user's input";
    return field;
  });
}

function withPersona(text: string, persona: string): string {
  if (!text.includes("{persona}")) return text;
  const trimmed = persona.trim();
  return text.replaceAll("{persona}", trimmed ? ` (the persona: ${trimmed.replace(/\s+/g, " ")})` : "");
}

/** Question ids for items: `<code>__<source>`, with `_2`, `_3`… for repeats. */
export function assignItemIds(items: Array<Omit<CheckItem, "id">>): CheckItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = `${item.code}__${item.source}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...item, id: n === 1 ? base : `${base}_${n}` };
  });
}

export const checksPoint: DecisionPoint<ChecksCallInput, ChecksCallVerdict> = {
  name: "checks",

  questions(input: ChecksCallInput, settings: PointSettings): Record<string, DecisionQuestion> {
    const out: Record<string, DecisionQuestion> = {};
    const judge = input.shape === "conversation";
    const outputSources = JUDGE_OUTPUT_SOURCES[checkpointOf(input)];
    const text = (s: string) => {
      const persona = withPersona(s, settings.persona);
      return judge ? judgeText(persona, outputSources) : persona;
    };
    for (const item of input.items) {
      const q = item.question;
      if (q.type === "choice" && q.options) {
        const criteria: Record<string, string> = {};
        for (const [key, description] of Object.entries(q.options)) criteria[key] = text(description);
        out[item.id] = { type: "choice", instructions: text(q.instructions), criteria };
      } else {
        out[item.id] = {
          type: "noul",
          instructions: text(q.instructions),
          criteria: { true: text(q.criteria.true), false: text(q.criteria.false) },
        };
      }
    }
    return out;
  },

  state(input: ChecksCallInput, budgetTokens: number): unknown {
    if (input.shape === "conversation") {
      return buildJudgeState(input.context, input.judgeOutput ?? "", budgetTokens);
    }
    return buildCheckState(
      { context: input.context, sources: input.sources, scope: input.scope, thinkingTailTokens: input.thinkingTailTokens },
      budgetTokens,
    );
  },

  resolve(answers: DecisionAnswers, input: ChecksCallInput, threshold): ChecksCallVerdict {
    const results: QuestionResult[] = [];
    for (const item of input.items) {
      const answer = answers[item.id];
      if (!answer) continue;
      const t = threshold(item.code, item.question.threshold);
      if (answer.type === "noul") {
        results.push({ id: item.id, code: item.code, source: item.source, probability: answer.noul, threshold: t, fired: answer.noul >= t });
      } else if (answer.type === "choice") {
        const fire = item.question.fireOption;
        const picked = fire !== undefined && answer.choice === fire;
        const probability = fire !== undefined ? (answer.probabilities[fire] ?? (picked ? answer.confidence : 0)) : 0;
        results.push({
          id: item.id,
          code: item.code,
          source: item.source,
          probability,
          threshold: t,
          // DECISION-MODEL §2: a choice threshold reads `confidence`.
          fired: picked && answer.confidence >= t,
          choice: answer.choice,
        });
      }
    }
    return { results };
  },

  fallback(): ChecksCallVerdict {
    return { results: [], unjudged: true };
  },

  describe(verdict: ChecksCallVerdict): unknown {
    if (verdict.unjudged) return { unjudged: true };
    return {
      fired: [...new Set(verdict.results.filter((r) => r.fired).map((r) => r.code))],
      results: verdict.results.map((r) => ({
        id: r.id,
        p: round3(r.probability),
        t: r.threshold,
        ...(r.fired ? { fired: true } : {}),
        ...(r.choice !== undefined ? { choice: r.choice } : {}),
      })),
    };
  },

  stateShape(input: ChecksCallInput): "object" | "conversation" {
    return input.shape;
  },
};

/** The checkpoint a call input belongs to (carried on the context's `action` kind). */
function checkpointOf(input: ChecksCallInput): Checkpoint {
  return input.context.checkpoint ?? "send";
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** One planned call: which items, in which state shape. */
export interface PlannedCall {
  items: CheckItem[];
  shape: "object" | "conversation";
  scope: CheckStateScope;
  judgeOutput?: string;
}

/**
 * Split an evaluation's items into decision calls for the member it would
 * reach first (spec §6.2). Undefined member (point off, chain unusable): one
 * call, so the engine records why it fell back.
 */
export function planCheckCalls(
  items: readonly CheckItem[],
  member: DecisionChainMember | undefined,
  checkpoint: Checkpoint,
  sources: CheckSources,
  checks: ReadonlyMap<string, Pick<CheckDefinition, "kind">>,
): PlannedCall[] {
  if (items.length === 0) return [];
  const fits = member?.config.decision;
  if (!member || !fits) return [{ items: [...items], shape: "object", scope: "full" }];

  const calls: PlannedCall[] = [];
  let rest = [...items];
  if (fits.state_shapes === "text_or_conversation") {
    // The judge member reads `{ input, output }`: the request and the judged
    // output sources. Questions over any other source, and non-`noul` ones, go
    // in an object call its fits route to the next member.
    const outputSources = JUDGE_OUTPUT_SOURCES[checkpoint];
    const judged = rest.filter(
      (i) => (i.question.type ?? "noul") === "noul" && (outputSources as readonly string[]).includes(i.source),
    );
    if (judged.length > 0) {
      const output = outputSources
        .map((source) => sourceText(sources, source).trim())
        .filter((text) => text.length > 0)
        .join("\n\n");
      for (const chunk of chunked(judged, fits.max_questions)) {
        calls.push({ items: chunk, shape: "conversation", scope: "full", judgeOutput: output });
      }
      rest = rest.filter((i) => !judged.includes(i));
    }
    if (rest.length > 0) calls.push({ items: rest, shape: "object", scope: "full" });
    return calls;
  }

  const types = fits.question_types;
  const typeFits = (i: CheckItem) => !types || types.includes(i.question.type ?? "noul");
  const countFits = fits.max_questions === undefined || rest.length <= fits.max_questions;
  const perQuestion = fits.billing === "per_question";
  const isStyle = (i: CheckItem) => checks.get(i.code)?.kind === "style" && i.source === "message";
  const hasStyle = rest.some(isStyle);
  const hasOther = rest.some((i) => !isStyle(i));
  // One call when it fits; per-question billing makes the shared full state
  // expensive for style questions, which only read the message.
  if (rest.every(typeFits) && countFits && !(perQuestion && hasStyle && hasOther)) {
    return [{ items: rest, shape: "object", scope: "full" }];
  }
  const groups: Array<{ items: CheckItem[]; scope: CheckStateScope }> = [
    { items: rest.filter((i) => isStyle(i) && typeFits(i)), scope: "message_only" },
    { items: rest.filter((i) => !isStyle(i) && typeFits(i)), scope: "full" },
    // A question type this member does not answer: its own call, which the
    // fits route to a member that does.
    { items: rest.filter((i) => !typeFits(i)), scope: "full" },
  ];
  for (const group of groups) {
    if (group.items.length === 0) continue;
    for (const chunk of chunked(group.items, fits.max_questions)) {
      calls.push({ items: chunk, shape: "object", scope: group.scope });
    }
  }
  return calls;
}

function chunked<T>(items: T[], size: number | undefined): T[][] {
  if (size === undefined || size <= 0 || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
