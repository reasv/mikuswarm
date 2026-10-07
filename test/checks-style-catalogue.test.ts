import assert from "node:assert/strict";
import test from "node:test";

import { BUILTIN_STYLE_CHECKS, LLM_VOCABULARY_WORDS } from "../src/checks/builtin/style.js";
import { buildCheckCatalogue, firstPatternMatch, prefilterAllows } from "../src/checks/catalogue.js";
import { fillMatched } from "../src/checks/revise.js";
import type { CheckDefinition } from "../src/checks/types.js";

// ---------------------------------------------------------------------------
// The starter style catalogue (spec REFUSAL-HANDLING §4.5): nine built-in
// style checks, all disabled, remedy revise at the send checkpoint; each
// check's patterns on positives and near misses; `{matched}`; questions with
// explicit `false` criteria naming the near misses. The sycophantic-opener,
// sign-off and Unicode-emoji checks are not shipped.
// ---------------------------------------------------------------------------

const CODES = [
  "style_em_dash",
  "style_not_x_but_y",
  "style_parallel_construction",
  "style_llm_vocabulary",
  "style_ai_disclaimer",
  "style_essay_formatting",
  "style_moralizing",
  "style_load_bearing",
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

test("the nine starter checks: disabled, style, revise, send only, each with an explanation", () => {
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
  for (const code of ["style_sycophantic_opener", "style_assistant_sign_off", "style_unicode_emoji"]) {
    assert.ok(!BUILTIN_STYLE_CHECKS.some((c) => c.code === code), `${code} is not shipped`);
  }
  // Detection per the §4.5 table.
  const detection = (code: string) => {
    const c = check(code);
    return { patterns: c.patterns.length > 0 || c.words.length > 0, question: c.questions.length > 0 };
  };
  assert.deepEqual(detection("style_em_dash"), { patterns: true, question: false });
  assert.deepEqual(detection("style_not_x_but_y"), { patterns: false, question: true });
  assert.deepEqual(detection("style_parallel_construction"), { patterns: false, question: true });
  assert.deepEqual(detection("style_llm_vocabulary"), { patterns: true, question: false });
  assert.deepEqual(detection("style_ai_disclaimer"), { patterns: true, question: true });
  assert.deepEqual(detection("style_essay_formatting"), { patterns: true, question: true });
  assert.deepEqual(detection("style_moralizing"), { patterns: false, question: true });
  assert.deepEqual(detection("style_load_bearing"), { patterns: false, question: true });
  assert.deepEqual(detection("style_wall_of_text"), { patterns: false, question: true });
  // The spec's explanations, verbatim.
  assert.equal(check("style_em_dash").agentExplanation, "Contains an em-dash. Use a comma, period, colon or parentheses instead.");
  assert.equal(check("style_llm_vocabulary").agentExplanation, 'Uses stock LLM vocabulary ("{matched}"). Use a plain word.');
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
  assert.deepEqual(check("style_not_x_but_y").questions.map((q) => q.threshold), [0.60, 0.60]);
  for (const q of check("style_not_x_but_y").questions) {
    assert.match(q.criteria.false, /concrete factual correction/);
  }
  assert.match(check("style_essay_formatting").questions[0]!.criteria.false, /list the user asked for is not essay formatting/);
  assert.match(check("style_load_bearing").questions[0]!.criteria.false, /Quoting .* is not the assistant's own phrasing/);
  assert.match(check("style_ai_disclaimer").questions[0]!.criteria.false, /AI as a subject/);
  assert.equal(check("style_wall_of_text").minChars, 300, "a short message is never a wall of text");
});

test("style_em_dash: the em-dash only", () => {
  hits("style_em_dash", ["it works — mostly", "a—b"], ["it works - mostly", "pages 10–12", "it works -- mostly"]);
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

test("style_load_bearing: a prefilter on the word, a question for figurative use, never a pattern hit", () => {
  const c = check("style_load_bearing");
  assert.equal(c.patterns.length + c.words.length, 0, "the word alone never decides the check");
  assert.equal(c.minChars, 0, "short messages are judged too: only messages with the word reach the question");
  for (const text of [
    "that joke is load-bearing",
    "a Load-Bearing assumption",
    "the word 'just' is load bearing here",
    "LOADBEARING",
    "load\u2011bearing detail",
    "load-bearing.",
  ]) {
    assert.equal(prefilterAllows(c, text), true, text);
  }
  for (const text of ["bearing the load", "a heavy load", "overload bearings", "unloadbearing"]) {
    assert.equal(prefilterAllows(c, text), false, text);
  }
  const q = c.questions[0]!;
  assert.equal(q.source, "message");
  assert.match(q.instructions, /figure of speech/);
  assert.match(q.criteria.false, /load-bearing wall, beam/);
  assert.match(q.criteria.false, /bridge/);
  assert.match(c.agentExplanation!, /figure of speech/);
  assert.match(c.agentExplanation!, /say plainly what you mean/);
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
