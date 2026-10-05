/**
 * Behaviour snapshots and change events (spec REFUSAL-HANDLING §12.4 source 1):
 * snapshot resolution without credentials, determinism, the structured diff into
 * typed events, the generic fallback, and storage.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildCheckCatalogue } from "../src/checks/catalogue.js";
import { diffBehaviourSnapshots, listBehaviourChanges, recordBehaviourSnapshot } from "../src/behaviour/changes.js";
import { buildBehaviourSnapshot, canonicalJson, snapshotHash, type BehaviourSnapshot } from "../src/behaviour/snapshot.js";
import { BUILD_REVISION_ENV, resolveCodeVersion } from "../src/behaviour/version.js";
import { Storage } from "../src/storage/index.js";

const SECRET = "sk-test-secret-value";
const model = (id: string, extra: Record<string, unknown> = {}) => ({
  id, provider: "test", endpoint: "https://upstream.invalid/v1?key=" + SECRET, api_key: SECRET,
  input_modalities: ["text"], max_tokens: 1000, ...extra,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function config(over: (c: any) => void = () => {}): any {
  const c = {
    models: {
      default: model("m-default", { fallback: ["model_b"] }),
      model_a: model("m-a", { thinking_level: "medium", fallback: ["model_b"], family: "fam_a" }),
      model_b: model("m-b"),
      model_c: model("m-c"),
      open_model_x: model("m-x"),
      decider: { ...model("d"), api: "system-one" },
    },
    agent: {
      sessions: { forced_completion_retries: 3 },
      session_types: { default: { model: "model_a" }, proactive: {}, research: { model: "model_c" } },
    },
    agents: {
      agent_a: { workspace_root: "/a" },
      agent_b: { workspace_root: "/b", models: { session_types: { default: "model_b" } } },
    },
    matrix: { accounts: { acc_a: { agent: "agent_a" }, acc_b: { agent: "agent_b" } } },
    user_limits: [{ user: "@u:x", models: ["model_a", "model_b"], agent: "agent_a" }],
    decisions: {
      enabled: true,
      model: "decider",
      routing: { enabled: true, tasks: { coding: { description: "code", models: ["model_c"] } } },
    },
    refusal_fallback: [{ name: "distill", reasons: ["distillation"], models: ["open_model_x"] }],
    checks: { style_x: { kind: "style", words: ["delve"] } },
  };
  over(c);
  return c;
}

const code = { version: "1.0.0", revision: "abc123" };
const snap = (c = config()) => buildBehaviourSnapshot({ config: c, catalogue: buildCheckCatalogue(c), code });

test("snapshot: resolved per agent and site, credentials and endpoints never included", () => {
  const s = snap();
  const json = canonicalJson(s);
  assert.ok(!json.includes(SECRET), "no api key or endpoint");
  assert.ok(!json.includes("upstream.invalid"));
  assert.deepEqual(Object.keys(s.agents).sort(), ["agent_a", "agent_b"]);
  // agent_a: global default type → model_a (thinking medium, fallback model_b).
  assert.deepEqual(s.agents.agent_a!.sites.default, { head: "model_a", fallbacks: ["model_b"], thinking: "medium" });
  // agent_b overrides the default type's model.
  assert.equal(s.agents.agent_b!.sites.default!.head, "model_b");
  assert.equal(s.agents.agent_a!.sites.research!.head, "model_c");
  // A declared type block without a model resolves to the literal "default".
  assert.equal(s.agents.agent_a!.sites.proactive!.head, "default");
  // Per-user preference list scoped to agent_a only.
  assert.equal(s.agents.agent_a!.preferences.length, 1);
  assert.equal(s.agents.agent_b!.preferences.length, 0);
  assert.deepEqual(s.agents.agent_a!.tasks.coding!.models, ["model_c"]);
  assert.ok(s.agents.agent_a!.checks.refusal_distillation, "enabled built-in checks listed");
  assert.equal(s.agents.agent_a!.checks.style_x!.kind, "style");
  assert.deepEqual(s.agents.agent_a!.decisions.points.routing, { enabled: true, chain: ["decider"] });
  assert.deepEqual(s.rules.distill!.models, [{ model: "open_model_x", tries: 1 }]);
  assert.equal(s.models.model_a!.family, "fam_a");
  assert.deepEqual(s.code, code);
});

test("snapshot: deterministic hash; key order and moved sources do not change it", () => {
  const a = snap();
  const reordered = config((c) => {
    c.models = Object.fromEntries(Object.entries(c.models).reverse());
    c.agents = { agent_b: c.agents.agent_b, agent_a: c.agents.agent_a };
  });
  assert.equal(snapshotHash(snap(reordered)), snapshotHash(a));
  // A different secret / endpoint (e.g. a renamed ${VAR}) is not a behaviour change.
  const rekeyed = config((c) => {
    for (const m of Object.values(c.models) as Array<Record<string, unknown>>) {
      m.api_key = "other";
      m.endpoint = "https://elsewhere.invalid";
    }
  });
  assert.equal(snapshotHash(snap(rekeyed)), snapshotHash(a));
  assert.deepEqual(diffBehaviourSnapshots(a, snap(rekeyed)), []);
});

test("snapshot: legacy single-agent mode uses one agent key", () => {
  const s = snap(config((c) => delete c.agents));
  assert.deepEqual(Object.keys(s.agents), [""]);
  assert.equal(s.agents[""]!.sites.default!.head, "model_a");
});

const kinds = (events: Array<{ kind: string }>) => events.map((e) => e.kind).sort();

test("diff: head model, chain and thinking changes per agent and site", () => {
  const prev = snap();
  // A shared block change (the global default type's model) yields one event per
  // agent and site it reaches: agent_a's default site and the worker types that fall
  // back to it; agent_b overrides the default type, so none for agent_b.
  const next = snap(config((c) => (c.agent.session_types.default.model = "model_c")));
  const events = diffBehaviourSnapshots(prev, next);
  const heads = events.filter((e) => e.kind === "head_model_changed");
  assert.deepEqual(heads.map((e) => e.sites[0]).sort(), ["condense", "default", "diary", "summarize"]);
  assert.ok(heads.every((e) => e.agents.length === 1 && e.agents[0] === "agent_a"));
  assert.ok(heads.some((e) => /^agent agent_a, default: head model model_a → model_c \(thinking medium → off\)$/.test(e.sentence)));

  // model_a's fallback edit: one chain_changed per agent/site whose head is model_a.
  // (agent_a's default, summarize, condense and diary sites all resolve to model_a.)
  const chain = diffBehaviourSnapshots(prev, snap(config((c) => (c.models.model_a.fallback = ["model_b", "model_c"]))));
  assert.deepEqual(kinds(chain), ["chain_changed", "chain_changed", "chain_changed", "chain_changed"]);
  assert.match(chain.find((e) => e.sites[0] === "default")!.sentence, /^agent agent_a, default: fallbacks now model_b, model_c \(was model_b\)$/);
  assert.ok(chain.every((e) => e.agents[0] === "agent_a" && e.models.includes("model_a") && e.models.includes("model_c")));

  const thinking = diffBehaviourSnapshots(prev, snap(config((c) => (c.models.model_a.thinking_level = "high"))));
  assert.deepEqual([...new Set(kinds(thinking))], ["thinking_changed"]);
  assert.equal(thinking.length, 4);
  assert.ok(thinking.some((e) => e.sentence === "agent agent_a, default on model_a: thinking medium → high"));

  // A model no site heads (the rule's open_model_x) reports its own change once.
  const ruleModel = diffBehaviourSnapshots(prev, snap(config((c) => (c.models.open_model_x.thinking_level = "low"))));
  assert.deepEqual(ruleModel.map((e) => [e.kind, e.sentence]), [["thinking_changed", "open_model_x: thinking off → low"]]);
});

test("diff: preference, routing task, rule and check events", () => {
  const prev = snap();
  const pref = diffBehaviourSnapshots(prev, snap(config((c) => (c.user_limits[0].models = ["model_b", "model_a"]))));
  assert.deepEqual(kinds(pref), ["preference_changed"]);
  assert.match(pref[0]!.sentence, /agent agent_a: user preference list changed \(list #1 \(user=@u:x\): model_b moved to first\)/);
  assert.deepEqual(pref[0]!.models.sort(), ["model_a", "model_b"]);

  const task = diffBehaviourSnapshots(prev, snap(config((c) => (c.decisions.routing.tasks.coding.models = ["model_c", "model_b"]))));
  assert.deepEqual(kinds(task), ["routing_task_changed", "routing_task_changed"], "one per agent sharing the task list");
  assert.match(task[0]!.sentence, /task `coding`: models now model_c, model_b \(was model_c\)/);

  const rule = diffBehaviourSnapshots(prev, snap(config((c) => c.refusal_fallback.push({ name: "any", models: ["model_b"] }))));
  assert.deepEqual(kinds(rule), ["rule_changed"]);
  assert.equal(rule[0]!.sentence, "rule `any`: added (models model_b)");

  const check = diffBehaviourSnapshots(prev, snap(config((c) => (c.checks.style_x.remedy = "observe"))));
  assert.deepEqual(kinds(check), ["check_changed", "check_changed"]);
  assert.match(check[0]!.sentence, /check `style_x`: remedy revise → observe/);
  const disabled = diffBehaviourSnapshots(prev, snap(config((c) => (c.checks.style_x.enabled = false))));
  assert.match(disabled[0]!.sentence, /check `style_x`: disabled/);
});

test("diff: code change, generic config_changed fallback, version change suppresses structural events", () => {
  const prev = snap();
  const nextCode = buildBehaviourSnapshot({ config: config(), catalogue: buildCheckCatalogue(config()), code: { version: "1.0.0", revision: "def456" } });
  const events = diffBehaviourSnapshots(prev, nextCode);
  assert.deepEqual(kinds(events), ["code_changed"]);
  assert.equal(events[0]!.sentence, "deploy: 1.0.0+abc123 → 1.0.0+def456");

  // Upstream wire id change of a model block: generic, names the resolved path.
  const wire = diffBehaviourSnapshots(prev, snap(config((c) => (c.models.model_b.id = "m-b-2")))).filter((e) => e.kind === "config_changed");
  assert.equal(wire.length, 1);
  assert.equal(wire[0]!.path, "models.model_b.id");
  assert.equal(wire[0]!.sentence, "models.model_b.id: m-b → m-b-2");
  assert.deepEqual(wire[0]!.models, ["model_b"]);

  // Forced-completion retries: generic per agent.
  const retries = diffBehaviourSnapshots(prev, snap(config((c) => (c.agent.sessions.forced_completion_retries = 2))));
  assert.deepEqual(kinds(retries), ["config_changed", "config_changed"]);
  assert.equal(retries[0]!.path, "agents.agent_a.contract.forcedCompletionRetries");

  const other: BehaviourSnapshot = { ...snap(config((c) => (c.models.model_b.id = "zzz"))), version: 999 };
  assert.deepEqual(diffBehaviourSnapshots(prev, other), []);
});

test("recordBehaviourSnapshot: first snapshot has no events, unchanged is skipped, a change stores events", async () => {
  const storage = await Storage.open({ databasePath: ":memory:" });
  try {
    const first = await recordBehaviourSnapshot(storage, snap(), 1_000);
    assert.equal(first.changed, true);
    assert.deepEqual(first.events, []);
    const again = await recordBehaviourSnapshot(storage, snap(), 2_000);
    assert.equal(again.changed, false);
    assert.equal(again.snapshotId, first.snapshotId);
    const next = await recordBehaviourSnapshot(storage, snap(config((c) => (c.agent.session_types.research.model = "model_b"))), 3_000);
    assert.equal(next.changed, true);
    assert.equal(next.events.length, 2, "research head changed for both agents");
    const stored = listBehaviourChanges(storage, 0, 10_000);
    assert.equal(stored.length, 2);
    assert.equal(stored[0]!.kind, "head_model_changed");
    assert.equal(stored[0]!.ts, 3_000);
    assert.equal(stored[0]!.old, "model_c");
    assert.equal(stored[0]!.new, "model_b");
    assert.deepEqual(stored[0]!.sites, ["research"]);
    const count = storage.read((db) => (db.prepare("select count(*) as n from behaviour_snapshots").get() as { n: number }).n);
    assert.equal(count, 2);
  } finally {
    await storage.waitForIdle();
    storage.close();
  }
});

test("resolveCodeVersion: baked revision wins, then git, else unknown", () => {
  const baked = resolveCodeVersion({ env: { [BUILD_REVISION_ENV]: "rev42" } });
  assert.equal(baked.revision, "rev42");
  assert.match(baked.version, /^\d+\.\d+\.\d+/);
  const none = resolveCodeVersion({ env: {}, cwd: "/" });
  assert.equal(none.revision, "unknown");
});
