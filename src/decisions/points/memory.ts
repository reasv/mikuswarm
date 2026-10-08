/**
 * Memory relevance (ARCHITECTURE.md §8h "Memory", §9d "Judged retrieval"): the
 * decision model as the FINAL FILTER of auto-retrieval. One request per
 * surviving memory passage (never several passages in one state: the model's
 * documented weakness with irrelevant material would degrade every answer),
 * all sent in parallel by the pipeline.
 *
 * Questions (independent `noul`s): `relevant` (would the passage help respond
 * to the request in this conversation), `about_participant` (does it describe
 * a participant or an interaction with them; asked only with participants),
 * and one `filter__<key>` per judged operator filter whose verdict the
 * passage has no fresh cache entry for (§9c "Memory filters": judged-filter
 * questions ride in the same request). Proactive sessions have no request:
 * the conversation window stands in for it.
 *
 * `memoryFilterPoint` is the same point (rows are `point = "memory"`) asked
 * only the filter questions about one block, for the surfaces that are not
 * auto-retrieval (recency layer, diary writer window, memory tools).
 */

import type { DecisionPoint } from "../registry.js";
import { jsonTokens } from "../client.js";
import { clipText, packNewest } from "../state.js";
import type { PointSettings } from "../config.js";
import type { DecisionAnswers, DecisionQuestion } from "../types.js";

export const DEFAULT_MEMORY_RELEVANCE_THRESHOLD = 0.7;
export const DEFAULT_MEMORY_CONVERSATION_MESSAGES = 8;

const REQUEST_TEXT_CLIP = 1200;
const CHAT_TEXT_CLIP = 400;
const PASSAGE_CLIP_SUFFIX = "…[entry truncated]";

export interface MemoryChatMessage {
  from: string;
  text: string;
  self?: true;
}

export interface MemoryRequest {
  from: string;
  text: string;
  reply_to?: { from: string; text: string };
}

/** A judged operator filter, as asked (spec §7.1). */
export interface MemoryFilterQuestion {
  key: string;
  description: string;
  examplesHide: string[];
  examplesKeep: string[];
  threshold: number;
}

export interface MemoryPassage {
  /** `YYYY-MM-DD` of the entry. */
  date: string;
  room: string | null;
  /** The whole block (cleaned). */
  text: string;
}

export interface MemoryPassageInput {
  /** Last messages, oldest first (deleted messages as placeholders). */
  conversation: MemoryChatMessage[];
  /** The request; absent for a proactive session. */
  request?: MemoryRequest;
  /** Display names the user lanes searched. */
  participants: string[];
  passage: MemoryPassage;
  /** Judged filters to ask alongside (no fresh cached verdict). */
  filters: MemoryFilterQuestion[];
  /** Carried into the decision row (citation, scores). */
  meta: { citation: string; contentHash: string; scores: Record<string, number | null> };
}

export interface MemoryPassageVerdict {
  /** `relevant ≥ relevance_threshold`; false on the fallback. */
  keep: boolean;
  relevant: number | null;
  aboutParticipant: number | null;
  /** Per judged filter: its probability and whether it hides the passage. */
  filters: Record<string, { probability: number; hidden: boolean }>;
  judged: boolean;
  meta: MemoryPassageInput["meta"];
}

export function filterQuestionId(key: string): string {
  return `filter__${key}`;
}

/**
 * One judged filter's question, worded the same on every surface (the state
 * names the diary block `entry` on both points), so a filter's calibration
 * holds wherever it is asked.
 */
function filterQuestion(f: MemoryFilterQuestion): DecisionQuestion {
  const criteria: { true?: string; false?: string } = {};
  if (f.examplesHide.length > 0) criteria.true = `For example: ${f.examplesHide.map((e) => JSON.stringify(e)).join("; ")}`;
  if (f.examplesKeep.length > 0) criteria.false = `For example: ${f.examplesKeep.map((e) => JSON.stringify(e)).join("; ")}`;
  return {
    type: "noul",
    instructions: `\`entry\` matches: ${f.description}`,
    ...(criteria.true || criteria.false ? { criteria } : {}),
  };
}

function resolveFilters(
  answers: DecisionAnswers,
  filters: MemoryFilterQuestion[],
  threshold: (name: string, value: number) => number,
): Record<string, { probability: number; hidden: boolean }> | null {
  const out: Record<string, { probability: number; hidden: boolean }> = {};
  for (const f of filters) {
    const a = answers[filterQuestionId(f.key)];
    if (!a || a.type !== "noul") return null;
    out[f.key] = { probability: a.noul, hidden: a.noul >= threshold(`filter.${f.key}`, f.threshold) };
  }
  return out;
}

function clipPassage(passage: MemoryPassage, budgetTokens: number, base: (p: MemoryPassage) => unknown): MemoryPassage {
  if (jsonTokens(base(passage)) <= budgetTokens) return passage;
  const chars = Array.from(passage.text);
  let low = 0;
  let high = chars.length;
  let best: MemoryPassage | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = { ...passage, text: chars.slice(0, mid).join("") + PASSAGE_CLIP_SUFFIX };
    if (jsonTokens(base(candidate)) <= budgetTokens) {
      best = candidate;
      low = mid + 1;
    } else high = mid - 1;
  }
  if (!best) throw new Error("memory_passage_outside_state_budget");
  return best;
}

export const memoryPoint: DecisionPoint<MemoryPassageInput, MemoryPassageVerdict> = {
  name: "memory",

  questions(input: MemoryPassageInput): Record<string, DecisionQuestion> {
    const questions: Record<string, DecisionQuestion> = {
      relevant: {
        type: "noul",
        instructions: input.request
          ? "`entry` contains information that would help respond to `request` in this `conversation`: " +
            "facts, history or earlier events about the people, things or topics being discussed."
          : "`entry` contains information that would help respond in this `conversation`: " +
            "facts, history or earlier events about the people, things or topics being discussed.",
      },
    };
    if (input.participants.length > 0) {
      questions["about_participant"] = {
        type: "noul",
        instructions: "`entry` describes one of `participants` or an interaction with them.",
      };
    }
    for (const f of input.filters) questions[filterQuestionId(f.key)] = filterQuestion(f);
    return questions;
  },

  state(input: MemoryPassageInput, budgetTokens: number): unknown {
    const request = input.request
      ? {
          from: input.request.from,
          text: clipText(input.request.text, REQUEST_TEXT_CLIP),
          ...(input.request.reply_to
            ? { reply_to: { from: input.request.reply_to.from, text: clipText(input.request.reply_to.text, CHAT_TEXT_CLIP) } }
            : {}),
        }
      : undefined;
    const conversation = input.conversation.map((m) => ({
      from: m.from,
      text: clipText(m.text, CHAT_TEXT_CLIP),
      ...(m.self ? { self: true as const } : {}),
    }));
    const build = (chat: typeof conversation, passage: MemoryPassage) => ({
      conversation: chat,
      ...(request ? { request } : {}),
      participants: input.participants,
      entry: { date: passage.date, ...(passage.room ? { room: passage.room } : {}), text: passage.text },
    });
    // The passage is the subject: fit it first (clipped only if it alone overflows),
    // then the newest conversation that still fits.
    const passage = clipPassage(input.passage, budgetTokens, (p) => build([], p));
    const packed = packNewest(conversation, budgetTokens, (chat) => build(chat, passage));
    return build(packed, passage);
  },

  resolve(answers, input, threshold, settings: PointSettings): MemoryPassageVerdict | null {
    const relevant = answers["relevant"];
    if (!relevant || relevant.type !== "noul") return null;
    const about = answers["about_participant"];
    const filters = resolveFilters(answers, input.filters, threshold);
    if (!filters) return null;
    const base = settings.threshold ?? DEFAULT_MEMORY_RELEVANCE_THRESHOLD;
    return {
      keep: relevant.noul >= threshold("relevance_threshold", base),
      relevant: relevant.noul,
      aboutParticipant: about && about.type === "noul" ? about.noul : null,
      filters,
      judged: true,
      meta: input.meta,
    };
  },

  fallback(input: MemoryPassageInput): MemoryPassageVerdict {
    return { keep: false, relevant: null, aboutParticipant: null, filters: {}, judged: false, meta: input.meta };
  },

  describe(verdict: MemoryPassageVerdict): unknown {
    const r3 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 1000);
    const hiddenBy = Object.entries(verdict.filters)
      .filter(([, v]) => v.hidden)
      .map(([k]) => k);
    return {
      citation: verdict.meta.citation,
      contentHash: verdict.meta.contentHash,
      // false on a fallback row: the passage then goes through the fallback rule.
      judged: verdict.judged,
      keep: verdict.keep,
      relevant: r3(verdict.relevant),
      aboutParticipant: r3(verdict.aboutParticipant),
      ...(hiddenBy.length > 0 ? { hiddenBy } : {}),
      scores: verdict.meta.scores,
    };
  },
};

/** One block judged against judged filters only (non-retrieval surfaces). */
export interface MemoryFilterInput {
  entry: MemoryPassage;
  filters: MemoryFilterQuestion[];
  meta: { citation: string; contentHash: string; surface: string };
}

export interface MemoryFilterVerdict {
  /** Null when not judged (fallback). */
  filters: Record<string, { probability: number; hidden: boolean }> | null;
  meta: MemoryFilterInput["meta"];
}

export const memoryFilterPoint: DecisionPoint<MemoryFilterInput, MemoryFilterVerdict> = {
  name: "memory",

  questions(input: MemoryFilterInput): Record<string, DecisionQuestion> {
    const questions: Record<string, DecisionQuestion> = {};
    for (const f of input.filters) questions[filterQuestionId(f.key)] = filterQuestion(f);
    return questions;
  },

  state(input: MemoryFilterInput, budgetTokens: number): unknown {
    const build = (p: MemoryPassage) => ({ entry: { date: p.date, ...(p.room ? { room: p.room } : {}), text: p.text } });
    return build(clipPassage(input.entry, budgetTokens, build));
  },

  resolve(answers, input, threshold): MemoryFilterVerdict | null {
    const filters = resolveFilters(answers, input.filters, threshold);
    return filters ? { filters, meta: input.meta } : null;
  },

  fallback(input: MemoryFilterInput): MemoryFilterVerdict {
    return { filters: null, meta: input.meta };
  },

  describe(verdict: MemoryFilterVerdict): unknown {
    return {
      citation: verdict.meta.citation,
      contentHash: verdict.meta.contentHash,
      surface: verdict.meta.surface,
      filters: verdict.filters,
    };
  },
};
