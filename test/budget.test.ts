import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetEngine, makeRateLimitedClaimGate, makeChainClaimGate, makeAgentLoopChainClaimGate, type BudgetHooks, type LimitRule, type SpendDescriptor } from "../src/budget/engine.js";
import type { UsageEventInput } from "../src/storage/database.js";
import { normalizeLimits, type RawLimitRule } from "../src/budget/normalize.js";
import { parseDuration, resolveWindow, isValidTimeZone } from "../src/budget/window.js";
import { collectZeroCostModelIds, collectKnownModelIds } from "../src/budget/zero-cost.js";

const noopLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger;
  },
} as never;

// ---------------------------------------------------------------------------
// window math (§5/§6.1)
// ---------------------------------------------------------------------------

test("parseDuration: units + rejects garbage", () => {
  assert.equal(parseDuration("24h"), 24 * 3_600_000);
  assert.equal(parseDuration("7d"), 7 * 86_400_000);
  assert.equal(parseDuration("30m"), 30 * 60_000);
  assert.equal(parseDuration("1w"), 604_800_000);
  assert.throws(() => parseDuration("soon"));
  assert.throws(() => parseDuration("10"));
});

test("isValidTimeZone: real zone vs numeric offset", () => {
  assert.equal(isValidTimeZone("America/New_York"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("+09:00"), false);
  assert.equal(isValidTimeZone("Not/AZone"), false);
});

test("resolveWindow: rolling trails now; calendar day aligns to local midnight", () => {
  const now = Date.UTC(2026, 5, 15, 18, 30, 0); // 2026-06-15 18:30 UTC
  const rolling = resolveWindow({ type: "rolling", durationMs: 86_400_000, duration: "24h" }, now);
  assert.equal(rolling.start, now - 86_400_000);

  const utcDay = resolveWindow({ type: "calendar", period: "day", tz: "UTC" }, now);
  assert.equal(utcDay.start, Date.UTC(2026, 5, 15, 0, 0, 0));
  assert.equal(utcDay.resetsAt, Date.UTC(2026, 5, 16, 0, 0, 0));

  // New York is UTC-4 in June (EDT): local day starts at 04:00 UTC, resets next 04:00.
  const nyDay = resolveWindow({ type: "calendar", period: "day", tz: "America/New_York" }, now);
  assert.equal(nyDay.start, Date.UTC(2026, 5, 15, 4, 0, 0));
  assert.equal(nyDay.resetsAt, Date.UTC(2026, 5, 16, 4, 0, 0));
});

test("resolveWindow: calendar month boundary", () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const m = resolveWindow({ type: "calendar", period: "month", tz: "UTC" }, now);
  assert.equal(m.start, Date.UTC(2026, 5, 1, 0, 0, 0));
  assert.equal(m.resetsAt, Date.UTC(2026, 6, 1, 0, 0, 0));
});

// ---------------------------------------------------------------------------
// BudgetEngine (§6)
// ---------------------------------------------------------------------------

function engineWith(rules: LimitRule[], seed: Record<string, number> = {}, opts: Partial<{ zero: Set<string>; deps: Record<string, string[]>; resolve: (t: string) => string | undefined }> = {}) {
  // sumUsageCost is seeded per rule NAME via a side channel: each rule's selector is
  // distinctive enough in these tests that we key the seed by rule name through a
  // closure passed in. Simpler: seed by matching the rule's own marker.
  return new BudgetEngine({
    rules,
    sumUsageCost: () => 0,
    zeroCostModelIds: opts.zero ?? new Set(),
    dependencies: opts.deps ?? {},
    resolveModelId: opts.resolve ?? (() => "m1"),
    logger: noopLogger,
    now: () => 1_000_000,
  });
}

const dayWindow = { type: "calendar", period: "day", tz: "UTC" } as const;

test("check: own-scope layering — narrow rule trips before broad", () => {
  const rules: LimitRule[] = [
    { name: "global", maxUsd: 50, window: dayWindow, selector: {} },
    { name: "sessions", maxUsd: 30, window: dayWindow, selector: { sessionTypes: ["default", "proactive"] } },
  ];
  const engine = engineWith(rules);
  // Push the sessions rule over cap, leave global with headroom.
  engine.record({ class: "agent_loop", sessionType: "default", modelId: "m1", costUsd: 30 });
  // default session blocked by `sessions`; summarization (not in that rule) still ok.
  assert.equal(engine.check({ class: "agent_loop", sessionType: "default", modelId: "m1" }).allowed, false);
  assert.equal(engine.check({ class: "agent_loop", sessionType: "summarize", modelId: "m1" }).allowed, true);
});

test("check: global exhaustion blocks everything incl. summarization", () => {
  const rules: LimitRule[] = [{ name: "global", maxUsd: 50, window: dayWindow, selector: {} }];
  const engine = engineWith(rules);
  engine.record({ class: "agent_loop", sessionType: "summarize", modelId: "m1", costUsd: 50 });
  assert.equal(engine.check({ class: "agent_loop", sessionType: "summarize", modelId: "m1" }).allowed, false);
  const blocked = engine.check({ class: "tool", tool: "image_generate", modelId: "m1" });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.primary?.name, "global");
});

test("check: zero-cost model bypasses all rules even when over budget", () => {
  const rules: LimitRule[] = [{ name: "global", maxUsd: 1, window: dayWindow, selector: {} }];
  const engine = engineWith(rules, {}, { zero: new Set(["free-model"]) });
  engine.record({ class: "agent_loop", modelId: "paid", costUsd: 5 }); // over cap
  assert.equal(engine.check({ class: "agent_loop", modelId: "paid" }).allowed, false);
  // The free model is never blocked.
  assert.equal(engine.check({ class: "agent_loop", modelId: "free-model" }).allowed, true);
});

test("check: cap 0 blocks any covered paid spend", () => {
  const rules: LimitRule[] = [{ name: "no-image", maxUsd: 0, window: dayWindow, selector: { tools: ["image_generate"] } }];
  const engine = engineWith(rules);
  assert.equal(engine.check({ class: "tool", tool: "image_generate", modelId: "m1" }).allowed, false);
  assert.equal(engine.check({ class: "tool", tool: "x_search", modelId: "m1" }).allowed, true);
});

test("check: blockingRules lists ALL hit rules; primary is earliest reset", () => {
  const rolling = { type: "rolling", durationMs: 1000, duration: "1s" } as const;
  const rules: LimitRule[] = [
    { name: "global", maxUsd: 1, window: dayWindow, selector: {} }, // resets later (day)
    { name: "burst", maxUsd: 1, window: rolling, selector: {} }, // resets sooner (1s rolling)
  ];
  const engine = engineWith(rules);
  engine.record({ class: "agent_loop", modelId: "m1", costUsd: 5 });
  const r = engine.check({ class: "agent_loop", modelId: "m1" });
  assert.equal(r.allowed, false);
  assert.deepEqual(
    r.blockingRules.map((b) => b.name).sort(),
    ["burst", "global"],
  );
  assert.equal(r.primary?.name, "burst"); // rolling 1s resets before the day boundary
});

test("checkAdmission: dependency cascade — summarization blocked blocks default", () => {
  const rules: LimitRule[] = [
    { name: "summ-cap", maxUsd: 1, window: dayWindow, selector: { sessionTypes: ["summarize"] } },
  ];
  const engine = engineWith(rules, {}, {
    deps: { default: ["summarize"] },
    resolve: (t) => (t === "summarize" ? "sm" : "m1"),
  });
  // default's own spend is fine, but summarize is over budget → default blocked by dependency.
  engine.record({ class: "agent_loop", sessionType: "summarize", modelId: "sm", costUsd: 2 });
  const adm = engine.checkAdmission("default", "m1");
  assert.equal(adm.allowed, false);
  assert.equal(adm.dependency?.sessionType, "summarize");
  assert.equal(adm.ownBlocking.length, 0);
});

test("checkAdmission: allowed when own + deps have headroom", () => {
  const rules: LimitRule[] = [{ name: "global", maxUsd: 100, window: dayWindow, selector: {} }];
  const engine = engineWith(rules, {}, { deps: { default: ["summarize"] } });
  assert.equal(engine.checkAdmission("default", "m1").allowed, true);
});

// ---------------------------------------------------------------------------
// #1/#19a — chain-aware launch admission gate (spec MODEL-FALLBACK §6.1)
// ---------------------------------------------------------------------------

test("#19a checkAdmissionChain: capped PRIMARY + in-budget FALLBACK ⇒ admitted", () => {
  // A model-scoped cap on the chain HEAD must NOT refuse the session when a
  // fallback member is in budget — the per-attempt resolver would serve the
  // fallback. The pre-fix head-only `checkAdmission` refused here.
  const rules: LimitRule[] = [
    { name: "primary-cap", maxUsd: 1, window: dayWindow, selector: { models: ["primary"] } },
  ];
  const engine = engineWith(rules);
  engine.record({ class: "agent_loop", sessionType: "default", modelId: "wire", logicalModelId: "primary", costUsd: 5 });
  // Head-only gate would refuse (primary is over its cap)...
  assert.equal(
    engine.checkAdmissionChain("default", "wire", ["primary"]).allowed,
    false,
    "head-only chain is refused when the primary is capped",
  );
  // ...but the whole chain admits because the fallback has headroom.
  assert.equal(
    engine.checkAdmissionChain("default", "wire", ["primary", "fallback"]).allowed,
    true,
    "an in-budget fallback member admits the session",
  );
});

test("#19a checkAdmissionChain: GLOBAL (wildcard) cap refuses every chain member", () => {
  // A wildcard rule (no `models` selector) covers every member, so no fallback can
  // escape it — the gate still refuses (global exhaustion has no cheaper escape).
  const rules: LimitRule[] = [{ name: "global", maxUsd: 1, window: dayWindow, selector: {} }];
  const engine = engineWith(rules);
  engine.record({ class: "agent_loop", sessionType: "default", modelId: "wire", logicalModelId: "primary", costUsd: 5 });
  const adm = engine.checkAdmissionChain("default", "wire", ["primary", "fallback"]);
  assert.equal(adm.allowed, false, "a global cap refuses the whole chain");
  assert.equal(adm.ownBlocking.map((b) => b.name).includes("global"), true);
  assert.equal(adm.primary?.name, "global");
});

test("#19a checkAdmissionChain: dependency cascade preserved even with an in-budget own chain", () => {
  // Own chain has headroom, but the structural summarization dependency is over
  // budget → still refused on the dependency (cascade unchanged by the chain path).
  const rules: LimitRule[] = [
    { name: "summ-cap", maxUsd: 1, window: dayWindow, selector: { sessionTypes: ["summarize"] } },
  ];
  const engine = engineWith(rules, {}, {
    deps: { default: ["summarize"] },
    resolve: (t) => (t === "summarize" ? "sm" : "m1"),
  });
  engine.record({ class: "agent_loop", sessionType: "summarize", modelId: "sm", costUsd: 2 });
  const adm = engine.checkAdmissionChain("default", "m1", ["primary", "fallback"]);
  assert.equal(adm.allowed, false);
  assert.equal(adm.dependency?.sessionType, "summarize");
  assert.equal(adm.ownBlocking.length, 0);
});

test("chain-aware dependency: capped prerequisite HEAD + in-budget prereq FALLBACK ⇒ admitted", () => {
  // A model-scoped cap on the summarization prerequisite's HEAD (GLM=`default`) must
  // NOT refuse a dependent reply: summarization's own pool degrades to its in-budget
  // fallback (DeepSeek) and still produces summaries, so the dependency is satisfied.
  // Pre-fix (head-only dependency check) this refused the reply.
  const rules: LimitRule[] = [
    { name: "glm-cap", maxUsd: 1, window: dayWindow, selector: { models: ["default"] } },
  ];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => 0,
    zeroCostModelIds: new Set(),
    dependencies: { default: ["summarize", "condense"] },
    resolveModelId: (t) => (t === "default" ? "sol-wire" : "glm-wire"),
    resolveLogicalModelId: (t) => (t === "default" ? "sol" : "default"),
    resolveModelChainLogicalIds: (t) =>
      t === "default" ? ["sol", "default", "deepseek"] : ["default", "deepseek"],
    logger: noopLogger,
    now: () => 1_000_000,
  });
  // Cap GLM (`default`) via a summarize request billed to the `default` chain member.
  engine.record({ class: "agent_loop", sessionType: "summarize", modelId: "glm-wire", logicalModelId: "default", costUsd: 5 });
  // summarize's head (`default`) is over budget, but its chain has DeepSeek in budget →
  // the reply's dependency is satisfied and admission succeeds.
  const adm = engine.checkAdmissionChain("default", "sol-wire", ["sol", "default", "deepseek"]);
  assert.equal(adm.allowed, true, "an in-budget prerequisite fallback admits the dependent session");
});

test("chain-aware dependency: cap over the WHOLE prereq chain refuses on the dependency", () => {
  // A cap covering every member of the prerequisite's chain (`default` + `deepseek`)
  // leaves summarization no escape — no fallback can produce summaries — so the
  // dependent reply is still refused, ON THE DEPENDENCY. The reply's OWN head (`sol`)
  // is left in budget so the refusal isolates to the dependency, not own-chain.
  const rules: LimitRule[] = [
    { name: "bg-chain-cap", maxUsd: 1, window: dayWindow, selector: { models: ["default", "deepseek"] } },
  ];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => 0,
    zeroCostModelIds: new Set(),
    dependencies: { default: ["summarize", "condense"] },
    resolveModelId: (t) => (t === "default" ? "sol-wire" : "glm-wire"),
    resolveLogicalModelId: (t) => (t === "default" ? "sol" : "default"),
    resolveModelChainLogicalIds: (t) =>
      t === "default" ? ["sol", "default", "deepseek"] : ["default", "deepseek"],
    logger: noopLogger,
    now: () => 1_000_000,
  });
  engine.record({ class: "agent_loop", sessionType: "summarize", modelId: "glm-wire", logicalModelId: "default", costUsd: 5 });
  const adm = engine.checkAdmissionChain("default", "sol-wire", ["sol", "default", "deepseek"]);
  assert.equal(adm.allowed, false, "the whole prereq chain is capped → no escape");
  assert.equal(adm.dependency?.sessionType, "summarize");
  assert.equal(adm.ownBlocking.length, 0);
});

test("#1 checkAdmission delegates to the head-only chain (back-compat)", () => {
  // The legacy head-only `checkAdmission` is now `checkAdmissionChain` with the
  // single head logical id; a model-scoped cap on that head refuses (no fallback).
  const rules: LimitRule[] = [
    { name: "head-cap", maxUsd: 1, window: dayWindow, selector: { models: ["head"] } },
  ];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => 0,
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "wire",
    resolveLogicalModelId: () => "head",
    logger: noopLogger,
    now: () => 1_000_000,
  });
  engine.record({ class: "agent_loop", sessionType: "default", modelId: "wire", logicalModelId: "head", costUsd: 5 });
  assert.equal(engine.checkAdmission("default", "wire").allowed, false);
});

test("ruleStatuses: one entry per rule with state + fraction", () => {
  const rules: LimitRule[] = [
    { name: "a", maxUsd: 10, window: dayWindow, selector: {} },
    { name: "b", maxUsd: 10, window: dayWindow, selector: { classes: ["caption"] } },
  ];
  const engine = engineWith(rules);
  engine.record({ class: "caption", modelId: "m1", costUsd: 9 }); // a: 9/10 near; b: 9/10 near
  engine.record({ class: "agent_loop", modelId: "m1", costUsd: 2 }); // a: 11/10 blocked
  const statuses = engine.ruleStatuses();
  assert.equal(statuses.length, 2);
  const a = statuses.find((s) => s.name === "a")!;
  const b = statuses.find((s) => s.name === "b")!;
  assert.equal(a.state, "blocked");
  assert.equal(b.state, "near");
});

// ---------------------------------------------------------------------------
// makeRateLimitedClaimGate — worker-pool claim gate logging (§6.4 / review #2)
// ---------------------------------------------------------------------------

/** A logger that records every `warn` call (message + fields) for assertions. */
function capturingLogger() {
  const warns: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    debug() {}, info() {}, error() {},
    warn(message: string, fields?: Record<string, unknown>) {
      warns.push({ message, fields });
    },
    child() {
      return logger;
    },
  } as never;
  return { logger, warns };
}

function overBudgetEngine(rules: LimitRule[], spend: { descriptor: SpendDescriptor; cost: number }[], now = () => 1_000_000) {
  const { logger, warns } = capturingLogger();
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => 0,
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "m1",
    logger,
    now,
  });
  for (const s of spend) engine.record({ ...s.descriptor, costUsd: s.cost });
  return { engine, warns };
}

test("#2 claim gate: over-budget pool logs ONE usage_limit_blocked('worker_claim') with the hit rules", () => {
  // A pool whose gated class is over budget must park AND emit one rule-naming log
  // (§6.4 explicitly names worker pools). Pre-fix summary/diary/embed parked silently.
  const rules: LimitRule[] = [
    { name: "diary-cap", maxUsd: 1, window: dayWindow, selector: { sessionTypes: ["diary"] } },
  ];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "agent_loop", sessionType: "diary", modelId: "m1" }, cost: 5 },
  ]);
  const gate = makeRateLimitedClaimGate({
    engine,
    descriptors: () => [{ class: "agent_loop", sessionType: "diary", modelId: "m1" }],
  });
  assert.equal(gate(), true, "the over-budget gate parks the pool");
  const blocked = warns.filter((w) => w.message === "usage_limit_blocked");
  assert.equal(blocked.length, 1, "exactly one block log on pause");
  assert.equal(blocked[0].fields?.gate, "worker_claim", "gate tag names the worker-claim gate");
  assert.deepEqual(
    (blocked[0].fields?.limits as { name: string }[]).map((l) => l.name),
    ["diary-cap"],
    "the log names the hit rule(s)",
  );
});

test("#2 claim gate: repeated polls within a minute do NOT re-log (rate limit holds)", () => {
  let clock = 1_000_000;
  const rules: LimitRule[] = [{ name: "g", maxUsd: 1, window: dayWindow, selector: {} }];
  const { engine, warns } = overBudgetEngine(
    rules,
    [{ descriptor: { class: "agent_loop", modelId: "m1" }, cost: 5 }],
    () => clock,
  );
  const gate = makeRateLimitedClaimGate({
    engine,
    descriptors: () => [{ class: "agent_loop", modelId: "m1" }],
    now: () => clock,
  });
  // Three polls 20s apart — all park, but only the first logs (≤1/min).
  assert.equal(gate(), true);
  clock += 20_000;
  assert.equal(gate(), true);
  clock += 20_000;
  assert.equal(gate(), true);
  assert.equal(
    warns.filter((w) => w.message === "usage_limit_blocked").length,
    1,
    "still parking, but no re-log inside the 60s window",
  );
  // Past the minute, it logs again (periodic re-log, §6.4).
  clock += 30_000; // now 70s since the first log
  assert.equal(gate(), true);
  assert.equal(
    warns.filter((w) => w.message === "usage_limit_blocked").length,
    2,
    "re-logs once the rate-limit window elapses",
  );
});

test("#2 claim gate: within-budget pool does not park and never logs", () => {
  const rules: LimitRule[] = [{ name: "g", maxUsd: 100, window: dayWindow, selector: {} }];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "agent_loop", modelId: "m1" }, cost: 5 }, // well under cap
  ]);
  const gate = makeRateLimitedClaimGate({
    engine,
    descriptors: () => [{ class: "agent_loop", modelId: "m1" }],
  });
  assert.equal(gate(), false, "headroom → no pause");
  assert.equal(warns.filter((w) => w.message === "usage_limit_blocked").length, 0, "no log when not blocked");
});

test("#2 claim gate: multi-descriptor (summarize+condense) — first over-budget descriptor wins the log", () => {
  // The summary pool gates on BOTH session types; an over-budget condense parks the
  // whole pool and the log names condense's rule.
  const rules: LimitRule[] = [
    { name: "condense-cap", maxUsd: 1, window: dayWindow, selector: { sessionTypes: ["condense"] } },
  ];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "agent_loop", sessionType: "condense", modelId: "m1" }, cost: 5 },
  ]);
  const gate = makeRateLimitedClaimGate({
    engine,
    // summarize first (within budget), condense second (over budget).
    descriptors: () => [
      { class: "agent_loop", sessionType: "summarize", modelId: "m1" },
      { class: "agent_loop", sessionType: "condense", modelId: "m1" },
    ],
  });
  assert.equal(gate(), true);
  const blocked = warns.filter((w) => w.message === "usage_limit_blocked");
  assert.equal(blocked.length, 1);
  assert.equal((blocked[0].fields?.descriptor as { sessionType?: string }).sessionType, "condense");
  assert.deepEqual(
    (blocked[0].fields?.limits as { name: string }[]).map((l) => l.name),
    ["condense-cap"],
  );
});

test("#2 claim gate: empty descriptor list never parks (all session types unresolvable)", () => {
  const rules: LimitRule[] = [{ name: "g", maxUsd: 1, window: dayWindow, selector: {} }];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "agent_loop", modelId: "m1" }, cost: 5 },
  ]);
  const gate = makeRateLimitedClaimGate({ engine, descriptors: () => [] });
  assert.equal(gate(), false, "no descriptors → never blocks (unresolvable model ids)");
  assert.equal(warns.filter((w) => w.message === "usage_limit_blocked").length, 0);
});

// ---------------------------------------------------------------------------
// #13 — logical-vs-upstream selector discrimination (headline §2.2)
// ---------------------------------------------------------------------------

test("#13 selector matches the LOGICAL id, not the shared upstream wire id", () => {
  // Two lanes share ONE upstream wire id ("gemini") but carry distinct LOGICAL ids
  // (caption-premium vs image-flash). A rule scoped to models=["caption-premium"]
  // must count ONLY the premium lane and leave the shared-upstream image lane free.
  // Pre-§2.2 (matching on the wire id) this rule would have caught BOTH lanes.
  const rules: LimitRule[] = [
    { name: "premium-cap", maxUsd: 1, window: dayWindow, selector: { models: ["caption-premium"] } },
  ];
  const engine = engineWith(rules);
  // Spend on the image lane (same wire id) does NOT count against the premium rule.
  engine.record({ class: "tool", tool: "image_generate", modelId: "gemini", logicalModelId: "image-flash", costUsd: 5 });
  assert.equal(
    engine.check({ class: "tool", tool: "image_generate", modelId: "gemini", logicalModelId: "image-flash" }).allowed,
    true,
    "the shared-upstream image lane is NOT blocked by the caption-scoped rule",
  );
  // The premium caption lane is still in budget too (nothing recorded there yet).
  assert.equal(
    engine.check({ class: "caption", modelId: "gemini", logicalModelId: "caption-premium" }).allowed,
    true,
    "premium lane within budget before its own spend",
  );
  // Now push the premium lane over its own cap.
  engine.record({ class: "caption", modelId: "gemini", logicalModelId: "caption-premium", costUsd: 2 });
  assert.equal(
    engine.check({ class: "caption", modelId: "gemini", logicalModelId: "caption-premium" }).allowed,
    false,
    "the caption-scoped rule counts only the premium logical lane and now blocks it",
  );
  assert.equal(
    engine.check({ class: "tool", tool: "image_generate", modelId: "gemini", logicalModelId: "image-flash" }).allowed,
    true,
    "the shared-upstream image lane stays unblocked despite the same wire id",
  );
  // isModelAvailable keys on the logical id too: premium unavailable, image free.
  assert.equal(engine.isModelAvailable("caption-premium"), false);
  assert.equal(engine.isModelAvailable("image-flash"), true);
});

// ---------------------------------------------------------------------------
// #2 — makeChainClaimGate: park ONLY when EVERY chain member is over budget
// ---------------------------------------------------------------------------

test("#2 chain gate: head over budget but fallback in budget ⇒ does NOT park", () => {
  // The pool-level chain gate mirrors the image-gen/x_search `chain.some` tool gate:
  // a head-only cap must not park the pool — the per-attempt resolver falls to the
  // in-budget fallback. Pre-fix the single-descriptor gate parked the whole pool.
  const rules: LimitRule[] = [
    { name: "head-cap", maxUsd: 1, window: dayWindow, selector: { models: ["embed-large"] } },
  ];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "embedding", modelId: "embed-large" }, cost: 5 },
  ]);
  const gate = makeChainClaimGate({
    engine,
    descriptors: () => [
      { class: "embedding", modelId: "embed-large" },
      { class: "embedding", modelId: "embed-small" },
    ],
  });
  assert.equal(gate(), false, "an in-budget fallback member keeps the pool running");
  assert.equal(warns.filter((w) => w.message === "usage_limit_blocked").length, 0, "no pause log");
});

test("#2 chain gate: EVERY member over budget ⇒ parks + logs once naming the head's rules", () => {
  const rules: LimitRule[] = [{ name: "all-cap", maxUsd: 1, window: dayWindow, selector: {} }];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "embedding", modelId: "embed-large" }, cost: 5 },
  ]);
  const gate = makeChainClaimGate({
    engine,
    descriptors: () => [
      { class: "embedding", modelId: "embed-large" },
      { class: "embedding", modelId: "embed-small" },
    ],
  });
  assert.equal(gate(), true, "all members over a global cap → park");
  const blocked = warns.filter((w) => w.message === "usage_limit_blocked");
  assert.equal(blocked.length, 1);
  assert.equal((blocked[0].fields?.descriptor as { modelId?: string }).modelId, "embed-large", "log names the head member");
  assert.deepEqual((blocked[0].fields?.limits as { name: string }[]).map((l) => l.name), ["all-cap"]);
});

test("#2 chain gate: empty chain never parks; late-bound engine never parks while unresolved", () => {
  const rules: LimitRule[] = [{ name: "g", maxUsd: 1, window: dayWindow, selector: {} }];
  const { engine } = overBudgetEngine(rules, [
    { descriptor: { class: "embedding", modelId: "embed-large" }, cost: 5 },
  ]);
  assert.equal(makeChainClaimGate({ engine, descriptors: () => [] })(), false, "empty chain → never park");
  const holder: { engine?: BudgetEngine } = {};
  const lateGate = makeChainClaimGate({
    engine: () => holder.engine,
    descriptors: () => [{ class: "embedding", modelId: "embed-large" }],
  });
  assert.equal(lateGate(), false, "engine not yet wired → never park");
});

// ---------------------------------------------------------------------------
// makeAgentLoopChainClaimGate — multi-lane chain-aware pool gate (summary/diary)
// ---------------------------------------------------------------------------

test("multi-lane gate: lane head capped but fallback in budget ⇒ does NOT park", () => {
  // The summarization pool serves `summarize` + `condense`, each with its own chain
  // (GLM=`default` → DeepSeek). A model-scoped cap on the shared head must degrade the
  // pool to DeepSeek, not park it — else context compaction stalls and cascades.
  const rules: LimitRule[] = [
    { name: "glm-cap", maxUsd: 1, window: dayWindow, selector: { models: ["default"] } },
  ];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "agent_loop", sessionType: "summarize", modelId: "glm-wire", logicalModelId: "default" }, cost: 5 },
  ]);
  const lane = (sessionType: string): SpendDescriptor[] => [
    { class: "agent_loop", sessionType, modelId: "glm-wire", logicalModelId: "default" },
    { class: "agent_loop", sessionType, modelId: "ds-wire", logicalModelId: "deepseek" },
  ];
  const gate = makeAgentLoopChainClaimGate({ engine, lanes: () => [lane("summarize"), lane("condense")] });
  assert.equal(gate(), false, "an in-budget fallback keeps the pool running on DeepSeek");
  assert.equal(warns.filter((w) => w.message === "usage_limit_blocked").length, 0, "no pause log");
});

test("multi-lane gate: a lane whose WHOLE chain is over budget ⇒ parks + logs the head", () => {
  // A cap scoped to `condense` covers every member of that lane → the lane is stuck →
  // the pool parks (any-lane-stuck), even though the `summarize` lane is fine.
  const rules: LimitRule[] = [
    { name: "condense-cap", maxUsd: 1, window: dayWindow, selector: { sessionTypes: ["condense"] } },
  ];
  const { engine, warns } = overBudgetEngine(rules, [
    { descriptor: { class: "agent_loop", sessionType: "condense", modelId: "glm-wire", logicalModelId: "default" }, cost: 5 },
  ]);
  const lane = (sessionType: string): SpendDescriptor[] => [
    { class: "agent_loop", sessionType, modelId: "glm-wire", logicalModelId: "default" },
    { class: "agent_loop", sessionType, modelId: "ds-wire", logicalModelId: "deepseek" },
  ];
  const gate = makeAgentLoopChainClaimGate({ engine, lanes: () => [lane("summarize"), lane("condense")] });
  assert.equal(gate(), true, "a fully-stuck lane parks the pool");
  const blocked = warns.filter((w) => w.message === "usage_limit_blocked");
  assert.equal(blocked.length, 1);
  assert.equal((blocked[0].fields?.descriptor as { sessionType?: string }).sessionType, "condense", "log names the stuck lane");
});

test("multi-lane gate: empty lanes never park; empty lane is skipped", () => {
  const rules: LimitRule[] = [{ name: "g", maxUsd: 1, window: dayWindow, selector: {} }];
  const { engine } = overBudgetEngine(rules, [
    { descriptor: { class: "agent_loop", sessionType: "summarize", modelId: "glm-wire", logicalModelId: "default" }, cost: 5 },
  ]);
  assert.equal(makeAgentLoopChainClaimGate({ engine, lanes: () => [] })(), false, "no lanes → never park");
  assert.equal(
    makeAgentLoopChainClaimGate({ engine, lanes: () => [[], []] })(),
    false,
    "all-empty lanes (unresolvable session types) → never park",
  );
});

// ---------------------------------------------------------------------------
// regression: finding #21 — embedding lane late-binding
//
// The embed worker's claim gate AND its ledger emitter are built (in
// subsystem.ts) BEFORE the BudgetEngine / ledger recorder exist, then read the
// shared holder at call time. These two tests fail on the pre-fix
// construction-time-ternary behavior, which froze both to `undefined`.
// ---------------------------------------------------------------------------

test("#21 claim gate: late-bound engine — never parks/logs while unresolved, parks once present + over budget", () => {
  // Mirror the embed-worker wiring: the gate is built against `() => holder.engine`
  // while the holder is empty, exactly as subsystem.ts builds it before app.ts
  // fills the holder. A construction-time read would have captured `undefined`.
  const { logger, warns } = capturingLogger();
  const holder: { engine?: BudgetEngine } = {};
  const descriptor: SpendDescriptor = { class: "embedding", modelId: "embed-model" };
  const gate = makeRateLimitedClaimGate({
    engine: () => holder.engine,
    descriptors: () => [descriptor],
  });

  // (a) Unresolved engine: never park, never log (no embedding work runs pre-startup).
  assert.equal(gate(), false, "unresolved engine → never parks");
  assert.equal(
    warns.filter((w) => w.message === "usage_limit_blocked").length,
    0,
    "unresolved engine → never logs",
  );

  // Fill the holder with an over-budget engine, as app.ts does after the factory.
  const rules: LimitRule[] = [
    { name: "embed-cap", maxUsd: 1, window: dayWindow, selector: { classes: ["embedding"] } },
  ];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => 0,
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "embed-model",
    logger,
    now: () => 1_000_000,
  });
  engine.record({ ...descriptor, costUsd: 5 }); // push over the $1 cap
  holder.engine = engine;

  // (b) Resolved + over budget: the SAME gate now parks and logs once, naming the rule.
  assert.equal(gate(), true, "resolved over-budget engine → parks");
  const blocked = warns.filter((w) => w.message === "usage_limit_blocked");
  assert.equal(blocked.length, 1, "exactly one block log once the engine is wired");
  assert.equal(blocked[0].fields?.gate, "worker_claim");
  assert.deepEqual(
    (blocked[0].fields?.limits as { name: string }[]).map((l) => l.name),
    ["embed-cap"],
  );
});

test("#21 onEmbeddingUsage: late-filled holder.record IS invoked with a class='embedding' row", () => {
  // The exact closure subsystem.ts installs on the embedding provider, built while
  // the holder is empty (as in app.ts). Pre-fix it was `record && remoteId ? … :
  // undefined`, so an empty-at-construction holder produced NO callback and every
  // embedding row was dropped. Late-binding `opts.budget?.record?.(…)` records once
  // the holder is filled.
  const remoteId = "embed-model";
  const recorded: UsageEventInput[] = [];
  const holder: BudgetHooks = {}; // empty at construction, like app.ts
  const onEmbeddingUsage: ((promptTokens: number, costUsd: number) => void) | undefined = remoteId
    ? (promptTokens, costUsd) => {
        holder.record?.({ class: "embedding", modelId: remoteId, inputTokens: promptTokens, costUsd });
      }
    : undefined;
  assert.ok(onEmbeddingUsage, "callback installed whenever remoteId is set (not gated on record)");

  // Before the holder is filled the optional-chain no-ops — no throw, nothing recorded.
  onEmbeddingUsage!(100, 0.002);
  assert.equal(recorded.length, 0, "no record sink yet → silently no-ops (no embedding work pre-startup)");

  // app.ts fills the holder; the SAME closure now records.
  holder.record = (event) => recorded.push(event);
  onEmbeddingUsage!(250, 0.005);
  assert.equal(recorded.length, 1, "row emitted once the holder is filled");
  assert.deepEqual(recorded[0], {
    class: "embedding",
    modelId: remoteId,
    inputTokens: 250,
    costUsd: 0.005,
  });
});

// ---------------------------------------------------------------------------
// regression: review group 1 (#1, #4, #5, #6, #10a)
// ---------------------------------------------------------------------------

test("#1 isModelAvailable: global (no-models) rule over cap blocks every model", () => {
  // A global rule has no `models` selector → it covers every model (wildcard),
  // exactly as check() treats it. Pre-fix isModelAvailable ignored such rules and
  // wrongly reported every model available even when global was over cap.
  const rules: LimitRule[] = [{ name: "global", maxUsd: 1, window: dayWindow, selector: {} }];
  const engine = engineWith(rules, {}, { zero: new Set(["free-model"]) });
  engine.record({ class: "agent_loop", modelId: "paid", costUsd: 5 }); // global over cap
  assert.equal(engine.isModelAvailable("paid"), false);
  assert.equal(engine.isModelAvailable("some-other-model"), false); // wildcard covers it too
  // Zero-cost short-circuit preserved: a free model is never blocked.
  assert.equal(engine.isModelAvailable("free-model"), true);
});

test("#1 isModelAvailable: models-scoped rule blocks only its listed models", () => {
  const rules: LimitRule[] = [
    { name: "opus", maxUsd: 1, window: dayWindow, selector: { models: ["opus"] } },
  ];
  const engine = engineWith(rules);
  engine.record({ class: "agent_loop", modelId: "opus", costUsd: 5 });
  assert.equal(engine.isModelAvailable("opus"), false);
  assert.equal(engine.isModelAvailable("sonnet"), true); // not in the rule's models
});

test("#4 calendar roll: check()/ruleStatuses() report rolled-empty window WITHOUT tick(), no SUM on hot path", () => {
  // UTC day window. Seed blocked, then advance the clock past midnight without
  // calling tick(): the read/decision paths must roll in place (spent→0) and see
  // the fresh window. Pre-fix, only record() rolled, so check()/ruleStatuses()
  // read stale spend for up to one tick after the boundary.
  let clock = Date.UTC(2026, 5, 15, 12, 0, 0); // noon, June 15 UTC
  let sumCalls = 0;
  const rules: LimitRule[] = [{ name: "daily", maxUsd: 10, window: dayWindow, selector: {} }];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: (f) => {
      sumCalls++; // seeds once; must NOT be called again by record/check/ruleStatuses
      return f.since <= Date.UTC(2026, 5, 15, 0, 0, 0) ? 12 : 0; // June-15 window seeded over cap
    },
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "m1",
    logger: noopLogger,
    now: () => clock,
  });
  assert.equal(sumCalls, 1, "seed runs exactly one SUM per rule");
  assert.equal(engine.check({ class: "agent_loop", modelId: "m1" }).allowed, false); // blocked on June 15

  // Cross the UTC midnight boundary into June 16.
  clock = Date.UTC(2026, 5, 16, 1, 0, 0);
  const after = engine.check({ class: "agent_loop", modelId: "m1" });
  assert.equal(after.allowed, true, "fresh window after the boundary has zero spend");
  const status = engine.ruleStatuses().find((s) => s.name === "daily")!;
  assert.equal(status.spentUsd, 0);
  assert.equal(status.state, "ok");
  assert.equal(status.resetsAt, Date.UTC(2026, 5, 17, 0, 0, 0)); // next midnight after June 16
  // No SUM ran on any of the post-seed read/decision paths (§6.5: rollIfNeeded is SUM-free).
  assert.equal(sumCalls, 1, "rollIfNeeded resets to 0 without a SQL SUM");
});

test("#4 record() rolls a passed calendar boundary in place without a SUM", () => {
  // A spend that lands just after midnight must accrue to the NEW window, not the
  // old one — and must do so WITHOUT the hot-path SUM the pre-fix lazy-roll ran.
  let clock = Date.UTC(2026, 5, 15, 23, 30, 0); // late June 15
  let sumCalls = 0;
  const rules: LimitRule[] = [{ name: "daily", maxUsd: 10, window: dayWindow, selector: {} }];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => {
      sumCalls++;
      return 8; // June-15 window seeded near cap
    },
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "m1",
    logger: noopLogger,
    now: () => clock,
  });
  assert.equal(sumCalls, 1);
  // Cross into June 16, then record: the boundary roll zeroes spent, so $5 leaves
  // the rule at 5/10 (NOT 8+5=13 against the stale window).
  clock = Date.UTC(2026, 5, 16, 0, 30, 0);
  engine.record({ class: "agent_loop", modelId: "m1", costUsd: 5 });
  assert.equal(engine.check({ class: "agent_loop", modelId: "m1" }).allowed, true);
  const status = engine.ruleStatuses().find((s) => s.name === "daily")!;
  assert.equal(status.spentUsd, 5);
  assert.equal(sumCalls, 1, "record()'s calendar roll uses no SQL SUM (§6.5)");
});

test("#4 tick(): rolling recompute + calendar roll re-sum from the ledger", () => {
  // tick() is the authoritative periodic reconciler (the only place a calendar
  // roll re-SUMs). Previously uncovered.
  let clock = Date.UTC(2026, 5, 15, 12, 0, 0);
  // Ledger state the SUM reflects, keyed by window kind, mutated between ticks.
  let rollingSpend = 5;
  let calendarSpend = 9;
  const rolling = { type: "rolling", durationMs: 3_600_000, duration: "1h" } as const;
  const rules: LimitRule[] = [
    { name: "roll", maxUsd: 10, window: rolling, selector: { classes: ["tool"] } },
    { name: "cal", maxUsd: 10, window: dayWindow, selector: { classes: ["agent_loop"] } },
  ];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: (f) => (f.classes?.includes("tool") ? rollingSpend : calendarSpend),
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "m1",
    logger: noopLogger,
    now: () => clock,
    tickMs: 1000,
  });
  engine.start();
  // Rolling rule recomputes every tick: shed aged-out spend so it drops below cap.
  rollingSpend = 2;
  // Calendar rule: cross midnight so the boundary rolls and re-SUMs the new window.
  calendarSpend = 1;
  clock = Date.UTC(2026, 5, 16, 1, 0, 0);
  // Drive one tick synchronously via the private method (the timer is unref'd).
  (engine as unknown as { tick(): void }).tick();
  engine.stop();
  const roll = engine.ruleStatuses().find((s) => s.name === "roll")!;
  const cal = engine.ruleStatuses().find((s) => s.name === "cal")!;
  assert.equal(roll.spentUsd, 2, "rolling rule recomputed from the ledger");
  assert.equal(cal.spentUsd, 1, "calendar rule re-summed the new day window");
  assert.equal(cal.resetsAt, Date.UTC(2026, 5, 17, 0, 0, 0));
});

test("#5 rolling resetsAt: counts down from oldest contributing spend, not now + duration", () => {
  // A rolling window frees up when its OLDEST spend ages out: minTs + duration,
  // far sooner than the now + duration upper bound. ruleStatuses() (console) and
  // accurateResetsAt() (refusal message) must surface the accurate ETA.
  const now = 10_000_000;
  const durationMs = 86_400_000; // 24h
  const oldestTs = now - 80_000_000; // contributing spend ~66m from aging out
  const rolling = { type: "rolling", durationMs, duration: "24h" } as const;
  const rules: LimitRule[] = [{ name: "burst", maxUsd: 1, window: rolling, selector: {} }];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => 5, // over cap
    minUsageTs: () => oldestTs,
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "m1",
    logger: noopLogger,
    now: () => now,
  });
  const status = engine.ruleStatuses().find((s) => s.name === "burst")!;
  assert.equal(status.resetsAt, oldestTs + durationMs, "console countdown uses oldest-spend ETA");
  assert.notEqual(status.resetsAt, now + durationMs, "not the full-duration upper bound");
  assert.equal(engine.accurateResetsAt("burst"), oldestTs + durationMs);
  // check() keeps the cheap upper bound (never consults minUsageTs on the hot path).
  const blocked = engine.check({ class: "agent_loop", modelId: "m1" });
  assert.equal(blocked.primary?.resetsAt, now + durationMs);
});

test("#5 rolling resetsAt: falls back to now + duration with no contributing spend", () => {
  const now = 10_000_000;
  const durationMs = 3_600_000;
  const rolling = { type: "rolling", durationMs, duration: "1h" } as const;
  const rules: LimitRule[] = [{ name: "burst", maxUsd: 5, window: rolling, selector: {} }];
  const engine = new BudgetEngine({
    rules,
    sumUsageCost: () => 0,
    minUsageTs: () => null, // no contributing spend in the window
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "m1",
    logger: noopLogger,
    now: () => now,
  });
  assert.equal(engine.accurateResetsAt("burst"), now + durationMs);
  assert.equal(engine.accurateResetsAt("no-such-rule"), undefined);
});

test("#6 record() rejects NaN and negative cost; the rule keeps enforcing", () => {
  // NaN <= 0 is false, so the old guard admitted a NaN cost → spent became NaN and
  // the rule silently stopped enforcing (fail-open). The `!(x > 0)` guard rejects
  // NaN, 0, and negatives uniformly.
  const rules: LimitRule[] = [{ name: "daily", maxUsd: 10, window: dayWindow, selector: {} }];
  const engine = engineWith(rules);
  engine.record({ class: "agent_loop", modelId: "m1", costUsd: 10 }); // exactly at cap
  engine.record({ class: "agent_loop", modelId: "m1", costUsd: Number.NaN }); // ignored
  engine.record({ class: "agent_loop", modelId: "m1", costUsd: -100 }); // ignored
  const status = engine.ruleStatuses().find((s) => s.name === "daily")!;
  assert.ok(Number.isFinite(status.spentUsd), "spent stays finite after a NaN cost");
  assert.equal(status.spentUsd, 10, "NaN/negative costs do not move the total");
  assert.equal(
    engine.check({ class: "agent_loop", modelId: "m1" }).allowed,
    false,
    "rule still blocks at cap (no fail-open)",
  );
});

test("#10a nearThreshold clamped to (0,1)", () => {
  const rules: LimitRule[] = [{ name: "a", maxUsd: 10, window: dayWindow, selector: {} }];
  const mk = (nearThreshold: number) =>
    new BudgetEngine({
      rules: rules.map((r) => ({ ...r })),
      sumUsageCost: () => 0,
      zeroCostModelIds: new Set(),
      dependencies: {},
      resolveModelId: () => "m1",
      logger: noopLogger,
      now: () => 1_000_000,
      nearThreshold,
    });
  // A 0 threshold must NOT mark a rule with a tiny spend "near" (clamped up to >0).
  const zero = mk(0);
  zero.record({ class: "agent_loop", modelId: "m1", costUsd: 0.001 }); // 0.0001 fraction
  assert.equal(zero.ruleStatuses()[0].state, "ok");
  // A >1 threshold must NOT disable "near" entirely (clamped down to 0.999). A
  // not-quite-full rule (0.9999 fraction, below cap so not "blocked") still flags
  // "near"; pre-clamp a raw 5.0 threshold could never be reached → "near" dead.
  const big = mk(5);
  big.record({ class: "agent_loop", modelId: "m1", costUsd: 9.999 }); // 0.9999 fraction
  assert.equal(big.ruleStatuses()[0].state, "near");
});

// ---------------------------------------------------------------------------
// seeding (§6.1)
// ---------------------------------------------------------------------------

test("engine seeds each rule from the ledger at construction", () => {
  const rules: LimitRule[] = [
    { name: "global", maxUsd: 50, window: dayWindow, selector: {} },
    { name: "image", maxUsd: 5, window: dayWindow, selector: { tools: ["image_generate"] } },
  ];
  const engine = new BudgetEngine({
    rules,
    // Seed image at cap, global with headroom.
    sumUsageCost: (f) => (f.tools?.includes("image_generate") ? 5 : 10),
    zeroCostModelIds: new Set(),
    dependencies: {},
    resolveModelId: () => "m1",
    logger: noopLogger,
    now: () => 1_000_000,
  });
  assert.equal(engine.check({ class: "tool", tool: "image_generate", modelId: "m1" }).allowed, false);
  assert.equal(engine.check({ class: "agent_loop", modelId: "m1" }).allowed, true);
});

// ---------------------------------------------------------------------------
// normalizeLimits (§5.2)
// ---------------------------------------------------------------------------

const normOpts = { defaultTz: "UTC", knownTools: new Set(["image_generate"]), knownSessionTypes: new Set(["default", "summarize"]) };

test("normalizeLimits: parses duration + defaults calendar tz", () => {
  const raw: RawLimitRule[] = [
    { name: "r", max_usd: 5, window: { type: "rolling", duration: "24h" } },
    { name: "c", max_usd: 5, window: { type: "calendar", period: "day" } },
  ];
  const res = normalizeLimits(raw, normOpts);
  assert.equal(res.fatal.length, 0);
  assert.equal(res.rules[0].window.type, "rolling");
  assert.equal((res.rules[0].window as { durationMs: number }).durationMs, 86_400_000);
  assert.equal((res.rules[1].window as { tz: string }).tz, "UTC");
});

test("normalizeLimits: fatal on duplicate name, bad duration, bad tz", () => {
  const dup = normalizeLimits(
    [
      { name: "x", max_usd: 1, window: { type: "rolling", duration: "1h" } },
      { name: "x", max_usd: 1, window: { type: "rolling", duration: "1h" } },
    ],
    normOpts,
  );
  assert.ok(dup.fatal.some((f) => /duplicate/.test(f)));

  const badDur = normalizeLimits([{ name: "y", max_usd: 1, window: { type: "rolling", duration: "nope" } }], normOpts);
  assert.equal(badDur.rules.length, 0);
  assert.ok(badDur.fatal.length > 0);

  const badTz = normalizeLimits([{ name: "z", max_usd: 1, window: { type: "calendar", period: "day", tz: "+09:00" } }], normOpts);
  assert.ok(badTz.fatal.some((f) => /tz/.test(f)));
});

test("normalizeLimits: warns on unknown tool/session-type + misplaced rejection message", () => {
  const res = normalizeLimits(
    [
      { name: "u", max_usd: 1, window: { type: "rolling", duration: "1h" }, tools: ["nope_tool"] },
      {
        name: "m",
        max_usd: 1,
        window: { type: "rolling", duration: "1h" },
        classes: ["caption"],
        trigger_rejection_message: "back later",
      },
    ],
    normOpts,
  );
  assert.equal(res.fatal.length, 0);
  assert.ok(res.warnings.some((w) => /unknown tool/.test(w)));
  assert.ok(res.warnings.some((w) => /trigger_rejection_message/.test(w)));
});

test("#11 normalizeLimits: warns on an unknown model id, not a known one (never fatal)", () => {
  const opts = { ...normOpts, knownModelIds: new Set(["opus", "sonnet"]) };
  const res = normalizeLimits(
    [
      // A `models` selector naming an id present in no config lane → dead rule → warn.
      { name: "bogus", max_usd: 1, window: { type: "rolling", duration: "1h" }, models: ["typo-model"] },
      // A selector listing only known ids → no model warning.
      { name: "good", max_usd: 1, window: { type: "rolling", duration: "1h" }, models: ["opus", "sonnet"] },
    ],
    opts,
  );
  assert.equal(res.fatal.length, 0, "an unknown model id is never fatal (models stays free-form)");
  assert.ok(
    res.warnings.some((w) => /unknown model "typo-model"/.test(w)),
    "the bogus model id earns a soft warning",
  );
  assert.ok(
    !res.warnings.some((w) => /unknown model "(opus|sonnet)"/.test(w)),
    "a known model id earns no warning",
  );
});

test("#11 normalizeLimits: omitting knownModelIds skips the model check entirely", () => {
  // A caller that doesn't assemble the known-id set (the default) must not warn on
  // any model id — the check is opt-in via `knownModelIds`.
  const res = normalizeLimits(
    [{ name: "r", max_usd: 1, window: { type: "rolling", duration: "1h" }, models: ["anything"] }],
    normOpts,
  );
  assert.equal(res.fatal.length, 0);
  assert.ok(!res.warnings.some((w) => /unknown model/.test(w)));
});

// ---------------------------------------------------------------------------
// collectZeroCostModelIds (§2.2)
// ---------------------------------------------------------------------------

test("collectZeroCostModelIds: zero-rate models in the set, paid excluded", () => {
  // After the unified registry (spec MODEL-FALLBACK §2.3) EVERY consumer references
  // `[models.*]` by name, so zero-cost collection scans ONLY config.models, keyed
  // by the LOGICAL id (block name).
  const config = {
    models: {
      caption: { id: "free", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
      big: { id: "paid", cost: { input: 3, output: 15, cache_read: 0, cache_write: 0 } },
      bare: { id: "bare" }, // no cost block → zero
    },
  } as never;
  const zero = collectZeroCostModelIds(config);
  assert.equal(zero.has("caption"), true);
  assert.equal(zero.has("bare"), true);
  assert.equal(zero.has("big"), false); // the paid block
  assert.equal(zero.has("free"), false); // a wire id, never a logical id
});

test("collectZeroCostModelIds: a per-image-only charge makes an image model paid", () => {
  // An image-gen model can price purely per-image with zero token rates (spec
  // MODEL-FALLBACK §2.3); the flat per_image counts toward "is this model free?".
  const config = {
    models: {
      "imagegen-flat": { id: "img", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0, per_image: 0.04 } },
      "imagegen-free": { id: "img2", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
    },
  } as never;
  const zero = collectZeroCostModelIds(config);
  assert.equal(zero.has("imagegen-flat"), false); // per_image > 0 → paid
  assert.equal(zero.has("imagegen-free"), true);
});

test("#11 collectKnownModelIds: every configured model id (zero ∪ paid)", () => {
  // Unified registry: all consumers reference [models.*], so the known set is just
  // the config.models block names (spec MODEL-FALLBACK §2.3).
  const config = {
    models: {
      default: { id: "free", cost: { input: 0, output: 0 } },
      big: { id: "paid", cost: { input: 3, output: 15 } },
      caption: { id: "cap-wire" },
      grok: { id: "x-ai/grok" },
    },
  } as never;
  const ids = collectKnownModelIds(config);
  for (const id of ["default", "big", "caption", "grok"]) {
    assert.equal(ids.has(id), true, `${id} is a known configured model id`);
  }
  assert.equal(ids.has("free"), false); // wire id, not a logical id
  assert.equal(ids.has("nonexistent"), false);
});

test("#19b a [[limits]] selector naming a virtual/fallback-member logical id does NOT warn", () => {
  // A virtual (pure-rename) model AND a fallback-member block are both [models.*]
  // blocks, so collectKnownModelIds returns their logical ids — a `models` selector
  // naming either is a KNOWN reference and must earn no "unknown model" warning.
  const config = {
    models: {
      default: { id: "wire-default", cost: { input: 1, output: 1 } },
      // A pure-rename virtual model with a fallback chain into a cheaper member.
      "caption-premium": { id: "wire-premium", fallback: ["caption-cheap"] },
      "caption-cheap": { id: "wire-cheap", cost: { input: 0, output: 0 } },
    },
  } as never;
  const known = collectKnownModelIds(config);
  assert.equal(known.has("caption-premium"), true, "the virtual model is a known logical id");
  assert.equal(known.has("caption-cheap"), true, "the fallback member is a known logical id");

  const res = normalizeLimits(
    [
      { name: "virt", max_usd: 1, window: { type: "rolling", duration: "1h" }, models: ["caption-premium"] },
      { name: "member", max_usd: 1, window: { type: "rolling", duration: "1h" }, models: ["caption-cheap"] },
    ],
    { ...normOpts, knownModelIds: known },
  );
  assert.equal(res.fatal.length, 0);
  assert.ok(
    !res.warnings.some((w) => /unknown model/.test(w)),
    "neither a virtual model nor a fallback member earns an unknown-model warning",
  );
});
