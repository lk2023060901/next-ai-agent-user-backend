// ─── Embedding Module ───────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Replace the entire EmbeddingService:
//    Implement the EmbeddingService interface from embedding-types.ts
//
// 2. Replace the EmbeddingProvider (API backend):
//    Implement the EmbeddingProvider interface for custom embedding APIs
//
// 3. Replace the EmbeddingCache:
//    Implement the EmbeddingCache interface (e.g. SQLite, Redis)
//
// 4. Replace the Reranker:
//    Implement the Reranker interface for custom reranking backends
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  EmbeddingService,
  EmbeddingServiceConfig,
  EmbeddingProvider,
  EmbeddingCache,
  CacheKey,
  BatchResult,
} from "./embedding-types.js";

export type {
  Reranker,
  RerankParams,
  RerankDocument,
  RerankResult,
  RerankConfig,
} from "./reranker.js";

// ─── Default implementations ────────────────────────────────────────────────

export {
  DefaultEmbeddingService,
  type DefaultEmbeddingServiceOptions,
} from "./embedding-service.js";
export { InMemoryEmbeddingCache } from "./cache.js";
export { BatchProcessor, type BatchProcessorOptions, contentHash } from "./batch-processor.js";
export { OpenAIEmbeddingProvider, type OpenAIEmbeddingOptions } from "./providers/openai-embeddings.js";
export { DefaultReranker } from "./providers/default-reranker.js";
