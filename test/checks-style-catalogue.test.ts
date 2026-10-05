import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_STYLE_CHECKS, LLM_VOCABULARY_WORDS } from "../src/checks/builtin/style.js";
import { buildCheckCatalogue, firstPatternMatch } from "../src/checks/catalogue.js";
import { fillMatched } from "../src/checks/revise.js";
import type { CheckDefinition } from "../src/checks/types.js";

// ---------------------------------------------------------------------------
// The starter style catalogue (spec REFUSAL-HANDLING §4.5): eleven built-in
// style checks, all disabled, remedy revise at the send checkpoint; each
// check's patterns on positives and near misses; `{matched}`; questions with
// explicit `false` criteria naming the near misses.
// ---------------------------------------------------------------------------

const CODES = [
  "style_em_dash",
  "style_not_x_but_y",
  "style_parallel_construction",
  "style_sycophantic_opener",
  "style_assistant_sign_off",
  "style_llm_vocabulary",
  "style_ai_disclaimer",
  "style_essay_formatting",
  "style_moralizing",
  "style_unicode_emoji",
  "style_wall_of_text",
];

const check = (code: string): CheckDefinition => {
  const found = BUILTIN_STYLE_CHECKS.find((c) => c.code === code);
  assert.ok(found, code);
  return found;
};

function hits(code: string, positives: string[], negatives: string[]): void {
  const c = check(code);
  for (const text of positives) assert.notEqual(firstPatternMatch(c, text), undefined, `${code} should match: ${text}`);
  for (const text of negatives) assert.equal(firstPatternMatch(c, text), undefined, `${code} should not match: ${text}`);
}

test("the eleven §4.5 checks: disabled, style, revise, send only, each with an explanation", () => {
  assert.deepEqual(BUILTIN_STYLE_CHECKS.map((c) => c.code), CODES);
  for (const c of BUILTIN_STYLE_CHECKS) {
    assert.equal(c.kind, "style");
    assert.equal(c.enabled, false, `${c.code} ships disabled (§11)`);
    assert.equal(c.remedy, "revise");
    assert.deepEqual(c.checkpoints, ["send"]);
    assert.equal(c.builtin, true);
    assert.ok(c.agentExplanation && c.agentExplanation.length > 10, c.code);
    assert.ok(c.patterns.length + c.words.length + c.questions.length > 0, `${c.code} detects something`);
  }
  // Detection per the §4.5 table.
  const detection = (code: string) => {
    const c = check(code);
    return { patterns: c.patterns.length > 0 || c.words.length > 0, question: c.questions.length > 0 };
  };
  assert.deepEqual(detection("style_em_dash"), { patterns: true, question: false });
  assert.deepEqual(detection("style_not_x_but_y"), { patterns: false, question: true });
  assert.deepEqual(detection("style_parallel_construction"), { patterns: false, question: true });
  assert.deepEqual(detection("style_sycophantic_opener"), { patterns: true, question: true });
  assert.deepEqual(detection("style_assistant_sign_off"), { patterns: true, question: true });
  assert.deepEqual(detection("style_llm_vocabulary"), { patterns: true, question: false });
  assert.deepEqual(detection("style_ai_disclaimer"), { patterns: true, question: true });
  assert.deepEqual(detection("style_essay_formatting"), { patterns: true, question: true });
  assert.deepEqual(detection("style_moralizing"), { patterns: false, question: true });
  assert.deepEqual(detection("style_unicode_emoji"), { patterns: true, question: false });
  assert.deepEqual(detection("style_wall_of_text"), { patterns: false, question: true });
  // The spec's explanations, verbatim.
  assert.equal(check("style_em_dash").agentExplanation, "Contains an em-dash. Use a comma, period, colon or parentheses instead.");
  assert.equal(check("style_llm_vocabulary").agentExplanation, 'Uses stock LLM vocabulary ("{matched}"). Use a plain word.');
  assert.equal(
    check("style_unicode_emoji").agentExplanation,
    "Contains standard Unicode emoji. Use a custom `:shortcode:` emoji or a kaomoji instead.",
  );
});

test("questions read the message and name their near misses in the false criteria", () => {
  for (const c of BUILTIN_STYLE_CHECKS) {
    for (const q of c.questions) {
      assert.equal(q.source, "message", c.code);
      assert.ok(q.threshold > 0.5 && q.threshold <= 1, c.code);
      assert.match(q.instructions, /`message`/);
      assert.ok(q.criteria.false.length > 40, `${c.code} names its near misses`);
    }
  }
  assert.match(check("style_not_x_but_y").questions[0]!.criteria.false, /factual correction is not a rhetorical contrast/);
  assert.match(check("style_essay_formatting").questions[0]!.criteria.false, /list the user asked for is not essay formatting/);
  assert.match(check("style_sycophantic_opener").questions[0]!.criteria.false, /Quoting .* is not the assistant's own phrasing/);
  assert.match(check("style_ai_disclaimer").questions[0]!.criteria.false, /AI as a subject/);
  assert.equal(check("style_wall_of_text").minChars, 300, "a short message is never a wall of text");
});

test("style_em_dash: the em-dash only", () => {
  hits("style_em_dash", ["it works — mostly", "a—b"], ["it works - mostly", "pages 10–12", "it works -- mostly"]);
});

test("style_sycophantic_opener: praise or effusive agreement as the opener", () => {
  hits(
    "style_sycophantic_opener",
    [
      "Great question! The answer is 42.",
      "great point, but the cache is per room",
      "Oh wow, what a fascinating idea.",
      "What an excellent question",
      "That's a great observation.",
      "You're absolutely right, the build was broken.",
      "you are completely right",
      "@alice great question, it was 1998",
      "Bob, excellent point.",
      "  Really great question honestly",
    ],
    [
      "That great idea of yours failed in prod.",
      "The real question is whether it ships.",
      "yeah, it was 1998",
      "You're right that it was 1998.",
      "I asked a great question yesterday and nobody answered.",
      "Great, that worked.",
      "the docs say \"Great question!\" is a cliché",
    ],
  );
});

test("style_assistant_sign_off: service offers anywhere in the message", () => {
  hits(
    "style_assistant_sign_off",
    [
      "Here it is. I hope this helps!",
      "hope that helps",
      "Let me know if you need anything else.",
      "let me know if you have any questions",
      "Feel free to ask!",
      "How can I help you today?",
      "how may I assist?",
      "I'd be happy to help with that.",
      "I would be glad to take a look.",
      "Is there anything else I can do?",
      "happy to help :)",
    ],
    [
      "let me know when the build finishes",
      "ping me if it breaks again",
      "I'm happy with how it turned out",
      "how can I fix this error?",
      "feel free",
      "does that help with the rendering at all",
    ],
  );
});

test("style_llm_vocabulary: whole words and phrases from the list, {matched} filled", () => {
  const c = check("style_llm_vocabulary");
  assert.deepEqual(c.words, [...LLM_VOCABULARY_WORDS]);
  hits(
    "style_llm_vocabulary",
    [
      "Let's delve into it.",
      "a rich Tapestry of styles",
      "it's a testament to their work",
      "It’s worth noting that the cache resets.",
      "it is worth noting",
      "in the realm of networking",
      "a multifaceted problem",
      "this underscores the point",
      "the hotel boasts a pool",
    ],
    ["the delveopment branch", "tapestrylike", "worth noting down", "realm", "he boasted about it", "under scores"],
  );
  assert.equal(firstPatternMatch(c, "We should DELVE deeper"), "DELVE");
  assert.equal(firstPatternMatch(c, "navigate   the complexities"), "navigate   the complexities");
  assert.equal(fillMatched(c.agentExplanation!, firstPatternMatch(c, "Let's delve in")), 'Uses stock LLM vocabulary ("delve"). Use a plain word.');
  // The list is configurable: `words` replaces it wholesale.
  const catalogue = buildCheckCatalogue({ checks: { style_llm_vocabulary: { enabled: true, words: ["synergy"] } } } as any);
  const configured = catalogue.get("style_llm_vocabulary")!;
  assert.equal(configured.enabled, true);
  assert.equal(firstPatternMatch(configured, "pure synergy"), "synergy");
  assert.equal(firstPatternMatch(configured, "let's delve"), undefined);
});

test("style_ai_disclaimer: disclaimers, not AI as a subject", () => {
  hits(
    "style_ai_disclaimer",
    [
      "As an AI, I don't have opinions.",
      "as an AI language model I cannot browse",
      "As a large language model, I can't feel that.",
      "I'm just an AI.",
      "I am only a language model and can't do that",
      "i'm an AI assistant, so no",
      "Sorry, I’m just an AI",
    ],
    [
      "As an AI researcher, she disagrees.",
      "I'm an AI engineer at a startup.",
      "the new AI model is out",
      "I read a paper by an AI lab",
      "he said \"as an\" and stopped",
    ],
  );
});

test("style_essay_formatting: markdown headings at a line start, not hashtags", () => {
  hits(
    "style_essay_formatting",
    ["# Summary\nIt works.", "Intro line\n## Details\nmore", "### Step 1"],
    ["#general is the channel", "use C# for that", "issue #42 is fixed", "- a list item\n- another"],
  );
});

test("style_unicode_emoji: standard emoji, never kaomoji or shortcodes", () => {
  const c = check("style_unicode_emoji");
  hits(
    "style_unicode_emoji",
    ["nice 😀", "👍🏽", "flag 🇯🇵", "love it ❤️", "⭐ starred", "☕", "press 1️⃣", "✔️ done"],
    ["(╯°□°）╯︵ ┻━┻", "ʕ•ᴥ•ʔ", "(｡◕‿◕｡)", "¯\\_(ツ)_/¯", "♡ ☆ ★ ♪ ✿", ":smile: :blobcat:", "© 2026 ™", "✔ done", "→ next"],
  );
  assert.equal(firstPatternMatch(c, "ok 👍🏽 then"), "👍🏽", "the whole emoji with its modifier");
});

test("fillMatched: the placeholder is filled, clipped, or dropped with its quotes for a judged hit", () => {
  assert.equal(fillMatched('Uses "{matched}".', "delve"), 'Uses "delve".');
  assert.equal(fillMatched("Uses ({matched}) here.", "a\n  b"), "Uses (a b) here.");
  assert.equal(fillMatched('Uses stock LLM vocabulary ("{matched}"). Use a plain word.', undefined), "Uses stock LLM vocabulary. Use a plain word.");
  assert.equal(fillMatched('Uses "{matched}" again.', undefined), "Uses again.");
  assert.equal(fillMatched("No placeholder.", undefined), "No placeholder.");
  const long = fillMatched("{matched}", "x".repeat(200));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});
