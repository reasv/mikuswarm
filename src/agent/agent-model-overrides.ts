// =============================================================================
// Per-agent model override ladders (spec PER-AGENT-MODEL-OVERRIDES §4).
//
// A pure module: no I/O, no logging, no side effects. Construct one instance
// per process from `buildAgentModelOverrides(config)` and call the resolver
// methods wherever a model reference must be resolved for a given agent.
//
// Design principle (§4): the agent override shadows the global value at the
// SAME RUNG of the existing ladder — it never reorders the ladder. Legacy mode
// (agentName = null, no [agents] table) short-circuits every resolver to the
// global value, producing byte-identical behaviour to today's global-only path.
// =============================================================================

import type { AppConfig } from "../config/index.js";
import type { MediaModality } from "../captioning/describe.js";

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Per-agent model override resolution table, precomputed from `AppConfig`.
 * Construct once with {@link buildAgentModelOverrides}; the returned object is
 * stateless and may be shared freely across sessions.
 *
 * All resolvers accept `agentName = null` for legacy single-agent mode and
 * agents-mode calls where the agent is unknown — they resolve identically to
 * today's global behavior in that case.
 */
export interface AgentModelOverrides {
  /**
   * Resolve the model reference for a session's chat lane (spec §4 chat-lane ladder).
   *
   * Three-rung ladder — rung wins at the first defined value:
   *   1. `agents.A.models.session_types[T]`, else `agent.session_types[T].model`
   *   2. `agents.A.models.session_types["default"]`, else (only when T's type block is
   *      absent) `agent.session_types["default"].model`
   *   3. literal `"default"`
   *
   * The agent override shadows the global at the SAME rung; a type with an
   * explicit global model keeps it unless the agent overrides that type by name.
   * `null` agentName resolves rungs 1-2 against the global only (no agent half).
   *
   * **Block-level fallback subtlety (rung 2 global half)**: when a declared type
   * block exists in `agent.session_types` but carries no `model` key, the factory's
   * `resolveSessionType` returns that block (not the default block), yielding the
   * literal `"default"` — NOT the default type's model. This module reproduces that
   * invariant exactly: when the type-specific block `t` is present (even without
   * a `model` key), the global half of rung 2 is `undefined` rather than
   * `globalSessionTypes["default"]?.model`. This preserves legacy invariance —
   * `null`-agent resolution is byte-identical to `factory.resolveSessionType`'s
   * own `(types[T] ?? types["default"])?.model ?? "default"` chain.
   */
  resolveSessionTypeModelRef(agentName: string | null, sessionType: string): string;

  /**
   * Resolve the model reference for a captioning request (spec §4 captioning ladder).
   *
   * Strict same-rung shadowing (owner sign-off 2026-08-08), consistent with the
   * chat lane. Three-rung ladder:
   *   1. `agents.A.models.captioning[M]`, else `captioning[M].model`
   *   2. `agents.A.models.captioning.model`, else `captioning.model`
   *   3. `"default"` (matches today's fall-through in `resolveModalityChain`)
   *
   * A globally-configured per-modality assignment keeps winning over an agent's
   * shared override — the agent must override the modality by name to displace it.
   */
  resolveCaptionModelRef(agentName: string | null, modality: MediaModality): string;

  /**
   * Resolve the model reference for an image-generation tier (spec §4 image_gen).
   *
   * Single-rung: `agents.A.models.image_gen[tier]`, else `image_gen.models[tier]`.
   * Callers must ensure `[image_gen]` is configured before calling (the ladder
   * has no independent fallback once the global table is absent).
   */
  resolveImageGenRef(agentName: string | null, tier: "pro" | "flash"): string;

  /**
   * Resolve the model reference for an x_search tier (spec §4 x_search).
   *
   * `fast` = `agents.A.models.x_search.model`, else `x_search.model`.
   *
   * `deep` = `agents.A.models.x_search.deep_model`, else `x_search.deep_model`,
   * else the resolved `fast` value — the deep→fast fall-through is evaluated
   * AFTER per-agent/global shadowing of each key (§4): when both agent and global
   * `deep_model` are absent, the agent's fast override wins over the global model.
   *
   * Callers must ensure `[x_search]` is configured before calling.
   */
  resolveXSearchRef(agentName: string | null, tier: "fast" | "deep"): string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a per-agent model override resolver from `config`.
 *
 * Precomputes the per-agent override maps once at construction; every resolver
 * call is a small number of property lookups with no allocation. The returned
 * object is immutable with respect to the config it was built from.
 */
export function buildAgentModelOverrides(config: AppConfig): AgentModelOverrides {
  const agents = config.agents ?? {};
  const globalSessionTypes = config.agent?.session_types ?? {};
  const globalCaptioning = config.captioning ?? {};

  return {
    // ── Chat lane (§4 session-type ladder) ──────────────────────────────────
    resolveSessionTypeModelRef(agentName, sessionType) {
      const agentOverrides = agentName !== null ? agents[agentName]?.models : undefined;
      // The type-specific global block (may exist without a `model` key — see JSDoc).
      const t = globalSessionTypes?.[sessionType];

      // Rung 1 — type-specific altitude: agent override, else the global type block's
      // own model. If t exists but has no model, t?.model is undefined → rung 1 falls.
      const r1 = agentOverrides?.session_types?.[sessionType] ?? t?.model;
      if (r1 !== undefined) return r1;

      // Rung 2 — default altitude: agent "default" override substitutes wherever the
      // type-specific altitude yielded nothing. The global half preserves factory's
      // block-level fallback: when `t` (the type-specific block) EXISTS, resolveSessionType
      // returns it (not the default block), so the chain resolves to
      // `t.model ?? "default"` = literal "default", NOT globalSessionTypes["default"].model.
      // We reproduce this exactly: if `t` is present, the global half is `undefined`.
      const r2 =
        agentOverrides?.session_types?.["default"] ??
        (t ? undefined : globalSessionTypes?.["default"]?.model);
      if (r2 !== undefined) return r2;

      // Rung 3: the literal model name "default" (the registry's always-present fallback).
      return "default";
    },

    // ── Captioning (§4 captioning ladder) ───────────────────────────────────
    resolveCaptionModelRef(agentName, modality) {
      const agentOverrides = agentName !== null ? agents[agentName]?.models : undefined;
      const agentCaptioning = agentOverrides?.captioning;

      // Rung 1: agent captioning[M] (if set), else global captioning[M].model (if set).
      // The global modality config is accessed via the well-known key (image/video/audio).
      const globalModalityModel = globalCaptioning[modality]?.model;
      const rung1 = agentCaptioning?.[modality] ?? globalModalityModel;
      if (rung1 !== undefined) return rung1;

      // Rung 2: agent captioning.model (if set), else global captioning.model (if set).
      const rung2 = agentCaptioning?.model ?? globalCaptioning.model;
      if (rung2 !== undefined) return rung2;

      // Rung 3: "default" — matches today's fall-through in resolveModalityChain (app.ts).
      return "default";
    },

    // ── Image generation (§4 single-rung) ───────────────────────────────────
    resolveImageGenRef(agentName, tier) {
      const agentOverrides = agentName !== null ? agents[agentName]?.models : undefined;
      const agentTier = agentOverrides?.image_gen?.[tier];
      if (agentTier !== undefined) return agentTier;
      // Global image_gen.models[tier] — present (validated at startup via §7 check).
      return config.image_gen!.models[tier];
    },

    // ── x_search (§4 single-rung with deep→fast fall-through) ───────────────
    resolveXSearchRef(agentName, tier) {
      const agentOverrides = agentName !== null ? agents[agentName]?.models : undefined;
      const agentXSearch = agentOverrides?.x_search;

      if (tier === "fast") {
        // fast = agent x_search.model else global x_search.model.
        return agentXSearch?.model ?? config.x_search!.model;
      }

      // deep tier: agent deep_model else global deep_model, else resolved fast.
      // The fall-through is evaluated AFTER per-agent/global shadowing of each key
      // (§4): when both agent and global deep_model are absent, the resolved fast
      // value (agent model override if present, else global model) takes effect.
      const agentDeep = agentXSearch?.deep_model;
      if (agentDeep !== undefined) return agentDeep;

      const globalDeep = config.x_search!.deep_model;
      if (globalDeep !== undefined) return globalDeep;

      // Fall through to the resolved fast value (§4 deep→fast fall-through).
      return agentXSearch?.model ?? config.x_search!.model;
    },
  };
}
