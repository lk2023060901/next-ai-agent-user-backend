import { DefaultDatabaseManager } from "./db/database-manager.impl.js";
import { DefaultEmbeddingService } from "./embedding/embedding-service.js";
import { DefaultMemoryManager } from "./memory/memory-manager.impl.js";
import { flushAllPersistentMessageHistoryWrites } from "./agent/persistent-message-history.js";
import type { DatabaseManager } from "./db/database-types.js";
import type { EmbeddingService } from "./embedding/embedding-types.js";
import type { MemoryManager } from "./memory/memory-types.js";
import type { SessionStore } from "./agent/agent-types.js";
import type {
  ProviderAdapter,
  CompleteParams,
  CompleteResult,
  StreamParams,
  StreamChunk,
  ProviderCapabilities,
} from "./providers/adapter.js";
import { config } from "./config.js";

// ─── Runtime Services ────────────────────────────────────────────────────────
//
// Lazy singleton that bootstraps the memory system infrastructure.
// If DB_PATH is not set, all services are null — the runtime works
// exactly as before (pure stateless mode).
//
// The bootstrap creates:
// 1. DatabaseManager — SQLite database with all storage layers
// 2. EmbeddingService — Optional embedding computation (vector search)
// 3. MemoryManager — Unified memory operations (read/write/search)

export interface RuntimeServices {
  db: DatabaseManager | null;
  embedding: EmbeddingService | null;
  memoryManager: MemoryManager | null;
  /** Session store for persistent message history. Null if DB_PATH unset. */
  sessionStore: SessionStore | null;
  /**
   * Set the LLM provider for memory operations (extraction, reflection,
   * consolidation, entity extraction). Called by the coordinator on the
   * first successful run when we know which model/apiKey to use.
   */
  setMemoryProvider(provider: ProviderAdapter): void;
}

let _services: RuntimeServices | null = null;

export function getRuntimeServices(): RuntimeServices {
  if (_services) return _services;
  _services = initializeServices();
  return _services;
}

/**
 * M4: Graceful shutdown — flush pending writes before closing DB.
 * better-sqlite3 uses synchronous I/O, but WAL mode may have unflushed pages.
 * This forces a WAL checkpoint and then closes the connection.
 */
export async function closeRuntimeServices(): Promise<void> {
  await flushAllPersistentMessageHistoryWrites();
  if (_services?.db) {
    try {
      // Force WAL checkpoint before closing to ensure all writes are flushed
      _services.db.raw.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      // best-effort checkpoint
    }
    _services.db.close();
  }
  _services = null;
}

// ─── Initialization ──────────────────────────────────────────────────────────

function initializeServices(): RuntimeServices {
  if (!config.dbPath) {
    console.warn(
      "[runtime] DB_PATH is not set — memory system, session persistence, and KB search are disabled. " +
      "Set DB_PATH to a writable directory path to enable these features.",
    );
    return {
      db: null,
      embedding: null,
      memoryManager: null,
      sessionStore: null,
      setMemoryProvider() { /* no-op when memory system is disabled */ },
    };
  }

  // 1. Database
  const db = new DefaultDatabaseManager({
    dbPath: config.dbPath,
    embeddingDimensions: config.embeddingDimensions,
  });
  db.initialize();

  // 2. Embedding service (optional — without it, vector search is skipped)
  let embedding: EmbeddingService | null = null;
  if (config.embeddingModel && config.embeddingApiKey) {
    embedding = new DefaultEmbeddingService({
      config: {
        provider: config.embeddingProvider,
        model: config.embeddingModel,
        dimensions: config.embeddingDimensions,
        apiKey: config.embeddingApiKey,
        baseUrl: config.embeddingBaseUrl || undefined,
      },
      cache: db.embeddingCache,
    });
  }

  // 3. Memory manager with LazyProvider
  // LLM-dependent operations (extraction, reflection, consolidation) use a
  // lazy provider that delegates to the first real provider set by the
  // coordinator. The read path (search, injection, core memory) never calls
  // the provider, so the lazy proxy is transparent.
  const lazyProvider = createLazyProvider();
  const memoryManager = new DefaultMemoryManager({
    memoryStore: db.memoryStore,
    vectorIndex: db.vectorIndex,
    ftsIndex: db.ftsIndex,
    graphStore: db.graphStore,
    provider: lazyProvider,
    embeddingService: embedding ?? undefined,
  });

  return {
    db,
    embedding,
    memoryManager,
    sessionStore: db.sessionStore,
    setMemoryProvider(provider: ProviderAdapter) {
      lazyProvider.setDelegate(provider);
    },
  };
}

// ─── Lazy Provider ──────────────────────────────────────────────────────────
//
// Delegates to a real provider once set. Before that, LLM calls throw
// a descriptive error. This allows the MemoryManager to be constructed
// at startup (before we know which model to use), and the real provider
// to be injected when the first run starts.

interface LazyProviderAdapter extends ProviderAdapter {
  setDelegate(provider: ProviderAdapter): void;
}

function createLazyProvider(): LazyProviderAdapter {
  let delegate: ProviderAdapter | null = null;

  function getDelegate(): ProviderAdapter {
    if (!delegate) {
      throw new Error(
        "MemoryManager LLM provider not yet configured. " +
        "It will be set automatically on the first agent run.",
      );
    }
    return delegate;
  }

  return {
    get providerName() {
      return delegate?.providerName ?? "lazy-pending";
    },

    setDelegate(provider: ProviderAdapter) {
      delegate = provider;
    },

    capabilities(): ProviderCapabilities {
      if (!delegate) {
        return {
          streaming: false,
          toolUse: false,
          reasoning: false,
          vision: false,
          caching: false,
          maxContextWindow: 0,
          maxOutputTokens: 0,
        };
      }
      return delegate.capabilities();
    },

    complete(params: CompleteParams): Promise<CompleteResult> {
      return getDelegate().complete(params);
    },

    stream(params: StreamParams): AsyncGenerator<StreamChunk> {
      return getDelegate().stream(params);
    },

    embed(texts: string[], model?: string): Promise<Float32Array[]> {
      return getDelegate().embed(texts, model);
    },
  };
}
