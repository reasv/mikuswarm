import { Type, type Static } from "@sinclair/typebox";

const SessionTypeSchema = Type.Object({
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
  // Per-session-type runaway loop-breakers (ARCHITECTURE.md §9c, §4). When set,
  // they override the global `agent.sessions.max_tool_calls` for sessions of this
  // type and add a turn-count cap. NOT a wall-clock timeout — purely a guard
  // against a degenerate loop. Worker session types (summarize/condense/diary)
  // set these to sane defaults; chat sessions leave them unset (unbounded, falling
  // back to the global cap).
  max_tool_calls: Type.Optional(Type.Integer({ minimum: 1 })),
  max_turns: Type.Optional(Type.Integer({ minimum: 1 })),
});

const DiarySchema = Type.Object({
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

const SummarizationSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  worker_count: Type.Optional(Type.Integer({ minimum: 1 })),
  generation_threshold_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  leaf_input_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  leaf_target_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  condense_fanout: Type.Optional(Type.Integer({ minimum: 2 })),
  condense_target_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
  summary_max_overage_factor: Type.Optional(Type.Number({ minimum: 1 })),
  summary_wait_timeout_ms: Type.Optional(Type.Integer({ minimum: 0 })),
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
const SearchSchema = Type.Object({
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
    Type.Object({
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
const ReactionsSchema = Type.Object({
  // Master switch: persist inbound reactions AND surface them in context.
  enabled: Type.Optional(Type.Boolean()),
  // View A: deduped key×count on rich-tier messages.
  show_aggregates: Type.Optional(Type.Boolean()),
  // View B: chronological discrete reaction lines.
  show_discrete: Type.Optional(Type.Boolean()),
  // View B target filter: true = only reactions to the assistant's own messages;
  // false also surfaces reactions to anyone's recent messages.
  discrete_assistant_only: Type.Optional(Type.Boolean()),
  // View B horizon: 0 = the whole rich tier; >0 = only the last N rich messages
  // produce discrete lines. Bounded (mirrors the [search] min/max convention) so a
  // fat-fingered value can't silently degrade.
  discrete_horizon_messages: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })),
  // More than this many senders on one reaction → first 4 + "(and N others)".
  // Minimum 4 (the shown-name count) so "(and N others)" can never go negative.
  discrete_name_cap: Type.Optional(Type.Integer({ minimum: 4, maximum: 1_000 })),
});

// Memory retrieval — hybrid lexical+semantic search over `memory/*.md`, plus
// auto-retrieval injected per trigger (ARCHITECTURE.md §9d). Optional so existing
// configs stay valid; `enabled` is the master switch for the whole index.
const RetrievalEmbeddingRemoteSchema = Type.Object({
  // OpenRouter-compatible embeddings endpoint (§5d). `dim` is REQUIRED when remote
  // is the active provider — it governs the vector index width (§5a/§6).
  id: Type.String({ minLength: 1 }),
  endpoint: Type.String({ minLength: 1 }),
  api_key: Type.String({ minLength: 1 }),
  dim: Type.Integer({ minimum: 1 }),
});

const RetrievalEmbeddingSchema = Type.Object({
  // Active-model resolution (§5a): 'remote' if the [remote] block is set, else the
  // bundled 'local' ONNX model (the zero-config default + safety net).
  provider: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
  local: Type.Optional(
    Type.Object({
      model: Type.Optional(Type.String({ minLength: 1 })),
      dim: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
  remote: Type.Optional(RetrievalEmbeddingRemoteSchema),
});

const RetrievalSchema = Type.Object({
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
    Type.Object({
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
    Type.Object({
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
    Type.Object({
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      min_score: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      max_tokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
      dedup_against_recency: Type.Optional(Type.Boolean()),
    }),
  ),
  embedding: Type.Optional(RetrievalEmbeddingSchema),
});

// Proactive posting (ARCHITECTURE.md §9g). Opt-in only: inert unless `enabled =
// true` AND at least one channel is listed. Global fields are defaults overridable
// per channel (effective value = channel ?? global ?? hardcoded default).
const ProactiveActiveHoursSchema = Type.Object({
  // Local hours (agent.timezone). Posting is only scheduled within [start, end).
  // Wraps past midnight when end <= start (e.g. start=9, end=1 → 09:00–01:00).
  start: Type.Integer({ minimum: 0, maximum: 23 }),
  end: Type.Integer({ minimum: 0, maximum: 23 }),
});

const ProactiveChannelSchema = Type.Object({
  timeline_key: Type.String({ minLength: 1 }), // required; exact match
  daily_posts: Type.Optional(Type.Integer({ minimum: 0 })),
  min_user_messages: Type.Optional(Type.Integer({ minimum: 0 })),
  dead_channel_backstop_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  min_gap_ms: Type.Optional(Type.Integer({ minimum: 0 })),
  active_hours: Type.Optional(ProactiveActiveHoursSchema),
});

const ProactiveSchema = Type.Object({
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

const TimelineSchema = Type.Object({
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
});

const ModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  endpoint: Type.String(),
  api_key: Type.String(),
  multimodal: Type.Boolean(),
  max_tokens: Type.Number({ minimum: 1 }),
  reasoning: Type.Optional(Type.Boolean()),
  context_window: Type.Optional(Type.Number({ minimum: 1 })),
  // Cap on the base64-encoded image payload shipped to the provider, NOT raw
  // file bytes. Raw bytes inflate ~4/3 in base64 (formula
  // `4 * ceil(rawBytes / 3)`). Used by `read_image` and by the danbooru
  // `preview` action's inline emission. Anthropic's per-image inline cap is
  // 5 MB base64 — values up to that ceiling are safe.
  image_input_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  cost: Type.Optional(Type.Object({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cache_read: Type.Number({ minimum: 0 }),
    cache_write: Type.Number({ minimum: 0 }),
  })),
  streaming: Type.Optional(Type.Boolean()),
  compat: Type.Optional(Type.Object({
    supports_cache_control_on_tools: Type.Optional(Type.Boolean()),
    supports_long_cache_retention: Type.Optional(Type.Boolean()),
    supports_eager_tool_input_streaming: Type.Optional(Type.Boolean()),
    send_session_affinity_headers: Type.Optional(Type.Boolean()),
  })),
});

const MatrixAccountSchema = Type.Object({
  homeserver: Type.String(),
  access_token: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),
  recovery_key: Type.Optional(Type.String()),
  user_id: Type.String(),
  device_id: Type.Optional(Type.String()),
  store_path: Type.String(),
});

const MediaImageSchema = Type.Object({
  max_total_pixels: Type.Optional(Type.Number({ minimum: 1 })),
  max_total_pixels_hard: Type.Optional(Type.Number({ minimum: 1 })),
  min_shortest_side: Type.Optional(Type.Number({ minimum: 1 })),
  max_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  mozjpeg: Type.Optional(Type.Boolean()),
});

const MediaVideoSchema = Type.Object({
  max_resolution: Type.Optional(Type.Number({ minimum: 1 })),
  max_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  max_duration_seconds: Type.Optional(Type.Number({ minimum: 1 })),
  gpu_acceleration: Type.Optional(Type.Boolean()),
  x264_preset: Type.Optional(Type.String()),
  cache_max_bytes: Type.Optional(Type.Number({ minimum: 0 })),
  cache_target_bytes: Type.Optional(Type.Number({ minimum: 0 })),
});

const MediaAudioSchema = Type.Object({
  max_bytes: Type.Optional(Type.Number({ minimum: 1 })),
  max_duration_seconds: Type.Optional(Type.Number({ minimum: 1 })),
});

const MediaSchema = Type.Object({
  download_size_limit: Type.Optional(Type.Number({ minimum: 1 })),
  image: Type.Optional(MediaImageSchema),
  video: Type.Optional(MediaVideoSchema),
  audio: Type.Optional(MediaAudioSchema),
});

const McpServerSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  transport: Type.Optional(Type.Union([
    Type.Literal("streamable-http"),
    Type.Literal("sse"),
  ])),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});

const McpSchema = Type.Object({
  servers: Type.Record(Type.String(), McpServerSchema),
});

const EnrichmentSchema = Type.Object({
  worker_count: Type.Optional(Type.Number({ minimum: 1 })),
  fetch_timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  trigger_wait_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
  max_previews_per_message: Type.Optional(Type.Number({ minimum: 0 })),
  max_retries: Type.Optional(Type.Number({ minimum: 0 })),
});

const CaptioningModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  endpoint: Type.String({ minLength: 1 }),
  api_key: Type.String({ minLength: 1 }),
});

const ModalityConfigSchema = Type.Object({
  prompt: Type.Optional(Type.String()),
  max_chars: Type.Optional(Type.Number({ minimum: 1 })),
  max_tokens: Type.Optional(Type.Number({ minimum: 1 })),
  concurrency: Type.Optional(Type.Number({ minimum: 1 })),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  model: Type.Optional(CaptioningModelSchema),
});

const CaptioningSchema = Type.Object({
  model: Type.Optional(CaptioningModelSchema),
  worker_count: Type.Optional(Type.Number({ minimum: 1 })),
  caption_all: Type.Optional(Type.Boolean()),
  caption_assistant_messages: Type.Optional(Type.Boolean()),
  trigger_wait_timeout_ms: Type.Optional(Type.Number({ minimum: 0 })),
  max_retries: Type.Optional(Type.Number({ minimum: 0 })),
  image: Type.Optional(ModalityConfigSchema),
  video: Type.Optional(ModalityConfigSchema),
  audio: Type.Optional(ModalityConfigSchema),
});

const ObservabilityServerSchema = Type.Object({
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

const ObservabilitySchema = Type.Object({
  server: Type.Optional(ObservabilityServerSchema),
});

export type ObservabilityServerConfig = Static<typeof ObservabilityServerSchema>;

// Browser-use backend (ARCHITECTURE.md browser section; spec/BROWSER-USE.md).
// Off by default; the harness connects to an operator-run CloakBrowser-Manager
// over HTTP and degrades gracefully if it is down (it does NOT manage the
// container). All fields are set explicitly in local config per the
// explicit-deployment-config convention.
const BrowserSchema = Type.Object({
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
  // with auto_launch=true if absent.
  profile_name: Type.String({ minLength: 1 }),
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
});

export type BrowserConfig = Static<typeof BrowserSchema>;

// Image generation/editing via Google's Gemini "nano banana" models. `base_url`
// is the Gemini API endpoint root (the
// tool appends `/v1beta/models/<model>:generateContent`); `api_key` is sent as
// `Authorization: Bearer`. The `api_key` field name matches the secret regex so
// it auto-registers for log redaction.
const ImageGenSchema = Type.Object({
  base_url: Type.String({ minLength: 1 }),
  api_key: Type.String({ minLength: 1 }),
  models: Type.Object({
    pro: Type.String({ minLength: 1 }),
    flash: Type.String({ minLength: 1 }),
  }),
  timeout_ms: Type.Optional(Type.Number({ minimum: 1000 })),
  // Gemini emits the image as output tokens; this must be high or generation is
  // truncated before any image is produced (see src/tools/image-gen.ts).
  max_output_tokens: Type.Optional(Type.Number({ minimum: 256 })),
  output_subdir: Type.Optional(Type.String()),
});

// Rate limiting (spec CONCURRENCY-AND-RATE-LIMITING §8/§9.5). Only the HTTP per-host
// limiter is implemented today; the LLM request scheduler (`[rate_limits.llm.*]`,
// Design A) is not yet built and is therefore absent from the schema until it lands.
const RateLimitsSchema = Type.Object({
  // Per-host HTTP egress limiting, enforced at the `guardedFetch` chokepoint
  // (src/tools/http-limiter.ts). State is keyed per host and shared across callers.
  http: Type.Optional(Type.Object({
    // Generous per-host admission cap (NOT a cross-domain cap). The old
    // `enrichment.fetch_concurrency` cross-domain cap of 6 is removed.
    default_max_in_flight_per_host: Type.Optional(Type.Number({ minimum: 1 })),
    // Optional pure degenerate backstop across all hosts; set far above normal load.
    global_ceiling_max_in_flight: Type.Optional(Type.Number({ minimum: 1 })),
    // 429/503 + Retry-After backoff is always on (§5.3); these only tune it.
    backoff_base_ms: Type.Optional(Type.Number({ minimum: 0 })),
    backoff_max_ms: Type.Optional(Type.Number({ minimum: 0 })),
    // Optional per-host concurrency overrides, keyed by lowercase hostname.
    per_host_max_in_flight: Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 1 }))),
  })),
});

// Recovery — request- and session-level resilience (spec CONCURRENCY-AND-RATE-LIMITING §6/§9.6).
// Only the Layer-1 (transparent request-level retry) knobs are implemented today; the
// Layer-2 session resume-in-place knobs (`session_auto_resume_*`) are NOT yet wired and
// are therefore deliberately absent from the schema until that code lands (per CLAUDE.md:
// config describes only implemented behaviour).
const RecoverySchema = Type.Object({
  // Layer 1 — transparent per-request retry for mechanical LLM failures
  // (network/stream reset, timeout, 5xx, 429). Re-issues the exact same request
  // before the run is allowed to fail. See src/agent/request-retry.ts.
  llm_request_retries: Type.Optional(Type.Number({ minimum: 0 })),
  llm_request_backoff_base_ms: Type.Optional(Type.Number({ minimum: 0 })),
  llm_request_backoff_max_ms: Type.Optional(Type.Number({ minimum: 0 })),
});

export const AppConfigSchema = Type.Object({
  app: Type.Object({
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
  agent: Type.Object({
    sessions: Type.Object({
      max_concurrent: Type.Number({ minimum: 1 }),
      max_concurrent_dm: Type.Number({ minimum: 1 }),
      max_queued_per_timeline: Type.Optional(Type.Number({ minimum: 1 })),
      forced_completion_retries: Type.Number({ minimum: 0 }),
      // Optional hard cap on tool-call iterations within a single session run.
      // Left unset by default → agent work is unbounded (the loop runs as long as
      // the model emits tool calls). Set a number only if you want a guardrail.
      max_tool_calls: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    system: Type.Object({
      fallback_prompt: Type.Optional(Type.String()),
    }),
    session_types: Type.Optional(Type.Record(Type.String(), SessionTypeSchema)),
    disabled_tools: Type.Optional(Type.Array(Type.String())),
    // Named IANA time zone (e.g. "UTC", "America/New_York", "Asia/Tokyo"). All
    // timestamps the agent can see are rendered in this zone; the server's real
    // zone is never exposed. Defaults to "UTC" (00-defaults.toml). Validated as a
    // real named zone at load time — bare numeric offsets like "+09:00" are
    // rejected (see configureAgentTimezone in src/time).
    timezone: Type.Optional(Type.String({ minLength: 1 })),
  }),
  models: Type.Intersect([
    Type.Object({ default: ModelSchema }),
    Type.Record(Type.String(), ModelSchema),
  ]),
  context: Type.Object({
    tiers: Type.Object({
      rich_target_tokens: Type.Number({ minimum: 1 }),
      rich_max_tokens: Type.Number({ minimum: 1 }),
      compact_target_tokens: Type.Number({ minimum: 1 }),
      compact_max_tokens: Type.Number({ minimum: 1 }),
    }),
  }),
  media: Type.Optional(MediaSchema),
  storage: Type.Object({
    database_path: Type.String(),
  }),
  workspace: Type.Object({
    root_dir: Type.String(),
  }),
  // Docker sandbox: when enabled, shell-shaped tool calls (the `bash` tool and
  // `search_files`/ripgrep) execute inside a long-lived container whose
  // /workspace is the bind-mounted workspace root. Pure byte I/O and image
  // tools stay in-process on the same bind-mounted files. See ARCHITECTURE.md §11a.
  // Optional so existing configs stay valid; when enabled, startup fails fast if
  // Docker/the image/the container are unavailable.
  sandbox: Type.Optional(Type.Object({
    enabled: Type.Boolean(),
    image: Type.String(),
    container_name: Type.String(),
    network: Type.String(),
    workspace_mount: Type.String(),
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
  })),
  matrix: Type.Object({
    enabled: Type.Boolean(),
    trigger_hold_ms: Type.Number({ minimum: 0 }),
    trigger_group_lookback_ms: Type.Optional(Type.Number({ minimum: 0 })),
    accounts: Type.Record(Type.String(), MatrixAccountSchema),
  }),
  timeline: Type.Optional(TimelineSchema),
  mcp: Type.Optional(McpSchema),
  enrichment: Type.Optional(EnrichmentSchema),
  captioning: Type.Optional(CaptioningSchema),
  summarization: Type.Optional(SummarizationSchema),
  diary: Type.Optional(DiarySchema),
  retrieval: Type.Optional(RetrievalSchema),
  search: Type.Optional(SearchSchema),
  reactions: Type.Optional(ReactionsSchema),
  proactive: Type.Optional(ProactiveSchema),
  sillytavern: Type.Optional(Type.Object({
    output_subdir: Type.Optional(Type.String()),
    export_subdir: Type.Optional(Type.String()),
    default_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    max_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    max_summary_entries: Type.Optional(Type.Number({ minimum: 1 })),
  })),
  user_profiles: Type.Optional(Type.Object({
    root_dir: Type.Optional(Type.String()),
    default_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    max_excerpt_chars: Type.Optional(Type.Number({ minimum: 256 })),
    // When false, `user_profile_read`/`user_profile_edit` reject explicit
    // targets that don't match the trigger sender's (provider, sender_id).
    // Defaults to true to preserve the previous behavior where the agent can
    // record notes about other room members on the requester's behalf.
    allow_cross_user_targets: Type.Optional(Type.Boolean()),
  })),
  danbooru: Type.Optional(Type.Object({
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
  })),
  network: Type.Optional(Type.Object({
    http_proxy_url: Type.Optional(Type.String()),
    // App-layer SSRF guard (defense-in-depth). When true (default), outbound
    // fetches from caller-supplied URLs resolve DNS and reject private/loopback/
    // link-local/metadata addresses, re-validating every redirect hop. Set false
    // only where the container/network firewall already blocks private egress
    // (see docker/95-docker.toml + docker/egress-rules.sh).
    ssrf_guard: Type.Optional(Type.Boolean()),
  })),
  image_gen: Type.Optional(ImageGenSchema),
  observability: Type.Optional(ObservabilitySchema),
  browser: Type.Optional(BrowserSchema),
  recovery: Type.Optional(RecoverySchema),
  rate_limits: Type.Optional(RateLimitsSchema),
});

export type AppConfig = Static<typeof AppConfigSchema>;
export type SummarizationConfig = Static<typeof SummarizationSchema>;
export type DiaryConfig = Static<typeof DiarySchema>;
export type RetrievalConfig = Static<typeof RetrievalSchema>;
export type SearchConfig = Static<typeof SearchSchema>;
export type ReactionsConfig = Static<typeof ReactionsSchema>;
export type ImageGenConfig = Static<typeof ImageGenSchema>;
export type ProactiveConfig = Static<typeof ProactiveSchema>;
export type ProactiveChannelConfig = Static<typeof ProactiveChannelSchema>;
