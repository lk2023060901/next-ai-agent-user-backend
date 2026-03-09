// ─── Embedding Service Types ────────────────────────────────────────────────
//
// Unified embedding infrastructure shared by KB and memory systems.
// Within a workspace, all embeddings must use the same model/dimensions
// to ensure vector space consistency (design doc §3 unified cognition).
//
// The embedding model is user-selected from the settings/providers page.
// This module is model-agnostic — it receives config externally and
// delegates to the appropriate provider adapter.

// ─── Embedding Provider ─────────────────────────────────────────────────────

/** Strategy interface for embedding model backends (OpenAI, Voyage, Ollama, etc.). */
export interface EmbeddingProvider {
  readonly name: string;

  /** Generate embeddings for a batch of texts. */
  embed(texts: string[], model: string): Promise<Float32Array[]>;
}

// ─── Embedding Service ──────────────────────────────────────────────────────

/** Unified embedding entry point — all callers go through here. */
export interface EmbeddingService {
  /**
   * Embed one or more texts.
   * Handles batching, caching, and provider dispatch transparently.
   */
  embed(texts: string[]): Promise<Float32Array[]>;

  /** Embed a single text (convenience wrapper). */
  embedOne(text: string): Promise<Float32Array>;

  /** Current model dimensions (from config). */
  readonly dimensions: number;

  /** Current model identifier (from config). */
  readonly model: string;
}

// ─── Embedding Service Config ───────────────────────────────────────────────
//
// Injected from outside — the user selects provider + model on the
// settings/providers page. The runtime receives this as workspace config.

export interface EmbeddingServiceConfig {
  provider: string;         // "openai" | "voyage" | "ollama" | "qwen" | "custom"
  model: string;            // e.g. "text-embedding-3-small"
  dimensions: number;       // Model output dimensions (from provider settings)
  baseUrl?: string;         // Custom/self-hosted endpoint
  apiKey?: string;          // API key (not needed for local providers)
  batchSize?: number;       // Max texts per API call (default: 16)
  maxTextLength?: number;   // Max chars per text, truncated if exceeded (default: 8192)
  timeoutMs?: number;       // Per-batch timeout (default: 60_000)
  maxRetries?: number;      // Retry failed batches (default: 2)
}

// ─── Batch Processor ────────────────────────────────────────────────────────

export interface BatchResult {
  embeddings: Float32Array[];
  cached: number;     // How many were served from cache
  computed: number;   // How many required API calls
}

// ─── Embedding Cache ────────────────────────────────────────────────────────

/**
 * Cache keyed by (provider, model, content_hash).
 * Prevents redundant API calls for identical content.
 */
export interface EmbeddingCache {
  /** Lookup cached embeddings. Returns null for cache misses. */
  getMany(keys: CacheKey[]): Promise<(Float32Array | null)[]>;

  /** Store embeddings in cache. */
  setMany(entries: Array<{ key: CacheKey; embedding: Float32Array }>): Promise<void>;

  /** Evict entries older than maxAgeMs. */
  evict(maxAgeMs: number): Promise<number>;
}

export interface CacheKey {
  provider: string;
  model: string;
  contentHash: string;
}
