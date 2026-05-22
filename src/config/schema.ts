import { Type, type Static } from "@sinclair/typebox";

const ModelSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  endpoint: Type.String(),
  api_key: Type.String(),
  multimodal: Type.Boolean(),
  max_tokens: Type.Number({ minimum: 1 }),
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
      forced_completion_retries: Type.Number({ minimum: 0 }),
    }),
    system: Type.Object({
      prompt: Type.String(),
    }),
  }),
  models: Type.Record(Type.String(), ModelSchema),
  context: Type.Object({
    tiers: Type.Object({
      rich_target_tokens: Type.Number({ minimum: 1 }),
      rich_max_tokens: Type.Number({ minimum: 1 }),
      compact_target_tokens: Type.Number({ minimum: 1 }),
      compact_max_tokens: Type.Number({ minimum: 1 }),
    }),
    images: Type.Object({
      caption_multimodal: Type.Boolean(),
      max_bytes: Type.Number({ minimum: 1 }),
      max_width: Type.Number({ minimum: 1 }),
      max_height: Type.Number({ minimum: 1 }),
    }),
  }),
  storage: Type.Object({
    database_path: Type.String(),
  }),
  workspace: Type.Object({
    root_dir: Type.String(),
  }),
  matrix: Type.Object({
    enabled: Type.Boolean(),
    trigger_hold_ms: Type.Number({ minimum: 0 }),
    accounts: Type.Record(Type.String(), MatrixAccountSchema),
  }),
});

export type AppConfig = Static<typeof AppConfigSchema>;
