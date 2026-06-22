import type { Logger } from "../../observability/logger.js";
import type { LlmScheduler } from "../../agent/scheduler.js";
import type { ModelChainEntry } from "../../agent/model-fallback.js";
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
  /** Budget availability by logical id (spec MODEL-FALLBACK §3/§7) for the remote chain. */
  isModelAvailable?: (logicalId: string) => boolean;
  /**
   * Resolved remote embedding chain (spec MODEL-FALLBACK §2.3): the referenced
   * `[models.*]` head + any fallback members, resolved at app wiring (where
   * `config.models` is available). Required when the remote provider is active.
   */
  embeddingChain?: ModelChainEntry[];
  /**
   * Usage sink for the remote provider (spec USAGE-COST-LIMITS §9): one call per
   * embedded batch with prompt tokens, computed USD cost, and the billed member's
   * ids. Local emits nothing.
   */
  onEmbeddingUsage?: (info: { promptTokens: number; costUsd: number; logicalModelId: string; modelId: string }) => void;
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
    if (!opts.embeddingChain || opts.embeddingChain.length === 0) {
      throw new Error(
        `remote embedding model "${config.embedding.remote.model}" did not resolve to a [models.*] chain`,
      );
    }
    return new RemoteEmbeddingProvider({
      chain: opts.embeddingChain,
      dim: config.embedding.remote.dim,
      batchSize: config.index.embedBatchSize,
      httpProxyUrl: opts.httpProxyUrl,
      scheduler: opts.scheduler,
      isModelAvailable: opts.isModelAvailable,
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
