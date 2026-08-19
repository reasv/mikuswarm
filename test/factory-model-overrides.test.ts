/**
 * Factory-level per-agent model override tests (spec PER-AGENT-MODEL-OVERRIDES §4/§8).
 *
 * Phase 1 — chat lane:
 *   - `resolveModelId(sessionType, timelineKey)` resolves through the per-agent ladder
 *     when `resolveAgentName` + `agentModelOverrides` are wired.
 *   - `resolveLogicalModelId(sessionType, timelineKey)` does the same for the logical id.
 *   - `resolveModelChainLogicalIds(sessionType, timelineKey)` resolves the chain head via
 *     the ladder.
 *   - Without a `timelineKey` the global-only path is used (backward-compatible callers).
 *   - Without `resolveAgentName` / `agentModelOverrides` wired (legacy mode) the helpers
 *     produce the same result as today's global-only path.
 *   - `create()` picks the per-agent overridden model key via the ladder.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentSessionFactory } from "../src/agent/factory.js";
import { buildAgentModelOverrides } from "../src/agent/agent-model-overrides.js";
import type { AppConfig } from "../src/config/index.js";
import { ContextBuilder } from "../src/context/builder.js";

// ---------------------------------------------------------------------------
// Minimal config builders
// ---------------------------------------------------------------------------

/** Minimal two-model config: "default" (id "def-wire") and "alt" (id "alt-wire"). */
function makeConfig(opts: {
  defaultModel?: string;
  altModel?: string;
  sessionTypes?: Record<string, { model?: string }>;
  agentOverrides?: Record<string, { session_types?: Record<string, string> }>;
} = {}): AppConfig {
  const defaultKey = opts.defaultModel ?? "default";
  const altKey = opts.altModel ?? "alt";
  const agents: Record<string, { workspace_root: string; models?: { session_types?: Record<string, string> } }> = {};
  for (const [name, ov] of Object.entries(opts.agentOverrides ?? {})) {
    agents[name] = { workspace_root: `./workspaces/${name}`, models: ov };
  }
  return {
    app: { name: "t", data_dir: "./var", log_level: "info", context_dump_dir: "./d" },
    agent: {
      sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
      system: {},
      session_types: opts.sessionTypes
        ? Object.fromEntries(
            Object.entries(opts.sessionTypes).map(([k, v]) => [k, { model: v.model }]),
          )
        : undefined,
    },
    models: {
      [defaultKey]: {
        id: `${defaultKey}-wire`,
        provider: "test",
        endpoint: "http://localhost",
        api_key: "k",
        input_modalities: ["text"],
        max_tokens: 1024,
        context_window: 128_000,
      },
      [altKey]: {
        id: `${altKey}-wire`,
        provider: "test",
        endpoint: "http://localhost",
        api_key: "k",
        input_modalities: ["text"],
        max_tokens: 1024,
        context_window: 64_000,
      },
    },
    context: {
      tiers: {
        rich_target_tokens: 1_000,
        rich_max_tokens: 2_000,
        compact_target_tokens: 3_000,
        compact_max_tokens: 4_000,
      },
    },
    storage: { database_path: ":memory:" },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { t: { homeserver: "http://localhost", user_id: "@t:l", store_path: "./var/t" } },
    },
    agents: Object.keys(agents).length > 0 ? agents : undefined,
  } as AppConfig;
}

/** Build a factory for a config with optional per-agent wiring. */
function makeFactory(
  config: AppConfig,
  resolveAgentName?: (timelineKey: string) => string | null,
): AgentSessionFactory {
  const overrides = buildAgentModelOverrides(config);
  return new AgentSessionFactory({
    config,
    contextBuilder: new ContextBuilder({} as never),
    getActiveSessions: () => [],
    agentModelOverrides: overrides,
    resolveAgentName,
  });
}

// ---------------------------------------------------------------------------
// resolveModelId — per-agent ladder via timelineKey
// ---------------------------------------------------------------------------

test("resolveModelId: without timelineKey uses global path (backward-compat)", () => {
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = makeFactory(config, () => "sidekick");
  // No timelineKey → global path → "default" model → upstream id "default-wire"
  assert.equal(factory.resolveModelId("default"), "default-wire");
});

test("resolveModelId: with timelineKey and agent override uses ladder", () => {
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = makeFactory(config, () => "sidekick");
  // timelineKey → resolveAgentName returns "sidekick" → ladder rung 1: "alt" → id "alt-wire"
  assert.equal(factory.resolveModelId("default", "matrix:sidekick:room"), "alt-wire");
});

test("resolveModelId: with timelineKey resolving to null uses global path", () => {
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  // resolveAgentName returns null → global path
  const factory = makeFactory(config, () => null);
  assert.equal(factory.resolveModelId("default", "matrix:legacy:room"), "default-wire");
});

test("resolveModelId: without resolveAgentName wired (legacy mode) uses global path", () => {
  // No resolveAgentName → legacy mode; override module present but resolver absent → global
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = new AgentSessionFactory({
    config,
    contextBuilder: new ContextBuilder({} as never),
    getActiveSessions: () => [],
    agentModelOverrides: buildAgentModelOverrides(config),
    // resolveAgentName absent
  });
  assert.equal(factory.resolveModelId("default", "matrix:sidekick:room"), "default-wire");
});

test("resolveModelId: agent rung-2 (default override) applies to un-configured session types", () => {
  const config = makeConfig({
    // no global session_types → only rung 3 fallback "default"
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = makeFactory(config, () => "sidekick");
  // "custom" type → no rung 1 → rung 2: agent["default"] = "alt" → "alt-wire"
  assert.equal(factory.resolveModelId("custom", "matrix:sidekick:room"), "alt-wire");
});

test("resolveModelId: non-overriding agent resolves same as global", () => {
  // Agent "main" has no overrides → resolves same as null
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { main: {} },
  });
  const factory = makeFactory(config, () => "main");
  assert.equal(factory.resolveModelId("default", "matrix:main:room"), "default-wire");
});

// ---------------------------------------------------------------------------
// resolveLogicalModelId — same ladder, returns the config block name
// ---------------------------------------------------------------------------

test("resolveLogicalModelId: without timelineKey returns global logical id", () => {
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = makeFactory(config, () => "sidekick");
  assert.equal(factory.resolveLogicalModelId("default"), "default");
});

test("resolveLogicalModelId: with timelineKey returns per-agent logical id", () => {
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = makeFactory(config, () => "sidekick");
  assert.equal(factory.resolveLogicalModelId("default", "matrix:sidekick:room"), "alt");
});

// ---------------------------------------------------------------------------
// resolveModelChainLogicalIds — chain head via ladder
// ---------------------------------------------------------------------------

test("resolveModelChainLogicalIds: without timelineKey uses global chain head", () => {
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = makeFactory(config, () => "sidekick");
  const chain = factory.resolveModelChainLogicalIds("default");
  assert.ok(chain.includes("default"), `expected chain to include "default", got ${chain}`);
});

test("resolveModelChainLogicalIds: with timelineKey uses per-agent chain head", () => {
  const config = makeConfig({
    sessionTypes: { default: { model: "default" } },
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const factory = makeFactory(config, () => "sidekick");
  const chain = factory.resolveModelChainLogicalIds("default", "matrix:sidekick:room");
  assert.ok(chain.includes("alt"), `expected chain to include "alt", got ${chain}`);
  assert.ok(!chain.includes("default"), `chain should not include "default" when overridden, got ${chain}`);
});

// ---------------------------------------------------------------------------
// Legacy invariance: without agentModelOverrides the helpers match today's behavior
// ---------------------------------------------------------------------------

test("invariance: without agentModelOverrides resolveModelId === today's global behavior", () => {
  const config = makeConfig({ sessionTypes: { default: { model: "default" } } });
  // No agentModelOverrides
  const legacyFactory = new AgentSessionFactory({
    config,
    contextBuilder: new ContextBuilder({} as never),
    getActiveSessions: () => [],
  });
  assert.equal(legacyFactory.resolveModelId("default"), "default-wire");
  // Even with a timelineKey — no ladder wired → global path
  assert.equal(legacyFactory.resolveModelId("default", "matrix:x:room"), "default-wire");
});

test("invariance: without agentModelOverrides resolveLogicalModelId === today's global behavior", () => {
  const config = makeConfig({ sessionTypes: { default: { model: "default" } } });
  const legacyFactory = new AgentSessionFactory({
    config,
    contextBuilder: new ContextBuilder({} as never),
    getActiveSessions: () => [],
  });
  assert.equal(legacyFactory.resolveLogicalModelId("default"), "default");
  assert.equal(legacyFactory.resolveLogicalModelId("default", "matrix:x:room"), "default");
});

// ---------------------------------------------------------------------------
// resolveAgentName closure isolation: the factory calls it exactly once per
// helper invocation (not on every intermediate step).
// ---------------------------------------------------------------------------

test("resolveAgentName is called with the provided timelineKey", () => {
  const config = makeConfig({
    agentOverrides: { sidekick: { session_types: { default: "alt" } } },
  });
  const seen: string[] = [];
  const factory = makeFactory(config, (tk) => { seen.push(tk); return "sidekick"; });
  factory.resolveModelId("default", "matrix:sidekick:room1");
  factory.resolveLogicalModelId("default", "matrix:sidekick:room2");
  factory.resolveModelChainLogicalIds("default", "matrix:sidekick:room3");
  assert.deepEqual(seen, [
    "matrix:sidekick:room1",
    "matrix:sidekick:room2",
    "matrix:sidekick:room3",
  ]);
});
