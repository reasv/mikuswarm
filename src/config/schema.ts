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
  fetch_concurrency: Type.Optional(Type.Number({ minimum: 1 })),
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
  })),
  network: Type.Optional(Type.Object({
    http_proxy_url: Type.Optional(Type.String()),
  })),
  observability: Type.Optional(ObservabilitySchema),
});

export type AppConfig = Static<typeof AppConfigSchema>;
export type SummarizationConfig = Static<typeof SummarizationSchema>;
