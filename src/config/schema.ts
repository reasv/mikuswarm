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
    }),
    system: Type.Object({
      fallback_prompt: Type.Optional(Type.String()),
    }),
    session_types: Type.Optional(Type.Record(Type.String(), SessionTypeSchema)),
    disabled_tools: Type.Optional(Type.Array(Type.String())),
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
  matrix: Type.Object({
    enabled: Type.Boolean(),
    trigger_hold_ms: Type.Number({ minimum: 0 }),
    trigger_group_lookback_ms: Type.Optional(Type.Number({ minimum: 0 })),
    accounts: Type.Record(Type.String(), MatrixAccountSchema),
  }),
  mcp: Type.Optional(McpSchema),
  enrichment: Type.Optional(EnrichmentSchema),
  captioning: Type.Optional(CaptioningSchema),
});

export type AppConfig = Static<typeof AppConfigSchema>;
