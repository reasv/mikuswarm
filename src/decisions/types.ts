/**
 * Wire types of the System-One decision API (ARCHITECTURE.md §8h).
 *
 * One endpoint takes `{ model, state, questions }` and returns typed answers.
 * The shape is shared by every vendor that serves it (natively, through
 * OpenRouter, or self-hosted); a Cloudflare-native route wraps the response as
 * `{ result: { … } }`.
 */

/** Instructions and criteria may be a string, an object, or an array. */
export type DecisionText = string | Record<string, unknown> | unknown[];

/** `choice`: pick one option key; `criteria` maps option key → description. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: DecisionText;
  criteria: Record<string, DecisionText>;
}

/** `score`: pick one level; `criteria` lists the levels in order. */
export interface ScoreQuestion {
  type: "score";
  instructions: DecisionText;
  criteria: DecisionText[];
}

/** `noul`: a calibrated probability that the statement holds. */
export interface NoulQuestion {
  type: "noul";
  instructions: DecisionText;
  criteria?: { true?: DecisionText; false?: DecisionText };
}

export type DecisionQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type DecisionQuestionType = DecisionQuestion["type"];

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  /** The model's own calibration signal, NOT the top probability. */
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: "noul";
  /** Probability that the statement is true. */
  noul: number;
}

export type DecisionAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export type DecisionAnswers = Record<string, DecisionAnswer>;

/** The request-shape facts the per-member fits check needs. */
export interface DecisionRequestShape {
  questionTypes: Set<DecisionQuestionType>;
  questionCount: number;
  maxChoiceOptions: number;
  maxScoreLevels: number;
}

export function requestShapeOf(questions: Record<string, DecisionQuestion>): DecisionRequestShape {
  const shape: DecisionRequestShape = {
    questionTypes: new Set(),
    questionCount: 0,
    maxChoiceOptions: 0,
    maxScoreLevels: 0,
  };
  for (const question of Object.values(questions)) {
    shape.questionCount += 1;
    shape.questionTypes.add(question.type);
    if (question.type === "choice") {
      shape.maxChoiceOptions = Math.max(shape.maxChoiceOptions, Object.keys(question.criteria).length);
    } else if (question.type === "score") {
      shape.maxScoreLevels = Math.max(shape.maxScoreLevels, question.criteria.length);
    }
  }
  return shape;
}

/**
 * Parse the `answers` map of a decision response against the questions asked.
 * Returns undefined when any asked question has no well-formed answer: a
 * partial answer map is treated as malformed, never as "the rest are unknown".
 */
export function parseAnswers(
  raw: unknown,
  questions: Record<string, DecisionQuestion>,
): DecisionAnswers | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const out: DecisionAnswers = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = source[id];
    if (!answer || typeof answer !== "object") return undefined;
    const a = answer as Record<string, unknown>;
    if (question.type === "noul") {
      const p = a["noul"];
      if (!isProbability(p)) return undefined;
      out[id] = { type: "noul", noul: p };
    } else if (question.type === "choice") {
      const choice = a["choice"];
      const confidence = a["confidence"];
      if (typeof choice !== "string" || !(choice in question.criteria)) return undefined;
      if (!isProbability(confidence)) return undefined;
      out[id] = { type: "choice", choice, probabilities: probabilityMap(a["probabilities"]), confidence };
    } else {
      const score = typeof a["score"] === "string" ? Number(a["score"]) : a["score"];
      const confidence = a["confidence"];
      if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score >= question.criteria.length) {
        return undefined;
      }
      if (!isProbability(confidence)) return undefined;
      out[id] = { type: "score", score, probabilities: probabilityMap(a["probabilities"]), confidence };
    }
  }
  return out;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function probabilityMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, p] of Object.entries(value as Record<string, unknown>)) {
    if (isProbability(p)) out[key] = p;
  }
  return out;
}

/** Compact answers for the evaluation log: `{ task: "coding@0.91", join: 0.12 }`. */
export function summarizeAnswers(answers: DecisionAnswers): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.type === "noul") out[id] = round3(answer.noul);
    else if (answer.type === "choice") out[id] = `${answer.choice}@${round3(answer.confidence)}`;
    else out[id] = `${answer.score}@${round3(answer.confidence)}`;
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
