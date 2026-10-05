/**
 * `[[refusal_fallback]]` rules (spec REFUSAL-HANDLING §8.1): normalization,
 * first-match selection (sites, agents, from_models, reasons, soft/hard, tasks)
 * and startup validation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import {
  matchRefusalRule,
  normalizeRefusalRules,
  refusalRulesForSession,
  validateRefusalRules,
} from "../src/refusals/rules.js";
import type { RefusalRule } from "../src/checks/types.js";

const chatModel = (id: string) => ({ id, provider: "test", endpoint: "http://localhost", api_key: "k" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function config(over: Record<string, unknown> = {}): any {
  return {
    models: {
      default: chatModel("m-default"),
      model_a: chatModel("m-a"),
      open_model_x: chatModel("m-x"),
      open_model_y: chatModel("m-y"),
      decider: { ...chatModel("d"), api: "system-one" },
    },
    agent: { session_types: { proactive: {}, research: {} } },
    agents: { agent_a: { workspace_root: "/a" }, agent_b: { workspace_root: "/b" } },
    ...over,
  };
}

const rule = (name: string, over: Partial<RefusalRule> = {}): RefusalRule => ({
  name,
  models: [{ model: "open_model_x", tries: 1 }],
  soft: "redo",
  onExhausted: "send_last",
  index: 0,
  ...over,
});

test("normalizeRefusalRules: defaults, authored order, empty tasks dropped", () => {
  const rules = normalizeRefusalRules({
    refusal_fallback: [
      { name: "distill", reasons: ["distillation"], from_models: ["model_a"], models: ["open_model_x", "open_model_y"] },
      { name: "any", models: ["open_model_y"], soft: "observe", on_exhausted: "withhold", tasks: [] },
    ],
  });
  assert.deepEqual(rules, [
    {
      name: "distill",
      reasons: ["distillation"],
      fromModels: ["model_a"],
      models: [
        { model: "open_model_x", tries: 1 },
        { model: "open_model_y", tries: 1 },
      ],
      soft: "redo",
      onExhausted: "send_last",
      index: 0,
    },
    { name: "any", models: [{ model: "open_model_y", tries: 1 }], soft: "observe", onExhausted: "withhold", index: 1 },
  ]);
  assert.deepEqual(normalizeRefusalRules({}), []);
});

test("matchRefusalRule: first match wins; omitted conditions match anything", () => {
  const rules = [
    rule("distill", { reasons: ["distillation"], index: 0 }),
    rule("generic", { models: [{ model: "open_model_y", tries: 1 }], index: 1 }),
  ];
  const base = { site: "default", agent: "agent_a", tasks: null, fromModel: "model_a", kind: "hard" as const };
  assert.equal(matchRefusalRule(rules, { ...base, reason: "distillation" })?.name, "distill");
  assert.equal(matchRefusalRule(rules, { ...base, reason: "safety" })?.name, "generic", "no reason list = any reason");
  assert.equal(matchRefusalRule([], { ...base, reason: "safety" }), undefined);
});

test("matchRefusalRule: sites, agents, from_models", () => {
  const rules = [
    rule("jobs", { sites: ["summarize", "caption"], index: 0 }),
    rule("agent_b_only", { agents: ["agent_b"], index: 1 }),
    rule("from_a", { fromModels: ["model_a"], index: 2 }),
  ];
  const m = (over: Record<string, unknown>) =>
    matchRefusalRule(rules, { site: "default", agent: "agent_a", reason: "safety", kind: "hard", ...over })?.name;
  assert.equal(m({ site: "caption", agent: null }), "jobs");
  assert.equal(m({ agent: "agent_b" }), "agent_b_only");
  assert.equal(m({ fromModel: "model_a" }), "from_a");
  assert.equal(m({ fromModel: "open_model_y" }), undefined);
  assert.equal(m({}), undefined, "unknown refusing model never matches a from_models rule");
  assert.equal(m({ agent: null, fromModel: "x" }), undefined, "no agent never matches an agents rule");
});

test("matchRefusalRule: soft refusals match only soft = redo rules; hard ones match both", () => {
  const rules = [rule("observe", { soft: "observe", index: 0 }), rule("redo", { soft: "redo", index: 1 })];
  const input = { site: "default", agent: "agent_a", reason: "persona" };
  assert.equal(matchRefusalRule(rules, { ...input, kind: "hard" })?.name, "observe");
  assert.equal(matchRefusalRule(rules, { ...input, kind: "soft" })?.name, "redo");
  assert.equal(matchRefusalRule([rules[0]!], { ...input, kind: "soft" }), undefined);
});

test("matchRefusalRule: a rule with tasks never matches a taskless session", () => {
  const rules = [rule("coding", { tasks: ["coding"], index: 0 }), rule("rest", { index: 1 })];
  const input = { site: "default", agent: "agent_a", reason: "safety", kind: "hard" as const };
  assert.equal(matchRefusalRule(rules, { ...input, tasks: null })?.name, "rest");
  assert.equal(matchRefusalRule(rules, { ...input })?.name, "rest");
  assert.equal(matchRefusalRule(rules, { ...input, tasks: [] })?.name, "rest");
  assert.equal(matchRefusalRule(rules, { ...input, tasks: ["other", "coding"] })?.name, "coding", "any listed task");
  assert.equal(matchRefusalRule(rules, { ...input, tasks: ["other"] })?.name, "rest");
});

test("refusalRulesForSession: scope only, whatever the reason or model", () => {
  const rules = [
    rule("distill", { reasons: ["distillation"], fromModels: ["model_a"], index: 0 }),
    rule("jobs", { sites: ["summarize"], index: 1 }),
    rule("agent_b", { agents: ["agent_b"], index: 2 }),
  ];
  assert.deepEqual(
    refusalRulesForSession(rules, { site: "default", agent: "agent_a", tasks: null }).map((r) => r.name),
    ["distill"],
  );
  assert.deepEqual(
    refusalRulesForSession(rules, { site: "summarize", agent: "agent_b" }).map((r) => r.name),
    ["distill", "jobs", "agent_b"],
  );
});

test("validateRefusalRules: a valid set passes; no rules is fine", () => {
  const cfg = config({
    refusal_fallback: [
      {
        name: "distill",
        sites: ["default", "proactive", "research", "record_turn", "summarize", "condense", "diary", "caption"],
        reasons: ["distillation"],
        from_models: ["model_a"],
        agents: ["agent_a"],
        models: ["open_model_x", "open_model_y"],
      },
      { name: "generic", models: ["open_model_y"], tasks: [] },
      // Same-model retries and repeated keys (spec §8.1 tries).
      { name: "retry", models: [{ model: "@same", tries: 2 }, "open_model_x", { model: "open_model_x", tries: 10 }] },
    ],
  });
  validateRefusalRules(cfg, buildCheckCatalogue(cfg));
  validateRefusalRules(config(), buildCheckCatalogue(config()));
});

test("validateRefusalRules: operator reasons from the catalogue are known", () => {
  const cfg = config({
    checks: { refusal_policy: { kind: "refusal", reason: "policy_x" } },
    refusal_fallback: [{ name: "p", reasons: ["policy_x"], models: ["open_model_x"] }],
  });
  validateRefusalRules(cfg, buildCheckCatalogue(cfg));
});

test("validateRefusalRules: startup errors", () => {
  const cases: Array<[unknown[], RegExp, Record<string, unknown>?]> = [
    [[{ name: "a", models: ["nope"] }], /refusal_fallback\[0\] \("a"\)\.models: "nope" does not name a \[models\.\*\] block/],
    [[{ name: "a", models: ["decider"] }], /"decider" is a system-one decision model/],
    [[{ name: "a", models: [] }], /models must list at least one model/],
    [[{ name: "a", models: ["open_model_x"] }, { name: "a", models: ["open_model_y"] }], /refusal_fallback\[1\] \("a"\): duplicate rule name/],
    [[{ name: "", models: ["open_model_x"] }], /refusal_fallback\[0\]: name is required/],
    [[{ name: "a", models: ["open_model_x"], tasks: ["coding"] }], /tasks: .*phase 4/],
    [[{ name: "a", models: ["open_model_x"], agents: ["agent_z"] }], /agents: "agent_z" names no agent \(known: agent_a, agent_b\)/],
    [[{ name: "a", models: ["open_model_x"], agents: ["agent_a"] }], /names no agent \(no \[agents\] table/, { agents: undefined }],
    [[{ name: "a", models: ["open_model_x"], from_models: ["ghost"] }], /from_models: "ghost" does not name/],
    [[{ name: "a", models: ["open_model_x"], sites: ["nowhere"] }], /sites: unknown site "nowhere"/],
    [[{ name: "a", models: ["open_model_x"], reasons: ["made_up"] }], /reasons: unknown reason "made_up"/],
    [[{ name: "a", models: ["open_model_x"], sites: [] }], /sites: must not be empty/],
    [[{ name: "a", models: [{ model: "open_model_x", tries: 0 }] }], /models\[0\]: tries must be an integer from 1 to 10 \(got 0\)/],
    [[{ name: "a", models: ["open_model_x", { model: "@same", tries: 11 }] }], /models\[1\]: tries must be an integer/],
    [[{ name: "a", models: [{ model: "open_model_x", tries: 2.5 }] }], /tries must be an integer/],
    [[], /models\.@same: "@same" is reserved/, { models: { ...config().models, "@same": chatModel("m-same") } }],
  ];
  for (const [rules, re, over] of cases) {
    const cfg = config({ refusal_fallback: rules, ...(over ?? {}) });
    assert.throws(() => validateRefusalRules(cfg, buildCheckCatalogue(cfg)), re, JSON.stringify(rules));
  }
});
