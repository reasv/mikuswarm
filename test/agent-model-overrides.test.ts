/**
 * Per-agent model override tests (spec PER-AGENT-MODEL-OVERRIDES §4/§7/§12).
 *
 * Covers:
 *   - §4 resolution ladders: all rungs × agent/global combinations for all four
 *     resolvers, including the null-agent (legacy) passthrough
 *   - §7 validation failures (path-precise errors): unknown session-type keys,
 *     unknown model refs, missing context_window, unconfigured-subsystem overrides,
 *     and the summaries_from conflict
 *   - §12 invariance: agents-mode with no overrides resolves identically to the
 *     global-only path; null-agent produces the same result as the global path
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../src/config/index.js";
import { loadConfig } from "../src/config/index.js";
import { validateAgentConfig } from "../src/app.ts";
import { buildAgentModelOverrides } from "../src/agent/agent-model-overrides.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function withConfigDir(
  toml: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "miku-amo-"));
  try {
    await writeFile(path.join(dir, "00-test.toml"), toml, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Minimal agents-mode config with two agents, no overrides. The matrix account
 * "main" points at agent "main". The second account "sidekick" points at "sidekick".
 */
const AGENTS_BASE = `
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
context_window = 128000

[models.chat-alt]
id = "chat-alt-id"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024
context_window = 64000

[models.caption-cheap]
id = "caption-cheap-id"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text", "image"]
max_tokens = 512

[models.imagegen-alt]
id = "imagegen-alt-id"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 4096

[models.grok-alt]
id = "grok-alt-id"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 2048

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.main]
homeserver = "http://localhost"
user_id = "@main:localhost"
store_path = "./var/main"
agent = "main"

[matrix.accounts.sidekick]
homeserver = "http://localhost"
user_id = "@sidekick:localhost"
store_path = "./var/sidekick"
agent = "sidekick"

[summarization]
enabled = false

[agents.main]
workspace_root = "./workspaces/main"

[agents.sidekick]
workspace_root = "./workspaces/sidekick"
`;

// ---------------------------------------------------------------------------
// Minimal AppConfig builders (for pure ladder-unit tests, no file I/O).
// These intentionally cast their return types so the resolvers can be tested
// in isolation without booting the whole app or touching the filesystem.
// ---------------------------------------------------------------------------

/** Minimal config object — no agents, global models only. */
function makeLegacyConfig(overrides: {
  sessionTypes?: Record<string, { model?: string }>;
  captioning?: {
    model?: string;
    image?: { model?: string };
    video?: { model?: string };
    audio?: { model?: string };
  };
  imageGen?: { pro: string; flash: string };
  xSearch?: { model: string; deep_model?: string };
} = {}): AppConfig {
  return {
    app: { name: "t", data_dir: "./var", log_level: "info", context_dump_dir: "./d" },
    agent: {
      sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
      system: {},
      session_types: overrides.sessionTypes
        ? Object.fromEntries(
            Object.entries(overrides.sessionTypes).map(([k, v]) => [k, { model: v.model }]),
          )
        : undefined,
    },
    models: {
      default: {
        id: "default-id",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "k",
        input_modalities: ["text"],
        max_tokens: 1024,
        context_window: 128000,
      },
      "chat-alt": {
        id: "chat-alt-id",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "k",
        input_modalities: ["text"],
        max_tokens: 1024,
        context_window: 64000,
      },
      "caption-cheap": {
        id: "caption-cheap-id",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "k",
        input_modalities: ["text", "image"],
        max_tokens: 512,
      },
      "imagegen-alt": {
        id: "imagegen-alt-id",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "k",
        input_modalities: ["text"],
        max_tokens: 4096,
      },
      "grok-alt": {
        id: "grok-alt-id",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "k",
        input_modalities: ["text"],
        max_tokens: 2048,
      },
    },
    context: {
      tiers: {
        rich_target_tokens: 1000,
        rich_max_tokens: 2000,
        compact_target_tokens: 3000,
        compact_max_tokens: 4000,
      },
    },
    storage: { database_path: ":memory:" },
    matrix: {
      enabled: false,
      trigger_hold_ms: 0,
      accounts: { test: { homeserver: "http://localhost", user_id: "@t:l", store_path: "./var/t" } },
    },
    captioning: overrides.captioning as AppConfig["captioning"],
    image_gen: overrides.imageGen
      ? { models: { pro: overrides.imageGen.pro, flash: overrides.imageGen.flash } }
      : undefined,
    x_search: overrides.xSearch as AppConfig["x_search"],
  } as AppConfig;
}

/** Agents-mode config with one agent named `agentName`. */
function makeAgentsConfig(
  agentName: string,
  agentModels: NonNullable<NonNullable<AppConfig["agents"]>[string]["models"]>,
  globalConfig: Parameters<typeof makeLegacyConfig>[0] = {},
): AppConfig {
  const base = makeLegacyConfig(globalConfig);
  return {
    ...base,
    agents: {
      [agentName]: {
        workspace_root: "./workspaces/" + agentName,
        models: agentModels,
      },
    },
  } as AppConfig;
}

// ---------------------------------------------------------------------------
// §4 resolveSessionTypeModelRef — chat-lane ladder
// ---------------------------------------------------------------------------

test("resolveSessionTypeModelRef: no config anywhere → literal 'default'", () => {
  const overrides = buildAgentModelOverrides(makeLegacyConfig());
  assert.equal(overrides.resolveSessionTypeModelRef(null, "chat"), "default");
  assert.equal(overrides.resolveSessionTypeModelRef(null, "default"), "default");
});

test("resolveSessionTypeModelRef: null agentName resolves via global-only rungs", () => {
  const cfg = makeLegacyConfig({
    sessionTypes: { "chat-alt-type": { model: "chat-alt" }, default: { model: "chat-alt" } },
  });
  const overrides = buildAgentModelOverrides(cfg);
  // Rung 1: global session_types["chat-alt-type"].model
  assert.equal(overrides.resolveSessionTypeModelRef(null, "chat-alt-type"), "chat-alt");
  // Rung 2: no type-specific entry → global session_types["default"].model
  assert.equal(overrides.resolveSessionTypeModelRef(null, "unknown-type"), "chat-alt");
});

test("resolveSessionTypeModelRef: rung 1 — agent type-specific override wins over global type-specific", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { session_types: { "chat-alt-type": "chat-alt" } },
    { sessionTypes: { "chat-alt-type": { model: "default" } } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveSessionTypeModelRef("sidekick", "chat-alt-type"), "chat-alt");
});

test("resolveSessionTypeModelRef: rung 1 — global type-specific wins when agent has no override for that type", () => {
  // Agent has only a "default" override, but the type has a global specific model.
  const cfg = makeAgentsConfig(
    "sidekick",
    { session_types: { default: "chat-alt" } },
    { sessionTypes: { premium: { model: "default" } } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  // Rung 1: no agent["premium"], but global session_types["premium"].model = "default" → "default"
  assert.equal(overrides.resolveSessionTypeModelRef("sidekick", "premium"), "default");
  // Rung 2: agent["default"] = "chat-alt" → "chat-alt" for types with no specific entry
  assert.equal(overrides.resolveSessionTypeModelRef("sidekick", "other"), "chat-alt");
});

test("resolveSessionTypeModelRef: rung 2 — agent default override shadows global default", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { session_types: { default: "chat-alt" } },
    { sessionTypes: { default: { model: "default" } } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  // Rung 2 wins: agent["default"] shadows global["default"].model
  assert.equal(overrides.resolveSessionTypeModelRef("sidekick", "other"), "chat-alt");
});

test("resolveSessionTypeModelRef: rung 3 — no agent or global defaults → literal 'default'", () => {
  const cfg = makeAgentsConfig("sidekick", {});
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveSessionTypeModelRef("sidekick", "any"), "default");
});

test("resolveSessionTypeModelRef: agent with no models block resolves via global (invariance)", () => {
  // An agent in the agents map without a models block must produce the same result as null.
  const cfg = makeLegacyConfig({ sessionTypes: { default: { model: "chat-alt" } } });
  const withAgents: AppConfig = {
    ...cfg,
    agents: { main: { workspace_root: "./workspaces/main" } },
  } as AppConfig;
  const overrides = buildAgentModelOverrides(withAgents);
  // "main" has no models block → same as null
  assert.equal(overrides.resolveSessionTypeModelRef("main", "any"), "chat-alt");
  assert.equal(overrides.resolveSessionTypeModelRef(null, "any"), "chat-alt");
});

test("resolveSessionTypeModelRef: null-agent passthrough equals global-only resolution", () => {
  // Null agent must produce identical results to a world with no agents table.
  const globalCfg = { sessionTypes: { chat: { model: "chat-alt" }, default: { model: "chat-alt" } } };
  const legacyOverrides = buildAgentModelOverrides(makeLegacyConfig(globalCfg));
  const agentsOverrides = buildAgentModelOverrides(
    makeAgentsConfig("main", { session_types: { chat: "chat-alt" } }, globalCfg),
  );
  // Null agent must not pick up the agent override
  assert.equal(legacyOverrides.resolveSessionTypeModelRef(null, "chat"), "chat-alt");
  assert.equal(agentsOverrides.resolveSessionTypeModelRef(null, "chat"), "chat-alt");
  assert.equal(agentsOverrides.resolveSessionTypeModelRef(null, "unknown"), "chat-alt");
});

// ---------------------------------------------------------------------------
// §4 resolveSessionTypeModelRef — block-level fallback (FIX 1 ladder correction)
//
// factory.resolveSessionType semantics: `(types[T] ?? types["default"])?.model ?? "default"`.
// When types[T] exists but has no `model` key, the fallback is the LITERAL "default"
// (not types["default"].model), because types[T] is truthy so `??` doesn't fall through.
// The ladder must reproduce this exactly for legacy invariance.
// ---------------------------------------------------------------------------

test("resolveSessionTypeModelRef: declared type block WITHOUT model + default WITH model → literal 'default' (block-fallback, FIX 1)", () => {
  // types["proactive"] exists (no model key) + types["default"] has model "chat-alt".
  // factory: (types["proactive"] ?? types["default"])?.model ?? "default"
  //        = types["proactive"]?.model ?? "default"  (types["proactive"] is truthy)
  //        = undefined ?? "default" = "default" (literal)
  // NOT "chat-alt" (the default type's model).
  const cfg = makeLegacyConfig({
    sessionTypes: {
      proactive: {},          // declared block, no model
      default: { model: "chat-alt" },
    },
  });
  const overrides = buildAgentModelOverrides(cfg);
  // null agent: rung 1 = undefined, rung 2 global half = t exists → undefined, rung 3 = "default"
  assert.equal(overrides.resolveSessionTypeModelRef(null, "proactive"), "default");
});

test("resolveSessionTypeModelRef: same config — agent overrides 'default' → agent default wins (FIX 1, case b)", () => {
  // Same as above: types["proactive"] declared without model; types["default"] has "chat-alt".
  // Agent overrides session_types["default"] = "chat-alt" (the agent's default override).
  // Rung 2: agent["default"] = "chat-alt" is defined → return "chat-alt" (agent default wins
  // over literal "default", even though the global half would have been undefined due to t).
  const cfg = makeAgentsConfig(
    "sidekick",
    { session_types: { default: "chat-alt" } },
    {
      sessionTypes: {
        proactive: {},          // declared block, no model
        default: { model: "default" },
      },
    },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveSessionTypeModelRef("sidekick", "proactive"), "chat-alt");
});

test("resolveSessionTypeModelRef: same config — agent overrides type by name → that wins (FIX 1, case c)", () => {
  // types["proactive"] declared without model; types["default"] has "default".
  // Agent overrides session_types["proactive"] = "chat-alt" → rung 1 agent half wins.
  const cfg = makeAgentsConfig(
    "sidekick",
    { session_types: { proactive: "chat-alt" } },
    {
      sessionTypes: {
        proactive: {},          // declared block, no model
        default: { model: "default" },
      },
    },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveSessionTypeModelRef("sidekick", "proactive"), "chat-alt");
});

test("resolveSessionTypeModelRef: type block ABSENT → default type's model (FIX 1, case d)", () => {
  // types["custom"] is entirely absent. Rung 1: t = undefined, r1 = undefined.
  // Rung 2 global half: t absent → globalSessionTypes["default"]?.model = "chat-alt" → return it.
  const cfg = makeLegacyConfig({
    sessionTypes: {
      // no "custom" entry — only "default"
      default: { model: "chat-alt" },
    },
  });
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveSessionTypeModelRef(null, "custom"), "chat-alt");
});

// ---------------------------------------------------------------------------
// §4 resolveCaptionModelRef — captioning ladder
// ---------------------------------------------------------------------------

test("resolveCaptionModelRef: no captioning config → 'default'", () => {
  const overrides = buildAgentModelOverrides(makeLegacyConfig());
  assert.equal(overrides.resolveCaptionModelRef(null, "image"), "default");
  assert.equal(overrides.resolveCaptionModelRef(null, "video"), "default");
  assert.equal(overrides.resolveCaptionModelRef(null, "audio"), "default");
});

test("resolveCaptionModelRef: null agent resolves via global only", () => {
  const cfg = makeLegacyConfig({
    captioning: { model: "caption-cheap", image: { model: "caption-cheap" } },
  });
  const overrides = buildAgentModelOverrides(cfg);
  // Rung 1: global image.model
  assert.equal(overrides.resolveCaptionModelRef(null, "image"), "caption-cheap");
  // Rung 2: no video.model → global captioning.model
  assert.equal(overrides.resolveCaptionModelRef(null, "video"), "caption-cheap");
  // Rung 3: audio — no modality or shared → "default"
  const noSharedCfg = makeLegacyConfig({ captioning: { image: { model: "caption-cheap" } } });
  const noSharedOverrides = buildAgentModelOverrides(noSharedCfg);
  assert.equal(noSharedOverrides.resolveCaptionModelRef(null, "audio"), "default");
});

test("resolveCaptionModelRef: rung 1 — agent modality wins over global modality", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { captioning: { image: "caption-cheap" } },
    { captioning: { image: { model: "default" } } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveCaptionModelRef("sidekick", "image"), "caption-cheap");
});

test("resolveCaptionModelRef: rung 1 — global modality wins over agent shared (strict same-rung shadowing)", () => {
  // §4: a globally-configured per-modality assignment keeps winning over an agent's
  // shared override. The agent must override the modality by name to displace it.
  const cfg = makeAgentsConfig(
    "sidekick",
    { captioning: { model: "caption-cheap" } }, // agent shared only
    { captioning: { image: { model: "default" } } }, // global has modality-specific
  );
  const overrides = buildAgentModelOverrides(cfg);
  // Rung 1: global image.model = "default" wins over agent shared model = "caption-cheap"
  assert.equal(overrides.resolveCaptionModelRef("sidekick", "image"), "default");
  // Rung 2: no global video.model → agent shared model = "caption-cheap"
  assert.equal(overrides.resolveCaptionModelRef("sidekick", "video"), "caption-cheap");
});

test("resolveCaptionModelRef: rung 2 — agent shared wins over global shared", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { captioning: { model: "caption-cheap" } },
    { captioning: { model: "default" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  // Rung 1: no per-modality anywhere → rung 2: agent shared = "caption-cheap"
  assert.equal(overrides.resolveCaptionModelRef("sidekick", "video"), "caption-cheap");
});

test("resolveCaptionModelRef: null-agent passthrough equals global-only resolution", () => {
  const globalCaption = { captioning: { model: "caption-cheap", image: { model: "caption-cheap" } } };
  const legacy = buildAgentModelOverrides(makeLegacyConfig(globalCaption));
  const withAgent = buildAgentModelOverrides(
    makeAgentsConfig("main", { captioning: { image: "grok-alt" } }, globalCaption),
  );
  // Null agent must not pick up "main"'s override
  assert.equal(legacy.resolveCaptionModelRef(null, "image"), "caption-cheap");
  assert.equal(withAgent.resolveCaptionModelRef(null, "image"), "caption-cheap");
  assert.equal(withAgent.resolveCaptionModelRef("main", "image"), "grok-alt");
});

// ---------------------------------------------------------------------------
// §4 resolveImageGenRef — image_gen single-rung
// ---------------------------------------------------------------------------

test("resolveImageGenRef: no agent override → global image_gen.models[tier]", () => {
  const cfg = makeLegacyConfig({ imageGen: { pro: "imagegen-alt", flash: "default" } });
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveImageGenRef(null, "pro"), "imagegen-alt");
  assert.equal(overrides.resolveImageGenRef(null, "flash"), "default");
});

test("resolveImageGenRef: agent override wins over global", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { image_gen: { pro: "imagegen-alt" } },
    { imageGen: { pro: "default", flash: "default" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveImageGenRef("sidekick", "pro"), "imagegen-alt");
  // flash has no agent override → global
  assert.equal(overrides.resolveImageGenRef("sidekick", "flash"), "default");
});

test("resolveImageGenRef: null-agent always resolves global", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { image_gen: { pro: "imagegen-alt" } },
    { imageGen: { pro: "default", flash: "default" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveImageGenRef(null, "pro"), "default");
});

// ---------------------------------------------------------------------------
// §4 resolveXSearchRef — x_search single-rung with deep→fast fall-through
// ---------------------------------------------------------------------------

test("resolveXSearchRef: no agent override → global model/deep_model", () => {
  const cfg = makeLegacyConfig({ xSearch: { model: "grok-alt", deep_model: "default" } });
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveXSearchRef(null, "fast"), "grok-alt");
  assert.equal(overrides.resolveXSearchRef(null, "deep"), "default");
});

test("resolveXSearchRef: deep falls through to global model when global deep_model absent", () => {
  const cfg = makeLegacyConfig({ xSearch: { model: "grok-alt" } }); // no deep_model
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveXSearchRef(null, "fast"), "grok-alt");
  // No deep_model → fall through to fast = "grok-alt"
  assert.equal(overrides.resolveXSearchRef(null, "deep"), "grok-alt");
});

test("resolveXSearchRef: agent fast override — fast tier", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { x_search: { model: "grok-alt" } },
    { xSearch: { model: "default" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveXSearchRef("sidekick", "fast"), "grok-alt");
});

test("resolveXSearchRef: agent deep override — deep tier", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { x_search: { deep_model: "grok-alt" } },
    { xSearch: { model: "default", deep_model: "default" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveXSearchRef("sidekick", "deep"), "grok-alt");
});

test("resolveXSearchRef: deep fall-through: agent deep absent + global deep absent → agent fast wins", () => {
  // §4: "agent deep_model absent + global deep_model absent → agent's fast override
  // wins over global model" — this is the key invariant documented in the spec.
  const cfg = makeAgentsConfig(
    "sidekick",
    { x_search: { model: "grok-alt" } }, // agent fast, no agent deep
    { xSearch: { model: "default" } },   // global fast, no global deep
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveXSearchRef("sidekick", "fast"), "grok-alt");
  // deep falls through: no agent deep, no global deep → resolved fast = "grok-alt"
  assert.equal(overrides.resolveXSearchRef("sidekick", "deep"), "grok-alt");
});

test("resolveXSearchRef: deep fall-through uses global model when agent has neither fast nor deep", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    {}, // no x_search overrides at all
    { xSearch: { model: "grok-alt" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  assert.equal(overrides.resolveXSearchRef("sidekick", "deep"), "grok-alt");
});

test("resolveXSearchRef: global deep_model wins over agent fast when only global deep is set", () => {
  // Global deep_model is set → use it (rung 1 for global deep side), don't fall through.
  const cfg = makeAgentsConfig(
    "sidekick",
    { x_search: { model: "grok-alt" } }, // agent fast only
    { xSearch: { model: "default", deep_model: "default" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  // Rung 1 deep: no agent deep → global deep = "default" (not the fall-through)
  assert.equal(overrides.resolveXSearchRef("sidekick", "deep"), "default");
});

test("resolveXSearchRef: null-agent passthrough", () => {
  const cfg = makeAgentsConfig(
    "sidekick",
    { x_search: { model: "grok-alt", deep_model: "grok-alt" } },
    { xSearch: { model: "default" } },
  );
  const overrides = buildAgentModelOverrides(cfg);
  // Null agent: only global values
  assert.equal(overrides.resolveXSearchRef(null, "fast"), "default");
  assert.equal(overrides.resolveXSearchRef(null, "deep"), "default");
});

// ---------------------------------------------------------------------------
// §12 absent-table invariance: agents-mode with no overrides === global path
// ---------------------------------------------------------------------------

test("invariance: agents-mode with no overrides resolves identically to global-only", () => {
  const globalCfg = {
    sessionTypes: { chat: { model: "chat-alt" }, default: { model: "chat-alt" } },
    captioning: { model: "caption-cheap", image: { model: "caption-cheap" } },
    imageGen: { pro: "imagegen-alt", flash: "default" } as const,
    xSearch: { model: "grok-alt", deep_model: "default" },
  };
  const legacy = buildAgentModelOverrides(makeLegacyConfig(globalCfg));

  // Agent with no models block
  const withAgents: AppConfig = {
    ...makeLegacyConfig(globalCfg),
    agents: { main: { workspace_root: "./workspaces/main" } },
  } as AppConfig;
  const withOverrides = buildAgentModelOverrides(withAgents);

  // All four resolvers must produce identical results for null vs. agent-without-overrides
  for (const agentName of [null, "main"] as Array<string | null>) {
    assert.equal(
      withOverrides.resolveSessionTypeModelRef(agentName, "chat"),
      legacy.resolveSessionTypeModelRef(null, "chat"),
    );
    assert.equal(
      withOverrides.resolveSessionTypeModelRef(agentName, "any"),
      legacy.resolveSessionTypeModelRef(null, "any"),
    );
    assert.equal(
      withOverrides.resolveCaptionModelRef(agentName, "image"),
      legacy.resolveCaptionModelRef(null, "image"),
    );
    assert.equal(
      withOverrides.resolveCaptionModelRef(agentName, "video"),
      legacy.resolveCaptionModelRef(null, "video"),
    );
    assert.equal(
      withOverrides.resolveImageGenRef(agentName, "pro"),
      legacy.resolveImageGenRef(null, "pro"),
    );
    assert.equal(
      withOverrides.resolveXSearchRef(agentName, "fast"),
      legacy.resolveXSearchRef(null, "fast"),
    );
    assert.equal(
      withOverrides.resolveXSearchRef(agentName, "deep"),
      legacy.resolveXSearchRef(null, "deep"),
    );
  }
});

// ---------------------------------------------------------------------------
// §7 schema validation: [agents.<name>.models] accepted / rejected by schema
// ---------------------------------------------------------------------------

test("schema: [agents.<name>.models] block with session_types is accepted", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.session_types]
default = "chat-alt"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(
      config.agents?.sidekick?.models?.session_types?.["default"],
      "chat-alt",
    );
  });
});

test("schema: [agents.<name>.models] with captioning overrides is accepted", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.captioning]
model = "caption-cheap"
image = "caption-cheap"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agents?.sidekick?.models?.captioning?.model, "caption-cheap");
    assert.equal(config.agents?.sidekick?.models?.captioning?.image, "caption-cheap");
  });
});

test("schema: [agents.<name>.models] with image_gen overrides is accepted", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.image_gen]
pro = "imagegen-alt"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agents?.sidekick?.models?.image_gen?.pro, "imagegen-alt");
  });
});

test("schema: [agents.<name>.models] with x_search overrides is accepted", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.x_search]
model = "grok-alt"
deep_model = "grok-alt"
`;
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    assert.equal(config.agents?.sidekick?.models?.x_search?.model, "grok-alt");
    assert.equal(config.agents?.sidekick?.models?.x_search?.deep_model, "grok-alt");
  });
});

test("schema: unknown key in [agents.<name>.models] is rejected (StrictObject)", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models]
unknown_key = "some-model"
`;
  await withConfigDir(toml, async (dir) => {
    await assert.rejects(
      () => loadConfig(dir, { env: false }),
      /unknown_key|additionalProperties|Invalid config/i,
      "unknown key in models block must be rejected by StrictObject",
    );
  });
});

// ---------------------------------------------------------------------------
// §7 cross-field validation: validateAgentConfig failures
// ---------------------------------------------------------------------------

/**
 * Build a minimal config that loads cleanly in agents mode, then invoke
 * validateAgentConfig — which is what the app startup does after loadConfig.
 */
async function loadAndValidate(toml: string): Promise<void> {
  await withConfigDir(toml, async (dir) => {
    const config = await loadConfig(dir, { env: false });
    validateAgentConfig(config);
  });
}

test("validation: session_types override key that is declared in agent.session_types is accepted", async () => {
  const toml = `${AGENTS_BASE}
[agent.session_types.chat-custom]
model = "chat-alt"

[agents.sidekick.models.session_types]
chat-custom = "chat-alt"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "a declared session type key must pass validation",
  );
});

test("validation: session_types override key 'default' is always valid", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.session_types]
default = "chat-alt"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "'default' must always be a valid session_types override key",
  );
});

test("validation: role-designated keys (summarize, condense, diary, proactive) are valid", async () => {
  const toml = `${AGENTS_BASE}
[models.no-window]
id = "nw"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
input_modalities = ["text"]
max_tokens = 512
context_window = 10000

[agents.sidekick.models.session_types]
summarize = "no-window"
condense = "no-window"
diary = "no-window"
proactive = "no-window"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "role-designated type names must be valid session_types override keys",
  );
});

test("validation: custom proactive session_type name is a valid override key", async () => {
  const toml = `${AGENTS_BASE}
[proactive]
enabled = false
session_type = "broadcast"

[agent.session_types.broadcast]
model = "chat-alt"

[agents.sidekick.models.session_types]
broadcast = "chat-alt"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "the configured proactive session_type name must be a valid override key",
  );
});

test("validation: unknown session_types override key → startup error", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.session_types]
totally-unknown-type = "chat-alt"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /totally-unknown-type|launchable session type/i,
    "an unknown session type key must fail validation",
  );
});

test("validation: session_types override pointing at unknown model → startup error", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.session_types]
default = "no-such-model"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /no-such-model|not found/i,
    "a session_types override pointing at a non-existent model must fail validation",
  );
});

test("validation: session_types override pointing at model without context_window → startup error", async () => {
  const toml = `${AGENTS_BASE}
[models.no-window]
id = "nw"
provider = "test"
endpoint = "http://localhost"
api_key = "k"
input_modalities = ["text"]
max_tokens = 512

[agents.sidekick.models.session_types]
default = "no-window"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /context_window|no-window/i,
    "a session_types override pointing at a model without context_window must fail validation",
  );
});

test("validation: captioning override without global [captioning] → startup error", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.captioning]
model = "caption-cheap"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /captioning|not configured/i,
    "captioning override without global [captioning] must fail validation",
  );
});

test("validation: captioning override with global [captioning] and valid model is accepted", async () => {
  const toml = `${AGENTS_BASE}
[captioning]
model = "default"

[agents.sidekick.models.captioning]
model = "caption-cheap"
image = "caption-cheap"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "captioning override with a valid model and global [captioning] must pass",
  );
});

test("validation: captioning override pointing at unknown model → startup error", async () => {
  const toml = `${AGENTS_BASE}
[captioning]
model = "default"

[agents.sidekick.models.captioning]
image = "no-such-model"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /no-such-model|not found/i,
    "captioning override pointing at a non-existent model must fail validation",
  );
});

test("validation: image_gen override without global [image_gen] → startup error", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.image_gen]
pro = "imagegen-alt"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /image_gen|not configured/i,
    "image_gen override without global [image_gen] must fail validation",
  );
});

test("validation: image_gen override with global [image_gen] and valid model is accepted", async () => {
  const toml = `${AGENTS_BASE}
[image_gen]
[image_gen.models]
pro = "default"
flash = "default"

[agents.sidekick.models.image_gen]
pro = "imagegen-alt"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "image_gen override with a valid model and global [image_gen] must pass",
  );
});

test("validation: image_gen override pointing at unknown model → startup error", async () => {
  const toml = `${AGENTS_BASE}
[image_gen]
[image_gen.models]
pro = "default"
flash = "default"

[agents.sidekick.models.image_gen]
flash = "no-such-model"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /no-such-model|not found/i,
    "image_gen override pointing at a non-existent model must fail validation",
  );
});

test("validation: x_search override without global [x_search] → startup error", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.x_search]
model = "grok-alt"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /x_search|not configured/i,
    "x_search override without global [x_search] must fail validation",
  );
});

test("validation: x_search override with global [x_search] and valid model is accepted", async () => {
  const toml = `${AGENTS_BASE}
[x_search]
model = "grok-alt"

[agents.sidekick.models.x_search]
model = "grok-alt"
deep_model = "grok-alt"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "x_search override with a valid model and global [x_search] must pass",
  );
});

test("validation: x_search override pointing at unknown model → startup error", async () => {
  const toml = `${AGENTS_BASE}
[x_search]
model = "grok-alt"

[agents.sidekick.models.x_search]
deep_model = "no-such-model"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /no-such-model|not found/i,
    "x_search override pointing at a non-existent model must fail validation",
  );
});

// Minimal agents-mode base for summaries_from tests — agents declared inline
// so tests can add summaries_from without TOML redefinition errors.
const SUMMARIES_FROM_BASE = `
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
context_window = 128000

[models.chat-alt]
id = "chat-alt-id"
provider = "test"
endpoint = "http://localhost"
api_key = "test-key"
input_modalities = ["text"]
max_tokens = 1024
context_window = 64000

[context.tiers]
rich_target_tokens = 1000
rich_max_tokens = 2000
compact_target_tokens = 3000
compact_max_tokens = 4000

[storage]
database_path = ":memory:"

[matrix]
enabled = false
trigger_hold_ms = 0

[matrix.accounts.main]
homeserver = "http://localhost"
user_id = "@main:localhost"
store_path = "./var/main"
agent = "main"

[matrix.accounts.sidekick]
homeserver = "http://localhost"
user_id = "@sidekick:localhost"
store_path = "./var/sidekick"
agent = "sidekick"

[summarization]
enabled = false
`;

test("validation: summaries_from + summarize session_type override → startup error (dead config)", async () => {
  const toml = `${SUMMARIES_FROM_BASE}
[agents.main]
workspace_root = "./workspaces/main"

[agents.main.models.session_types]
summarize = "chat-alt"

[agents.sidekick]
workspace_root = "./workspaces/sidekick"
summaries_from = "main"

[agents.sidekick.models.session_types]
summarize = "chat-alt"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /summaries_from|summarize|dead config/i,
    "summaries_from + summarize override must fail validation",
  );
});

test("validation: summaries_from + condense session_type override → startup error (dead config)", async () => {
  const toml = `${SUMMARIES_FROM_BASE}
[agents.main]
workspace_root = "./workspaces/main"

[agents.sidekick]
workspace_root = "./workspaces/sidekick"
summaries_from = "main"

[agents.sidekick.models.session_types]
condense = "chat-alt"
`;
  await assert.rejects(
    () => loadAndValidate(toml),
    /summaries_from|condense|dead config/i,
    "summaries_from + condense override must fail validation",
  );
});

test("validation: summaries_from without summarize/condense overrides is accepted", async () => {
  const toml = `${SUMMARIES_FROM_BASE}
[agents.main]
workspace_root = "./workspaces/main"

[agents.sidekick]
workspace_root = "./workspaces/sidekick"
summaries_from = "main"

[agents.sidekick.models.session_types]
default = "chat-alt"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "summaries_from without summarize/condense overrides must pass",
  );
});

test("validation: valid full override config with all subsystems is accepted", async () => {
  const toml = `${AGENTS_BASE}
[captioning]
model = "default"

[image_gen]
[image_gen.models]
pro = "default"
flash = "default"

[x_search]
model = "grok-alt"

[agent.session_types.chat-custom]
model = "chat-alt"

[agents.sidekick.models.session_types]
default = "chat-alt"
chat-custom = "chat-alt"
summarize = "chat-alt"
condense = "chat-alt"
diary = "chat-alt"
proactive = "chat-alt"

[agents.sidekick.models.captioning]
model = "caption-cheap"
image = "caption-cheap"
video = "caption-cheap"
audio = "caption-cheap"

[agents.sidekick.models.image_gen]
pro = "imagegen-alt"
flash = "imagegen-alt"

[agents.sidekick.models.x_search]
model = "grok-alt"
deep_model = "grok-alt"
`;
  await assert.doesNotReject(
    () => loadAndValidate(toml),
    "a fully-specified valid override config must pass all validation",
  );
});

test("validation: error message is path-precise — names the agent and key", async () => {
  const toml = `${AGENTS_BASE}
[agents.sidekick.models.session_types]
default = "nonexistent-model-xyz"
`;
  let errorMessage = "";
  try {
    await loadAndValidate(toml);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  assert.ok(
    errorMessage.includes("sidekick"),
    `error message must name the agent ("sidekick"), got: ${errorMessage}`,
  );
  assert.ok(
    errorMessage.includes("nonexistent-model-xyz"),
    `error message must name the bad model ref, got: ${errorMessage}`,
  );
});

// ---------------------------------------------------------------------------
// §4 resolveCaptionModelRef — 4-component mix and unknown-agent passthrough
// ---------------------------------------------------------------------------

test("resolveCaptionModelRef: 4-component mix — all four captioning override slots interact correctly", () => {
  // Fixture 1: agent has both image (rung 1) and shared (rung 2); global has both image and shared.
  // No global video entry, so video falls to rung 2 where agent shared beats global shared.
  const cfg1 = makeAgentsConfig(
    "test",
    { captioning: { image: "cap-agent-img", model: "cap-agent-shared" } },
    { captioning: { image: { model: "cap-global-img" }, model: "cap-global-shared" } },
  );
  const ov1 = buildAgentModelOverrides(cfg1);
  // Rung 1: agent image override shadows global image override
  assert.equal(ov1.resolveCaptionModelRef("test", "image"), "cap-agent-img");
  // Rung 2: no global video.model → agent shared beats global shared
  assert.equal(ov1.resolveCaptionModelRef("test", "video"), "cap-agent-shared");
  // Audio: same path as video — no modality-specific anywhere → rung 2: agent shared
  assert.equal(ov1.resolveCaptionModelRef("test", "audio"), "cap-agent-shared");

  // Fixture 2: same agent; global now adds video.model.
  // Owner-signed-off invariant: global-modality (rung 1) beats agent-shared (rung 2).
  const cfg2 = makeAgentsConfig(
    "test",
    { captioning: { image: "cap-agent-img", model: "cap-agent-shared" } },
    {
      captioning: {
        image: { model: "cap-global-img" },
        video: { model: "cap-global-vid" },
        model: "cap-global-shared",
      },
    },
  );
  const ov2 = buildAgentModelOverrides(cfg2);
  // Rung 1: global video.model wins — agent has no video-specific override
  assert.equal(ov2.resolveCaptionModelRef("test", "video"), "cap-global-vid");
  // Agent image override still wins at rung 1 (unchanged)
  assert.equal(ov2.resolveCaptionModelRef("test", "image"), "cap-agent-img");
  // Audio: still no modality-specific anywhere → rung 2: agent shared
  assert.equal(ov2.resolveCaptionModelRef("test", "audio"), "cap-agent-shared");
});

test("unknown-agent passthrough: unrecognized agentName resolves identically to null", () => {
  // An agentName not present in the agents table has no overrides —
  // every resolver must produce the same result as agentName = null.
  const globalCfg = {
    sessionTypes: { chat: { model: "chat-alt" }, default: { model: "chat-alt" } },
    captioning: { model: "caption-cheap", image: { model: "caption-cheap" } },
    imageGen: { pro: "imagegen-alt", flash: "default" } as const,
    xSearch: { model: "grok-alt", deep_model: "default" },
  };
  // "known-agent" is in the agents table with overrides; "phantom" is not.
  const cfg = makeAgentsConfig(
    "known-agent",
    {
      session_types: { default: "chat-alt" },
      captioning: { image: "caption-cheap" },
    },
    globalCfg,
  );
  const overrides = buildAgentModelOverrides(cfg);

  for (const phantom of ["phantom", "nobody", "unknown-agent-xyz"]) {
    assert.equal(
      overrides.resolveSessionTypeModelRef(phantom, "chat"),
      overrides.resolveSessionTypeModelRef(null, "chat"),
      `resolveSessionTypeModelRef("${phantom}", "chat") must equal null-agent result`,
    );
    assert.equal(
      overrides.resolveSessionTypeModelRef(phantom, "any"),
      overrides.resolveSessionTypeModelRef(null, "any"),
      `resolveSessionTypeModelRef("${phantom}", "any") must equal null-agent result`,
    );
    assert.equal(
      overrides.resolveCaptionModelRef(phantom, "image"),
      overrides.resolveCaptionModelRef(null, "image"),
      `resolveCaptionModelRef("${phantom}", "image") must equal null-agent result`,
    );
    assert.equal(
      overrides.resolveCaptionModelRef(phantom, "video"),
      overrides.resolveCaptionModelRef(null, "video"),
      `resolveCaptionModelRef("${phantom}", "video") must equal null-agent result`,
    );
    assert.equal(
      overrides.resolveImageGenRef(phantom, "pro"),
      overrides.resolveImageGenRef(null, "pro"),
      `resolveImageGenRef("${phantom}", "pro") must equal null-agent result`,
    );
    assert.equal(
      overrides.resolveXSearchRef(phantom, "fast"),
      overrides.resolveXSearchRef(null, "fast"),
      `resolveXSearchRef("${phantom}", "fast") must equal null-agent result`,
    );
    assert.equal(
      overrides.resolveXSearchRef(phantom, "deep"),
      overrides.resolveXSearchRef(null, "deep"),
      `resolveXSearchRef("${phantom}", "deep") must equal null-agent result`,
    );
  }
});
