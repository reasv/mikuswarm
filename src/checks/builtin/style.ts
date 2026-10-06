/**
 * Built-in style checks: the starter style catalogue (spec REFUSAL-HANDLING
 * §4.5). All ship disabled; an operator enables the ones that fit the persona
 * (`[checks.<code>] enabled = true`) and may override any field.
 *
 * Two sources: the style rules the workspace template already gives the agent
 * (no "I'm just an AI" disclaimers, no figurative "load-bearing", short messages
 * unless length is warranted), and common LLM-isms (owner decision 26). The
 * sycophantic-opener, sign-off and Unicode-emoji checks of the original starter
 * set are left commented out below: the first two were never seen in practice,
 * and standard emoji have legitimate uses.
 *
 * Detection:
 * - Patterns decide their check without a model call and work without a
 *   decision model; they ignore the style length floor (§6.3). They are kept
 *   precise (anchored openers, phrases rather than single words, lookaheads that
 *   skip "an AI researcher"); paraphrases are the questions' job.
 * - A prefilter gates a question on a cheap pattern (`style_load_bearing` asks
 *   only when the word is there); unlike a pattern it never decides the check.
 * - Questions read the outgoing `message`. When the fits split the evaluation,
 *   style questions get the message alone, so every question works without
 *   `request` and only uses it when present.
 * - Each question's `false` criteria name the near misses (a factual correction
 *   is not a rhetorical contrast, a list the user asked for is not essay
 *   formatting, quoting someone is not the agent's own phrasing), because
 *   decision models read instructions literally.
 *
 * Deliberate uses (a quotation, an example) are what the override argument is
 * for (§6.4); the tool error says so.
 */
import type { CheckDefinition, CheckQuestion } from "../types.js";

/** Default threshold of the starter style questions (calibrated later, §15). */
export const STYLE_THRESHOLD = 0.85;

/** Shared near miss: someone else's words, or the construction as the topic. */
const QUOTED =
  "Quoting or reporting what someone else wrote, or showing the construction as an example because the conversation is about it, is not the assistant's own phrasing.";

/**
 * Optional leading mention or addressed name before an opener ("@alice ",
 * "<@123> ", "Bob, "); with PRAISE, used by the unshipped `style_sycophantic_opener`.
 */
const LEAD = String.raw`^\s*(?:(?:[@<]\S+[,:]?|\p{Lu}\p{L}*[,:])\s+)?(?:(?:oh|wow|ah|ooh|yes)[,!]?\s+){0,2}`;

const PRAISE = String.raw`(?:really\s+|very\s+|such\s+an?\s+)?(?:great|excellent|fantastic|wonderful|fascinating|brilliant|insightful|thoughtful|amazing)\s+`;

/** Default word list of `style_llm_vocabulary` (replaced wholesale by `[checks.style_llm_vocabulary] words`). */
export const LLM_VOCABULARY_WORDS: readonly string[] = [
  "delve",
  "delves",
  "delved",
  "delving",
  "tapestry",
  "tapestries",
  "testament to",
  "multifaceted",
  "navigate the complexities",
  "navigating the complexities",
  "in the realm of",
  "it's worth noting",
  "it’s worth noting",
  "it is worth noting",
  "underscores",
  "boasts",
];

/** "load-bearing", "load bearing", "loadbearing", any case or hyphen: the prefilter of `style_load_bearing`. */
export const LOAD_BEARING_PATTERN = /(?<![\p{L}\p{N}_])load[\s\u2010\u2011-]*bearing/iu;

/**
 * Standard Unicode emoji (the unshipped `style_unicode_emoji` below):
 * emoji-presentation code points, text-default symbols forced to emoji with
 * VS16, keycaps, with their modifiers and ZWJ sequences.
 * Text-default symbols that kaomoji use (♡ ☆ ✿ ♪ ツ) and `:shortcode:` never match.
 */
export const UNICODE_EMOJI_PATTERN =
  /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️|[#*0-9]️?⃣)(?:\p{Emoji_Modifier}|️|‍\p{Extended_Pictographic}️?)*/u;

const MESSAGE_INTRO =
  "`message` is a chat message the assistant is about to send (`request`, when present, is what it replies to). ";

function messageQuestion(instructions: string, criteria: { true: string; false: string }, threshold = STYLE_THRESHOLD): CheckQuestion {
  return { source: "message", instructions: MESSAGE_INTRO + instructions, criteria, threshold };
}

function styleCheck(
  code: string,
  description: string,
  agentExplanation: string,
  detection: {
    patterns?: RegExp[];
    words?: readonly string[];
    prefilter?: RegExp[];
    question?: CheckQuestion;
    questions?: CheckQuestion[];
    minChars?: number;
  },
): CheckDefinition {
  return {
    code,
    kind: "style",
    enabled: false,
    remedy: "revise",
    description,
    agentExplanation,
    checkpoints: ["send"],
    apiSignals: [],
    patterns: detection.patterns ?? [],
    words: [...(detection.words ?? [])],
    ...(detection.prefilter ? { prefilter: detection.prefilter } : {}),
    ...(detection.minChars !== undefined ? { minChars: detection.minChars } : {}),
    questions: detection.questions ?? (detection.question ? [detection.question] : []),
    builtin: true,
  };
}

export const BUILTIN_STYLE_CHECKS: readonly CheckDefinition[] = [
  styleCheck(
    "style_em_dash",
    "Contains an em-dash",
    "Contains an em-dash. Use a comma, period, colon or parentheses instead.",
    { patterns: [/—/u] },
  ),
  styleCheck(
    "style_not_x_but_y",
    "Rhetorical contrast: 'not X, but Y' or 'X, not Y'",
    'Uses a contrast primarily for rhetorical impact ("not X, but Y" or "X, not Y"). State the point directly.',
    {
      questions: [
        messageQuestion(
          "`message` uses \"not X, but Y\" or an equivalent (\"it's not X, it's Y\", \"not just X, but Y\", " +
            "\"less X, more Y\", \"this isn't about X, it's about Y\") primarily to add rhetorical impact: " +
            "making a characterization sound more emphatic, profound, dramatic, or validating.",
          {
            true: "The contrast mainly adds emphasis or rhetorical weight; stating Y directly would convey substantially the same information.",
            false: "The contrast makes a concrete factual correction, explains a useful practical distinction, or is only quoted or discussed.",
          },
          0.70,
        ),
        messageQuestion(
          "In `message`, the assistant uses \"X, not Y\" primarily to add rhetorical impact: " +
            "making a characterization sound more emphatic, profound, dramatic, or validating.",
          {
            true: "The contrast mainly adds emphasis or rhetorical weight; stating X directly would convey substantially the same information.",
            false: "The contrast makes a concrete factual correction, explains a useful practical distinction, or is only quoted or discussed.",
          },
          0.70,
        ),
      ],
    },
  ),
  styleCheck(
    "style_parallel_construction",
    "Rhetorical parallelism: rhythmic triads, anaphora, mirrored clauses",
    "Uses a rhetorical parallel construction (a rhythmic triad or repeated sentence frame). Say it plainly, once.",
    {
      question: messageQuestion(
        "`message` uses parallelism for rhythm: a triad of near-synonyms or matched phrases used as a flourish (\"fast, " +
          "simple, and reliable\"), several sentences or clauses opening with the same words (anaphora), or mirrored " +
          "clauses used as a slogan (\"the more you X, the more you Y\").",
        {
          true: "The repetition or the set of three exists for cadence; the same point would survive said once.",
          false:
            "A list of distinct facts, steps or items that happens to have three entries, an answer that enumerates what " +
            `was asked for, or ordinary repetition in casual speech is not rhetorical parallelism. ${QUOTED}`,
        },
      ),
    },
  ),
  // Not shipped: never seen in practice.
  // styleCheck(
  //   "style_sycophantic_opener",
  //   "Opens by praising or agreeing with the user",
  //   "Opens by praising or agreeing with the user. Start with the substance.",
  //   {
  //     patterns: [
  //       // "Great question!", "That's a great point", "Bob, excellent observation".
  //       new RegExp(
  //         LEAD + String.raw`(?:that(?:'|’)?s\s+(?:a\s+|an\s+)?)?` + PRAISE + String.raw`(?:question|point|observation|insight)s?\b`,
  //         "iu",
  //       ),
  //       // "What a fascinating idea", "What an excellent question".
  //       new RegExp(LEAD + String.raw`what\s+an?\s+` + PRAISE + String.raw`(?:question|point|idea|observation|insight|thought)s?\b`, "iu"),
  //       // "You're absolutely right".
  //       new RegExp(LEAD + String.raw`you(?:(?:'|’)re|\s+are)\s+(?:absolutely|completely|totally|so|entirely|100%)\s+right\b`, "iu"),
  //     ],
  //     question: messageQuestion(
  //       "`message` opens by praising the user or their question or idea, or by effusively agreeing, before getting to its " +
  //         "substance (\"Great question!\", \"You're absolutely right\", \"What a fascinating idea\", or a paraphrase).",
  //       {
  //         true: "The first sentence or phrase of `message` is flattery or effusive agreement that adds nothing.",
  //         false:
  //           "A short plain acknowledgment that carries information (confirming a fact, conceding a correction: \"yeah, it " +
  //           "was 1998\"), praise that is the substance asked for (someone shared their work and asked for an opinion), or " +
  //           `warmth later in the message is not a sycophantic opener. ${QUOTED}`,
  //       },
  //     ),
  //   },
  // ),
  // styleCheck(
  //   "style_assistant_sign_off",
  //   "Assistant-style offers and sign-offs",
  //   "Ends with (or contains) an assistant-style offer or sign-off. Drop it.",
  //   {
  //     patterns: [
  //       /\bhope\s+(?:this|that|it)\s+helps\b/iu,
  //       /\blet\s+me\s+know\s+if\s+(?:you\s+)?(?:have|need|want|would\s+like)\s+(?:any(?:thing)?\s+)?(?:else|more|other|further|additional|help|questions?|clarification)\b/iu,
  //       /\bfeel\s+free\s+to\s+(?:ask|reach\s+out|let\s+me\s+know)\b/iu,
  //       /\bhow\s+(?:can|may)\s+I\s+(?:help|assist)(?:\s+you)?(?:\s+today)?\s*\?/iu,
  //       /\bI(?:(?:'|’)d|\s+would)\s+be\s+(?:happy|glad|delighted)\s+to\b/iu,
  //       /\bis\s+there\s+anything\s+else\s+(?:I\s+can|you(?:(?:'|’)d|\s+would)\s+like)\b/iu,
  //       /\bhappy\s+to\s+help\b/iu,
  //     ],
  //     question: messageQuestion(
  //       "`message` contains a customer-service offer or sign-off: hoping it helped, inviting more questions, offering " +
  //         "further help, asking how it can help (\"I hope this helps\", \"Let me know if you need anything else\", \"Feel " +
  //         "free to ask\", \"How can I help?\", \"I'd be happy to\"), or a paraphrase.",
  //       {
  //         true: "`message` contains a service phrase a support bot would add and a person in this chat would not say.",
  //         false:
  //           "A concrete follow-up that belongs to the conversation (\"ping me when the build finishes and I'll check the " +
  //           `logs\") or friendly small talk is not an assistant sign-off. ${QUOTED}`,
  //       },
  //     ),
  //   },
  // ),
  styleCheck(
    "style_llm_vocabulary",
    "Overused LLM vocabulary (configurable word list)",
    'Uses stock LLM vocabulary ("{matched}"). Use a plain word.',
    { words: LLM_VOCABULARY_WORDS },
  ),
  styleCheck(
    "style_ai_disclaimer",
    "Disclaimers about being an AI",
    "Contains an AI disclaimer. Stay in character and drop it.",
    {
      patterns: [
        // "As an AI, …", "as a large language model I …"; not "as an AI researcher".
        /\bas\s+an?\s+(?:AI|artificial\s+intelligence|(?:large\s+)?language\s+model|LLM)(?:\s+(?:language\s+)?model|\s+assistant|\s+chatbot)?(?=\s*[,.;:!?)]|\s*$|\s+(?:I|myself)\b)/iu,
        // "I'm just an AI.", "I am only a language model and …"; not "I'm an AI engineer".
        /\bI(?:(?:'|’)m|\s+am)\s+(?:just\s+|only\s+|merely\s+|simply\s+)?an?\s+(?:AI|artificial\s+intelligence|(?:large\s+)?language\s+model|LLM|chatbot)(?:\s+(?:language\s+)?model|\s+assistant)?(?=\s*[,.;:!?)]|\s*$|\s+(?:and|but|so|that|who|with|without)\b)/iu,
      ],
      question: messageQuestion(
        "`message` disclaims being an AI or a language model to qualify or excuse what it says (\"as an AI I don't have " +
          "opinions\", \"I'm just a language model\", \"being a program, I can't really feel that\"), or a paraphrase.",
        {
          true: "`message` steps out of the conversation to remind the reader it is an AI, as a caveat or an excuse.",
          false: `Talking about AI as a subject (models, research, a news story) is not a disclaimer. ${QUOTED}`,
        },
      ),
    },
  ),
  styleCheck(
    "style_essay_formatting",
    "Essay formatting (headings, section labels, bullet structure) in a chat message",
    "Formats a chat message like an essay (headings, bullet structure). Write it as a normal chat message unless a list was asked for.",
    {
      // Markdown headings at a line start ("# Title", "### Section"), never "#hashtag".
      patterns: [/^[ \t]{0,3}#{1,6}[ \t]+\S/mu],
      question: messageQuestion(
        "`message` is structured like a document: headings, bold section labels, or bulleted or numbered structure " +
          "organising what would read naturally as a few chat sentences.",
        {
          true: "The structure was not called for: nobody asked for a list or a document, and the content is conversational.",
          false:
            "A list the user asked for is not essay formatting (steps, a ranking, options, a comparison when `request` asks " +
            "for one), nor is a code block, a short enumeration inside a sentence, or a structured answer to a structured " +
            `request. ${QUOTED}`,
        },
      ),
    },
  ),
  styleCheck(
    "style_moralizing",
    "Unprompted moral commentary, warnings or caveats",
    "Adds moral commentary or caveats nobody asked for. Remove them.",
    {
      question: messageQuestion(
        "`message` adds ethical commentary, a warning, or a caveat that nobody asked for and that does not change the " +
          "answer (\"it's important to remember…\", \"please be respectful…\", \"always consult a professional\").",
        {
          true: "Removing that commentary would lose nothing anyone asked for.",
          false:
            "Safety information the user asked for, a caveat that changes whether the answer is correct or usable (\"this " +
            `only works on version 2\"), or an opinion the conversation invited is not moralizing. ${QUOTED}`,
        },
      ),
    },
  ),
  // Not shipped: standard emoji have legitimate uses.
  // styleCheck(
  //   "style_unicode_emoji",
  //   "Standard Unicode emoji in the message body",
  //   "Contains standard Unicode emoji. Use a custom `:shortcode:` emoji or a kaomoji instead.",
  //   { patterns: [UNICODE_EMOJI_PATTERN] },
  // ),
  styleCheck(
    "style_load_bearing",
    'Figurative "load-bearing"',
    'Uses "load-bearing" as a figure of speech. Don\'t; say plainly what you mean (for example "important", "essential" or "doing the real work").',
    {
      // Only messages with the word are judged, so the length floor would only hide short ones.
      prefilter: [LOAD_BEARING_PATTERN],
      minChars: 0,
      question: messageQuestion(
        "`message` uses \"load-bearing\" (or \"load bearing\", \"loadbearing\") as a figure of speech: it calls " +
          "something that is not a physical structure load-bearing to mean that it is important, essential or doing " +
          "a lot of work (\"that joke is load-bearing\", \"a load-bearing assumption\", \"the word 'just' is " +
          "load-bearing here\").",
        {
          true: "In its own words, `message` calls an idea, word, joke, person, assumption, detail or anything else that is not a physical structure load-bearing.",
          false:
            "The literal structural or engineering meaning is not a figure of speech: a load-bearing wall, beam, column, " +
            "pillar or foundation, a building, bridge or other architecture, a mechanical, structural or electrical " +
            `load. ${QUOTED}`,
        },
      ),
    },
  ),
  styleCheck(
    "style_wall_of_text",
    "Far longer than the exchange calls for",
    "Much longer than this exchange calls for. Cut it to what matters.",
    {
      // A message this short is never a wall of text: skip the question's cost.
      minChars: 300,
      question: messageQuestion(
        "`message` is far longer than the exchange calls for: a casual remark or short question answered with paragraphs, " +
          "padding, or background nobody asked for.",
        {
          true: "Most of `message` could be cut without losing anything the conversation needed.",
          false:
            "A long message is fine when someone asked for research, an explanation, instructions, a story or exact quoted " +
            "material, or when the question itself is detailed. When `request` is absent and the length could be " +
            "warranted, it is not a wall of text.",
        },
      ),
    },
  ),
];
