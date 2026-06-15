import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetEngine, type LimitRule } from "../src/budget/engine.js";
import { normalizeLimits, type RawLimitRule } from "../src/budget/normalize.js";
import { parseDuration, resolveWindow, isValidTimeZone } from "../src/budget/window.js";
import { collectZeroCostModelIds } from "../src/budget/zero-cost.js";

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

// ---------------------------------------------------------------------------
// collectZeroCostModelIds (§2.2)
// ---------------------------------------------------------------------------

test("collectZeroCostModelIds: zero-rate models in the set, paid excluded", () => {
  const config = {
    models: {
      default: { id: "free", cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
      big: { id: "paid", cost: { input: 3, output: 15, cache_read: 0, cache_write: 0 } },
      bare: { id: "bare" }, // no cost block → zero
    },
    retrieval: { embedding: { remote: { id: "emb", cost_per_mtok: 0 } } },
  } as never;
  const zero = collectZeroCostModelIds(config);
  assert.equal(zero.has("free"), true);
  assert.equal(zero.has("bare"), true);
  assert.equal(zero.has("emb"), true);
  assert.equal(zero.has("paid"), false);
});

test("collectZeroCostModelIds: a paid appearance overrides a zero appearance", () => {
  const config = {
    models: {
      default: { id: "shared" }, // zero here
    },
    x_search: { model: "shared", cost: { input: 5, output: 5 } }, // paid here
  } as never;
  const zero = collectZeroCostModelIds(config);
  assert.equal(zero.has("shared"), false);
});
