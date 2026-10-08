/**
 * Builds the re-rank and late-interaction provider chains from the resolved
 * `[retrieval.rerank]` / `[retrieval.late]` config (ARCHITECTURE.md §9d
 * "Re-rank stages"). Local providers load in process (ONNX, off the event
 * loop) with weights cached under `<data_dir>/models/<stage>`; remote providers
 * speak the open `/rerank` shape or an embeddings-shaped multi-vector endpoint.
 */
import path from "node:path";
import type { Logger } from "../../observability/logger.js";
import type { ResolvedModelProvider, ResolvedRetrievalConfig } from "../config.js";
import { LocalCrossEncoder } from "../onnx/cross-encoder.js";
import { LocalLateEncoder } from "../onnx/late-encoder.js";
import { ProviderChain, type ChainMember } from "./chain.js";
import { RemoteLateEncoder, RemoteRerankProvider } from "./remote.js";
import type { LateEncoder, RerankProvider } from "./types.js";

/** Document encoding is background work: a generous default deadline per call. */
export const LATE_DOCUMENT_TIMEOUT_MS = 300_000;

export interface ProviderFactoryOptions {
  dataDir: string;
  httpProxyUrl?: string;
  logger?: Logger;
}

function rerankProvider(cfg: ResolvedModelProvider, opts: ProviderFactoryOptions): RerankProvider {
  if (cfg.kind === "remote") return new RemoteRerankProvider(cfg, { httpProxyUrl: opts.httpProxyUrl });
  return new LocalCrossEncoder(cfg, {
    cacheRoot: path.join(opts.dataDir, "models", "rerank"),
    httpProxyUrl: opts.httpProxyUrl,
    logger: opts.logger,
  });
}

function lateEncoder(cfg: ResolvedModelProvider, opts: ProviderFactoryOptions, side: "document" | "query"): LateEncoder {
  if (cfg.kind === "remote") return new RemoteLateEncoder(cfg, { httpProxyUrl: opts.httpProxyUrl });
  return new LocalLateEncoder(cfg, {
    cacheRoot: path.join(opts.dataDir, "models", "late"),
    httpProxyUrl: opts.httpProxyUrl,
    logger: opts.logger,
    // Query encoding is on the hot path; document encoding is low priority (its own
    // child process at a lower OS priority).
    ...(side === "query" ? { threads: 2 } : { threads: 1, lowPriority: true }),
  });
}

export function createRerankChain(
  config: ResolvedRetrievalConfig["rerank"],
  opts: ProviderFactoryOptions,
): ProviderChain<RerankProvider> | undefined {
  if (!config.enabled) return undefined;
  const members: ChainMember<RerankProvider>[] = config.chain.map((name) => {
    const p = config.providers[name]!;
    return { provider: rerankProvider(p, opts), enabled: p.enabled, timeoutMs: p.timeoutMs ?? config.timeoutMs };
  });
  return new ProviderChain("rerank", members, { logger: opts.logger });
}

/**
 * The late stage's two chains: document encoders (background indexing) and
 * query encoders (hot path). A provider named in both gets one instance per
 * side, so a local model's query side keeps its own threads.
 */
export function createLateChains(
  config: ResolvedRetrievalConfig["late"],
  opts: ProviderFactoryOptions,
): { documents: ProviderChain<LateEncoder>; queries: ProviderChain<LateEncoder> } | undefined {
  if (!config.enabled) return undefined;
  const documents = new ProviderChain(
    "late_documents",
    config.chain.map((name) => {
      const p = config.providers[name]!;
      return { provider: lateEncoder(p, opts, "document"), enabled: p.enabled, timeoutMs: p.timeoutMs ?? LATE_DOCUMENT_TIMEOUT_MS };
    }),
    { logger: opts.logger },
  );
  const queries = new ProviderChain(
    "late_queries",
    config.queryChain.map((name) => {
      const p = config.providers[name]!;
      return { provider: lateEncoder(p, opts, "query"), enabled: p.enabled, timeoutMs: p.timeoutMs ?? config.timeoutMs };
    }),
    { logger: opts.logger },
  );
  return { documents, queries };
}
