import assert from "node:assert/strict";
import test from "node:test";
import { effectiveMaxContextTokens } from "../src/agent/factory.js";
import { validateContextTokenCeilings } from "../src/app.js";
import type { AppConfig } from "../src/config/index.js";

// --- #8 (a): effective-limit composition (Decision D2 — a session type can
// only TIGHTEN a model's ceiling, never raise it; the effective limit is the
// min of the set values). ---

test("effectiveMaxContextTokens: returns the min of two set values", () => {
  assert.equal(effectiveMaxContextTokens(8_000, 4_000), 4_000);
  assert.equal(effectiveMaxContextTokens(4_000, 8_000), 4_000);
});

test("effectiveMaxContextTokens: a session type can only tighten, never raise", () => {
  // Model ceiling 4_000, session type asks for 9_000 → still clamped to 4_000.
  // The type cannot widen the model's operator-set ceiling (D2).
  assert.equal(effectiveMaxContextTokens(4_000, 9_000), 4_000);
});

test("effectiveMaxContextTokens: returns the single set value when only one side is set", () => {
  assert.equal(effectiveMaxContextTokens(5_000, undefined), 5_000);
  assert.equal(effectiveMaxContextTokens(undefined, 5_000), 5_000);
});

test("effectiveMaxContextTokens: returns null when both are unset (unenforced)", () => {
  assert.equal(effectiveMaxContextTokens(undefined, undefined), null);
});

test("effectiveMaxContextTokens: equal values collapse to that value", () => {
  assert.equal(effectiveMaxContextTokens(6_000, 6_000), 6_000);
});

// --- #8 (b/c): cross-field startup validation. `validateContextTokenCeilings`
// is the pure function extracted from `startMikuAgent` (it reads only
// config.models + config.agent.session_types). We cast minimal fixtures, the
// same convention the other tests use for partial config/dep shapes. ---

/** Minimal AppConfig shape touched by validateContextTokenCeilings. */
function configWith(opts: {
  models: Record<
    string,
    { context_window?: number; max_context_tokens?: number }
  >;
  sessionTypes?: Record<
    string,
    { model?: string; max_context_tokens?: number }
  >;
}): AppConfig {
  return {
    models: opts.models,
    agent: { session_types: opts.sessionTypes },
  } as unknown as AppConfig;
}

test("validateContextTokenCeilings: throws when a model's max_context_tokens > context_window", () => {
  const config = configWith({
    models: { default: { context_window: 4_000, max_context_tokens: 8_000 } },
  });
  assert.throws(
    () => validateContextTokenCeilings(config),
    /models\.default: max_context_tokens \(8000\) must be <= context_window \(4000\)/,
  );
});

test("validateContextTokenCeilings: throws when a session-type ceiling exceeds the resolved model's context_window", () => {
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

test("validateContextTokenCeilings: passes when only one side is set", () => {
  // Model has a ceiling but no window → nothing to compare against; passes.
  assert.doesNotThrow(() =>
    validateContextTokenCeilings(
      configWith({ models: { default: { max_context_tokens: 8_000 } } }),
    ),
  );
  // Model has a window but no ceiling; a session-type ceiling within window passes.
  assert.doesNotThrow(() =>
    validateContextTokenCeilings(
      configWith({
        models: { default: { context_window: 10_000 } },
        sessionTypes: { summarize: { max_context_tokens: 6_000 } },
      }),
    ),
  );
});

test("validateContextTokenCeilings: passes when values fit (ceiling <= window, equal allowed)", () => {
  assert.doesNotThrow(() =>
    validateContextTokenCeilings(
      configWith({
        models: { default: { context_window: 8_000, max_context_tokens: 8_000 } },
        sessionTypes: { summarize: { max_context_tokens: 8_000 } },
      }),
    ),
  );
});

test("validateContextTokenCeilings: passes when nothing is set (empty config)", () => {
  assert.doesNotThrow(() =>
    validateContextTokenCeilings(configWith({ models: { default: {} } })),
  );
});
