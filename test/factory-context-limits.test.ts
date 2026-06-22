import assert from "node:assert/strict";
import test from "node:test";
import { AgentSessionFactory, composeSessionContextCeiling } from "../src/agent/factory.js";
import { validateContextTokenCeilings } from "../src/app.js";
import type { AppConfig } from "../src/config/index.js";

// === spec CONTEXT-LIMIT-UNIFICATION ===========================================
// `context_window` is the sole model-level ceiling and the always-on enforcement
// base; `max_context_tokens` survives only as a per-session-type override that
// can TIGHTEN that ceiling. One resolver composes the two and feeds every
// consumer. These tests pin the composition, the cross-field validation, and the
// per-session resolver method.

// --- §2.2: composition — min(context_window, override) ------------------------

test("composeSessionContextCeiling: override below the window tightens to the override", () => {
  assert.equal(composeSessionContextCeiling(128_000, 60_000), 60_000);
});

test("composeSessionContextCeiling: override equal to the window collapses to that value", () => {
  assert.equal(composeSessionContextCeiling(60_000, 60_000), 60_000);
});

test("composeSessionContextCeiling: override above the window cannot raise the ceiling", () => {
  // Defensive min(): even though cross-validation rejects override > window, the
  // composer never widens the model ceiling.
  assert.equal(composeSessionContextCeiling(60_000, 128_000), 60_000);
});

test("composeSessionContextCeiling: unset override falls back to the window (always a number)", () => {
  assert.equal(composeSessionContextCeiling(128_000, undefined), 128_000);
  assert.equal(composeSessionContextCeiling(128_000), 128_000);
});

// --- §2.5: cross-field startup validation. `validateContextTokenCeilings` is the
// pure function extracted from `startMikuAgent` (it reads only config.models +
// config.agent.session_types). We cast minimal fixtures, the same convention the
// other tests use for partial config/dep shapes. ---

/** Minimal AppConfig shape touched by validateContextTokenCeilings. */
function configWith(opts: {
  models: Record<string, { context_window?: number; max_context_tokens?: number }>;
  sessionTypes?: Record<string, { model?: string; max_context_tokens?: number }>;
}): AppConfig {
  return {
    models: opts.models,
    agent: { session_types: opts.sessionTypes },
  } as unknown as AppConfig;
}

test("validateContextTokenCeilings: throws when the default model has no context_window", () => {
  assert.throws(
    () => validateContextTokenCeilings(configWith({ models: { default: {} } })),
    /models\.default: context_window is required \(resolved by default model\)/,
  );
});

test("validateContextTokenCeilings: throws when a session-resolved model has no context_window", () => {
  const config = configWith({
    models: { default: { context_window: 128_000 }, tiny: {} },
    sessionTypes: { worker: { model: "tiny" } },
  });
  assert.throws(
    () => validateContextTokenCeilings(config),
    /models\.tiny: context_window is required \(resolved by agent\.session_types\.worker\)/,
  );
});

test("validateContextTokenCeilings: throws when a session type names a missing model", () => {
  const config = configWith({
    models: { default: { context_window: 128_000 } },
    sessionTypes: { worker: { model: "ghost" } },
  });
  assert.throws(
    () => validateContextTokenCeilings(config),
    /agent\.session_types\.worker: model "ghost" not found in \[models\]/,
  );
});

test("validateContextTokenCeilings: throws when a session-type override exceeds the resolved model's context_window", () => {
  const config = configWith({
    models: { default: { context_window: 4_000 } },
    sessionTypes: { summarize: { max_context_tokens: 9_000 } },
  });
  assert.throws(
    () => validateContextTokenCeilings(config),
    /agent\.session_types\.summarize: max_context_tokens \(9000\) exceeds context_window \(4000\) of its model "default"/,
  );
});

test("validateContextTokenCeilings: a session type resolves through its own `model` key", () => {
  const config = configWith({
    models: {
      default: { context_window: 100_000 },
      tiny: { context_window: 2_000 },
    },
    // Resolves to the `tiny` model, whose window (2_000) is the wall it must fit under.
    sessionTypes: { worker: { model: "tiny", max_context_tokens: 5_000 } },
  });
  assert.throws(
    () => validateContextTokenCeilings(config),
    /agent\.session_types\.worker: max_context_tokens \(5000\) exceeds context_window \(2000\) of its model "tiny"/,
  );
});

test("validateContextTokenCeilings: passes when values fit (override <= window, equal allowed)", () => {
  assert.doesNotThrow(() =>
    validateContextTokenCeilings(
      configWith({
        models: { default: { context_window: 8_000 } },
        sessionTypes: { summarize: { max_context_tokens: 8_000 }, chat: {} },
      }),
    ),
  );
});

test("validateContextTokenCeilings: passes when only the default model with a window is configured", () => {
  assert.doesNotThrow(() =>
    validateContextTokenCeilings(configWith({ models: { default: { context_window: 128_000 } } })),
  );
});

// --- §2.4: the single per-session resolver. `resolveSessionContextCeiling`
// composes the resolved model's window with the session type's override and
// ALWAYS returns a number — never null, so enforcement is always wired. ---

/** Build a factory over a minimal config exercising only the resolver. */
function makeFactory(opts: {
  models: Record<string, { context_window?: number }>;
  sessionTypes?: Record<string, { model?: string; max_context_tokens?: number }>;
}): AgentSessionFactory {
  const config = {
    models: opts.models,
    agent: { session_types: opts.sessionTypes },
  } as unknown as AppConfig;
  return new AgentSessionFactory({
    config,
    contextBuilder: {} as any,
    getActiveSessions: () => [],
  });
}

test("resolveSessionContextCeiling: an interactive type with no override resolves to the model window (always-on enforcement)", () => {
  // The behavioral delta: `default`/`proactive` gain the model's context_window
  // as an enforced ceiling where they previously resolved to null (unbounded).
  const factory = makeFactory({
    models: { default: { context_window: 128_000 } },
    sessionTypes: { default: {} },
  });
  assert.equal(factory.resolveSessionContextCeiling("default"), 128_000);
});

test("resolveSessionContextCeiling: a worker override tightens below the window", () => {
  const factory = makeFactory({
    models: { default: { context_window: 128_000 } },
    sessionTypes: { summarize: { max_context_tokens: 60_000 } },
  });
  assert.equal(factory.resolveSessionContextCeiling("summarize"), 60_000);
});

test("resolveSessionContextCeiling: resolves through a session type's own model key", () => {
  const factory = makeFactory({
    models: { default: { context_window: 128_000 }, tiny: { context_window: 32_000 } },
    sessionTypes: { worker: { model: "tiny", max_context_tokens: 20_000 } },
  });
  assert.equal(factory.resolveSessionContextCeiling("worker"), 20_000);
});

test("resolveSessionContextCeiling: an unknown session type falls back to the default model window", () => {
  const factory = makeFactory({
    models: { default: { context_window: 128_000 } },
    sessionTypes: {},
  });
  // No matching or `default` session type → resolves the `default` model window.
  assert.equal(factory.resolveSessionContextCeiling("nonexistent"), 128_000);
});

test("resolveSessionContextCeiling: throws (defensive) when the resolved model has no context_window", () => {
  const factory = makeFactory({ models: { default: {} } });
  assert.throws(
    () => factory.resolveSessionContextCeiling("default"),
    /model "default" \(session type "default"\) has no context_window/,
  );
});

// --- SESSION-COST-LIMITS §3: resolveSessionCostCeiling — global default +
// per-session-type override; `0` (either level) means "no cap"; unset = unlimited. ---

/** Build a factory exercising the cost-ceiling resolver. */
function makeCostFactory(opts: {
  global?: number;
  sessionTypes?: Record<string, { max_session_cost_usd?: number }>;
}): AgentSessionFactory {
  const config = {
    models: { default: { context_window: 128_000 } },
    agent: { max_session_cost_usd: opts.global, session_types: opts.sessionTypes },
  } as unknown as AppConfig;
  return new AgentSessionFactory({
    config,
    contextBuilder: {} as any,
    getActiveSessions: () => [],
  });
}

test("resolveSessionCostCeiling: unset global and override → unlimited (undefined)", () => {
  const factory = makeCostFactory({ sessionTypes: { default: {} } });
  assert.equal(factory.resolveSessionCostCeiling("default"), undefined);
});

test("resolveSessionCostCeiling: global default applies when no override is set", () => {
  const factory = makeCostFactory({ global: 1.5, sessionTypes: { default: {} } });
  assert.equal(factory.resolveSessionCostCeiling("default"), 1.5);
  // Unknown session type also inherits the global default.
  assert.equal(factory.resolveSessionCostCeiling("nonexistent"), 1.5);
});

test("resolveSessionCostCeiling: a per-type override wins over the global default", () => {
  const factory = makeCostFactory({ global: 1.0, sessionTypes: { diary: { max_session_cost_usd: 0.25 } } });
  assert.equal(factory.resolveSessionCostCeiling("diary"), 0.25);
});

test("resolveSessionCostCeiling: an override of 0 opts out even when a global default exists", () => {
  const factory = makeCostFactory({ global: 1.0, sessionTypes: { unbounded: { max_session_cost_usd: 0 } } });
  assert.equal(factory.resolveSessionCostCeiling("unbounded"), undefined);
});

test("resolveSessionCostCeiling: a global default of 0 means unlimited", () => {
  const factory = makeCostFactory({ global: 0, sessionTypes: { default: {} } });
  assert.equal(factory.resolveSessionCostCeiling("default"), undefined);
});

// === spec MODEL-FALLBACK §8: scheduler-snapshot annotation map ================

test("buildModelHealthAnnotations: maps health key → logical ids + has-fallback", async () => {
  const { buildModelHealthAnnotations } = await import("../src/app.js");
  const models = {
    // Two logical ids share ONE upstream (endpoint+id) → one health key; the
    // virtual one carries a fallback chain, so hasFallback ORs true.
    "gemini-flash": { id: "gemini-2.5-flash", endpoint: "https://gw/google" },
    "caption-premium": { id: "gemini-2.5-flash", endpoint: "https://gw/google", fallback: ["caption-cheap"] },
    "caption-cheap": { id: "gemini-lite", endpoint: "https://gw/google" },
    default: { id: "opus", endpoint: "https://gw/anthropic" },
  } as never;
  const map = buildModelHealthAnnotations(models);

  const shared = map["https://gw/google::gemini-2.5-flash"]!;
  assert.deepEqual([...shared.logicalIds].sort(), ["caption-premium", "gemini-flash"]);
  assert.equal(shared.hasFallback, true, "a shared key is fallback-bearing if ANY logical id has a chain");

  assert.deepEqual(map["https://gw/google::gemini-lite"], { logicalIds: ["caption-cheap"], hasFallback: false });
  assert.deepEqual(map["https://gw/anthropic::opus"], { logicalIds: ["default"], hasFallback: false });
});
