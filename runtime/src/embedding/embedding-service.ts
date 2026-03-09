import type {
  EmbeddingProvider,
  EmbeddingService,
  EmbeddingServiceConfig,
  EmbeddingCache,
} from "./embedding-types.js";
import { BatchProcessor } from "./batch-processor.js";
import { InMemoryEmbeddingCache } from "./cache.js";
import { OpenAIEmbeddingProvider } from "./providers/openai-embeddings.js";

// ─── Options ────────────────────────────────────────────────────────────────

export interface DefaultEmbeddingServiceOptions {
  config: EmbeddingServiceConfig;

  // ─── Optional overrides (plugin injection points) ─────────────────────
  /** Custom embedding provider — replace the API backend. */
  provider?: EmbeddingProvider;
  /** Custom cache — replace with SQLite/Redis/etc. */
  cache?: EmbeddingCache;
}

// ─── Default Embedding Service ──────────────────────────────────────────────
//
// Unified entry point for all embedding operations (memory + KB).
// Composes: provider adapter + batch processor + cache.
//
// The embedding model is user-selected from the settings/providers page.
// Most providers (OpenAI, Voyage, Ollama /v1, Azure, etc.) are
// OpenAI-compatible and use the same provider adapter.

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_MAX_TEXT_LENGTH = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

export class DefaultEmbeddingService implements EmbeddingService {
  readonly dimensions: number;
  readonly model: string;

  private readonly batchProcessor: BatchProcessor;
  private readonly maxTextLength: number;

  constructor(options: DefaultEmbeddingServiceOptions) {
    const { config } = options;
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.maxTextLength = config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

    const provider = options.provider ?? createProvider(config);
    const cache = options.cache ?? new InMemoryEmbeddingCache();

    this.batchProcessor = new BatchProcessor({
      provider,
      model: config.model,
      cache,
      batchSize: config.batchSize ?? DEFAULT_BATCH_SIZE,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
    });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Truncate texts that exceed max length
    const truncated = texts.map((t) =>
      t.length > this.maxTextLength ? t.slice(0, this.maxTextLength) : t,
    );

    const result = await this.batchProcessor.process(truncated);
    return result.embeddings;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [embedding] = await this.embed([text]);
    return embedding!;
  }
}

// ─── Provider Factory ───────────────────────────────────────────────────────

function createProvider(config: EmbeddingServiceConfig): EmbeddingProvider {
  // Most providers (OpenAI, Voyage, Ollama /v1, Azure, Qwen-compatible,
  // etc.) follow the OpenAI embedding API format.
  return new OpenAIEmbeddingProvider({
    apiKey: config.apiKey ?? "",
    baseUrl: config.baseUrl,
  });
}
