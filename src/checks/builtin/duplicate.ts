/**
 * The built-in duplicate-send check (DECISION-MODEL §5.4; ARCHITECTURE.md §8j
 * "Duplicate sends"). One agent runs several sessions in parallel; a session
 * can be about to post something another session of the same agent already
 * posted to the same channel after this session last saw it. The check asks
 * three literal, independent questions over explicit fields (the state is
 * `{ earlier: [...], draft: {...} }`, src/checks/duplicate.ts); any one at or
 * above its threshold blocks the send with the revise remedy.
 *
 * Disabled by default: a deployment turns it on with
 * `[checks.duplicate] enabled = true` (and judged checks on).
 */
import type { CheckDefinition } from "../types.js";

/** The check's code. */
export const DUPLICATE_CHECK_CODE = "duplicate";

/** The questions' statements (owner-approved wording, DECISION-MODEL §5.4). */
export const DUPLICATE_QUESTION_TEXT = {
  answered_already: "`draft.text` answers a question or request that one of `earlier[*].text` already answered.",
  repeats: "Most of the information in `draft.text` already appears in one of `earlier[*].text`.",
  contradicts: "`draft.text` states something that conflicts with a statement in one of `earlier[*].text`.",
} as const;

export type DuplicateQuestionName = keyof typeof DUPLICATE_QUESTION_TEXT;

export const BUILTIN_DUPLICATE_CHECKS: readonly CheckDefinition[] = [
  {
    code: DUPLICATE_CHECK_CODE,
    kind: "duplicate",
    enabled: false,
    remedy: "revise",
    description:
      "Repeats, re-answers or contradicts a message another session of the same agent posted to the same channel " +
      "that this session has not seen",
    // The tool error is written from the verdict (src/checks/duplicate.ts,
    // `duplicateRejection`); this is the fallback when it has no details.
    agentExplanation:
      "Another session of yours already posted a message here that you have not seen, and your draft repeats, " +
      "re-answers or contradicts it. Read the channel and rewrite your message so it fits after that one.",
    checkpoints: ["send"],
    apiSignals: [],
    patterns: [],
    words: [],
    questions: [
      {
        name: "answered_already",
        source: "message",
        instructions: DUPLICATE_QUESTION_TEXT.answered_already,
        criteria: {
          true:
            "One of `earlier[*].text` already answers the question or request that `draft.text` answers, " +
            "whoever asked it (`answering` shows what each message was answering).",
          false: "`draft.text` answers something none of `earlier[*].text` answered, or answers nothing.",
        },
        threshold: 0.8,
      },
      {
        name: "repeats",
        source: "message",
        instructions: DUPLICATE_QUESTION_TEXT.repeats,
        criteria: {
          true: "Most of what `draft.text` says is already said in one of `earlier[*].text`.",
          false: "Most of `draft.text` is information that none of `earlier[*].text` contains.",
        },
        threshold: 0.8,
      },
      {
        name: "contradicts",
        source: "message",
        instructions: DUPLICATE_QUESTION_TEXT.contradicts,
        criteria: {
          true: "`draft.text` says something that one of `earlier[*].text` says differently: they cannot both be right.",
          false: "`draft.text` agrees with every `earlier[*].text`, or they talk about different things.",
        },
        threshold: 0.8,
      },
    ],
    builtin: true,
  },
];
