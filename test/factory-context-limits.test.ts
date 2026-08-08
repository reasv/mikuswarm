import assert from "node:assert/strict";
import test from "node:test";
import { AgentSessionFactory, additiveThinkingBudgetTokens, composeSessionContextCeiling } from "../src/agent/factory.js";
import { buildModelFallback, resolveModelChain, type ModelChainEntry } from "../src/agent/model-fallback.js";
import { validateContextTokenCeilings } from "../src/app.js";
import { createAssistantMessageEventStream, type Model, type Api } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { SessionUsageTracker } from "../src/agent/usage.js";
import type { AppConfig } from "../src/config/index.js";
import type { UserLimitContext, UserLimitResolution } from "../src/budget/index.js";
import type { BuiltContext } from "../src/context/index.js";
import { ContextBuilder } from "../src/context/builder.js";
import type { AgentSessionRecord } from "../src/agent/session-manager.js";

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

test("buildModelHealthAnnotations: a model with no endpoint maps under unknown::<id> (issue #18)", async () => {
  const { buildModelHealthAnnotations } = await import("../src/app.js");
  // No `endpoint` → the health key uses the `unknown` sentinel (mirrors
  // buildFetchChain / modelHealthKey: `${endpoint ?? "unknown"}::${id}`).
  const models = { local: { id: "bge-small" } } as never;
  const map = buildModelHealthAnnotations(models);
  assert.deepEqual(map["unknown::bge-small"], { logicalIds: ["local"], hasFallback: false });
});

// === spec MODEL-FALLBACK §3 #1: agent-path capability pre-filter (image →
// multimodal), derived from the RAW session inputs at create time (#6). ========

/** Minimal session record with a trigger event carrying the given attachments. */
function sessionWith(attachments: Array<{ mediaType: string; localPath?: string }>): any {
  return {
    id: "s-1",
    timelineKey: "tk",
    sessionType: "default",
    status: "running",
    createdAt: 0,
    trigger: {
      provider: "test",
      timelineKey: "tk",
      event: {
        id: "e-1",
        timelineKey: "tk",
        provider: "test",
        role: "user",
        sender: { id: "u" },
        body: "hi",
        timestamp: 0,
        receivedAt: 0,
        attachments,
      },
    },
  };
}

test("rawInputsRequireMultimodal: trigger image attachment ⇒ true; non-image ⇒ false", async () => {
  const { rawInputsRequireMultimodal } = await import("../src/agent/factory.js");
  assert.equal(
    rawInputsRequireMultimodal(sessionWith([{ mediaType: "image", localPath: "/m/a.png" }])),
    true,
  );
  // A file attachment with no image → no requirement.
  assert.equal(
    rawInputsRequireMultimodal(sessionWith([{ mediaType: "file", localPath: "/m/a.pdf" }])),
    false,
  );
  // An image attachment without a local path is not a real image block → false.
  assert.equal(
    rawInputsRequireMultimodal(sessionWith([{ mediaType: "image" }])),
    false,
  );
  // No attachments at all → false.
  assert.equal(rawInputsRequireMultimodal(sessionWith([])), false);
});

test("rawInputsRequireMultimodal: reply-quoted image ⇒ true", async () => {
  const { rawInputsRequireMultimodal } = await import("../src/agent/factory.js");
  const session = sessionWith([]);
  session.trigger.event.replyTo = { attachments: [{ mediaType: "image", localPath: "/m/q.png" }] };
  assert.equal(rawInputsRequireMultimodal(session), true);
});

test("rawInputsRequireMultimodal: generation + proactive modes never require multimodal", async () => {
  const { rawInputsRequireMultimodal } = await import("../src/agent/factory.js");
  const imaged = sessionWith([{ mediaType: "image", localPath: "/m/a.png" }]);
  // Even with an image on the trigger, generation/proactive sessions send no pixels.
  assert.equal(rawInputsRequireMultimodal(imaged, { proactive: true }), false);
  assert.equal(rawInputsRequireMultimodal(imaged, { summarizationCutoff: { endTimestamp: 1 } }), false);
  assert.equal(rawInputsRequireMultimodal(imaged, { condenseInputs: { summaries: [] } as any }), false);
  assert.equal(
    rawInputsRequireMultimodal(imaged, { diaryRange: { earliestTimestamp: 0, latestTimestamp: 1, summaryId: "x" } }),
    false,
  );
});

test("rawInputsRequireMultimodal: resume snapshot carrying imageBlocks ⇒ true", async () => {
  const { rawInputsRequireMultimodal } = await import("../src/agent/factory.js");
  const session = sessionWith([]); // trigger itself has no image
  const snapshot = [
    { type: "chatEvent", role: "user", content: "earlier", imageBlocks: [{ mediaType: "image/png", dataBase64: "AAAA" }] } as any,
  ];
  assert.equal(rawInputsRequireMultimodal(session, { resume: { snapshot } }), true);
  // A resume snapshot with no image blocks and a text-only trigger ⇒ false.
  assert.equal(
    rawInputsRequireMultimodal(session, { resume: { snapshot: [{ type: "chatEvent", role: "user", content: "t" } as any] } }),
    false,
  );
});

test("ContextBuilder.replyModelCanSeeImages: keys off the REPLY model, never [models.default]", async () => {
  const { ContextBuilder } = await import("../src/context/builder.js");
  const config = {
    models: {
      default: { input_modalities: ["text"] },        // text-only default
      sol: { input_modalities: ["text", "image"] },   // image-capable reply model
    },
  } as any;
  const cb = new ContextBuilder({} as any, config, {} as any);
  // The bug this guards: one model's modality must NEVER gate another's. A session
  // whose reply model is the image-capable "sol" ships pixels even though the
  // `default` block is text-only.
  assert.equal(cb.replyModelCanSeeImages({ model: "sol" } as any), true);
  // A session on the text-only default (or a type with no model override) → captions.
  assert.equal(cb.replyModelCanSeeImages({ model: "default" } as any), false);
  assert.equal(cb.replyModelCanSeeImages(undefined), false);
});

test("createModelFromConfig: text-only member → input ['text'] (triggers pi-ai image strip); multimodal → ['text','image']", async () => {
  const { createModelFromConfig } = await import("../src/agent/factory.js");
  // pi-ai's `downgradeUnsupportedImages(messages, model)` replaces image blocks with a
  // text placeholder whenever `model.input` lacks "image"; each fallback member is
  // dispatched with ITS OWN descriptor (buildModelFallback → makeModel per member), so
  // a text-only model that actually serves an image-bearing context strips the pixels.
  // This locks OUR half: a text-only model's descriptor carries input ["text"].
  const base = { context_window: 1000, max_tokens: 100 };
  const textOnly = createModelFromConfig({ id: "glm", input_modalities: ["text"], ...base } as any);
  assert.deepEqual(textOnly.input, ["text"], "text-only model descriptor must exclude image → pi-ai downgrades pixels");
  const multimodal = createModelFromConfig({ id: "sol", input_modalities: ["text", "image"], ...base } as any);
  assert.deepEqual(multimodal.input, ["text", "image"]);
});

test("agent capability filter: image session drops a text-only fallback; text session keeps it", async () => {
  const { buildModelFallback, resolveModelChain } = await import("../src/agent/model-fallback.js");
  const { rawInputsRequireMultimodal } = await import("../src/agent/factory.js");
  const makeBase = () => ((): never => { throw new Error("unused"); }) as any;
  const makeModel = (cfg: any, cw: number) => ({ id: cfg.id, baseUrl: cfg.endpoint, contextWindow: cw } as any);
  const models = {
    "head-mm": { id: "wire-head", endpoint: "https://gw/h", api_key: "k", input_modalities: ["text", "image"], context_window: 100_000, fallback: ["fb-text"] },
    "fb-text": { id: "wire-fb", endpoint: "https://gw/f", api_key: "k", input_modalities: ["text"], context_window: 100_000 },
  } as never;
  const chain = resolveModelChain("head-mm", models);

  // Image-bearing session → require multimodal → the text-only fallback is dropped.
  const imaged = sessionWith([{ mediaType: "image", localPath: "/m/a.png" }]);
  const fbImage = buildModelFallback(chain, {
    consumer: "agent",
    makeBase,
    makeModel,
    capability: rawInputsRequireMultimodal(imaged) ? (c: any) => c.input_modalities.includes("image") : undefined,
  });
  assert.deepEqual(fbImage.survivorLogicalIds, ["head-mm"], "text-only fallback dropped for an image session");

  // Text-only session → no requirement → the full chain survives.
  const textOnly = sessionWith([{ mediaType: "file", localPath: "/m/a.pdf" }]);
  const fbText = buildModelFallback(chain, {
    consumer: "agent",
    makeBase,
    makeModel,
    capability: rawInputsRequireMultimodal(textOnly) ? (c: any) => c.input_modalities.includes("image") : undefined,
  });
  assert.deepEqual(fbText.survivorLogicalIds, ["head-mm", "fb-text"], "full chain kept for a text-only session");
});

// === spec PER-USER-LIMITS §5.3 / review #4 ===================================
// `additiveThinkingBudgetTokens` returns the extended-thinking output a provider
// BILLS on top of the issued base `max_tokens` (so the per-user affordability
// estimate can reserve it). Additive only where the provider actually adds it:
// Anthropic non-adaptive (older) + Google/Gemini; 0 for adaptive Anthropic
// (Opus/Sonnet 4.6+ effort hint), the OpenAI effort path, and thinking off.

/** Minimal ModelConfig shape touched by additiveThinkingBudgetTokens. */
function modelCfg(opts: {
  id: string;
  api?: "anthropic-messages" | "openai-completions" | "openai-responses" | "google-generative-ai";
  max_tokens?: number;
  reasoning?: boolean;
  adaptive_thinking?: boolean;
}): any {
  return {
    id: opts.id,
    api: opts.api,
    max_tokens: opts.max_tokens ?? 32_000,
    reasoning: opts.reasoning,
    adaptive_thinking: opts.adaptive_thinking,
  };
}

test("additiveThinkingBudgetTokens: off / disabled-capability ⇒ 0 (#4)", () => {
  assert.equal(additiveThinkingBudgetTokens(modelCfg({ id: "claude-3-5-sonnet" }), "off"), 0);
  assert.equal(
    additiveThinkingBudgetTokens(modelCfg({ id: "claude-3-5-sonnet", reasoning: false }), "high"),
    0,
  );
});

test("additiveThinkingBudgetTokens: Anthropic NON-adaptive is additive, per-level (#4)", () => {
  const m = modelCfg({ id: "claude-3-5-sonnet", api: "anthropic-messages" });
  assert.equal(additiveThinkingBudgetTokens(m, "minimal"), 1024);
  assert.equal(additiveThinkingBudgetTokens(m, "low"), 2048);
  assert.equal(additiveThinkingBudgetTokens(m, "medium"), 8192);
  assert.equal(additiveThinkingBudgetTokens(m, "high"), 16384);
  // xhigh clamps to high (pi-ai clampReasoning) → 16384.
  assert.equal(additiveThinkingBudgetTokens(m, "xhigh"), 16384);
});

test("additiveThinkingBudgetTokens: Anthropic ADAPTIVE (Opus/Sonnet 4.6+) is 0 — effort hint, no add (#4)", () => {
  for (const id of ["claude-opus-4-6", "claude-opus-4.7", "claude-sonnet-4-6"]) {
    assert.equal(
      additiveThinkingBudgetTokens(modelCfg({ id, api: "anthropic-messages" }), "high"),
      0,
      `${id} must not be penalized`,
    );
  }
});

test("additiveThinkingBudgetTokens: adaptive_thinking flag is authoritative; unset falls back to heuristic (#1)", () => {
  // `true` ⇒ additive 0 even for an id the heuristic does NOT recognize (e.g. a
  // newer adaptive Anthropic model the hardcoded list has drifted past).
  assert.equal(
    additiveThinkingBudgetTokens(
      modelCfg({ id: "claude-opus-4-8", api: "anthropic-messages", adaptive_thinking: true }),
      "high",
    ),
    0,
    "adaptive_thinking:true must reserve 0 for an unlisted adaptive model",
  );
  // `false` ⇒ the flat budget even for an id the heuristic WOULD call adaptive
  // (the explicit flag overrides the substring match).
  assert.equal(
    additiveThinkingBudgetTokens(
      modelCfg({ id: "claude-opus-4-7", api: "anthropic-messages", adaptive_thinking: false }),
      "high",
    ),
    16384,
    "adaptive_thinking:false must force the flat additive budget",
  );
  // UNSET ⇒ heuristic preserved: a listed adaptive id (opus-4-7) still ⇒ 0.
  assert.equal(
    additiveThinkingBudgetTokens(modelCfg({ id: "claude-opus-4-7", api: "anthropic-messages" }), "high"),
    0,
    "unset flag must keep the opus-4-7 heuristic fallback",
  );
});

test("additiveThinkingBudgetTokens: Gemini uses its MODEL-SPECIFIC native budget, not the flat map (#4)", () => {
  // Mirrors pi-ai getGoogleBudget: 2.5-pro high=32768 (NOT the flat Anthropic 16384),
  // 2.5-flash high=24576, 2.5-flash-lite high=24576. A high max_tokens so no clamp.
  const pro = modelCfg({ id: "gemini-2.5-pro", api: "google-generative-ai", max_tokens: 64_000 });
  const flash = modelCfg({ id: "gemini-2.5-flash", api: "google-generative-ai", max_tokens: 64_000 });
  const lite = modelCfg({ id: "gemini-2.5-flash-lite", api: "google-generative-ai", max_tokens: 64_000 });

  // pro-high MUST be 32768 — would have been the old flat-map 16384.
  assert.equal(additiveThinkingBudgetTokens(pro, "high"), 32768);
  assert.notEqual(additiveThinkingBudgetTokens(pro, "high"), 16384);
  // flash-high / lite-high: 24576 each (flash-lite is matched before flash).
  assert.equal(additiveThinkingBudgetTokens(flash, "high"), 24576);
  assert.equal(additiveThinkingBudgetTokens(lite, "high"), 24576);

  // Level boundary: pro minimal=128, low=2048, medium=8192; flash minimal=128, lite minimal=512.
  assert.equal(additiveThinkingBudgetTokens(pro, "minimal"), 128);
  assert.equal(additiveThinkingBudgetTokens(pro, "low"), 2048);
  assert.equal(additiveThinkingBudgetTokens(pro, "medium"), 8192);
  assert.equal(additiveThinkingBudgetTokens(lite, "minimal"), 512);

  // xhigh clamps to high (pi-ai clampReasoning) → the pro high budget.
  assert.equal(additiveThinkingBudgetTokens(pro, "xhigh"), 32768);

  // The model-specific budget is still clamped to the model's own max_tokens.
  const proTiny = modelCfg({ id: "gemini-2.5-pro", api: "google-generative-ai", max_tokens: 10_000 });
  assert.equal(additiveThinkingBudgetTokens(proTiny, "high"), 10_000);

  // Unrecognized Gemini id (getGoogleBudget would return -1, e.g. a level-based
  // Gemini-3 model): fall back to the flat per-level map, never the -1 sentinel.
  const g3 = modelCfg({ id: "gemini-3-pro", api: "google-generative-ai", max_tokens: 64_000 });
  assert.equal(additiveThinkingBudgetTokens(g3, "high"), 16384);
});

test("additiveThinkingBudgetTokens: OpenAI effort path adds nothing (fits within max_tokens) (#4)", () => {
  assert.equal(
    additiveThinkingBudgetTokens(modelCfg({ id: "gpt-5", api: "openai-completions" }), "high"),
    0,
  );
  assert.equal(
    additiveThinkingBudgetTokens(modelCfg({ id: "gpt-5", api: "openai-responses" }), "high"),
    0,
  );
});

test("additiveThinkingBudgetTokens: additive portion never exceeds the model's own max_tokens (#4)", () => {
  // A tiny-max model: the 16384 high budget clamps to max_tokens (pi-ai clamps the
  // wire cap to modelMax too).
  const m = modelCfg({ id: "claude-3-5-haiku", api: "anthropic-messages", max_tokens: 4_000 });
  assert.equal(additiveThinkingBudgetTokens(m, "high"), 4_000);
});

// === spec PER-MEMBER-CONTEXT-FITS §2.3: resolveSessionContextCeiling no chain min =

test("resolveSessionContextCeiling §2.3: head window only — a small fallback member does not shrink the planning ceiling", () => {
  // Before this spec: resolveSessionContextCeiling took the min over the chain, so a
  // 64k fallback member silently shrank the planning ceiling of a 256k head to 64k.
  // After: the head's own window governs; per-member fits are checked at selection time.
  const factory = makeFactory({
    models: {
      default: { context_window: 256_000, fallback: ["small"] } as any,
      small: { context_window: 64_000 },
    },
  });
  // Must return the HEAD's 256k — not the chain min 64k.
  assert.equal(factory.resolveSessionContextCeiling("default"), 256_000);
});

test("resolveSessionContextCeiling §2.3: session-type override still applied to head window", () => {
  const factory = makeFactory({
    models: {
      default: { context_window: 256_000, fallback: ["small"] } as any,
      small: { context_window: 64_000 },
    },
    sessionTypes: { default: { max_context_tokens: 128_000 } },
  });
  // Override tightens the head's 256k to 128k (not the min-over-chain 64k).
  assert.equal(factory.resolveSessionContextCeiling("default"), 128_000);
});

// === spec PER-MEMBER-CONTEXT-FITS §2.3: per-member model descriptor ============

// Shared helpers for buildModelFallback descriptor tests.
function descModelCfg(id: string, context_window: number): any {
  return {
    id,
    provider: "test",
    endpoint: `https://gw/${id}`,
    api_key: "k",
    input_modalities: ["text"],
    max_tokens: 4096,
    context_window,
  };
}

const capturedContextWindows: Record<string, number> = {};
function recordingMakeModel(cfg: any, cw: number): Model<Api> {
  capturedContextWindows[cfg.id] = cw;
  return {
    id: cfg.id,
    name: cfg.id,
    api: "anthropic-messages",
    provider: cfg.provider,
    baseUrl: cfg.endpoint,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cw,
    maxTokens: cfg.max_tokens,
  } as Model<Api>;
}

test("per-member descriptor §2.3: each member's Model descriptor carries its OWN window, not the chain min", () => {
  const captured: Record<string, number> = {};
  const headCfg = descModelCfg("head-256k", 256_000);
  const smallCfg = descModelCfg("small-64k", 64_000);
  const X: ModelChainEntry = { logicalId: "X", config: headCfg };
  const Y: ModelChainEntry = { logicalId: "Y", config: smallCfg };

  buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: () => (() => { throw new Error("unused"); }) as any,
    makeModel: (cfg, cw) => {
      captured[cfg.id] = cw;
      return recordingMakeModel(cfg, cw);
    },
  });

  // Head gets its own 256k, not the chain min 64k.
  assert.equal(captured["head-256k"], 256_000, "head descriptor carries its own window");
  // Small member gets its own 64k.
  assert.equal(captured["small-64k"], 64_000, "small member descriptor carries its own window");
});

test("per-member descriptor §2.3: contextOverride applied per member, not as a shared floor", () => {
  const captured: Record<string, number> = {};
  const headCfg = descModelCfg("head-256k", 256_000);
  const smallCfg = descModelCfg("small-64k", 64_000);
  const X: ModelChainEntry = { logicalId: "X", config: headCfg };
  const Y: ModelChainEntry = { logicalId: "Y", config: smallCfg };

  buildModelFallback([X, Y], {
    consumer: "test",
    makeBase: () => (() => { throw new Error("unused"); }) as any,
    makeModel: (cfg, cw) => {
      captured[cfg.id] = cw;
      return recordingMakeModel(cfg, cw);
    },
    contextOverride: 128_000, // tightens X to 128k, Y stays 64k (already smaller)
  });

  // Override tightens X from 256k to 128k (min(256k, 128k)).
  assert.equal(captured["head-256k"], 128_000, "head is tightened by the override");
  // Y is already smaller than the override; its own 64k governs.
  assert.equal(captured["small-64k"], 64_000, "small member uses its own window when < override");
});

// === spec PER-MEMBER-CONTEXT-FITS §2.3/§4 factory integration: enforcement ====
//
// These tests use a fake per-user engine that captures affordability probes and
// terminates content-class without touching any real HTTP endpoint, following
// the pattern established in agent-context.test.ts.

/** Minimal AppConfig with a two-member chain (head 256k, fallback 64k). */
function perMemberConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    app: { name: "test", data_dir: "/tmp", log_level: "error", context_dump_dir: "/tmp" },
    agent: {
      sessions: { max_concurrent: 1, max_concurrent_dm: 1, forced_completion_retries: 0 },
      system: {},
    },
    models: {
      default: {
        id: "head-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 256_000,
      },
      fallback: {
        id: "fallback-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 64_000,
      },
    },
    context: {
      tiers: { rich_target_tokens: 2000, rich_max_tokens: 4000, compact_target_tokens: 4000, compact_max_tokens: 8000 },
    },
    storage: { database_path: ":memory:" },
    workspace: { root_dir: "/tmp" },
    matrix: { enabled: false, trigger_hold_ms: 0, accounts: {} },
    ...overrides,
  } as AppConfig;
}

/** Minimal BuiltContext with a triggerGroup final turn. */
function minimalBuilt(): BuiltContext {
  return {
    messages: [
      { type: "system", role: "system", content: "sys", tier: "system", tokenEstimate: 1 },
      { type: "triggerGroup", role: "user", content: "hi", tier: "trigger", tokenEstimate: 1, timestamp: 10 },
    ],
    tokenEstimate: 2,
    compactTokens: 0,
    richTokens: 0,
    imageBlocks: [],
  } as BuiltContext;
}

function stubCtxBuilder(built: BuiltContext): ContextBuilder {
  return { build: async () => built } as unknown as ContextBuilder;
}

function perMemberSession(): AgentSessionRecord {
  return {
    id: "s-pm",
    timelineKey: "matrix:miku:room:!r",
    sessionType: "default",
    status: "running",
    trigger: {
      provider: "matrix",
      timelineKey: "matrix:miku:room:!r",
      event: {
        id: "ev1",
        timelineKey: "matrix:miku:room:!r",
        provider: "matrix",
        role: "user",
        sender: { id: "@u:hs" },
        body: "hi",
        timestamp: 10,
        receivedAt: 10,
      },
    } as any,
    createdAt: 0,
  };
}

/** A fake engine that always says "affordable" — lets us observe selection without blocking. */
function affordableEngine(): any {
  return {
    affordable: () => ({ ok: true, maxOutput: 4096, remainingUsd: Infinity }),
    bindingConstraint: () => undefined,
    noteSelection: () => {},
  };
}

/** A fake engine that always says "unaffordable" — terminates content-class on first request. */
function unaffordableEngine(): any {
  return {
    affordable: () => ({ ok: false, maxOutput: 0, remainingUsd: 0 }),
    bindingConstraint: () => undefined,
    noteSelection: () => {},
  };
}

function perUserResolution(models: string[]): UserLimitResolution {
  return {
    matched: true,
    active: true,
    banned: false,
    models,
    constraints: [],
    ledgerPartitionKeys: [],
  } as unknown as UserLimitResolution;
}

const perUserCtx: UserLimitContext = { userId: "@alice:hs", roomId: "!room:hs" } as UserLimitContext;

// § Per-member fits §2.3: head doesn't fit but fallback DOES — Gate B selects
// the fallback member and proceeds (blocked by budget, NOT by context).
// This tests the mirror of the incident shape: here the HEAD is the small member,
// the big fallback carries the context. chooseChainMember must skip the head and
// use the large fallback when observed > head.window but observed <= big.window.
test("Gate B §2.4 fits: context above head window but below fallback window — budget-denied, NOT context-denied", async () => {
  // head = 64k, big = 256k → maxOperativeContextWindow = 256k.
  // At 100k: head (64k) doesn't fit, big (256k) does → Gate B skips head, picks big.
  const config = perMemberConfig({
    models: {
      default: {
        id: "head-64k",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 64_000,
        fallback: ["big"],
      },
      big: {
        id: "big-256k",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 256_000,
      },
    },
  } as any);

  const factory = new AgentSessionFactory({
    config,
    contextBuilder: stubCtxBuilder(minimalBuilt()),
    getActiveSessions: () => [],
  });

  const resolution = perUserResolution(["default"]);
  const engine = unaffordableEngine(); // always blocks; we use it to observe the cause

  // Seed 100k context via resume so ctxCounter.running = 100k.
  const seed = new SessionUsageTracker({
    llmRequests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: 100_000,
  });

  const { agent } = await factory.create(perMemberSession(), [], {
    resume: { snapshot: [{ type: "chatEvent", role: "user", content: "x", timestamp: 1 } as any] },
    usage: seed,
    userLimit: { engine, resolution, ctx: perUserCtx },
  });

  await agent.prompt({ role: "user", content: "test", timestamp: 20 } as any);

  // big member (256k) accommodates 100k → Gate B finds viable-healthy member.
  // Unaffordable engine blocks on budget — NOT on context.
  assert.match(
    agent.state.errorMessage ?? "",
    /budget exhausted/,
    "big fallback (256k) fits 100k; Gate B budget-denied not context-denied",
  );
  assert.ok(
    !(agent.state.errorMessage ?? "").includes("context exceeds"),
    "must NOT be context-denied when the fallback member window accommodates the context",
  );
});

// § Enforcement: past maxOperativeContextWindow terminates with the max-window message.
test("checkContextBudget §2.3: context past max member window terminates with max-window + skipped members", async () => {
  // head = 64k, big = 256k → maxOperativeContextWindow = 256k.
  const config = perMemberConfig({
    models: {
      default: {
        id: "head-64k",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 64_000,
        fallback: ["big"],
      },
      big: {
        id: "big-256k",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 256_000,
      },
    },
  } as any);

  const factory = new AgentSessionFactory({
    config,
    contextBuilder: stubCtxBuilder(minimalBuilt()),
    getActiveSessions: () => [],
  });

  const { agent, usage } = await factory.create(perMemberSession(), []);

  // Simulate 300k — exceeds ALL member windows (max = 256k).
  usage.record(
    { input: 240_000, output: 60_000, cacheRead: 0, cacheWrite: 0, totalTokens: 300_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    "head-64k",
  );
  assert.equal(usage.snapshot().contextTokens, 300_000);

  await agent.prompt({ role: "user", content: "test", timestamp: 20 } as any);

  const err = agent.state.errorMessage ?? "";
  assert.match(err, /context token limit exceeded/, "must produce context-limit error");
  assert.match(err, /max member window 256000/, "must report the max member window");
  assert.match(err, /members skipped on fits/, "must list the members skipped");
});

// § Gate B: terminal message distinguishes context vs budget vs outage
test("Gate B §2.4 terminal: 'context exceeds all model windows' when context too large for all preferences", async () => {
  // Both preferred models have small windows; context is seeded to exceed both.
  const config = perMemberConfig({
    models: {
      default: {
        id: "def-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 128_000,
      },
      small: {
        id: "small-model",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 64_000,
      },
    },
  } as any);

  const factory = new AgentSessionFactory({
    config,
    contextBuilder: stubCtxBuilder(minimalBuilt()),
    getActiveSessions: () => [],
  });

  // Per-user set: both preferred models have small windows.
  const resolution = perUserResolution(["default", "small"]);
  const engine = affordableEngine(); // would be affordable, but context doesn't fit

  // Seed a large context (larger than ALL preferred model windows: 128k and 64k).
  const seed = new SessionUsageTracker({
    llmRequests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: 200_000, // > max(128k, 64k)
  });

  const { agent } = await factory.create(perMemberSession(), [], {
    resume: { snapshot: [{ type: "chatEvent", role: "user", content: "x", timestamp: 1 } as any] },
    usage: seed,
    userLimit: { engine, resolution, ctx: perUserCtx },
  });

  await agent.prompt({ role: "user", content: "test", timestamp: 20 } as any);

  assert.match(
    agent.state.errorMessage ?? "",
    /context exceeds all model windows/,
    "context-denied terminal must be distinguished from outage",
  );
});

test("Gate B §2.4 terminal: 'no healthy model is available' when models healthy but no context issue", async () => {
  // Models have large windows, but the engine always says unaffordable.
  // When nothing is affordable but context fits → budget exhausted.
  const config = perMemberConfig();
  const factory = new AgentSessionFactory({
    config,
    contextBuilder: stubCtxBuilder(minimalBuilt()),
    getActiveSessions: () => [],
  });

  const resolution = perUserResolution(["default"]);
  const engine = unaffordableEngine(); // always says unaffordable → budget cause

  const { agent } = await factory.create(perMemberSession(), [], {
    resume: { snapshot: [{ type: "chatEvent", role: "user", content: "x", timestamp: 1 } as any] },
    usage: new SessionUsageTracker(),
    userLimit: { engine, resolution, ctx: perUserCtx },
  });

  await agent.prompt({ role: "user", content: "test", timestamp: 20 } as any);

  // With context fitting (small running counter) but unaffordable → budget exhausted.
  assert.match(
    agent.state.errorMessage ?? "",
    /budget exhausted/,
    "unaffordable + fits should be 'budget exhausted', not 'no healthy model'",
  );
});

// § Gate B §2.4: single-member selectable is fits-gated by Gate B even though
// dispatch keeps the single-member fast path.
test("Gate B §2.4: single-member selectable is context-gated (context-denied when window exceeded)", async () => {
  // Single preferred model with a small window; context seeded above it.
  const config = perMemberConfig({
    models: {
      default: {
        id: "small-single",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 64_000,
        // No fallback — single-member chain.
      },
    },
  } as any);

  const factory = new AgentSessionFactory({
    config,
    contextBuilder: stubCtxBuilder(minimalBuilt()),
    getActiveSessions: () => [],
  });

  const resolution = perUserResolution(["default"]);
  const engine = affordableEngine();

  // Seed context above the single model's window.
  const seed = new SessionUsageTracker({
    llmRequests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: 100_000, // > 64k window
  });

  const { agent } = await factory.create(perMemberSession(), [], {
    resume: { snapshot: [{ type: "chatEvent", role: "user", content: "x", timestamp: 1 } as any] },
    usage: seed,
    userLimit: { engine, resolution, ctx: perUserCtx },
  });

  await agent.prompt({ role: "user", content: "test", timestamp: 20 } as any);

  // Gate B should deny: context exceeds the single model's window.
  assert.match(
    agent.state.errorMessage ?? "",
    /context exceeds all model windows/,
    "single-member selectable must be context-gated by Gate B",
  );
});

// § Gate B §2.4 (incident shape): preferred model head has a small fallback member,
// but the head's OWN window fits → Gate B should pass (it checks per member, not chain min).
test("Gate B §2.4 incident shape: preferred head serves when ITS window fits, even if chain has smaller member", async () => {
  // This is the incident that motivated the spec:
  // head window 256k, fallback member window 64k, observed context 150k.
  // Old behavior: operativeContextWindow = min = 64k → fits check fails → wrong terminal.
  // New behavior: chooseChainMember with observed=150k → head (256k) fits → proceeds.
  const config = perMemberConfig({
    models: {
      default: {
        id: "head-256k",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 256_000,
        fallback: ["floor"],
      },
      floor: {
        id: "floor-64k",
        provider: "test",
        endpoint: "http://localhost",
        api_key: "key",
        input_modalities: ["text"],
        max_tokens: 4096,
        context_window: 64_000,
      },
    },
  } as any);

  const factory = new AgentSessionFactory({
    config,
    contextBuilder: stubCtxBuilder(minimalBuilt()),
    getActiveSessions: () => [],
  });

  const resolution = perUserResolution(["default"]);
  // Engine terminates immediately (unaffordable) once Gate B passes — we just want to
  // confirm the run was blocked by BUDGET (passed fits) not CONTEXT.
  const engine = unaffordableEngine();

  // Seed context at 150k — between floor 64k and head 256k.
  const seed = new SessionUsageTracker({
    llmRequests: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    contextTokens: 150_000,
  });

  const { agent } = await factory.create(perMemberSession(), [], {
    resume: { snapshot: [{ type: "chatEvent", role: "user", content: "x", timestamp: 1 } as any] },
    usage: seed,
    userLimit: { engine, resolution, ctx: perUserCtx },
  });

  await agent.prompt({ role: "user", content: "test", timestamp: 20 } as any);

  // With per-member fits: head (256k) accommodates 150k → Gate B passes fits →
  // unaffordable engine blocks → "budget exhausted", NOT "context exceeds all windows".
  assert.match(
    agent.state.errorMessage ?? "",
    /budget exhausted/,
    "incident shape: head window fits 150k context; gate passes fits → budget-denied, not context-denied",
  );
  assert.ok(
    !(agent.state.errorMessage ?? "").includes("context exceeds"),
    "must NOT say 'context exceeds' when the head's own window fits the context",
  );
});
