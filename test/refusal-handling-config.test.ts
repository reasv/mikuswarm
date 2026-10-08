/**
 * Refusal-handling config (spec REFUSAL-HANDLING §4.4, §6, §8.1, §12.3): the
 * TOML tables load through the schema, and the `checks` decision point is
 * merged, resolved and validated like the other points.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config/index.js";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { normalizeRefusalRules, validateRefusalRules } from "../src/refusals/rules.js";
import {
  anyDecisionPointEnabled,
  checksPointKnobs,
  decisionsFor,
  duplicateKnobs,
  pointSettings,
  validateDecisionsConfig,
} from "../src/decisions/config.js";

const BASE_CONFIG = `
[app]
name = "mikuswarm"
data_dir = "./var"
log_level = "info"
context_dump_dir = "./debug/context"

[agent.sessions]
max_concurrent = 1
max_concurrent_dm = 1
forced_completion_retries = 0

[agent.system]

[models.default]
id = "test-model"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[workspace]
root_dir = "./workspaces/test"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.test]
homeserver = "http://localhost"
user_id = "@test:localhost"
store_path = "./var/test"

[summarization]
enabled = false
`;

async function load(extra: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-rh-config-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), BASE_CONFIG, "utf8");
    await writeFile(path.join(dir, "90-test.toml"), extra, "utf8");
    return await loadConfig(dir, { env: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("TOML: checks, rules, decisions.checks, model family and forced_completion_redo load", async () => {
  const config = await load(`
[agent.sessions]
forced_completion_redo = true

[models.default]
family = "family_a"

[models.open_model_x]
id = "open-x"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1024

[checks.refusal_distillation]
description = "Declined as reasoning extraction"
api_signals = [ { api = "anthropic-messages", stop_reason = "refusal", category = "reasoning_extraction" } ]

  [[checks.refusal_distillation.questions]]
  source = "message"
  instructions = "The assistant declines because it would reveal its reasoning."
  criteria = { true = "declines", false = "answers" }
  threshold = 0.8

[checks.style_vocab]
kind = "style"
enabled = false
agent_explanation = "Uses stock vocabulary ({matched})."
words = ["delve", "tapestry"]
patterns = ["(?i)\\\\bin the realm of\\\\b"]
min_chars = 20

[[refusal_fallback]]
name = "distillation"
reasons = ["distillation"]
models = [{ model = "@same", tries = 2 }, "open_model_x", { model = "open_model_x" }]
on_exhausted = "withhold"

[decisions.checks]
send_deadline_ms = 4000
style_min_chars = 30
`);
  assert.equal(config.agent.sessions.forced_completion_redo, true);
  assert.equal(config.models.default.family, "family_a");
  const catalogue = buildCheckCatalogue(config);
  const distill = catalogue.get("refusal_distillation")!;
  assert.equal(distill.questions.length, 1);
  assert.equal(distill.reason, "distillation");
  const vocab = catalogue.get("style_vocab")!;
  assert.equal(vocab.patterns[0]!.test("In The Realm Of"), true);
  assert.deepEqual(vocab.words, ["delve", "tapestry"]);
  assert.equal(vocab.minChars, 20);
  validateRefusalRules(config, catalogue);
  assert.deepEqual(normalizeRefusalRules(config), [
    {
      name: "distillation",
      reasons: ["distillation"],
      models: [
        { model: "@same", tries: 2 },
        { model: "open_model_x", tries: 1 },
        { model: "open_model_x", tries: 1 },
      ],
      soft: "redo",
      onExhausted: "withhold",
      index: 0,
    },
  ]);
  const knobs = checksPointKnobs(decisionsFor(config, null));
  assert.equal(knobs.sendDeadlineMs, 4000);
  assert.equal(knobs.styleMinChars, 30);
});

test("TOML: unknown kind / remedy / source / checkpoint and bad thresholds fail at load", async () => {
  const bad: Array<[string, RegExp]> = [
    [`[checks.x]\nkind = "vibe"\n`, /\/checks\/x\/kind/],
    [`[checks.x]\nkind = "style"\nremedy = "fix"\n`, /\/checks\/x\/remedy/],
    [`[checks.x]\nkind = "style"\ncheckpoints = ["later"]\n`, /\/checks\/x\/checkpoints\/0/],
    [`[checks.x]\nkind = "style"\n[[checks.x.questions]]\nsource = "nowhere"\ninstructions = "i"\ncriteria = { true = "a", false = "b" }\nthreshold = 0.5\n`, /\/checks\/x\/questions\/0\/source/],
    [`[checks.x]\nkind = "style"\n[[checks.x.questions]]\nsource = "message"\ninstructions = "i"\ncriteria = { true = "a", false = "b" }\nthreshold = 1.5\n`, /\/checks\/x\/questions\/0\/threshold/],
    [`[checks.x]\nkind = "style"\nmystery = 1\n`, /checks\.x\.mystery is not a recognized config key/],
    [`[[refusal_fallback]]\nname = "a"\nmodels = []\n`, /\/refusal_fallback\/0\/models/],
    [`[[refusal_fallback]]\nname = "a"\nmodels = ["default"]\nsoft = "maybe"\n`, /\/refusal_fallback\/0\/soft/],
    [`[[refusal_fallback]]\nname = "a"\nmodels = ["default"]\non_exhausted = "explode"\n`, /\/refusal_fallback\/0\/on_exhausted/],
    [`[[refusal_fallback]]\nname = "a"\nmodels = [{ model = "default", tries = 0 }]\n`, /\/refusal_fallback\/0\/models\/0/],
    [`[[refusal_fallback]]\nname = "a"\nmodels = [{ model = "default", tries = 11 }]\n`, /\/refusal_fallback\/0\/models\/0/],
    [`[[refusal_fallback]]\nname = "a"\nmodels = [{ model = "default", tries = 1.5 }]\n`, /\/refusal_fallback\/0\/models\/0/],
    [`[[refusal_fallback]]\nname = "a"\nmodels = [{ model = "default", weight = 2 }]\n`, /refusal_fallback/],
    [`[decisions.checks]\nsend_deadline_ms = -1\n`, /\/decisions\/checks\/send_deadline_ms/],
  ];
  for (const [extra, re] of bad) {
    await assert.rejects(load(extra), re, extra);
  }
});

test("defaults: knobs without a [decisions.checks] table", () => {
  assert.deepEqual(checksPointKnobs({}), {
    sendDeadlineMs: 5000,
    endingDeadlineMs: 15000,
    backgroundDeadlineMs: 30000,
    styleMinChars: 40,
    reviseMaxConsecutive: 2,
    reviseMaxPerSession: 6,
    recentMessages: 6,
    thinkingTailTokens: 800,
  });
});

const decider = { id: "vendor/decider", provider: "p", api: "system-one", endpoint: "https://gw.example/d", api_key: "k" };
const chat = { id: "chat", provider: "p", endpoint: "https://chat.example", api_key: "k" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cfg(over: Record<string, unknown> = {}): any {
  return { models: { default: chat, decider }, agent: { session_types: {} }, ...over };
}

test("decisions: the checks point merges per agent and resolves like other points", () => {
  const config = cfg({
    decisions: { enabled: true, model: "decider", checks: { enabled: false, send_deadline_ms: 3000 } },
    agents: { agent_a: { workspace_root: "/a", decisions: { checks: { enabled: true, recent_messages: 2 } } } },
  });
  assert.equal(pointSettings(decisionsFor(config, null), "checks"), undefined, "off globally");
  const a = decisionsFor(config, "agent_a");
  assert.equal(a.checks?.send_deadline_ms, 3000, "global knob carried through");
  assert.equal(a.checks?.recent_messages, 2);
  const settings = pointSettings(a, "checks")!;
  assert.equal(settings.point, "checks");
  assert.equal(settings.model, "decider");
  assert.equal(checksPointKnobs(a).recentMessages, 2);
  assert.equal(anyDecisionPointEnabled(config), true);
  validateDecisionsConfig(config);
});

test("decisions: judged checks need [decisions].enabled AND [decisions.checks].enabled", () => {
  assert.equal(anyDecisionPointEnabled(cfg({ decisions: { model: "decider", checks: { enabled: true } } })), false);
  // The memory point is on by default whenever [decisions] is (ARCHITECTURE.md §9d).
  assert.equal(anyDecisionPointEnabled(cfg({ decisions: { enabled: true, model: "decider", memory: { enabled: false } } })), false);
  assert.equal(anyDecisionPointEnabled(cfg({ decisions: { enabled: true, model: "decider" } })), true);
});

test("decisions: checks point validation", () => {
  assert.throws(
    () => validateDecisionsConfig(cfg({ decisions: { enabled: true, checks: { enabled: true } } })),
    /decisions\.checks is enabled but neither it nor decisions names a decision model/,
  );
  assert.throws(
    () => validateDecisionsConfig(cfg({ decisions: { checks: { model: "default" } } })),
    /decisions\.checks\.model = "default" must name a model with api = "system-one"/,
  );
  assert.throws(
    () => validateDecisionsConfig(cfg({ decisions: { checks: { min_confidence: 0.5 } } })),
    /checks\.min_confidence is not used by the checks point/,
  );
});

test("TOML: the duplicate check's table, named questions, thresholds and [decisions.checks.duplicate] load", async () => {
  const config = await load(`
[models.decider]
id = "decider-1"
provider = "test"
api = "system-one"
endpoint = "http://localhost/decisions"
api_key = "k"
input_modalities = ["text"]
max_tokens = 1

[checks.duplicate]
enabled = true
thresholds = { repeats = 0.9 }

[checks.same_link]
kind = "duplicate"
  [[checks.same_link.questions]]
  name = "same_link"
  source = "message"
  instructions = "\`draft.text\` posts a link one of \`earlier[*].text\` already posted."
  criteria = { true = "the same link", false = "no link in common" }
  threshold = 0.7

[decisions]
enabled = true

[decisions.checks]
enabled = true
model = "decider"

[decisions.checks.duplicate]
max_earlier = 3
earlier_max_tokens = 800
`);
  const catalogue = buildCheckCatalogue(config);
  assert.deepEqual(catalogue.get("duplicate")!.questions.map((q) => q.threshold), [0.8, 0.9, 0.8]);
  assert.equal(catalogue.get("same_link")!.questions[0]!.name, "same_link");
  assert.deepEqual(duplicateKnobs(decisionsFor(config, null)), { model: "decider", maxEarlier: 3, earlierMaxTokens: 800 });
  validateDecisionsConfig(config);
});

test("decisions: the duplicate chain defaults to [decisions].model and is validated", () => {
  assert.deepEqual(duplicateKnobs(cfg({ decisions: { model: "decider", checks: { model: "judge" } } }).decisions), {
    model: "decider",
    maxEarlier: 5,
    earlierMaxTokens: 1500,
  });
  assert.equal(duplicateKnobs({ checks: { model: "judge" } } as never).model, "judge", "without [decisions].model: the point's");
  assert.equal(duplicateKnobs({ model: "decider", checks: { duplicate: { model: "other" } } } as never).model, "other");
  assert.throws(
    () => validateDecisionsConfig(cfg({ decisions: { checks: { duplicate: { model: "default" } } } })),
    /decisions\.checks\.duplicate\.model = "default" must name a model with api = "system-one"/,
  );
});
