import {
  Type,
  type ObjectOptions,
  type Static,
  type TObject,
  type TProperties,
} from "@sinclair/typebox";

/**
 * Strict object schema: unknown keys FAIL validation at load (review issue #29,
 * decision E). Every fixed-shape object in the config tree is built with this
 * helper so a misspelled or stale key (e.g. `enrichment.fetch_concurrency`)
 * fail-fasts with a path-naming error instead of being silently ignored.
 *
 * Dictionary-shaped sections — `Type.Record(...)` like `[models.*]`,
 * `[agent.session_types.*]`, `[rate_limits.llm.*]`, `[matrix.accounts.*]`,
 * `[mcp.servers.*]` — deliberately keep arbitrary keys at the dictionary level;
 * only their VALUE schemas are strict.
 */
function StrictObject<T extends TProperties>(properties: T, options: ObjectOptions = {}): TObject<T> {
  return Type.Object(properties, { ...options, additionalProperties: false });
}

const SessionTypeSchema = StrictObject({
  workspace_files: Type.Optional(Type.Array(Type.String())),
  tail_file: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  session_instruction: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  skills: Type.Optional(
    Type.Union([
      Type.Literal("all"),
      Type.Literal("none"),
      Type.Array(Type.String()),
    ]),
  ),
  // Model key from the `models` record. Defaults to "default".
  model: Type.Optional(Type.String()),
  // LLM-scheduler priority class (spec CONCURRENCY-AND-RATE-LIMITING §9.3).
  // Priority attaches to the session type (the workload), NOT the model: two
  // session types can share one model/budget yet differ in urgency. Built-in
  // defaults (src/agent/scheduler.ts defaultPriorityForSessionType): default →
  // interactive, proactive → proactive, summarize/condense → background,
  // diary → background_low; unknown types → interactive.
  priority: Type.Optional(Type.Union([
    Type.Literal("interactive"),
    Type.Literal("proactive"),
    Type.Literal("background"),
    Type.Literal("background_low"),
  ])),
  // Per-session-type runaway loop-breakers (ARCHITECTURE.md §9c, §4). When set,
  // they override the global `agent.sessions.max_tool_calls` for sessions of this
  // type and add a turn-count cap. NOT a wall-clock timeout — purely a guard
  // against a degenerate loop. Worker session types (summarize/condense/diary)
  // set these to sane defaults; chat sessions leave them unset (unbounded, falling
  // back to the global cap).
  max_tool_calls: Type.Optional(Type.Integer({ minimum: 1 })),
  max_turns: Type.Optional(Type.Integer({ minimum: 1 })),
  // Per-session-type context-token ceiling — an ARTIFICIAL, tighter OVERRIDE
  // layered on the model's `context_window` (spec CONTEXT-LIMIT-UNIFICATION
  // §2.2/U2). Effective ceiling = `min(context_window, max_context_tokens)`,
  // considering the override only when set — a session type can only TIGHTEN the
  // model ceiling, never raise it. Enforced on ACTUALS (last committed request's
  // provider-reported context size), never estimates; the first request of a
  // session is never blocked locally. Unset = the model's `context_window` is the
  // ceiling (always enforced — never unbounded). Worker session types
  // (summarize/condense/diary) set a conservative value to bound a runaway
  // session; interactive types leave it unset and inherit `context_window`.
  // Cross-field validated at app wiring (must not exceed the resolved model's
  // `context_window`). The name (vs `context_window`) deliberately signals
  // "artificial tightening," not a model property.
  max_context_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  // Per-session-type USD cost ceiling (spec SESSION-COST-LIMITS §3) — an OVERRIDE
  // of the global `agent.max_session_cost_usd`. Set = wins; unset = inherits the
  // global default (or unlimited when that is also unset). Counts BOTH lanes:
  // agent-loop cost + this session's tool-use cost (`tool_invocations`); captioning
  // is excluded (pool-scoped). Enforced per-session-run on actuals; the first
  // request is never blocked locally. `0` disables the cap for this type even when
  // a global default is set.
  max_session_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
});

const DiarySchema = StrictObject({
  // When false, the diary worker pool does not drain — level-1 summaries still
  // accumulate `diary_status='pending'` and flush if it is later enabled.
  enabled: Type.Optional(Type.Boolean()),
  worker_count: Type.Optional(Type.Integer({ minimum: 1 })),
  max_retries: Type.Optional(Type.Integer({ minimum: 0 })),
  // The new-section token cap enforced per-edit by the diary tool (§8/§8c).
  per_session_budget_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  // Token ceiling for the recent-memory window (§9a/§10a), shared by the diary
  // session's continuity context and the chat-side recent-diary surfacing layer.
  recency_max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  // N most recent EXISTING day files at/before the anchor day to surface (§9a).
  recency_file_count: Type.Optional(Type.Integer({ minimum: 1 })),
});

const SummarizationSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()),
  worker_count: Type.Optional(Type.Integer({ minimum: 1 })),
  generation_threshold_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  leaf_input_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  leaf_target_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  condense_fanout: Type.Optional(Type.Integer({ minimum: 2 })),
  condense_target_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  summary_max_overage_factor: Type.Optional(Type.Number({ minimum: 1 })),
  // NOTE: summary_wait_timeout_ms was removed with wait-or-omit (spec
  // CONCURRENCY-AND-RATE-LIMITING §7.2): a build now waits until the covering
  // job is terminal — bounded by the job's own retries, not a wall clock.
  max_retries: Type.Optional(Type.Integer({ minimum: 0 })),
  label_cache_ttl_ms: Type.Optional(Type.Integer({ minimum: 0 })),
});

// Chat-history search & recap tools (ARCHITECTURE.md §9e). The FTS index is always
// built; these knobs tune the absence-gap detection ("since I was gone") and recap's
// summary token budget. Optional — defaults fall back to the shared constants.
//
// Upper bound for the absence-window knobs. Mirrors HORIZON_MS in
// src/search/absence.ts (the absence resolver's look-back window); duplicated here as
// a literal to avoid a config → search module dependency. 30 days in ms.
const SEARCH_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
const SearchSchema = StrictObject({
  // Numeric knobs carry both minimum AND maximum bounds (review issue #7), mirroring
  // [retrieval]: an unbounded value degrades silently rather than failing fast at
  // load. The two *_ms fields are capped at SEARCH_HORIZON_MS (30 days) — the absence
  // resolver only ever scans that far back (src/search/absence.ts HORIZON_MS), so a
  // larger gap/lookback is meaningless. recap_budget_tokens is the live risk: it
  // bypasses recap's own bounded max_tokens arg and flows straight into summary
  // coverage selection (src/search/coverage.ts), so a fat-fingered value would bloat
  // recap output with no cap; its maximum mirrors [retrieval] auto.max_tokens (100k).
  //
  // Inter-message gap (ms) above which a user counts as having been "away" — the
  // boundary for recap / search_messages since_user_absence.
  absence_gap_ms: Type.Optional(Type.Integer({ minimum: 60_000, maximum: SEARCH_HORIZON_MS })),
  // Fallback recap/absence window (ms) when a user has no messages in the horizon.
  default_lookback_ms: Type.Optional(Type.Integer({ minimum: 60_000, maximum: SEARCH_HORIZON_MS })),
  // Token budget for the summaries recap returns before coarsening to higher levels.
  recap_budget_tokens: Type.Optional(Type.Integer({ minimum: 200, maximum: 100_000 })),
  // Summary search & expansion (§9e "Summary search"). Bounds the expand_summary tool's
  // output — both knobs are safety caps on a single drill-down, so they carry min+max
  // like the others (an unbounded expansion of a high-level summary could fan out into
  // hundreds of events).
  summaries: Type.Optional(
    StrictObject({
      // Max rendered tokens one expand_summary call accumulates before it stops and
      // reports how many constituents were omitted. Default 4000; max mirrors
      // recap_budget_tokens (100k) as the ceiling on a single tool's output.
      expand_token_cap: Type.Optional(Type.Integer({ minimum: 200, maximum: 100_000 })),
      // Max tiers a single expand_summary call may auto-recurse. Default 3; a hard cap
      // keeps a deep drill from blowing up regardless of the per-call `depth` arg.
      expand_max_depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
    }),
  ),
});

// Passive reaction surfacing (ARCHITECTURE.md §9f). All optional; defaults ship in
// 00-defaults.toml. `enabled` is the master switch for both ingest and the two views.
const ReactionsSchema = StrictObject({
  // Master switch: persist inbound reactions AND surface them in context.
  enabled: Type.Optional(Type.Boolean()),
  // View A: deduped key×count on rich-tier messages.
  show_aggregates: Type.Optional(Type.Boolean()),
  // View B: chronological discrete reaction lines.
  show_discrete: Type.Optional(Type.Boolean()),
  // View B target filter: true = only reactions to the assistant's own messages;
  // false also surfaces reactions to anyone's recent messages. The
  // discrete_other_horizon_messages knob below applies ONLY to those non-self
  // (inter-user) lines — it keeps cross-user reaction chatter tighter than the
  // bot-directed lines.
  discrete_assistant_only: Type.Optional(Type.Boolean()),
  // View B horizon: 0 = the whole rich tier; >0 = only the last N rich messages
  // produce discrete lines. Bounded (mirrors the [search] min/max convention) so a
  // fat-fingered value can't silently degrade.
  discrete_horizon_messages: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  // View B horizon for NON-self (inter-user) targets, applied independently of
  // discrete_horizon_messages so cross-user reactions can be clamped to just the
  // conversationally-live edge (the reactions that become topics are on recent
  // messages). 0 = whole rich tier; >0 = last N rich messages. Inert while
  // discrete_assistant_only is true (no non-self targets exist).
  discrete_other_horizon_messages: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  // View B episode splitting: a coalesced (target, emoji) reaction is split into
  // separate lines across a "seam" so temporally-distinct reaction bursts land at
  // their own point in the timeline instead of all at the latest reaction. Between
  // two consecutive reactions to the same message: 0 messages in between → never
  // split; ≥ discrete_split_messages messages in between → split (the conversation
  // moved on); 1..N-1 in between → split only if more than discrete_split_minutes
  // elapsed (so the later reaction reads as happening *after* the intervening msgs).
  // Applies to all View B lines (self and inter-user). Both bounded.
  discrete_split_messages: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  discrete_split_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
  // More than this many senders on one reaction → first 4 + "(and N others)".
  // Minimum 4 (the shown-name count) so "(and N others)" can never go negative.
  discrete_name_cap: Type.Optional(Type.Integer({ minimum: 4, maximum: 1_000 })),
});

// Memory retrieval — hybrid lexical+semantic search over `memory/*.md`, plus
// auto-retrieval injected per trigger (ARCHITECTURE.md §9d). Optional so existing
// configs stay valid; `enabled` is the master switch for the whole index.
const RetrievalEmbeddingRemoteSchema = StrictObject({
  // Unified registry (spec MODEL-FALLBACK §2.3): `[models.*]` block name for the
  // embeddings endpoint — connection (endpoint/id/api_key), rate-limit group, and
  // cost (its `cost.input` is the USD/1M-input-token rate) live on the referenced
  // block. The old inline id/endpoint/api_key/rate_limit_group/cost_per_mtok are
  // gone. NOTE: a `fallback` chain on the referenced model must produce
  // VECTOR-COMPATIBLE embeddings (same `dim` AND embedding space) — the dim check
  // rejects a wrong-width member, but a same-dim different-space model would
  // silently corrupt the cache/index; in practice point fallback at the same
  // model on a different endpoint.
  model: Type.String({ minLength: 1 }),
  // REQUIRED when remote is active — governs the vector index width (§5a/§6).
  dim: Type.Integer({ minimum: 1 }),
  // Chars-per-token estimate used to price a response that omits a token count
  // (§9). Defaults to 4 when unset.
  chars_per_token: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});

const RetrievalEmbeddingSchema = StrictObject({
  // Active-model resolution (§5a): 'remote' if the [remote] block is set, else the
  // bundled 'local' ONNX model (the zero-config default + safety net).
  provider: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
  local: Type.Optional(
    StrictObject({
      model: Type.Optional(Type.String({ minLength: 1 })),
      dim: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
  remote: Type.Optional(RetrievalEmbeddingRemoteSchema),
});

const RetrievalSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()),
  // §8c — inject the small relevant-memory block inside each trigger's final user
  // turn. Independently disablable (cache-safe placement; risk is distraction).
  auto_retrieval: Type.Optional(Type.Boolean()),
  // Numeric knobs carry both minimum AND maximum bounds (review issue #10): an
  // unbounded value degrades silently — e.g. a huge candidate_multiplier or
  // max_results blows the `getChunksByRowids` IN-list toward SQLite's bound-parameter
  // limit (32766 since SQLite 3.32; the old 999 default predates it). The maxima are
  // generous (well above every value 00-defaults.toml ships) yet keep the worst-case
  // IN-list — `max_results × candidate_multiplier` = 100 × 50 = 5000 rowids — safely
  // under that ceiling, while still rejecting fat-fingered config at load. A cross-
  // field constraint that TypeBox can't express (fallback_chunk_tokens <=
  // max_chunk_tokens) is enforced in resolveRetrievalConfig (issue #14).
  index: Type.Optional(
    StrictObject({
      worker_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 })),
      max_retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      embed_batch_size: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048 })),
      // Oversized header blocks above this many tokens are sub-split (§3); also the
      // embedder's per-input token ceiling.
      max_chunk_tokens: Type.Optional(Type.Integer({ minimum: 16, maximum: 8192 })),
      fallback_chunk_tokens: Type.Optional(Type.Integer({ minimum: 16, maximum: 8192 })),
      fallback_chunk_overlap: Type.Optional(Type.Integer({ minimum: 0, maximum: 8192 })),
    }),
  ),
  query: Type.Optional(
    StrictObject({
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      vector_weight: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      text_weight: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      candidate_multiplier: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      mmr_enabled: Type.Optional(Type.Boolean()),
      mmr_lambda: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      temporal_decay_enabled: Type.Optional(Type.Boolean()),
      temporal_decay_half_life_days: Type.Optional(Type.Number({ minimum: 1, maximum: 36500 })),
    }),
  ),
  auto: Type.Optional(
    StrictObject({
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      dedup_against_recency: Type.Optional(Type.Boolean()),
      // User lane (§9d): a lexical-only sub-search keyed on the trigger user's
      // display name(s), reserving a few result slots for "my recent history with
      // this person" alongside the topical lane. Additive to max_results; the whole
      // block stays bounded by max_tokens.
      user_lane_enabled: Type.Optional(Type.Boolean()),
      user_lane_max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      // Lower than the topical floor on purpose — the lane is already name-scoped, so
      // the floor only drops near-noise rather than gating relevance.
      user_lane_min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      // Match shortened display-name forms by prefix (e.g. "Plaguis"→"Plag") in
      // addition to exact. Exact is always preferred; prefix only fills leftover slots.
      user_lane_prefix_enabled: Type.Optional(Type.Boolean()),
      // Prefix stem length AND the min token length to attempt a prefix at all. Larger
      // = fewer false positives, less tolerance for short nicknames (the FP/recall knob).
      user_lane_prefix_min_chars: Type.Optional(Type.Integer({ minimum: 2, maximum: 64 })),
    }),
  ),
  embedding: Type.Optional(RetrievalEmbeddingSchema),
});

// Proactive posting (ARCHITECTURE.md §9g). Opt-in only: inert unless `enabled =
// true` AND at least one channel is listed. Global fields are defaults overridable
// per channel (effective value = channel ?? global ?? hardcoded default).
const ProactiveActiveHoursSchema = StrictObject({
  // Local hours (agent.timezone). Posting is only scheduled within [start, end).
  // Wraps past midnight when end <= start (e.g. start=9, end=1 → 09:00–01:00).
  start: Type.Integer({ minimum: 0, maximum: 23 }),
  end: Type.Integer({ minimum: 0, maximum: 23 }),
});

const ProactiveChannelSchema = StrictObject({
  timeline_key: Type.String({ minLength: 1 }), // required; exact match
  daily_posts: Type.Optional(Type.Integer({ minimum: 0 })),
  min_user_messages: Type.Optional(Type.Integer({ minimum: 0 })),
  dead_channel_backstop_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  min_gap_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  active_hours: Type.Optional(ProactiveActiveHoursSchema),
});

const ProactiveSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()), // global master switch
  session_type: Type.Optional(Type.String({ minLength: 1 })), // session_types key; default "proactive"
  kickoff_prompt: Type.Optional(Type.String()), // final user turn template ({time} substituted)
  // Global defaults, overridable per channel:
  daily_posts: Type.Optional(Type.Integer({ minimum: 0 })),
  min_user_messages: Type.Optional(Type.Integer({ minimum: 0 })),
  dead_channel_backstop_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  min_gap_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  active_hours: Type.Optional(ProactiveActiveHoursSchema),
  channels: Type.Optional(Type.Array(ProactiveChannelSchema)),
});

// Resumable sessions (spec RESUMABLE-SESSIONS §14). Replying to a COMPLETED
// agent message continues its session as a genuine multi-turn rollout instead of
// spawning a fresh one. Off by default per context (`enabled.dm`/`enabled.group`
// both false); every knob is per-context (DM vs group) except `same_user_only`,
// which is global (inert in DMs). Each field is optional so a partial/omitted
// block degrades to the safe code-level default (resume off); 00-defaults.toml
// ships the full explicit block. Cross-field checks live in app.ts.
const ResumeEnabledSchema = StrictObject({
  dm: Type.Optional(Type.Boolean()),
  group: Type.Optional(Type.Boolean()),
});

// Resume time window per context (§7): a reply more than this many ms after the
// session completed → FRESH. 0 or -1 = unlimited.
const ResumeWindowSchema = StrictObject({
  dm: Type.Optional(Type.Integer({ minimum: -1 })),
  group: Type.Optional(Type.Integer({ minimum: -1 })),
});

// Gap-backfill budget for one context (§9.3). Two independent limits; the
// backfill stops at whichever is hit first. 0 = include none (gap off; the
// default), >0 = cap, -1 = unlimited. `max_tokens` excludes the trigger group.
// Cross-field rule (app.ts): the two are never BOTH -1.
const ResumeGapBudgetSchema = StrictObject({
  max_messages: Type.Optional(Type.Integer({ minimum: -1 })),
  max_tokens: Type.Optional(Type.Integer({ minimum: -1 })),
});

const ResumeGapSchema = StrictObject({
  dm: Type.Optional(ResumeGapBudgetSchema),
  group: Type.Optional(ResumeGapBudgetSchema),
});

const ResumeSatelliteSchema = StrictObject({
  // The single satellite knob (§11): repeat the tail instructions in the fresh
  // satellite on resume (default on). `runtime_state` is always re-rendered and
  // `retrieved_memory` is always omitted on resume — neither is configurable.
  tail: Type.Optional(Type.Boolean()),
});

// Work-gate tuning for one context (§7a). The base gate (≥1 non-exempt tool call
// somewhere in scope) is ALWAYS on; only these two knobs are configurable.
const ResumeWorkGateContextSchema = StrictObject({
  // Where the work must appear: `since_last_turn` (strict — in the latest
  // resume-generation's rollout) or `any_in_history` (loose — anywhere so far).
  scope: Type.Optional(
    Type.Union([Type.Literal("since_last_turn"), Type.Literal("any_in_history")]),
  ),
  // Extra tool names (first-party OR `mcp__…`) to treat as non-work, on top of
  // the built-in chat-surface/control exempt set. Lean exempt for anything
  // ambiguous — the safe failure direction is "didn't resume".
  extra_exempt_tools: Type.Optional(Type.Array(Type.String())),
});

const ResumeWorkGateSchema = StrictObject({
  dm: Type.Optional(ResumeWorkGateContextSchema),
  group: Type.Optional(ResumeWorkGateContextSchema),
});

// Follow-up folding (spec FOLLOWUP-FOLDING §9): fold a quick same-sender follow-up
// (forced-split media, a trailing bare-text thought, or an amending re-`@`) into the
// session its immediately-prior triggering message produced, instead of losing it,
// answering it in isolation, or spawning a parallel twin. Three independent levers,
// each a two-clock gate; every field optional so a partial block degrades to the
// safe code default (folding off), with 00-defaults.toml shipping the full block.
// Cross-field checks (each lever's user_gap_ms ≤ wall_clock_ms) live in app.ts.
const FollowUpLeverSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()),
  // Max user-perceived gap (origin-ts diff) trigger→follow-up. Tighter as the
  // address gets more explicit (media loosest, re-`@` tightest).
  user_gap_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  // Watch lifetime; absorbs upload/federation/decrypt/caption lag without
  // resurrecting an ancient session.
  wall_clock_ms: Type.Optional(Type.Integer({ minimum: 0 })),
});

const FollowUpSchema = StrictObject({
  media: Type.Optional(FollowUpLeverSchema),
  text: Type.Optional(FollowUpLeverSchema),
  mention: Type.Optional(FollowUpLeverSchema),
});

// Capability feature gates. Each boolean turns a related group of agent tools ON.
// Every flag is OFF by default: an absent `[features]` table — or an absent key —
// means the feature is disabled, so its tools are NOT registered for ANY session
// type (a global capability gate, composed with `agent.disabled_tools`: a tool
// excluded by EITHER mechanism is unavailable). The feature→tools mapping lives in
// src/app.ts (FEATURE_TOOLS). Turning a flag on (e.g. `[features]\ncharacter_card =
// true`) restores its tools.
//   - character_card → character_card_create / character_card_read / character_card_edit
//   - danbooru       → the `danbooru` search tool
// NOTE: this phase gates only tool availability. A later change will also drive
// skill-file seeding off these flags; that behaviour is NOT implemented yet, so do
// not assume it here.
const FeaturesSchema = StrictObject({
  character_card: Type.Optional(Type.Boolean()),
  danbooru: Type.Optional(Type.Boolean()),
});

const ResumeSchema = StrictObject({
  // Reserve the scarce single resume for the ORIGINAL trigger sender (§6/§7):
  // a reply from a different user → FRESH. Global; inert in DMs (the asker is the
  // only human). Applies to human replies only — explicit agent delegations
  // bypass it (the decision IS the signal).
  same_user_only: Type.Optional(Type.Boolean()),
  enabled: Type.Optional(ResumeEnabledSchema),
  window: Type.Optional(ResumeWindowSchema),
  gap: Type.Optional(ResumeGapSchema),
  satellite: Type.Optional(ResumeSatelliteSchema),
  work_gate: Type.Optional(ResumeWorkGateSchema),
});

const TimelineSchema = StrictObject({
  // How many messages to fetch on first trigger (initial backfill). 0 = none.
  initial_backfill_messages: Type.Optional(Type.Number({ minimum: 0 })),
  // Max history window for initial backfill (ms), measured back from the trigger
  // (the activation moment), not from "now"; whichever limit is reached first.
  initial_backfill_window_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Timeout for the initial backfill fetch (ms). The first trigger is held this long.
  initial_backfill_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Messages per backward-pagination page request during initial backfill.
  // Clamped 1–1000 by the backfill loop; defaults to 100.
  initial_backfill_page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
  // Stop backfill paging after this many consecutive undecryptable (UTD) events
  // (no useful forward progress into key-less history). 0 disables the guard.
  initial_backfill_utd_halt_threshold: Type.Optional(Type.Number({ minimum: 0 })),
  // Re-decryption sweeper: how often (ms) to retry stored UTD events to see if
  // room keys have since arrived. 0 disables the sweeper.
  redecryption_sweep_interval_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Max UTD events probed per sweep tick (bounds native calls per interval).
  redecryption_sweep_batch: Type.Optional(Type.Number({ minimum: 1 })),
  // Prune events from inactive timelines older than this (days). 0 = no pruning.
  // Drives the Phase 8 retention cleanup job (runs on startup + daily).
  inactive_event_retention_days: Type.Optional(Type.Number({ minimum: 0 })),

  // --- Startup gap backfetch (ARCHITECTURE.md §7c) ---
  // Master on/off switch. When enabled, on startup the bot paginates backward
  // per room from the live head until it reaches the last message it already has
  // (the floor), filling any history missed while it was offline. Off → behaviour
  // is exactly as before (no freeze, no backfetch).
  gap_backfetch_enabled: Type.Optional(Type.Boolean()),
  // Per-room message cap. UNSET or 0 ⇒ UNBOUNDED (the default): page until the gap
  // is fully closed (floor reached) or history is exhausted. A positive value is a
  // purely opt-in safety valve for memory/startup-latency control; under it a
  // permanent hole may remain below the oldest committed gap message (§10).
  gap_backfetch_max_messages: Type.Optional(Type.Number({ minimum: 0 })),
  // Don't fetch messages older than `now - this` (ms). 0 ⇒ no window bound (default).
  gap_backfetch_window_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Per-room wall-clock budget (ms) for the descent. 0 ⇒ no timeout (default).
  gap_backfetch_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Messages per backward-pagination page request (clamped 1–1000). Default 100.
  gap_backfetch_page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
  // Stop paging after this many consecutive undecryptable (UTD) events (no useful
  // forward progress into key-less history). 0 disables the guard. Default 50.
  gap_backfetch_utd_halt_threshold: Type.Optional(Type.Number({ minimum: 0 })),
  // How many rooms are backfetched in parallel on startup (bounded so the descent
  // doesn't hammer the homeserver / shared HTTP limiter). Default 3.
  gap_backfetch_concurrency: Type.Optional(Type.Number({ minimum: 1 })),
});

const ModelSchema = StrictObject({
  // Model inheritance (spec MODEL-FALLBACK §2.1). When set, the named `[models.*]`
  // block is deep-merged UNDER this one (child fields win, everything else
  // inherited) at config load, BEFORE schema validation — so a VIRTUAL model can
  // reuse a real model's connection properties (endpoint/api/key/cost/window/…)
  // and override only what differs, crucially its own `fallback` chain. Transitive;
  // cycles fail fast at load. The loader strips `inherits` after merging, so a
  // resolved model is a plain real model.
  inherits: Type.Optional(Type.String({ minLength: 1 })),
  // Per-model fallback chain (spec MODEL-FALLBACK §2.1). An ordered list of
  // `[models.*]` block names (logical ids); a request to THIS model is served by
  // the first chain member that is up, transparently. The chain is exactly the
  // one written here — a member's own `fallback` does NOT transitively extend it
  // (§9, head's chain only). Fallbacks live ONLY on models; there is no per-tool
  // or per-session-type fallback config. The model itself is the implicit head, so
  // a chain of `["Y","Z"]` resolves as `[self, Y, Z]`.
  fallback: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  id: Type.String({ minLength: 1 }),
  // pi-ai provider string. Besides naming the upstream, it drives the OAI
  // provider's compat AUTO-DETECTION (request dialect): e.g. "together" turns
  // on Together's thinking format (`reasoning: {enabled}`), `max_tokens`
  // field, and no-strict-mode — needed when a gateway URL hides the real
  // upstream from URL-based detection.
  provider: Type.String({ minLength: 1 }),
  // Which wire API the endpoint speaks (pi-ai api registry; selects the
  // streamSimple implementation). Default "anthropic-messages".
  api: Type.Optional(Type.Union([
    Type.Literal("anthropic-messages"),
    Type.Literal("openai-completions"),
    Type.Literal("openai-responses"),
    Type.Literal("google-generative-ai"),
  ])),
  endpoint: Type.String(),
  api_key: Type.String(),
  // The model's accepted INPUT modalities (spec MODEL-FALLBACK §3 capability
  // pre-filter). "text" is the baseline; "image"/"video"/"audio" declare which
  // non-text inputs the model can actually consume. Used as the fallback
  // capability predicate everywhere a request carries non-text content: the
  // agent path requires `includes("image")` when raw session inputs carry images,
  // and each captioning lane requires its own modality (image/video/audio) so a
  // heterogeneous chain never ships e.g. a video to an image-only fallback.
  // Required (mirrors the explicit-config convention) — a text-only model is
  // `["text"]`.
  input_modalities: Type.Array(
    Type.Union([
      Type.Literal("text"),
      Type.Literal("image"),
      Type.Literal("video"),
      Type.Literal("audio"),
    ]),
  ),
  max_tokens: Type.Number({ minimum: 1 }),
  reasoning: Type.Optional(Type.Boolean()),
  // Extended-thinking level requested on every LLM call made with this model
  // (pi-agent-core `thinkingLevel` → pi-ai `options.reasoning`). `reasoning`
  // above is only the CAPABILITY flag on the model descriptor — it never turns
  // thinking on by itself; this field does. Unset or "off" = thinking disabled
  // (requests go out with thinking explicitly off). On adaptive-thinking
  // models (Opus/Sonnet 4.6+) the level maps to an effort hint and the model
  // decides when/how much to think; on older models it maps to a token budget.
  // A non-off level with `reasoning = false` is contradictory (validated
  // fail-fast at app wiring).
  thinking_level: Type.Optional(Type.Union([
    Type.Literal("off"),
    Type.Literal("minimal"),
    Type.Literal("low"),
    Type.Literal("medium"),
    Type.Literal("high"),
    Type.Literal("xhigh"),
  ])),
  // Whether this Anthropic model uses ADAPTIVE thinking (an effort HINT with no
  // additive `max_tokens` budget — the wire cap stays at the issued `max_tokens`
  // and billed output never exceeds it). When set, AUTHORITATIVE for the per-user
  // affordability basis (PER-USER-LIMITS §5): `true` ⇒ reserve 0 thinking tokens
  // inside the issued cap (no over-reservation), `false` ⇒ the flat per-level
  // additive budget. When UNSET, a hardcoded id heuristic (Opus 4.6/4.7, Sonnet
  // 4.6) decides — so set `adaptive_thinking = true` explicitly for adaptive
  // Anthropic models NEWER than that list (e.g. Opus 4.8+) to avoid a phantom
  // reservation that can spuriously deny a within-budget user. Only consulted on
  // the anthropic-messages path; Gemini/OpenAI budgets are derived separately.
  adaptive_thinking: Type.Optional(Type.Boolean()),
  // Per-level remap of `thinking_level` → the provider's wire value for the
  // reasoning-effort knob (pi-ai `Model.thinkingLevelMap`). Needed when the
  // upstream's effort vocabulary differs from pi-ai's `ThinkingLevel` enum
  // ("minimal"|"low"|"medium"|"high"|"xhigh"). Example: GLM-5.2 on Together
  // exposes two efforts, "high" and "max" — map `xhigh = "max"` (and the lower
  // levels to "high") so `thinking_level = "xhigh"` is forwarded on the wire as
  // `reasoning_effort = "max"`. A level mapped to `null` is treated as
  // unsupported (pi-ai clamps away from it). Only consulted on the
  // openai-completions path when `compat.supports_reasoning_effort` is set.
  // Mapping `xhigh` is ALSO what makes `xhigh` selectable at all — pi-ai treats
  // xhigh as a supported level only when it is explicitly mapped here.
  thinking_level_map: Type.Optional(StrictObject({
    off: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    minimal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    low: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    medium: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    high: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    xhigh: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  })),
  // The model-level context ceiling AND the always-on enforcement base (spec
  // CONTEXT-LIMIT-UNIFICATION §2.1/U1). Operators set it deliberately BELOW the
  // physical provider window to stay clear of edge-case degradation/cost. It is
  // the SOLE model-level limit: the operative per-session ceiling is
  // `min(context_window, session_type.max_context_tokens)`, resolved once and
  // fed to every consumer (enforcement, the pi-ai model descriptor, the
  // text-editor read budget — `resolveSessionContextCeiling`). Required for any
  // model a session type resolves to (fail-fast at app wiring, §2.5) so
  // enforcement is always wired. There is no model-level `max_context_tokens` —
  // it was removed (U2); a tighter ceiling is expressed per session type.
  context_window: Type.Optional(Type.Number({ minimum: 1 })),
  // Cap on the base64-encoded image payload shipped to the provider, NOT raw
  // file bytes. Raw bytes inflate ~4/3 in base64 (formula
  // `4 * ceil(rawBytes / 3)`). Used by `read_image` and by the danbooru
  // `preview` action's inline emission. Anthropic's per-image inline cap is
  // 5 MB base64 — values up to that ceiling are safe.
  image_input_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  // NOTE: `cost` DEEP-MERGES with the inherited block (spec MODEL-FALLBACK §2.1
  // inheritance). A partial override on a virtual model keeps the parent's other
  // rate fields — so to make an inheriting model zero-cost, set ALL rate fields
  // and `per_image` to 0, not just one (zeroing only `input` leaves the inherited
  // `output`/`cache_*`/`per_image` in force).
  cost: Type.Optional(StrictObject({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cache_read: Type.Number({ minimum: 0 }),
    cache_write: Type.Number({ minimum: 0 }),
    // Optional flat USD charge per generated image (spec MODEL-FALLBACK §2.3) —
    // used by image-gen models that quote per-image pricing, moved here from the
    // old inline `[image_gen.costs.*].per_image` when the registry was unified.
    per_image: Type.Optional(Type.Number({ minimum: 0 })),
  })),
  streaming: Type.Optional(Type.Boolean()),
  // LLM rate-limit group (spec CONCURRENCY-AND-RATE-LIMITING §9.2): which shared
  // upstream budget this model's requests draw from. Group attaches to the
  // model/endpoint. Unset = `default` — not an error. NEVER derived from the
  // endpoint host (a gateway can multiplex several provider hosts onto one
  // rate-limited account). A non-default value must name a group declared in
  // `[rate_limits.llm.*]` (validated fail-fast at app wiring).
  rate_limit_group: Type.Optional(Type.String({ minLength: 1 })),
  // Per-model override of the interactive-class wall-clock retry budget (spec
  // LLM-FAILURE-HANDLING §6, maintainer decision). The budget bounds only
  // WAITING (admission-queue waits + inter-attempt backoff) and a STUCK attempt
  // that produces zero tokens by the deadline — it never aborts a streaming
  // attempt that has emitted any token (incl. reasoning). A model that is slow
  // to FIRST token can be granted a larger pre-first-token budget here. Unset =
  // fall back to `recovery.llm_request_max_wait_ms`. Only affects
  // interactive-class sessions (chat/proactive); background-class work is
  // unbounded regardless.
  llm_request_max_wait_ms: Type.Optional(Type.Number({ minimum: 1 })),
  // Per-model override of the unhealthy-probe backoff CEILING (spec MODEL-FALLBACK
  // §4.1). While this model is unhealthy the scheduler probes on a capped
  // exponential backoff (base → ×2 → cap); a model with an especially poor
  // fallback can pin a tighter cap here so it returns to the primary sooner.
  // Unset = the global `recovery.llm_probe_backoff_max_ms`.
  llm_probe_backoff_max_ms: Type.Optional(Type.Number({ minimum: 1 })),
  compat: Type.Optional(StrictObject({
    supports_cache_control_on_tools: Type.Optional(Type.Boolean()),
    supports_long_cache_retention: Type.Optional(Type.Boolean()),
    supports_eager_tool_input_streaming: Type.Optional(Type.Boolean()),
    send_session_affinity_headers: Type.Optional(Type.Boolean()),
    // Force-enable the openai-completions `reasoning_effort` parameter. pi-ai
    // auto-detects effort support from the endpoint/provider and DISABLES it for
    // `provider = "together"` (that gateway dialect normally only toggles
    // thinking on/off via `reasoning: { enabled }`). Set true when the Together
    // upstream actually honors an effort level (e.g. GLM-5.2's high/max) so
    // `thinking_level` (via `thinking_level_map`) is forwarded as
    // `reasoning_effort`. Unset = keep pi-ai's auto-detection.
    supports_reasoning_effort: Type.Optional(Type.Boolean()),
    // Override whether the system prompt is sent with the OpenAI-style
    // `developer` role. pi-ai uses `developer` whenever `reasoning` is on and it
    // auto-detects the role as supported (true for most providers) — but some
    // OAI-compatible upstreams behind a gateway (e.g. a proxied DeepSeek, whose
    // API only accepts system/user/assistant/tool) reject `developer` with a
    // deserialization 400. Set false to force the plain `system` role. Unset =
    // keep pi-ai's auto-detection.
    supports_developer_role: Type.Optional(Type.Boolean()),
    // Override pi-ai's "reasoning_content required on every assistant message"
    // safety net (auto-enabled for `provider = "deepseek"`). When on, pi-ai
    // stamps `reasoning_content: ""` on any assistant turn that carried no
    // thinking block — but DeepSeek V4 Pro thinking mode REJECTS a present-but-
    // empty `reasoning_content` (400 "must be passed back to the API") on those
    // reasoning-less turns (e.g. historical/plain context messages). Per DeepSeek
    // docs the field is optional and ignored on non-tool-call turns, so omitting
    // it is correct; set false to suppress the empty-string stamp. Real reasoning
    // on tool-call turns is emitted independently (thinking-signature path) and
    // is unaffected. Unset = keep pi-ai's auto-detection.
    requires_reasoning_content_on_assistant_messages: Type.Optional(Type.Boolean()),
  })),
});

const MatrixAccountSchema = StrictObject({
  homeserver: Type.String(),
  access_token: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),
  recovery_key: Type.Optional(Type.String()),
  user_id: Type.String(),
  device_id: Type.Optional(Type.String()),
  store_path: Type.String(),
  /**
   * Agent this account belongs to (spec MULTI-AGENT-SUPPORT §4.1).
   * Defaults to the account key when absent. Only valid when an [agents] table
   * is present; a validation error in legacy mode (§4.2).
   */
  agent: Type.Optional(Type.String({ minLength: 1 })),
});

/**
 * Per-bot-account config for a Discord application. Token is auto-redacted
 * by the existing key-name regex (`token` matches `/(api[_-]?key|token|...)/i`).
 */
const DiscordAccountSchema = StrictObject({
  /** Discord bot token — sourced from ${VAR} env substitution. */
  token: Type.String(),
  /** Discord application id — required for application emoji lookup. */
  application_id: Type.Optional(Type.String()),
  /** Guild id allowlist. Absent = all joined guilds are served. */
  guilds: Type.Optional(Type.Array(Type.String())),
  /** Accept DMs from users sharing a guild (default true). */
  dm_enabled: Type.Optional(Type.Boolean()),
  /**
   * Enable the GUILD_MEMBERS privileged intent (roster access). Off by default;
   * requires the intent to be toggled on in the Discord Developer Portal as well.
   */
  member_intent: Type.Optional(Type.Boolean()),
  /**
   * Agent this account belongs to (spec MULTI-AGENT-SUPPORT §4.1).
   * Defaults to the account key when absent. Only valid when an [agents] table
   * is present; a validation error in legacy mode (§4.2).
   */
  agent: Type.Optional(Type.String({ minLength: 1 })),
});

/**
 * Sandbox subsystem config block (spec MULTI-AGENT-SUPPORT §10).
 * Shared shape between the top-level `[sandbox]` and per-agent
 * `[agents.<name>.sandbox]` blocks. Extracted so both reference the same
 * TypeBox schema and `SandboxBlockConfig` can be exported as a named type.
 *
 * This const is defined before the `[browser]` block (which it precedes
 * conceptually) and referenced twice: once in `AgentBlockSchema` (per-agent
 * strict-mode override) and once in `AppConfigSchema` (global sandbox).
 */
const SandboxBlockSchema = StrictObject({
  enabled: Type.Boolean(),
  image: Type.String(),
  container_name: Type.String(),
  network: Type.String(),
  // DNS servers for the sandbox (`docker create --dns`). Unset ⇒
  // ["1.1.1.1", "8.8.8.8"] (historical default — a bridge network where the
  // daemon's embedded resolver is unreachable behind the egress firewall). Set
  // to [] to emit NO --dns: REQUIRED when `network` is a namespace join
  // ("container:…"/"host"), since Docker rejects --dns with a shared netns — the
  // sandbox then inherits that namespace's resolver (e.g. a VPN anchor's tunnel
  // DNS, so its egress + name resolution both ride the tunnel). Non-empty ⇒
  // those servers verbatim.
  dns: Type.Optional(Type.Array(Type.String())),
  workspace_mount: Type.String(),
  // How the sandbox bind source (`docker create -v <src>`) is derived from the
  // workspace root. "host" (default): the resolved path is used as-is — the
  // agent runs on the daemon's own filesystem. "container": the agent itself
  // runs in a container, so the path is translated at startup by inspecting
  // the agent's OWN container mounts over the socket (src/sandbox/host-path.ts)
  // — no host path appears in any config; the compose project stays relocatable.
  workspace_bind_source: Type.Optional(
    Type.Union([Type.Literal("host"), Type.Literal("container")]),
  ),
  exec_timeout_ms: Type.Number({ minimum: 1 }),
  max_output_bytes: Type.Number({ minimum: 1 }),
  stop_on_shutdown: Type.Optional(Type.Boolean()),
  // Resource/isolation knobs (room to grow; passed to `docker create`).
  memory: Type.Optional(Type.String()),
  cpus: Type.Optional(Type.Number({ minimum: 0 })),
  pids_limit: Type.Optional(Type.Number({ minimum: 1 })),
  read_only_root: Type.Optional(Type.Boolean()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  binds: Type.Optional(Type.Array(Type.String())),
});

/**
 * Per-agent identity block (spec MULTI-AGENT-SUPPORT §4.1).
 * Each entry under `[agents.*]` declares one named agent's workspace,
 * and optionally its own sandbox (strict mode, §10) and browser profile (§10a).
 */
const AgentBlockSchema = StrictObject({
  /** Absolute or relative path to this agent's workspace root directory. */
  workspace_root: Type.String({ minLength: 1 }),
  /**
   * Optional summary mirroring donor (spec MULTI-AGENT-SUPPORT §10b).
   * When set, this agent's timelines that share a channel with the named donor
   * agent receive mirrored summaries from the donor rather than generating their
   * own. The donor agent must be declared and must not itself have summaries_from
   * (no chains). Default off: absent → native summarization for all timelines.
   */
  summaries_from: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * Per-agent sandbox override (spec MULTI-AGENT-SUPPORT §10 "strict" mode).
   * When set, this agent gets its own dedicated container. Overrides `[sandbox]`
   * wholesale — no per-key merge. Agents without this block share the global
   * `[sandbox]` container ("shared soft-isolation" mode).
   */
  sandbox: Type.Optional(SandboxBlockSchema),
  /**
   * Per-agent browser profile (spec MULTI-AGENT-SUPPORT §10a).
   * When set, this agent gets its own `BrowserSession` (own Manager profile,
   * lazily launched on first use). Agents without this block get no browser tools.
   * Connection settings (`manager_url`, `auth_token`, timeouts, etc.) are
   * inherited from the global `[browser]` block.
   */
  browser: Type.Optional(StrictObject({
    profile_name: Type.String({ minLength: 1 }),
  })),
  /**
   * Per-agent MCP server allowlist (spec PER-AGENT-MCP-SCOPING).
   * When absent (default), this agent sees tools from ALL configured
   * `[mcp.servers.*]` — identical to today's behavior. When present, only
   * tools from the listed servers (`mcp_<server>_*`) are visible to every
   * session of this agent (chat and worker types alike). An empty array `[]`
   * is valid: this agent gets no MCP tools at all. Only meaningful under an
   * `[agents]` table (no legacy-mode variant). Cross-field validated at
   * startup: every listed key must name a configured `[mcp.servers.<key>]`
   * block — a missing key is a startup error (catches typos and stale entries
   * when a server is removed from config).
   */
  mcp_servers: Type.Optional(Type.Array(Type.String())),
});

/**
 * Sibling-reply suppression settings (spec MULTI-AGENT-SUPPORT §9).
 * Controls whether one in-process bot account can trigger another.
 * Default `replies = "never"` suppresses all sibling triggers.
 */
const SiblingsSchema = StrictObject({
  /**
   * "never" (default): sibling messages are ingested and stored but never
   * trigger a session.
   * "capped": sibling mention/reply triggers only while the chain count is
   * below max_bot_chain; all agents go silent once the cap is reached until
   * a human speaks (spec MULTI-AGENT-SUPPORT §9).
   */
  replies: Type.Optional(
    Type.Union([Type.Literal("never"), Type.Literal("capped")]),
  ),
  /**
   * In "capped" mode: maximum consecutive bot-authored messages allowed
   * since the last human message before all agents go silent.
   * Counting is knob-independent: webhook-authored messages count as human;
   * self, sibling, and flagged third-party bot messages count as bot.
   * Default: 4. Minimum: 1.
   */
  max_bot_chain: Type.Optional(Type.Integer({ minimum: 1 })),
  /**
   * Controls whether genuine third-party Discord bot senders (author.bot set,
   * no webhook_id) can trigger the agent without limit or are subject to the
   * same max_bot_chain window as siblings.
   * "unlimited" (default): today's behaviour — third-party bots trigger without
   * any bot-chain gate, byte-identical to pre-Phase-5b.
   * "capped": third-party bots are subject to the same chain window as siblings.
   * Webhook-authored messages (webhook_id set) are ALWAYS treated as human
   * regardless of this knob — they relay real humans through bridges.
   * Matrix has no reliable bot marker; this knob is Discord-only (spec §9/§14).
   */
  third_party_bots: Type.Optional(
    Type.Union([Type.Literal("unlimited"), Type.Literal("capped")]),
  ),
});

/**
 * Top-level `[discord]` block — a peer of `[matrix]`. Default: enabled = false,
 * no accounts. Validated at startup but not yet consumed by the provider
 * (Discord provider wired in Phase 3+).
 */
const DiscordSchema = StrictObject({
  enabled: Type.Boolean(),
  trigger_hold_ms: Type.Optional(Type.Number({ minimum: 0 })),
  accounts: Type.Optional(Type.Record(Type.String(), DiscordAccountSchema)),
});

// Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / §13 Phase 5d).
// Default-off: the block must be present AND enabled = true for the store to activate.
// `path` is the store root; it must be on the same filesystem as every agent workspace
// root (validated at startup via a cross-device link() probe — fail-fast with a clear
// error if any workspace is on a different device).
const AttachmentStoreSchema = StrictObject({
  // Master switch. false (or block absent) = no store; behaviour is byte-identical
  // to pre-Phase-5d. No probe runs and no extra I/O occurs when disabled.
  enabled: Type.Optional(Type.Boolean()),
  // Store root directory. Relative paths resolve against cwd (same convention as
  // other dir keys). Must be on the same filesystem as all workspace roots.
  // Default when enabled but unset: "./attachment-store".
  path: Type.Optional(Type.String({ minLength: 1 })),
});

const MediaImageSchema = StrictObject({
  max_total_pixels: Type.Optional(Type.Number({ minimum: 1 })),
  max_total_pixels_hard: Type.Optional(Type.Number({ minimum: 1 })),
  min_shortest_side: Type.Optional(Type.Number({ minimum: 1 })),
  max_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  mozjpeg: Type.Optional(Type.Boolean()),
});

const MediaVideoSchema = StrictObject({
  max_resolution: Type.Optional(Type.Number({ minimum: 1 })),
  max_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  max_duration_seconds: Type.Optional(Type.Number({ minimum: 1 })),
  gpu_acceleration: Type.Optional(Type.Boolean()),
  x264_preset: Type.Optional(Type.String()),
  cache_max_bytes: Type.Optional(Type.Number({ minimum: 0 })),
  cache_target_bytes: Type.Optional(Type.Number({ minimum: 0 })),
});

const MediaAudioSchema = StrictObject({
  max_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  max_duration_seconds: Type.Optional(Type.Number({ minimum: 1 })),
});

const MediaSchema = StrictObject({
  download_size_limit: Type.Optional(Type.Number({ minimum: 1 })),
  image: Type.Optional(MediaImageSchema),
  video: Type.Optional(MediaVideoSchema),
  audio: Type.Optional(MediaAudioSchema),
});

const McpServerSchema = StrictObject({
  url: Type.String({ minLength: 1 }),
  transport: Type.Optional(Type.Union([
    Type.Literal("streamable-http"),
    Type.Literal("sse"),
  ])),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const McpSchema = StrictObject({
  servers: Type.Record(Type.String(), McpServerSchema),
});

const EnrichmentSchema = StrictObject({
  worker_count: Type.Optional(Type.Number({ minimum: 1 })),
  fetch_timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  trigger_wait_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
  max_previews_per_message: Type.Optional(Type.Number({ minimum: 0 })),
  max_retries: Type.Optional(Type.Number({ minimum: 0 })),
});

// X.com enrichment via the FxTwitter API + the x_fetch tool (ARCHITECTURE.md
// §7a/§10). Top-level rather than [enrichment.fxtwitter]: two consumers share
// it (the enrichment worker and the x_fetch tool), and a flat top-level table
// keeps the two seams' config side by side. No byte caps here — all media fetches ride the
// global media.download_size_limit. The compact-tier truncation (280/140) is
// a renderer constant, not config. Cross-field sanity (default_max_chars <=
// max_chars_limit <= max_total_chars) is validated at app wiring.
const FxTwitterSchema = StrictObject({
  // false → X status URLs are NOT previewed at all (no Synapse fallback —
  // deliberately: the Synapse og-card for X is noise, not signal).
  enabled: Type.Optional(Type.Boolean()),
  // Self-hostable mirror override.
  api_base: Type.Optional(Type.String({ minLength: 1 })),
  fetch_timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  // Rich-tier text cap, applied independently per tweet node (text and
  // community note each). Generous-but-bounded: X premium long posts exceed it.
  max_text_chars: Type.Optional(Type.Integer({ minimum: 1 })),
  // false → individual photo assets instead of the mosaic collage.
  prefer_mosaic: Type.Optional(Type.Boolean()),
  // Per node (tweet and quote each); X's own per-post max is 4.
  max_videos_per_tweet: Type.Optional(Type.Integer({ minimum: 0 })),
  // Extra mirror base-domains recognized as X status hosts, merged into the
  // built-in set (subdomains of each are matched too). For new FixTweet/mirror
  // aliases the ecosystem invents, without a code change.
  extra_status_hosts: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  tool: Type.Optional(StrictObject({
    // Registers x_fetch — independent of the enrichment enable.
    enabled: Type.Optional(Type.Boolean()),
    default_max_chars: Type.Optional(Type.Integer({ minimum: 1 })),
    max_chars_limit: Type.Optional(Type.Integer({ minimum: 1 })),
    // Cap on the assembled document (paginated via offset); the total must
    // accommodate long-form posts, hence well above any single window.
    max_total_chars: Type.Optional(Type.Integer({ minimum: 1 })),
    // Image blocks per call via view_media.
    max_view_blocks: Type.Optional(Type.Integer({ minimum: 1 })),
  })),
});

// Unified registry (spec MODEL-FALLBACK §2.3): captioning models are NAMED
// references into `[models.*]` (connection / provider / cost / rate_limit_group /
// any `fallback` chain live on the referenced block) — the old inline caption
// model block (id/endpoint/api_key/provider/cost/rate_limit_group) is gone.
// NOTE: the per-modality `concurrency` alias (deprecated transitional knob) was
// removed (review issue #29): caption-inference concurrency is governed by the
// captioning rate-limit group's `max_in_flight` ([rate_limits.llm.*], spec §9.4).
const ModalityConfigSchema = StrictObject({
  prompt: Type.Optional(Type.String()),
  max_chars: Type.Optional(Type.Number({ minimum: 1 })),
  max_tokens: Type.Optional(Type.Number({ minimum: 1 })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  // `[models.*]` block name for this modality; unset = the top-level captioning
  // `model`, else the `default` model.
  model: Type.Optional(Type.String({ minLength: 1 })),
});

const CaptioningSchema = StrictObject({
  // `[models.*]` block name shared by all modalities unless overridden per
  // modality; unset = the `default` model.
  model: Type.Optional(Type.String({ minLength: 1 })),
  worker_count: Type.Optional(Type.Number({ minimum: 1 })),
  caption_all: Type.Optional(Type.Boolean()),
  caption_assistant_messages: Type.Optional(Type.Boolean()),
  trigger_wait_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
  max_retries: Type.Optional(Type.Number({ minimum: 0 })),
  image: Type.Optional(ModalityConfigSchema),
  video: Type.Optional(ModalityConfigSchema),
  audio: Type.Optional(ModalityConfigSchema),
});

const ObservabilityServerSchema = StrictObject({
  // Off by default; the operator opts in via local config (memory:
  // feedback_explicit_deployment_config — ship defaults, set real values
  // explicitly). When false, no server is started.
  enabled: Type.Boolean(),
  // Bind localhost only; the console is for the operator, not end users (spec §1).
  bind: Type.String(),
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  // When set, required as a bearer token on every request and SSE connection.
  // The key name matches the secret-redaction regex (`token`), so the loader
  // auto-registers the value for redaction in logs and JSON responses.
  //
  // `minLength: 1` enforces the fail-fast distinction (issue #5): the key being
  // ABSENT means auth is intentionally disabled (localhost-operator default),
  // whereas a key PRESENT but empty (e.g. `${MIKUSWARM_CONSOLE_TOKEN}` expanding to
  // "") is a misconfiguration that would otherwise silently open the console —
  // it is rejected at load time. Whitespace-only tokens are caught by the
  // explicit guard in the loader (schema length alone can't see them).
  auth_token: Type.Optional(Type.String({ minLength: 1 })),
});

const ObservabilitySchema = StrictObject({
  server: Type.Optional(ObservabilityServerSchema),
  // Capacity of the in-memory LLM request ring backing GET /api/llm-requests
  // (spec LLM-FAILURE-HANDLING §9.2). Not durable by design — the LLM gateway holds
  // the authoritative wire log; this adds session/priority attribution,
  // admission wait, attempt numbering, and failures that never hit the wire.
  llm_request_ring_size: Type.Optional(Type.Number({ minimum: 1 })),
});

export type ObservabilityServerConfig = Static<typeof ObservabilityServerSchema>;

// Browser-use backend (ARCHITECTURE.md browser section; spec/BROWSER-USE.md).
// Off by default; the harness connects to an operator-run CloakBrowser-Manager
// over HTTP and degrades gracefully if it is down (it does NOT manage the
// container). All fields are set explicitly in local config per the
// explicit-deployment-config convention.
const BrowserSchema = StrictObject({
  enabled: Type.Boolean(),
  // CloakBrowser-Manager base URL (loopback-published REST + CDP-WS proxy).
  manager_url: Type.String({ minLength: 1 }),
  // Matches the Manager's AUTH_TOKEN. Passed as `Authorization: Bearer` on REST
  // and on connectOverCDP (forwarded on the WS upgrade — phase-0 verified). The
  // key name ends in `token`, so the loader auto-registers it for log redaction.
  // Optional + minLength:1: ABSENT means the Manager runs token-less (localhost
  // isolation only); PRESENT-but-empty is a misconfiguration and is rejected.
  auth_token: Type.Optional(Type.String({ minLength: 1 })),
  // The single persistent identity. Resolved by name each boot; created lazily
  // with auto_launch=true if absent. In agents mode, this is unset at the global
  // level (a startup error if set); each agent declares its own profile_name
  // under [agents.<name>.browser]. In legacy mode, absent ⇒ code default "miku"
  // (spec MULTI-AGENT-SUPPORT §10a / §4.2 schema-optional treatment).
  profile_name: Type.Optional(Type.String({ minLength: 1 })),
  // Fingerprint platform spoof. Most common / least suspicious is windows.
  platform: Type.Union([
    Type.Literal("windows"),
    Type.Literal("macos"),
    Type.Literal("linux"),
  ]),
  // Stable fingerprint seed (create-once). 0 (or unset) ⇒ let the Manager pick a
  // random seed once and persist it; a drifting seed defeats the "same person".
  fingerprint_seed: Type.Optional(Type.Number({ minimum: 0 })),
  // Bézier-curve mouse + per-character typing — a stronger "real user" signal.
  humanize: Type.Boolean(),
  // Gate browser act:evaluate (arbitrary JS in the page), mirroring OpenClaw.
  evaluate_enabled: Type.Boolean(),
  // Optional fingerprint screen size (defaults to the Manager's 1920x1080).
  screen_width: Type.Optional(Type.Integer({ minimum: 1 })),
  screen_height: Type.Optional(Type.Integer({ minimum: 1 })),
  // Profile timezone/locale. Default to agent.timezone (and a derived locale)
  // unless overridden here, so the browser and chat persona agree on locale.
  timezone: Type.Optional(Type.String({ minLength: 1 })),
  locale: Type.Optional(Type.String({ minLength: 1 })),
  // Optional egress proxy: http(s)://… or socks5://… (host:port:user:pass is
  // normalized by the Manager). Empty ⇒ direct egress through the hardened bridge.
  proxy: Type.Optional(Type.String()),
  // Match the spoofed timezone/locale to the proxy's exit IP.
  geoip: Type.Boolean(),
  // Auto-handling of JS alert/confirm/prompt so a dialog can never hang a page.
  // alert is always accepted; this controls confirm/prompt.
  dialog_policy: Type.Union([Type.Literal("dismiss"), Type.Literal("accept")]),
  // Truncate AI snapshots to bound context cost.
  snapshot_max_chars: Type.Integer({ minimum: 1000 }),
  // Max child frames (iframes) descended into per snapshot. 0 ⇒ main document
  // only (the pre-frames behavior). Child-frame content is appended under
  // [frame fN: url] boundaries with refs namespaced fN:eN, all still bounded by
  // snapshot_max_chars (a page full of ad iframes can't blow the budget).
  // Ceiling of 256: descending into more than a few dozen frames is already
  // absurd (and bounded by snapshot_max_chars anyway), so a few hundred is a
  // generous hard cap that fail-fasts an obviously fat-fingered value.
  snapshot_max_frames: Type.Integer({ minimum: 0, maximum: 256 }),
  // Per-navigation / per-action / connect (incl. first-launch cold start) timeouts.
  // Floor of 1000ms: a sub-second op/nav/connect timeout would spuriously fail
  // real work; the previous minimum of 1ms was a footgun, not a useful setting.
  nav_timeout_ms: Type.Integer({ minimum: 1000 }),
  act_timeout_ms: Type.Integer({ minimum: 1000 }),
  connect_timeout_ms: Type.Integer({ minimum: 1000 }),
  // Close a session's tab after this much idle, to bound tab growth. Floor is
  // the sweep interval (30000ms, SWEEP_INTERVAL_MS in src/browser/session.ts):
  // a smaller value would reap sessions on the very first sweep after a single
  // op, racing live tool calls (issue #1). Shipped default is 600000, well above
  // this floor.
  session_page_idle_ms: Type.Integer({ minimum: 30000 }),
  // Browser downloads (ARCHITECTURE.md §11b "Downloads"): the shared staging dir
  // AS SEEN BY THE BROWSER container — sent verbatim over CDP in
  // Browser.setDownloadBehavior. When the browser is enabled, set BOTH downloads
  // keys or NEITHER (cross-field validated in app.ts inside the `enabled` guard,
  // not the loader, per the proactive-posting precedent — so setting exactly one
  // is a startup error only when the browser is enabled, consistent with
  // manager_url/auth_token); both unset ⇒ downloads disabled, an explicit opt-in
  // that must match the deployment's mount topology (the bytes land in the
  // browser container's fs).
  downloads_dir: Type.Optional(Type.String({ minLength: 1 })),
  // The SAME storage as seen by the agent process; relative paths resolve against
  // cwd like the other dir keys. Two keys rather than one because only the compose
  // topology mounts both sides at one identical path — standalone (agent on host)
  // inherently sees the staging dir at a different path than the browser does.
  downloads_local_dir: Type.Optional(Type.String({ minLength: 1 })),
});

export type BrowserConfig = Static<typeof BrowserSchema>;

// Image generation/editing via Google's Gemini "nano banana" models. Unified
// registry (spec MODEL-FALLBACK §2.3): the `pro`/`flash` tiers REFERENCE
// `[models.*]` blocks by name — each carrying `endpoint` (the Gemini API root;
// the tool appends `/v1beta/models/<id>:generateContent`), `id` (wire model),
// `api_key`, `cost` (incl. the optional flat `per_image`), and any `fallback`
// chain. `base_url`/`api_key`/`costs` are gone (moved onto the referenced models).
const ImageGenSchema = StrictObject({
  models: StrictObject({
    pro: Type.String({ minLength: 1 }),
    flash: Type.String({ minLength: 1 }),
  }),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  // Gemini emits the image as output tokens; this must be high or generation is
  // truncated before any image is produced (see src/tools/image-gen.ts).
  max_output_tokens: Type.Optional(Type.Number({ minimum: 256 })),
  output_subdir: Type.Optional(Type.String()),
});

// X.com search via Grok-as-subagent (ARCHITECTURE.md §10).
// Routes through OpenRouter via the LLM gateway — `base_url` is the OpenRouter API root
// (the tool appends `/chat/completions`), `api_key` is sent as
// `Authorization: Bearer` (the field name matches the secret regex, so it
// auto-registers for log redaction). Reuses the existing `${OPENROUTER_BASE_URL}`
// + `${LLM_API_KEY}` — no new credential, no new egress host. Hydration +
// captioning reuse the shared FxTwitter client + the image caption model.
const XSearchSchema = StrictObject({
  // false → x_search is not registered. Defaults to true when the block exists.
  enabled: Type.Optional(Type.Boolean()),
  // Unified registry (spec MODEL-FALLBACK §2.3): the fast/deep tiers REFERENCE
  // `[models.*]` blocks by name (each carrying endpoint/id/api_key/cost +
  // optional `fallback` chain). `base_url`/`api_key`/`cost` are gone — they live
  // on the referenced model. `model` (fast tier) is required when the block
  // exists; `deep_model` defaults to `model`.
  model: Type.String({ minLength: 1 }),
  deep_model: Type.Optional(Type.String({ minLength: 1 })),
  // Wall-clock bound on the Grok reasoning search (slow); graceful timeout.
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  // Short-TTL cache of the (expensive) Grok synthesis; 0 disables caching.
  cache_ttl_minutes: Type.Optional(Type.Number({ minimum: 0 })),
  // How many cited tweets to re-fetch verbatim via FxTwitter by default, and the
  // hard cap the `hydrate` parameter is clamped to.
  hydrate_default: Type.Optional(Type.Integer({ minimum: 0 })),
  hydrate_max: Type.Optional(Type.Integer({ minimum: 0 })),
  // Images auto-captioned inline across the hydrated tweets; rest → media tool.
  caption_top: Type.Optional(Type.Integer({ minimum: 0 })),
  // Per-source verbatim text window (chars) in the Sources block.
  source_text_chars: Type.Optional(Type.Integer({ minimum: 1 })),
  // Grok's own inline vision over cited media (cheap; on by default).
  enable_image_understanding: Type.Optional(Type.Boolean()),
  enable_video_understanding: Type.Optional(Type.Boolean()),
  // Overridable subagent scaffold (forces a live cited search; §4.2).
  system_prompt: Type.Optional(Type.String({ minLength: 1 })),
  // Pricing now lives on the referenced `[models.*]` block's `cost` (spec
  // MODEL-FALLBACK §2.3) — the old inline `[x_search.cost]` is gone.
});

// Reverse-image source lookup via SauceNAO (spec SAUCENAO-SOURCE-LOOKUP; backs
// the `find_source` tool). Opt-in (`enabled`, default false). `api_key` is a
// per-account SauceNAO key; the field name matches the secret regex so it
// auto-registers for log redaction. It is OPTIONAL in the schema (so a disabled
// block needn't ship a `${SAUCENAO_API_KEY}` template that would fail startup
// when the env var is unset); the `enabled => api_key` invariant is enforced as
// a cross-field check in app.ts (per the proactive-posting precedent).
const SauceNaoSchema = StrictObject({
  enabled: Type.Optional(Type.Boolean()),
  api_key: Type.Optional(Type.String({ minLength: 1 })),
  base_url: Type.Optional(Type.String({ minLength: 1 })), // default https://saucenao.com
  numres: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  max_results_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
  min_similarity: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  db: Type.Optional(Type.Integer({ minimum: 0 })), // default 999 (all indexes)
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  max_image_bytes: Type.Optional(Type.Integer({ minimum: 1 })), // upload conditioning cap
  view_max_blocks: Type.Optional(Type.Integer({ minimum: 1 })),
  // In-memory short-window guard for SauceNAO's per-account quota (§4). The long/
  // daily window is surfaced from SauceNAO's own counters, not enforced here.
  rate_limit: Type.Optional(
    StrictObject({
      short_window_max: Type.Optional(Type.Integer({ minimum: 1 })),
      short_window_ms: Type.Optional(Type.Number({ minimum: 1000 })),
      max_wait_ms: Type.Optional(Type.Number({ minimum: 0 })),
    }),
  ),
});

// One LLM rate-limit group = one shared upstream budget (spec §9.2). There is one
// `default` group and everything lands in it unless a model opts into another via
// `rate_limit_group`; extra groups exist only for genuinely separate budgets.
// `max_in_flight` is the only lever (shallow upstream queue → effective priority);
// there is deliberately NO `max_rpm` (§5.1) — the upstream-hard-limit case is
// handled reactively by the unconditional 429/503 backoff (§5.3), which these
// backoff knobs only tune, never enable/disable.
const LlmRateLimitGroupSchema = StrictObject({
  max_in_flight: Type.Optional(Type.Number({ minimum: 1 })),
  // minimum:1 (not 0): backoff is the unconditional §5.3 invariant — a 0 base/max
  // would compute a 0 window for every throttle, disabling it via config.
  backoff_base_ms: Type.Optional(Type.Number({ minimum: 1 })),
  backoff_max_ms: Type.Optional(Type.Number({ minimum: 1 })),
});

// Rate limiting (spec CONCURRENCY-AND-RATE-LIMITING §5/§8/§9). Two independent
// subsystems: the per-host HTTP egress limiter (`[rate_limits.http]`, Design D)
// and the LLM request scheduler's group declarations (`[rate_limits.llm.*]`,
// Design A — src/agent/scheduler.ts).
const RateLimitsSchema = StrictObject({
  // LLM rate-limit groups, keyed by group name (§9.2). Declaring `default` tunes
  // the built-in group; other names become available to `rate_limit_group`.
  llm: Type.Optional(Type.Record(Type.String(), LlmRateLimitGroupSchema)),
  // Per-host HTTP egress limiting, enforced at the `guardedFetch` chokepoint
  // (src/tools/http-limiter.ts). State is keyed per host and shared across callers.
  http: Type.Optional(StrictObject({
    // Generous per-host admission cap (NOT a cross-domain cap). The old
    // `enrichment.fetch_concurrency` cross-domain cap of 6 is removed.
    default_max_in_flight_per_host: Type.Optional(Type.Number({ minimum: 1 })),
    // Optional pure degenerate backstop across all hosts; set far above normal load.
    global_ceiling_max_in_flight: Type.Optional(Type.Number({ minimum: 1 })),
    // 429/503 + Retry-After backoff is always on (§5.3); these only tune it.
    // minimum:1 (and floored in configureHttpLimiter): a 0 base/max would compute
    // a 0 window for every throttle, disabling the invariant via config.
    backoff_base_ms: Type.Optional(Type.Number({ minimum: 1 })),
    backoff_max_ms: Type.Optional(Type.Number({ minimum: 1 })),
    // Optional per-host concurrency overrides, keyed by lowercase hostname.
    per_host_max_in_flight: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 1 }))),
  })),
});

// Recovery — request-level resilience (spec LLM-FAILURE-HANDLING §4–§6/§10).
const RecoverySchema = StrictObject({
  // Layer 0 — transparent per-request retry for environmental LLM failures
  // (network/stream reset, timeout, 5xx, 429, mid-stream deaths). Re-issues the
  // exact same request before the run is allowed to fail; the attempt budget is
  // wall-clock (below), not a count. See src/agent/request-retry.ts.
  // Local inter-attempt backoff, applied only while the model is healthy and
  // the group unthrottled (the admission queue is the wait point otherwise).
  llm_request_backoff_base_ms: Type.Optional(Type.Number({ minimum: 0 })),
  llm_request_backoff_max_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Interactive-class wall-clock retry budget (spec §6): live chat + proactive
  // requests keep retrying within this window, then the session parks
  // `failed-resumable` for manual console resume. Background-class work
  // (summaries/diaries) is deliberately unbounded — it waits out any outage.
  llm_request_max_wait_ms: Type.Optional(Type.Number({ minimum: 1 })),
  // Per-model health (spec §5): consecutive environmental failures before the
  // model turns unhealthy (half-open admission).
  llm_unhealthy_threshold: Type.Optional(Type.Number({ minimum: 1 })),
  // Probe cadence while unhealthy — a per-episode CAPPED EXPONENTIAL BACKOFF
  // (spec MODEL-FALLBACK §4.1, REPLACING the old fixed `llm_probe_interval_ms`).
  // First probe fires `..._base_ms` after turning unhealthy (aggressive, to catch
  // a quick recovery while work rides the fallback), doubling on each failed probe
  // up to `..._max_ms`, reset to base on recovery. A model can pin a tighter cap
  // via its own `models.*.llm_probe_backoff_max_ms`.
  llm_probe_backoff_base_ms: Type.Optional(Type.Number({ minimum: 1 })),
  llm_probe_backoff_max_ms: Type.Optional(Type.Number({ minimum: 1 })),
  // User-facing failure notice (spec §8.3): when non-empty, sent verbatim to
  // the session's room when a USER-TRIGGERED chat session stops trying on its
  // own (parked failed-resumable, or its build timed out waiting on summary
  // coverage). Static phrase only — the actual error is never included.
  // Empty/absent = today's silence. Suppressed for proactive and synthetic
  // sessions.
  failure_notice: Type.Optional(Type.String()),
});

// Period cost-limit rule (spec USAGE-COST-LIMITS §5.1). A centralized array of
// own-scope rules; each declares a USD cap over a window and an optional selector
// (which spend it covers). Selector dimensions AND together, OR within a list; an
// omitted dimension is a wildcard; no dimensions = global. TypeBox covers
// shape/bounds — cross-field semantics (name uniqueness, valid IANA tz, parseable
// duration, message applicability) are validated fail-fast in app.ts (§5.2).
const LimitWindowSchema = Type.Union([
  StrictObject({
    type: Type.Literal("rolling"),
    // Trailing-window length, e.g. "24h", "7d", "30d" (parsed in app.ts).
    duration: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    type: Type.Literal("calendar"),
    period: Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month")]),
    // IANA zone the boundary is computed in. Optional — defaults to
    // `agent.timezone` (then "UTC") at normalization.
    tz: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);

const LimitRuleSchema = StrictObject({
  name: Type.String({ minLength: 1 }),
  max_usd: Type.Number({ minimum: 0 }),
  window: LimitWindowSchema,
  // Selector dimensions — all optional. Omitted = wildcard.
  classes: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("agent_loop"),
        Type.Literal("tool"),
        Type.Literal("caption"),
        Type.Literal("embedding"),
      ]),
    ),
  ),
  session_types: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  models: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  // Posted as a timeline reply when a human trigger is refused by this rule
  // (global-rule-typical). `{resets_at}` is templated. Omit to refuse silently.
  trigger_rejection_message: Type.Optional(Type.String()),
  // Agent/account scope (spec MULTI-AGENT-SUPPORT §8): when set, the rule counts
  // only events attributable to the named agent or account. Agents mode only —
  // a startup error in legacy mode (same policy as `[accounts.*].agent`).
  // Only one of `agent`/`account` may be set on a given rule.
  agent: Type.Optional(Type.String({ minLength: 1 })),
  account: Type.Optional(Type.String({ minLength: 1 })),
});

// Per-user cost limits & model selection (spec PER-USER-LIMITS). A SEPARATE
// mechanism from `[[limits]]` above: partitioned per-user (or per shared-pool)
// counters + a per-field cascade + a per-attempt model selection/degradation
// action, gating ONLY the human-triggered agent loop. TypeBox covers shape;
// cross-field semantics (cascade coherence, partition templates, sub-cap ⊆ models,
// space=Phase-2 fatal, single shared pool per rule) live in `normalizeUserLimits`
// (src/budget/normalize-user-limits.ts), invoked fail-fast from app.ts (§9).

// A match dimension (`user`/`room`/`space`): a single glob/exact string OR a list
// of them (OR within the dimension); omitted = wildcard (spec §8.1).
const UserLimitMatchSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Array(Type.String({ minLength: 1 })),
]);

// One budget constraint inside a rule's `limits` set (spec §3.1/§3.5), ANDed with
// the others. No `models` = the fungible total; `models = [...]` = a sub-cap that
// only carves the total. `partition` is a template rendered from the trigger ctx
// (default `{user_id}`); a value shared across users makes it a shared pool (§3.5).
const UserLimitConstraintSchema = StrictObject({
  max_usd: Type.Number({ minimum: 0 }),
  window: LimitWindowSchema,
  models: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  partition: Type.Optional(Type.String()),
});

const UserLimitRuleSchema = StrictObject({
  // Match dimensions — single glob/exact or a list (any matches); omit = wildcard.
  // `space` matching is implemented (§11, schema v32): a rule may scope by Matrix
  // space and `space` is accepted (no longer a normalizer fatal).
  user: Type.Optional(UserLimitMatchSchema),
  room: Type.Optional(UserLimitMatchSchema),
  space: Type.Optional(UserLimitMatchSchema),
  // Ordered preference set (registry block names; virtual or real, incl. upgrades),
  // most-preferred first — the selection/degradation order (§4). Omit = the
  // session-type default model (today's behavior: a cap on the default, no selection).
  models: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  // The constraint set (ANDed), each counter keyed by its `partition` (§3.5).
  limits: Type.Optional(Type.Array(UserLimitConstraintSchema)),
  // Shorthand (§3.4): a top-level `max_usd` (+ optional `window`) the normalizer
  // expands into a single fungible-total constraint. `max_usd` is `Type.Number()`
  // with NO minimum (unlike §8e) — `0` = ban, `< 0` = exempt (no constraint emitted).
  max_usd: Type.Optional(Type.Number()),
  window: Type.Optional(LimitWindowSchema),
  // Templated refusal (§12); cascades INDEPENDENTLY of the model-budget block.
  trigger_rejection_message: Type.Optional(Type.String()),
  // Agent/account scope (spec MULTI-AGENT-SUPPORT §8): same semantics as
  // [[limits]].agent/account — counts only events from the named agent/account.
  agent: Type.Optional(Type.String({ minLength: 1 })),
  account: Type.Optional(Type.String({ minLength: 1 })),
});

// Pluggable tokenizer (spec/TOKENIZER-SWAP.md §5.4). Per-consumer selection: the
// `primary` tokenizer measures everything that bounds what we send the chat model
// (context tiers, summarization, diary, auto-retrieval, search coverage); the
// `retrieval` tokenizer is the memory chunker's, which must match the EMBEDDER, not
// the chat model (switching `primary` must not perturb chunk boundaries/hashes/
// embeddings). Both default to `gpt-tokenizer` (the shipped default + always-on
// fallback). When either is `glm`, `glm_tokenizer_path` is required and readable —
// a cross-field check in app.ts (TypeBox can't express it) fail-fasts otherwise.
const TokenizerKindSchema = Type.Union([Type.Literal("gpt-tokenizer"), Type.Literal("glm")]);
const TokenizerSchema = StrictObject({
  primary: Type.Optional(TokenizerKindSchema),
  retrieval: Type.Optional(TokenizerKindSchema),
  // Path to the GLM `tokenizer.json` (Hugging Face format). Required when either
  // selection is `glm`; loaded once at startup by the native tokenizer.
  glm_tokenizer_path: Type.Optional(Type.String({ minLength: 1 })),
});

// Tool-result context budget (spec TOOL-RESULT-BUDGET). Generic result-shaping
// layer applied at the per-session tool-assembly seam (buildSessionTools).
// Two layers guard against unbounded tool results:
//   Layer 1 — per-result cap: individual results whose text tokens exceed
//     result_max_tokens are truncated. 0 = disabled.
//   Layer 2 — per-turn aggregate clamp: the sum of a turn's result tokens may
//     not exceed (servingWindow − runningContext − result_reserve_tokens).
//     result_min_tokens is the floor each result keeps regardless of the
//     accumulator, so even a late result in an over-budget batch stays useful.
// All three ship in 00-defaults.toml (defaults ON — owner sign-off §2).
const AgentToolsSchema = StrictObject({
  // Layer 1 per-result cap. Any individual result whose estimated text-token
  // count exceeds this is truncated with a visible marker. 0 = disabled.
  result_max_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  // Layer 2 headroom the turn budget must always hold back — covers the next
  // request's output (max_tokens) plus room for subsequent turns.
  result_reserve_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
  // Layer 2 per-result floor: minimum allowance kept for any single result
  // regardless of how much the turn accumulator has consumed. Must be ≥ 1
  // (a floor of 0 would defeat the purpose of keeping a useful head).
  result_min_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
});

// Message-only history backfetch (spec MESSAGE-BACKFETCH §9; ARCHITECTURE.md §7d).
// Console/operator-triggered jobs that page a room's history BELOW its context
// floor into the search-only region (indexed + enriched, never summarized/diaried/
// embedded/rendered). Master switch off by default; per-job targets carry their own
// caps, these are the engine-wide knobs + per-job defaults.
const BackfetchSchema = StrictObject({
  // Master switch. Off ⇒ startJob/resume are no-ops and the console surface is inert.
  enabled: Type.Optional(Type.Boolean()),
  // /messages page size (clamped 1–1000 by the engine). Default 100.
  page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
  // Pause paging while this many backfetched rows await enrichment, so a single job
  // can't flood the pool (§6.4). 0 ⇒ no backlog pause. Default 500.
  max_backlog: Type.Optional(Type.Number({ minimum: 0 })),
  // Optional throttle between pages (ms). 0 ⇒ no throttle (default).
  page_min_interval_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Default max stored per job for an unbounded ('beginning') target. A hit parks
  // the job 'paused' (resumable). 0 ⇒ unbounded (default).
  default_safety_cap: Type.Optional(Type.Number({ minimum: 0 })),
  // Default per-run wall-clock budget (ms); a hit parks 'paused'. 0 ⇒ none (default).
  default_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
  // Consecutive-UTD halt for the 'oldest_decryptable' target. 0 disables. Default 50.
  utd_halt_threshold: Type.Optional(Type.Number({ minimum: 0 })),
  // Default value of a new job's caption_after toggle. NEVER makes the live claimer
  // pick up deferred rows — only drives the post-fetch promote (§7.3). Default false.
  caption_backfetched: Type.Optional(Type.Boolean()),
});

export const AppConfigSchema = StrictObject({
  app: StrictObject({
    name: Type.String(),
    data_dir: Type.String(),
    log_level: Type.Union([
      Type.Literal("debug"),
      Type.Literal("info"),
      Type.Literal("warn"),
      Type.Literal("error"),
    ]),
    context_dump_dir: Type.String(),
  }),
  // Capability feature gates (off by default). When a feature is off, its tools are
  // not available to the agent in any session type; see FeaturesSchema above.
  features: Type.Optional(FeaturesSchema),
  agent: StrictObject({
    sessions: StrictObject({
      max_concurrent: Type.Number({ minimum: 1 }),
      max_concurrent_dm: Type.Number({ minimum: 1 }),
      max_queued_per_timeline: Type.Optional(Type.Number({ minimum: 1 })),
      forced_completion_retries: Type.Number({ minimum: 0 }),
      // Co-target coalescing window (spec DUPLICATE-REPLY-MITIGATION §8): the max
      // age difference between a new reply and a running session's trigger for the
      // two to coalesce (both replied to the SAME message → the second is steered
      // into the first as a co-reply interjection instead of spawning a twin).
      // Short by chat standards (a minute) so only near-simultaneous reactions to
      // the same beat merge. Unset → no coalescing.
      coalesce_window_ms: Type.Optional(Type.Number({ minimum: 0 })),
      // Optional hard cap on tool-call iterations within a single session run.
      // Left unset by default → agent work is unbounded (the loop runs as long as
      // the model emits tool calls). Set a number only if you want a guardrail.
      max_tool_calls: Type.Optional(Type.Number({ minimum: 1 })),
      // Resumable sessions (spec RESUMABLE-SESSIONS §14): reply-to-continue. Off
      // by default per context; the whole block is optional so omitting it leaves
      // resume off. Cross-field validation in app.ts.
      resume: Type.Optional(ResumeSchema),
      // Follow-up folding (spec FOLLOWUP-FOLDING §9): fold quick same-sender
      // follow-ups (media/text/re-`@`) into the prior triggering message's session.
      // Whole block optional; omitting it leaves folding off. Cross-field checks
      // (per-lever user_gap_ms ≤ wall_clock_ms) in app.ts.
      followup: Type.Optional(FollowUpSchema),
    }),
    system: StrictObject({
      fallback_prompt: Type.Optional(Type.String()),
    }),
    session_types: Type.Optional(Type.Record(Type.String(), SessionTypeSchema)),
    // Global per-session-run USD cost ceiling (spec SESSION-COST-LIMITS §3),
    // applied to every session unless a session type overrides it via
    // `session_types.*.max_session_cost_usd`. Counts agent-loop cost +
    // tool-use cost (captioning excluded). Unset = unlimited.
    max_session_cost_usd: Type.Optional(Type.Number({ minimum: 0 })),
    // Fraction of the resolved cost ceiling at which a one-shot, agent-visible
    // budget interjection fires (spec SESSION-COST-LIMITS §2.1). Strictly in
    // (0,1); defaults to 0.8 (00-defaults.toml). Ignored when no ceiling resolves.
    cost_warn_fraction: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 })),
    // Per-user limits (spec PER-USER-LIMITS §5.3 / §16 Q1): the minimum affordable
    // OUTPUT tokens below which a model is judged unable to complete a turn within
    // the user's remaining budget — so it is skipped and selection degrades to the
    // next preference (the `viable_min` floor). Larger = degrade earlier (avoid
    // near-useless premium turns); smaller = squeeze the premium model to the last
    // cent. Defaults to 256 (00-defaults.toml). Only consulted when `[[user_limits]]`
    // is active.
    user_limit_min_output_tokens: Type.Optional(Type.Number({ minimum: 1 })),
    disabled_tools: Type.Optional(Type.Array(Type.String())),
    // Named IANA time zone (e.g. "UTC", "America/New_York", "Asia/Tokyo"). All
    // timestamps the agent can see are rendered in this zone; the server's real
    // zone is never exposed. Defaults to "UTC" (00-defaults.toml). Validated as a
    // real named zone at load time — bare numeric offsets like "+09:00" are
    // rejected (see configureAgentTimezone in src/time).
    timezone: Type.Optional(Type.String({ minLength: 1 })),
    // Tool-result context budget (spec TOOL-RESULT-BUDGET §7). All three knobs
    // ship in 00-defaults.toml; see AgentToolsSchema above for per-key docs.
    tools: Type.Optional(AgentToolsSchema),
  }),
  // NOT StrictObject: `models` is a dictionary (arbitrary model names) with a
  // required `default` entry. A strict `{ default }` arm would reject every
  // other model name at the intersect level; the Record arm validates all
  // values (including `default`) against the strict ModelSchema, so unknown
  // keys INSIDE a model block still fail.
  models: Type.Intersect([
    Type.Object({ default: ModelSchema }),
    Type.Record(Type.String(), ModelSchema),
  ]),
  context: StrictObject({
    tiers: StrictObject({
      rich_target_tokens: Type.Number({ minimum: 1 }),
      rich_max_tokens: Type.Number({ minimum: 1 }),
      compact_target_tokens: Type.Number({ minimum: 1 }),
      compact_max_tokens: Type.Number({ minimum: 1 }),
    }),
  }),
  // Pluggable tokenizer (spec/TOKENIZER-SWAP.md §5.4). Optional so existing configs
  // stay valid; unset = `gpt-tokenizer` everywhere (behaviour-identical default).
  tokenizer: Type.Optional(TokenizerSchema),
  media: Type.Optional(MediaSchema),
  storage: StrictObject({
    database_path: Type.String(),
  }),
  /**
   * Legacy single-agent workspace. When `[agents]` is present, `root_dir` is a
   * startup error (mutually exclusive). When absent, the code default
   * `"./workspaces/miku"` is used (spec MULTI-AGENT-SUPPORT §4.2).
   */
  workspace: Type.Optional(StrictObject({
    root_dir: Type.Optional(Type.String()),
  })),
  /**
   * Per-agent identity blocks (spec MULTI-AGENT-SUPPORT §4.1). When present,
   * every account's `agent` field (defaulting to the account key) must match a
   * declared entry, and workspace roots must be pairwise disjoint.
   * Mutually exclusive with `[workspace].root_dir`.
   */
  agents: Type.Optional(Type.Record(Type.String(), AgentBlockSchema)),
  /**
   * Sibling-reply suppression (spec MULTI-AGENT-SUPPORT §9). Controls whether
   * one in-process bot account can trigger another. Default: never trigger.
   */
  siblings: Type.Optional(SiblingsSchema),
  // Docker sandbox: when enabled, shell-shaped tool calls (the `bash` tool and
  // `search_files`/ripgrep) execute inside a long-lived container whose
  // /workspace is the bind-mounted workspace root. Pure byte I/O and image
  // tools stay in-process on the same bind-mounted files. See ARCHITECTURE.md §11a.
  // Optional so existing configs stay valid; when enabled, startup fails fast if
  // Docker/the image/the container are unavailable.
  // In agents mode (§10): acts as the shared-mode sandbox for agents without a
  // per-agent [agents.<name>.sandbox] block. Uses SandboxBlockSchema (same shape).
  sandbox: Type.Optional(SandboxBlockSchema),
  matrix: StrictObject({
    enabled: Type.Boolean(),
    trigger_hold_ms: Type.Number({ minimum: 0 }),
    trigger_group_lookback_ms: Type.Optional(Type.Number({ minimum: 0 })),
    accounts: Type.Record(Type.String(), MatrixAccountSchema),
  }),
  /** Discord provider config. Validated at startup; consumed when enabled (Phase 3+). */
  discord: Type.Optional(DiscordSchema),
  timeline: Type.Optional(TimelineSchema),
  mcp: Type.Optional(McpSchema),
  enrichment: Type.Optional(EnrichmentSchema),
  fxtwitter: Type.Optional(FxTwitterSchema),
  captioning: Type.Optional(CaptioningSchema),
  summarization: Type.Optional(SummarizationSchema),
  diary: Type.Optional(DiarySchema),
  retrieval: Type.Optional(RetrievalSchema),
  search: Type.Optional(SearchSchema),
  reactions: Type.Optional(ReactionsSchema),
  proactive: Type.Optional(ProactiveSchema),
  backfetch: Type.Optional(BackfetchSchema),
  character_card: Type.Optional(StrictObject({
    output_subdir: Type.Optional(Type.String()),
    export_subdir: Type.Optional(Type.String()),
    default_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    max_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    max_summary_entries: Type.Optional(Type.Number({ minimum: 1 })),
  })),
  user_profiles: Type.Optional(StrictObject({
    root_dir: Type.Optional(Type.String()),
    default_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    max_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    // When false, `user_profile_read`/`user_profile_edit` reject explicit
    // targets that don't match the trigger sender's (provider, sender_id).
    // Defaults to true to preserve the previous behavior where the agent can
    // record notes about other room members on the requester's behalf.
    allow_cross_user_targets: Type.Optional(Type.Boolean()),
  })),
  danbooru: Type.Optional(StrictObject({
    base_url: Type.Optional(Type.String()),
    login: Type.Optional(Type.String()),
    api_key: Type.Optional(Type.String()),
    max_regular_tags: Type.Optional(Type.Number({ minimum: 1 })),
    default_limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
    default_order: Type.Optional(Type.String()),
    download_subdir: Type.Optional(Type.String()),
    // In-tool rate limiter (spec Design D §8.2): paces the JSON API + asset CDN as
    // one account-level budget. Defaults: 500 ms between starts, 2 in flight.
    min_request_interval_ms: Type.Optional(Type.Number({ minimum: 0 })),
    max_in_flight: Type.Optional(Type.Number({ minimum: 1 })),
    // Tag-suggestion ("did you mean") support. When `suggest_on_empty` is true
    // (default), a search that returns zero posts resolves each supplied
    // includeTag through Danbooru's autocomplete + tag-wildcard endpoints and
    // appends real, similar tag names to the result — the agent's recovery hint
    // when it guessed a tag that does not exist. The same resolver backs the
    // explicit `action: "tags"` lookup. `max_suggestions` caps how many
    // candidates each lookup returns (default 6).
    suggest_on_empty: Type.Optional(Type.Boolean()),
    max_suggestions: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
  })),
  network: Type.Optional(StrictObject({
    http_proxy_url: Type.Optional(Type.String()),
    // App-layer SSRF guard (defense-in-depth). When true (default), outbound
    // fetches from caller-supplied URLs resolve DNS and reject private/loopback/
    // link-local/metadata addresses, re-validating every redirect hop. Set false
    // only where the container/network firewall already blocks private egress
    // (see docker/95-docker.toml + docker/egress-rules.sh).
    ssrf_guard: Type.Optional(Type.Boolean()),
  })),
  image_gen: Type.Optional(ImageGenSchema),
  x_search: Type.Optional(XSearchSchema),
  saucenao: Type.Optional(SauceNaoSchema),
  observability: Type.Optional(ObservabilitySchema),
  browser: Type.Optional(BrowserSchema),
  recovery: Type.Optional(RecoverySchema),
  rate_limits: Type.Optional(RateLimitsSchema),
  // Period cost limits (spec USAGE-COST-LIMITS §5): a centralized array of
  // own-scope budget rules enforced across the app by the BudgetEngine. Unset/
  // empty = no period limits (the §8d per-run ceiling is orthogonal, unchanged).
  limits: Type.Optional(Type.Array(LimitRuleSchema)),
  // Per-user cost limits & model selection (spec PER-USER-LIMITS): partitioned
  // per-user / shared-pool budgets + per-attempt model selection/degradation, for
  // the HUMAN-triggered agent loop only. Unset/empty = feature off (zero behavior
  // change). Ordered: precedence is authored order (CSS-style cascade, §8.1).
  user_limits: Type.Optional(Type.Array(UserLimitRuleSchema)),
  // Content-addressed attachment store (spec MULTI-AGENT-SUPPORT §11.5 / §13 Phase 5d).
  // Default-off: absent block (or enabled = false) → byte-identical behaviour, no probe,
  // no extra I/O. When enabled, the store must share a filesystem with every workspace
  // root (validated at startup via a cross-device link() probe).
  attachment_store: Type.Optional(AttachmentStoreSchema),
});

export type AppConfig = Static<typeof AppConfigSchema>;
export type SummarizationConfig = Static<typeof SummarizationSchema>;
export type DiaryConfig = Static<typeof DiarySchema>;
export type RetrievalConfig = Static<typeof RetrievalSchema>;
export type SearchConfig = Static<typeof SearchSchema>;
export type ReactionsConfig = Static<typeof ReactionsSchema>;
export type ImageGenConfig = Static<typeof ImageGenSchema>;
export type XSearchConfig = Static<typeof XSearchSchema>;
export type SauceNaoConfig = Static<typeof SauceNaoSchema>;
export type BackfetchConfig = Static<typeof BackfetchSchema>;
export type TokenizerConfig = Static<typeof TokenizerSchema>;
export type FxTwitterRawConfig = Static<typeof FxTwitterSchema>;
export type ProactiveConfig = Static<typeof ProactiveSchema>;
export type ProactiveChannelConfig = Static<typeof ProactiveChannelSchema>;
/** Per-agent workspace config (spec MULTI-AGENT-SUPPORT §4.1, §10, §10a). */
export type AgentBlockConfig = Static<typeof AgentBlockSchema>;
/** Sandbox subsystem config block (spec MULTI-AGENT-SUPPORT §10). */
export type SandboxBlockConfig = Static<typeof SandboxBlockSchema>;
/** Per-agent browser profile config (spec MULTI-AGENT-SUPPORT §10a). */
export type AgentBrowserBlockConfig = NonNullable<AgentBlockConfig["browser"]>;
/** Sibling-reply suppression config (spec MULTI-AGENT-SUPPORT §9). */
export type SiblingsConfig = Static<typeof SiblingsSchema>;
/** Content-addressed attachment store config (spec MULTI-AGENT-SUPPORT §11.5 / Phase 5d). */
export type AttachmentStoreConfig = Static<typeof AttachmentStoreSchema>;
/** Tool-result context budget config (spec TOOL-RESULT-BUDGET §7). */
export type AgentToolsConfig = Static<typeof AgentToolsSchema>;
