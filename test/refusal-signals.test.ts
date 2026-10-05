/**
 * Hard-refusal classification (spec REFUSAL-HANDLING §4.2, §5.1): built-in API
 * signals, precedence, operator mappings, unknown categories.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { classifyApiRefusal, UNCATEGORIZED_REFUSAL_CODE } from "../src/refusals/signals.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const catalogueOf = (config: any = {}) => buildCheckCatalogue(config);
const ANTHROPIC = "anthropic-messages";

test("built-ins: Anthropic categories map to their reasons", () => {
  const c = catalogueOf();
  assert.deepEqual(classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category: "reasoning_extraction" }), {
    checkCode: "refusal_distillation",
    reason: "distillation",
    subReason: "reasoning_extraction",
    method: "provider_category",
  });
  for (const category of ["cyber", "bio", "Cyber"]) {
    const r = classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category })!;
    assert.equal(r.checkCode, "refusal_safety", category);
    assert.equal(r.method, "provider_category");
    assert.equal(r.subReason, category, "the raw category is recorded");
  }
});

test("built-ins: an Anthropic refusal with no or an unknown category is uncategorized", () => {
  const c = catalogueOf();
  for (const category of [null, undefined, "", "   "]) {
    assert.deepEqual(classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category }), {
      checkCode: UNCATEGORIZED_REFUSAL_CODE,
      reason: "unclear",
      subReason: "refusal",
      method: "stop_reason",
    });
  }
  assert.deepEqual(classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category: "brand_new" }), {
    checkCode: UNCATEGORIZED_REFUSAL_CODE,
    reason: "unclear",
    subReason: "brand_new",
    method: "stop_reason",
  });
});

test("built-ins: filter stop reasons, case-insensitive, with or without api", () => {
  const c = catalogueOf();
  const cases: Array<[string, string | undefined, string]> = [
    ["sensitive", ANTHROPIC, "refusal_safety"],
    ["content_filter", "openai-completions", "refusal_safety"],
    ["incomplete.content_filter", "openai-responses", "refusal_safety"],
    ["content_filtered", undefined, "refusal_safety"],
    ["guardrail_intervened", undefined, "refusal_safety"],
    ["SAFETY", "google-generative-ai", "refusal_safety"],
    ["safety", "google-generative-ai", "refusal_safety"],
    ["PROHIBITED_CONTENT", undefined, "refusal_safety"],
    ["blocklist", undefined, "refusal_safety"],
    ["SPII", "google-generative-ai", "refusal_privacy"],
  ];
  for (const [stop, api, code] of cases) {
    const r = classifyApiRefusal(c, { api, rawStopReason: stop });
    assert.equal(r?.checkCode, code, stop);
    assert.equal(r?.method, "stop_reason");
    assert.equal(r?.subReason, stop);
  }
  assert.equal(classifyApiRefusal(c, { rawStopReason: "stop" }), undefined, "not a refusal");
  assert.equal(classifyApiRefusal(c, { rawStopReason: "length" }), undefined);
});

test("api restriction: a category signal for another api does not match", () => {
  const c = catalogueOf();
  // Category signals name anthropic-messages; through another api the refusal is uncategorized.
  const r = classifyApiRefusal(c, { api: "openai-completions", rawStopReason: "refusal", category: "cyber" })!;
  assert.equal(r.checkCode, UNCATEGORIZED_REFUSAL_CODE);
  assert.equal(r.subReason, "cyber");
  // An unknown api (not passed) still matches an api-restricted signal.
  assert.equal(classifyApiRefusal(c, { rawStopReason: "refusal", category: "cyber" })!.checkCode, "refusal_safety");
});

test("operator mappings: a new category on an operator check", () => {
  const c = catalogueOf({
    checks: {
      refusal_policy: {
        kind: "refusal",
        reason: "policy_x",
        api_signals: [{ api: ANTHROPIC, stop_reason: "refusal", category: "new_category" }],
      },
    },
  });
  assert.deepEqual(classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category: "new_category" }), {
    checkCode: "refusal_policy",
    reason: "policy_x",
    subReason: "new_category",
    method: "provider_category",
  });
});

test("precedence: exact category > category-less > uncategorized; operator beats built-in on a tie", () => {
  // A category-less operator mapping of `refusal` beats the uncategorized catch-all
  // but loses to an exact category match.
  const c = catalogueOf({
    checks: {
      refusal_any: { kind: "refusal", reason: "policy_any", api_signals: [{ stop_reason: "refusal" }] },
    },
  });
  assert.equal(classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal" })!.checkCode, "refusal_any");
  assert.equal(classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category: "odd" })!.checkCode, "refusal_any");
  assert.equal(
    classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category: "cyber" })!.checkCode,
    "refusal_safety",
  );
  // Same specificity as a built-in signal: the operator check wins.
  const tie = catalogueOf({
    checks: {
      refusal_mine: {
        kind: "refusal",
        reason: "policy_mine",
        api_signals: [{ api: ANTHROPIC, stop_reason: "refusal", category: "cyber" }],
      },
    },
  });
  assert.equal(classifyApiRefusal(tie, { api: ANTHROPIC, rawStopReason: "refusal", category: "cyber" })!.checkCode, "refusal_mine");
  // A signal naming the request's api beats an otherwise equal one that names none.
  const apiFirst = catalogueOf({
    checks: {
      refusal_a: { kind: "refusal", reason: "a", api_signals: [{ stop_reason: "blocked" }] },
      refusal_b: { kind: "refusal", reason: "b", api_signals: [{ api: "openai-completions", stop_reason: "blocked" }] },
    },
  });
  assert.equal(classifyApiRefusal(apiFirst, { api: "openai-completions", rawStopReason: "blocked" })!.checkCode, "refusal_b");
  assert.equal(classifyApiRefusal(apiFirst, { api: "openai-responses", rawStopReason: "blocked" })!.checkCode, "refusal_a");
});

test("explicit no-category signal matches only a category-less refusal", () => {
  const c = catalogueOf({
    checks: {
      refusal_bare: { kind: "refusal", reason: "bare", api_signals: [{ stop_reason: "refusal", category: "" }] },
    },
  });
  assert.equal(classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal" })!.checkCode, "refusal_bare");
  assert.equal(
    classifyApiRefusal(c, { api: ANTHROPIC, rawStopReason: "refusal", category: "weird" })!.checkCode,
    UNCATEGORIZED_REFUSAL_CODE,
  );
});

test("per-agent mappings and disabled checks", () => {
  const c = catalogueOf({
    checks: { refusal_safety: { enabled: false } },
    agents: {
      agent_a: {
        workspace_root: "/a",
        checks: { refusal_persona: { api_signals: [{ stop_reason: "content_filter" }] } },
      },
    },
  });
  // A disabled check still classifies its API signals (hard refusals are always recorded).
  assert.equal(classifyApiRefusal(c, { rawStopReason: "content_filter" })!.checkCode, "refusal_safety");
  // agent_a maps content_filter to persona as well: same specificity, both built-in, catalogue order wins.
  assert.equal(classifyApiRefusal(c, { rawStopReason: "content_filter" }, "agent_a")!.checkCode, "refusal_safety");
  const custom = catalogueOf({
    checks: { refusal_policy: { kind: "refusal", reason: "p", api_signals: [] } },
    agents: {
      agent_a: { workspace_root: "/a", checks: { refusal_policy: { api_signals: [{ stop_reason: "content_filter" }] } } },
    },
  });
  assert.equal(classifyApiRefusal(custom, { rawStopReason: "content_filter" }, "agent_a")!.checkCode, "refusal_policy");
  assert.equal(classifyApiRefusal(custom, { rawStopReason: "content_filter" }, "agent_b")!.checkCode, "refusal_safety");
});
