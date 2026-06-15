import type { Logger } from "../../observability/logger.js";
import type { LlmScheduler } from "../../agent/scheduler.js";
import type { ResolvedRetrievalConfig } from "../config.js";
import { type EmbeddingProvider, LocalEmbeddingProvider } from "./provider.js";
import { RemoteEmbeddingProvider } from "./remote.js";

export { type EmbeddingProvider, LocalEmbeddingProvider, l2normalize } from "./provider.js";
export { RemoteEmbeddingProvider } from "./remote.js";

export interface CreateProviderOptions {
  /** Directory for the local model's ONNX weight cache (first-run download). */
  cacheDir: string;
  /** Optional HTTP proxy URL for the remote provider. */
  httpProxyUrl?: string;
  /** LLM scheduler — only the remote provider participates (spec §5.4). */
  scheduler?: LlmScheduler;
  /**
   * Usage sink for the remote provider (spec USAGE-COST-LIMITS §9): one call per
   * embedded batch with prompt tokens + computed USD cost. Local emits nothing.
   */
  onEmbeddingUsage?: (promptTokens: number, costUsd: number) => void;
  logger?: Logger;
}

/**
 * Construct the active embedding provider per the resolved config (ARCHITECTURE.md
 * §9d / design §5a). Remote (OpenRouter-compatible) when configured; otherwise the
 * bundled local model. Construction is cheap and never touches the network — the
 * local model's weights load lazily on first use (§5c) and the remote provider only
 * connects when actually called, so this can't block startup.
 */
export function createEmbeddingProvider(
  config: ResolvedRetrievalConfig,
  opts: CreateProviderOptions,
): EmbeddingProvider {
  if (config.embedding.provider === "remote" && config.embedding.remote) {
    return new RemoteEmbeddingProvider({
      id: config.embedding.remote.id,
      endpoint: config.embedding.remote.endpoint,
      apiKey: config.embedding.remote.apiKey,
      dim: config.embedding.remote.dim,
      batchSize: config.index.embedBatchSize,
      httpProxyUrl: opts.httpProxyUrl,
      scheduler: opts.scheduler,
      rateLimitGroup: config.embedding.remote.rateLimitGroup,
      costPerMtok: config.embedding.remote.costPerMtok,
      charsPerToken: config.embedding.remote.charsPerToken,
      onUsage: opts.onEmbeddingUsage,
      logger: opts.logger,
    });
  }
  return new LocalEmbeddingProvider({
    model: config.embedding.local.model,
    dim: config.embedding.local.dim,
    cacheDir: opts.cacheDir,
    logger: opts.logger,
  });
}
