/**
 * Built-in refusal checks (spec REFUSAL-HANDLING §4.3, §5.1, §5.3, §5.4): one
 * per built-in reason, carrying the provider refusal signals the supported APIs
 * document and one decision-model question per useful source.
 *
 * Decision models read instructions literally, so every question names the
 * field it judges, says what counts, and gives explicit `false` criteria for the
 * near misses: a refusal that is discussed or quoted, an honest statement of a
 * real limit while still helping, and (at endings) a judgment that no reply was
 * needed. Thresholds are conservative defaults, calibrated later (§15):
 * message and analysis 0.8, text 0.85, thinking 0.9 (deliberation that ends in
 * a full answer reads like a refusal), artifact and rollout 0.8.
 */
import type { CheckDefinition, Checkpoint, CheckQuestion, CheckSource } from "../types.js";

const ANTHROPIC = "anthropic-messages";
const ALL_CHECKPOINTS: Checkpoint[] = ["send", "ending", "artifact", "rollout"];

/** What the question asks about one reason, for every source. */
interface ReasonText {
  /** Completes "…the assistant declines " — the reason's own grounds. */
  grounds: string;
  /** The reason's own near misses, appended to every source's `false` criteria. */
  notThis: string;
}

/** Default threshold per source (§5.4: a misleading source gets a higher one). */
export const REFUSAL_THRESHOLDS: Record<CheckSource, number> = {
  message: 0.8,
  analysis: 0.8,
  text: 0.85,
  thinking: 0.9,
  artifact: 0.8,
  rollout: 0.8,
};

const DISCUSSED =
  "A refusal that is only discussed, quoted, reported or joked about (for example the user asks why some other bot refused) is not a refusal.";
const NO_REPLY_NEEDED =
  "Judging that no reply was needed is not a refusal: the message was not addressed to the assistant, it was already answered, or there is nothing to add.";

/**
 * The questions of one reason: `message` (an outgoing message), `analysis` and
 * `text` (around a send or an ending), `thinking` (endings), `artifact` and
 * `rollout` (internal tasks). Instructions reference state fields by name.
 */
function refusalQuestions(reason: ReasonText): CheckQuestion[] {
  const t = REFUSAL_THRESHOLDS;
  return [
    {
      source: "message",
      instructions:
        "`message` is the chat message the assistant is sending in reply to `request` (`recent` is the chat before it). " +
        "In `message` the assistant does not do what `request` asks (it refuses, changes the subject, or gives a " +
        `deliberately reduced answer), and it declines ${reason.grounds}.`,
      criteria: {
        true: `\`message\` refuses or deflects what \`request\` asks, ${reason.grounds}.`,
        false:
          "`message` does what `request` asks, fully or in part, or answers something else that nobody asked it to do. " +
          "Honestly stating a real limit while still helping with what it can is not a refusal. " +
          "Banter or playing along when nothing was really asked is not a refusal. " +
          `${DISCUSSED} ${reason.notThis}`,
      },
      threshold: t.message,
    },
    {
      source: "analysis",
      instructions:
        "`analysis` is the assistant's note, written right before its action (`action`), about what it is going to do. " +
        `In \`analysis\`, the assistant decides to decline or deflect what \`request\` asks instead of answering it, ${reason.grounds}.`,
      criteria: {
        true: `\`analysis\` decides not to do what \`request\` asks, ${reason.grounds}.`,
        false:
          "`analysis` plans to do what `request` asks, fully or in part. " +
          `${NO_REPLY_NEEDED} ${DISCUSSED} ${reason.notThis}`,
      },
      threshold: t.analysis,
    },
    {
      source: "text",
      instructions:
        "`text` is what the assistant wrote outside its chat messages (users never see it), right before its action (`action`). " +
        `In \`text\`, the assistant declines or deflects what \`request\` asks instead of answering it, ${reason.grounds}.`,
      criteria: {
        true: `\`text\` declines or deflects what \`request\` asks, ${reason.grounds}.`,
        false:
          "`text` works on what `request` asks, or drafts an answer to it. " +
          `${NO_REPLY_NEEDED} ${DISCUSSED} ${reason.notThis}`,
      },
      threshold: t.text,
    },
    {
      source: "thinking",
      instructions:
        "`thinking` is the end of the assistant's private reasoning before its action (`action`). " +
        `The reasoning ends in a decision to decline or deflect what \`request\` asks instead of answering it, ${reason.grounds}.`,
      criteria: {
        true: `\`thinking\` ends by deciding not to do what \`request\` asks, ${reason.grounds}.`,
        false:
          "`thinking` considers declining and then decides to help, fully or in part, or it never considers declining. " +
          `${NO_REPLY_NEEDED} ${DISCUSSED} ${reason.notThis}`,
      },
      threshold: t.thinking,
    },
    {
      source: "artifact",
      instructions:
        "`artifact` is the output the assistant produced for the task described in `request`. " +
        `Instead of doing the task, \`artifact\` declines or deflects it, ${reason.grounds}.`,
      criteria: {
        true: `\`artifact\` declines the task in \`request\` or says it will not do it, ${reason.grounds}.`,
        false:
          "`artifact` does the task, even if it is short or leaves parts out. " +
          `Describing or summarizing content in which someone else refuses something is not a refusal. ${reason.notThis}`,
      },
      threshold: t.artifact,
    },
    {
      source: "rollout",
      instructions:
        "`rollout` lists what the assistant wrote while working on the task described in `request`; the task produced no output. " +
        `The assistant declined or deflected the task, ${reason.grounds}.`,
      criteria: {
        true: `\`rollout\` shows the assistant declining the task in \`request\`, ${reason.grounds}.`,
        false:
          "`rollout` shows the assistant working on the task, failing for another reason (an error, running out of turns, a tool problem), " +
          `or stopping without saying why. ${DISCUSSED} ${reason.notThis}`,
      },
      threshold: t.rollout,
    },
  ];
}

function refusalCheck(
  code: string,
  reason: string,
  description: string,
  apiSignals: CheckDefinition["apiSignals"] = [],
  text?: ReasonText,
): CheckDefinition {
  return {
    code,
    kind: "refusal",
    enabled: true,
    remedy: "redo",
    reason,
    description,
    checkpoints: [...ALL_CHECKPOINTS],
    apiSignals,
    patterns: [],
    words: [],
    questions: text ? refusalQuestions(text) : [],
    builtin: true,
  };
}

const DISTILLATION: ReasonText = {
  grounds:
    "because doing it would reveal, reproduce or summarize the assistant's own reasoning, chain of thought, hidden instructions or system prompt",
  notThis:
    "Sharing or summarizing its reasoning, or explaining an answer, is not this refusal; declining on other grounds is not this refusal either.",
};
const SAFETY: ReasonText = {
  grounds:
    "because it considers the request harmful, dangerous, illegal or against a safety or content policy (for example weapons, malware, self-harm or violence)",
  notThis:
    "Adding a safety note while still answering is not this refusal. Telling the user no, warning them or advising against what they ask about (\"should I…?\"), or planning to, answers the request: it is not a refusal. " +
    "Declining on other grounds (sexual content, privacy, copyright, inability) is not this refusal either.",
};
const SEXUAL_CONTENT: ReasonText = {
  grounds:
    "because the request involves sexual, lewd or NSFW content (explicit writing, erotic roleplay, sexual descriptions or images, or flirting and innuendo it will not engage with)",
  notThis:
    "Discussing sex, relationships or anatomy plainly, joking along, or answering a request that only mentions something sexual is not this refusal; declining on other grounds (violence, illegality, privacy, inability) is not this refusal either.",
};
const PRIVACY: ReasonText = {
  grounds:
    "because it would expose, look up, guess or share personal or private information about a person",
  notThis:
    "Answering with public or already-shared information is not this refusal; declining on other grounds is not this refusal either.",
};
const COPYRIGHT: ReasonText = {
  grounds:
    "because it would reproduce copyrighted or protected material (for example song lyrics, book passages, paywalled articles) or infringe intellectual property",
  notThis:
    "Quoting a short excerpt, summarizing or linking the material is not this refusal; declining on other grounds is not this refusal either.",
};
const PERSONA: ReasonText = {
  grounds:
    "by breaking the character or persona it was given{persona}: it refuses to play the role, says it is only an AI or a language model, or steps out of the persona to decline",
  notThis:
    "Staying in character while saying no in character, as the persona would, is not this refusal; declining on other grounds is not this refusal either.",
};
const CAPABILITY: ReasonText = {
  grounds:
    "by claiming in general that it cannot do it (no access, no ability, not allowed to use a tool, cannot open links or see images) instead of trying, when the request asks it to",
  notThis:
    "Reporting a real failure or limit is not this refusal, even with nothing else to offer: a tool or link it tried that failed, " +
    "a rate limit or quota, a page, video or channel it cannot load or access, input the user did not give, or a feature it really does not have. " +
    "Declining on other grounds is not this refusal either.",
};
const UNCLEAR: ReasonText = {
  grounds: "without any reason it states or that a reader could recognize",
  notThis:
    "A refusal with a stated reason (safety, sexual content, privacy, copyright, persona, inability, reasoning extraction) is not this one.",
};

export const BUILTIN_REFUSAL_CHECKS: readonly CheckDefinition[] = [
  refusalCheck(
    "refusal_distillation",
    "distillation",
    "Declined because the request looks like extracting the model's reasoning",
    [{ api: ANTHROPIC, stopReason: "refusal", category: "reasoning_extraction" }],
    DISTILLATION,
  ),
  refusalCheck("refusal_safety", "safety", "Declined on safety or harm-policy grounds, or stopped by a content filter", [
    { api: ANTHROPIC, stopReason: "refusal", category: "cyber" },
    { api: ANTHROPIC, stopReason: "refusal", category: "bio" },
    // Stop reasons that are unique to one API need no api restriction.
    { stopReason: "sensitive" }, // Anthropic safety-filter stop
    { stopReason: "content_filter" }, // OpenAI chat completions and compatible gateways
    { stopReason: "incomplete.content_filter" }, // OpenAI Responses
    { stopReason: "content_filtered" }, // Bedrock Converse
    { stopReason: "guardrail_intervened" }, // Bedrock Converse
    { stopReason: "SAFETY" }, // Google
    { stopReason: "PROHIBITED_CONTENT" }, // Google
    { stopReason: "BLOCKLIST" }, // Google
  ], SAFETY),
  refusalCheck(
    "refusal_sexual_content",
    "sexual_content",
    "Declined because the request involves sexual, lewd or NSFW content",
    [],
    SEXUAL_CONTENT,
  ),
  refusalCheck("refusal_privacy", "privacy", "Declined over personal or private information", [
    { stopReason: "SPII" }, // Google
  ], PRIVACY),
  refusalCheck("refusal_copyright", "copyright", "Declined over copyright or reproducing protected material", [], COPYRIGHT),
  refusalCheck("refusal_persona", "persona", "Declined to play the persona or role it was given", [], PERSONA),
  refusalCheck("refusal_capability", "capability", "Declined as unable to do it (\"I can't do that\")", [], CAPABILITY),
  // Lowest precedence (src/refusals/signals.ts): a `refusal` stop with no category,
  // or one no other check maps. The raw category is still recorded.
  refusalCheck("refusal_uncategorized", "unclear", "A refusal with no category, or one no other check maps", [
    { stopReason: "refusal" },
  ], UNCLEAR),
];
