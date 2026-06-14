export { MemoryIndexer, type MemoryIndexerOptions } from "./indexer.js";
export {
  MemorySearch,
  buildFtsMatch,
  userLaneTokens,
  userLanePrefixStem,
  type MemorySearchDeps,
} from "./search.js";
export type { RetrievalResult, SearchOptions, SearchOutcome, UserLaneOptions } from "./search.js";
export {
  createRetrievalSubsystem,
  type RetrievalSubsystem,
  type CreateSubsystemOptions,
} from "./subsystem.js";
export { VectorStore } from "./vector-store.js";
export { EmbedWorkerPool } from "./embed-worker.js";
export {
  createEmbeddingProvider,
  LocalEmbeddingProvider,
  RemoteEmbeddingProvider,
  l2normalize,
  type EmbeddingProvider,
} from "./embedding/index.js";
export {
  resolveRetrievalConfig,
  activeEmbeddingDim,
  activeEmbeddingModelId,
  type ResolvedRetrievalConfig,
} from "./config.js";
export { chunkMemoryFile, dayFromFilename, type MemoryChunk } from "./chunk.js";
