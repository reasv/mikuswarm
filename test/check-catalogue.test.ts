/**
 * Check catalogue (spec REFUSAL-HANDLING §4): built-ins, field-by-field
 * overrides, operator checks, per-agent overrides, validation, pattern helpers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCheckCatalogue,
  catalogueReasons,
  compileCheckPattern,
  compileWordList,
  firstPatternMatch,
} from "../src/checks/catalogue.js";
import {
  BUILTIN_CHECKS,
  BUILTIN_CONTRACT_CHECKS,
  BUILTIN_REFUSAL_CHECKS,
  BUILTIN_STYLE_CHECKS,
} from "../src/checks/builtin/index.js";
import type { CheckDefinition } from "../src/checks/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const build = (config: any) => buildCheckCatalogue(config);

const question = (over: Record<string, unknown> = {}) => ({
  source: "message",
  instructions: "The assistant declines.",
  criteria: { true: "declines", false: "answers" },
  threshold: 0.8,
  ...over,
});

test("built-ins: the seven refusal checks, enabled, redo, all checkpoints", () => {
  const catalogue = build({});
  const refusal = catalogue.all().filter((c) => c.kind === "refusal");
  assert.deepEqual(
    refusal.map((c) => [c.code, c.reason]),
    [
      ["refusal_distillation", "distillation"],
      ["refusal_safety", "safety"],
      ["refusal_privacy", "privacy"],
      ["refusal_copyright", "copyright"],
      ["refusal_persona", "persona"],
      ["refusal_capability", "capability"],
      ["refusal_uncategorized", "unclear"],
    ],
  );
  for (const c of refusal) {
    assert.equal(c.enabled, true);
    assert.equal(c.remedy, "redo");
    assert.equal(c.builtin, true);
    assert.deepEqual(c.checkpoints, ["send", "ending", "artifact", "rollout"]);
    // One judged question per useful source (spec §5.4–§5.5).
    assert.deepEqual(
      c.questions.map((q) => q.source),
      ["message", "analysis", "text", "thinking", "artifact", "rollout"],
    );
  }
  assert.equal(
    BUILTIN_CHECKS.length,
    BUILTIN_REFUSAL_CHECKS.length + BUILTIN_STYLE_CHECKS.length + BUILTIN_CONTRACT_CHECKS.length,
  );
  assert.equal(BUILTIN_STYLE_CHECKS.length, 11, "the starter style catalogue (§4.5)");
});

test("override: a built-in is overridden field by field, the rest kept", () => {
  const catalogue = build({
    checks: { refusal_persona: { remedy: "observe", questions: [question()] } },
  });
  const persona = catalogue.get("refusal_persona")!;
  assert.equal(persona.remedy, "observe");
  assert.equal(persona.reason, "persona", "kept");
  assert.equal(persona.enabled, true, "kept");
  assert.equal(persona.builtin, true);
  assert.equal(persona.questions.length, 1);
  assert.equal(persona.questions[0]!.threshold, 0.8);
  // The built-in module itself is untouched.
  assert.equal(BUILTIN_REFUSAL_CHECKS.find((c) => c.code === "refusal_persona")!.remedy, "redo");
});

test("override: disabling a built-in; enabledFor filters it out", () => {
  const catalogue = build({ checks: { refusal_capability: { enabled: false } } });
  assert.equal(catalogue.get("refusal_capability")!.enabled, false);
  assert.ok(catalogue.all().some((c) => c.code === "refusal_capability"), "all() includes disabled checks");
  assert.ok(!catalogue.enabledFor("send").some((c) => c.code === "refusal_capability"));
});

test("operator checks: defaults by kind, config order after built-ins", () => {
  const catalogue = build({
    checks: {
      style_custom: { kind: "style", patterns: ["(?i)\\bdelve\\b"], agent_explanation: 'Uses "{matched}".' },
      refusal_custom: { kind: "refusal", reason: "policy_x", description: "Custom reason" },
      contract_custom: { kind: "contract" },
    },
  });
  const codes = catalogue.all().map((c) => c.code);
  assert.deepEqual(codes.slice(-3), ["style_custom", "refusal_custom", "contract_custom"]);
  const style = catalogue.get("style_custom")!;
  assert.equal(style.remedy, "revise");
  assert.deepEqual(style.checkpoints, ["send"]);
  assert.equal(style.enabled, true);
  assert.equal(style.builtin, false);
  assert.equal(style.description, "style_custom", "description defaults to the code");
  const refusal = catalogue.get("refusal_custom")!;
  assert.equal(refusal.remedy, "redo");
  assert.deepEqual(refusal.checkpoints, ["send", "ending", "artifact", "rollout"]);
  const contract = catalogue.get("contract_custom")!;
  assert.equal(contract.remedy, "observe");
  assert.deepEqual(contract.checkpoints, ["ending"]);
  assert.deepEqual(catalogue.enabledFor("send").map((c) => c.code).includes("contract_custom"), false);
  assert.ok(catalogue.enabledFor("ending").some((c) => c.code === "contract_custom"));
});

test("api_signals: snake_case mapped; empty category means none", () => {
  const catalogue = build({
    checks: {
      refusal_safety: {
        api_signals: [
          { api: "openai-responses", stop_reason: "refusal", category: "violence" },
          { stop_reason: "refusal", category: "" },
          { stop_reason: "blocked" },
        ],
      },
    },
  });
  assert.deepEqual(catalogue.get("refusal_safety")!.apiSignals, [
    { api: "openai-responses", stopReason: "refusal", category: "violence" },
    { stopReason: "refusal", category: null },
    { stopReason: "blocked" },
  ]);
});

test("per-agent overrides: deep merge over the global entry, other agents unaffected", () => {
  const catalogue = build({
    checks: { refusal_persona: { remedy: "observe" } },
    agents: {
      agent_a: { workspace_root: "/a", checks: { refusal_persona: { enabled: false } } },
      agent_b: { workspace_root: "/b" },
    },
  });
  const a = catalogue.get("refusal_persona", "agent_a")!;
  assert.equal(a.enabled, false);
  assert.equal(a.remedy, "observe", "the global override still applies");
  assert.equal(catalogue.get("refusal_persona", "agent_b")!.enabled, true);
  assert.equal(catalogue.get("refusal_persona")!.enabled, true);
  assert.equal(catalogue.get("refusal_persona", "unknown_agent")!.enabled, true, "unknown agent = global");
  assert.equal(catalogue.get("refusal_persona", null)!.enabled, true);
  assert.ok(!catalogue.enabledFor("send", "agent_a").some((c) => c.code === "refusal_persona"));
});

test("per-agent overrides: only existing codes", () => {
  assert.throws(
    () => build({ agents: { agent_a: { workspace_root: "/a", checks: { style_new: { kind: "style" } } } } }),
    /\[agents\.agent_a\.checks\.style_new\]: no check "style_new" exists/,
  );
  const ok = build({
    checks: { style_new: { kind: "style", enabled: false } },
    agents: { agent_a: { workspace_root: "/a", checks: { style_new: { enabled: true } } } },
  });
  assert.equal(ok.get("style_new", "agent_a")!.enabled, true);
  assert.equal(ok.get("style_new")!.enabled, false);
});

test("validation: startup errors name the table", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ x: { description: "no kind" } }, /\[checks\.x\]: kind is required/],
    [{ x: { kind: "nonsense" } }, /\[checks\.x\]: unknown kind "nonsense"/],
    [{ x: { kind: "style", remedy: "fix" } }, /unknown remedy "fix"/],
    [{ x: { kind: "style", checkpoints: ["later"] } }, /unknown checkpoint "later"/],
    [{ x: { kind: "style", questions: [question({ source: "elsewhere" })] } }, /questions\[0\]: unknown source "elsewhere"/],
    [{ x: { kind: "refusal" } }, /\[checks\.x\]: a refusal check needs a reason/],
    [{ x: { kind: "refusal", reason: "r", remedy: "revise" } }, /remedy "revise" is not allowed on a refusal check/],
    [{ refusal_persona: { remedy: "revise" } }, /\[checks\.refusal_persona\]: remedy "revise"/],
    [{ x: { kind: "style", remedy: "redo" } }, /remedy "redo" is not allowed on a style check/],
    [{ x: { kind: "style", patterns: ["ok", "(unclosed"] } }, /\[checks\.x\]\.patterns\[1\]: invalid regular expression/],
    [{ x: { kind: "style", questions: [question({ threshold: 1.5 })] } }, /questions\[0\]: threshold must be in 0\.\.1/],
    [{ x: { kind: "style", questions: [question({ threshold: -0.1 })] } }, /threshold must be in 0\.\.1/],
    [{ x: { kind: "style", reason: "r" } }, /reason applies only to refusal checks/],
    [{ x: { kind: "style", api_signals: [{ stop_reason: "refusal" }] } }, /api_signals apply only to refusal checks/],
    [{ x: { kind: "contract", min_chars: 10 } }, /min_chars applies only to style checks/],
    [{ x: { kind: "style", checkpoints: [] } }, /checkpoints must not be empty/],
    [{ refusal_safety: { kind: "style" } }, /cannot change the kind of check "refusal_safety"/],
  ];
  for (const [checks, re] of cases) {
    assert.throws(() => build({ checks }), re, JSON.stringify(checks));
  }
  assert.throws(
    () =>
      build({
        agents: { agent_a: { workspace_root: "/a", checks: { refusal_persona: { remedy: "revise" } } } },
      }),
    /\[agents\.agent_a\.checks\.refusal_persona\]: remedy "revise"/,
  );
});

test("patterns: (?i) prefix, unicode classes; words: boundaries, phrases, case", () => {
  assert.equal(compileCheckPattern("(?i)\\bdelve\\b").test("We DELVE in"), true);
  assert.equal(compileCheckPattern("\\bdelve\\b").test("We DELVE in"), false);
  assert.equal(compileCheckPattern("\\p{Extended_Pictographic}").test("ok 🎉"), true);
  const words = compileWordList(["delve", "testament to", "tapestry", ""])!;
  assert.equal("a rich Tapestry of".match(words)?.[0], "Tapestry");
  assert.equal("a testament  to it".match(words)?.[0], "testament  to");
  assert.equal(words.test("delved"), false, "whole words only");
  assert.equal(words.test("undelve"), false);
  assert.equal(words.test("über delve!"), true);
  assert.equal(compileWordList([]), undefined);
  assert.equal(compileWordList(["a.b"])!.test("axb"), false, "regex metacharacters are escaped");
});

test("firstPatternMatch: patterns first, then the word list", () => {
  const catalogue = build({
    checks: {
      style_a: { kind: "style", patterns: ["—"], words: ["delve"] },
      style_b: { kind: "style", words: ["tapestry", "delve"] },
    },
  });
  const a = catalogue.get("style_a")!;
  const b = catalogue.get("style_b")!;
  assert.equal(firstPatternMatch(a, "let's delve — now"), "—");
  assert.equal(firstPatternMatch(a, "let's Delve now"), "Delve");
  assert.equal(firstPatternMatch(a, "plain text"), undefined);
  assert.equal(firstPatternMatch(b, "a tapestry"), "tapestry");
  const bare: CheckDefinition = { ...b, words: [], patterns: [] };
  assert.equal(firstPatternMatch(bare, "a tapestry"), undefined);
});

test("catalogueReasons: built-in and operator reasons across agents", () => {
  const catalogue = build({
    checks: { refusal_custom: { kind: "refusal", reason: "policy_x" } },
    agents: { agent_a: { workspace_root: "/a", checks: { refusal_custom: { reason: "policy_y" } } } },
  });
  const reasons = catalogueReasons(catalogue, ["agent_a"]);
  for (const r of ["distillation", "unclear", "policy_x", "policy_y"]) assert.ok(reasons.has(r), r);
});
