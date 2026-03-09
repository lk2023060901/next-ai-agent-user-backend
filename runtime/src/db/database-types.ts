import type Database from "better-sqlite3";
import type {
  AccessLogStore,
  CoreMemoryStore,
  FullTextIndex,
  GraphStore,
  MemoryStore,
  MemoryViewStore,
  ReflectionStateStore,
  VectorIndex,
} from "../memory/store/interfaces.js";
import type { EmbeddingCache } from "../embedding/embedding-types.js";
import type { ObservabilityStore } from "./observability-types.js";

// ─── Database Manager ───────────────────────────────────────────────────────
//
// Manages the SQLite database lifecycle and exposes storage implementations.
// Plugin injection point: replace the entire manager to switch to
// PostgreSQL, Turso, or any other backend.

export interface DatabaseManager {
  /** Underlying raw database connection (for advanced use / transactions). */
  readonly raw: Database.Database;

  // ─── Primary stores (memory entries + search) ─────────────────────────
  readonly memoryStore: MemoryStore;
  readonly vectorIndex: VectorIndex;
  readonly ftsIndex: FullTextIndex;
  readonly graphStore: GraphStore;

  // ─── Lifecycle stores ─────────────────────────────────────────────────
  readonly coreMemoryStore: CoreMemoryStore;
  readonly reflectionStateStore: ReflectionStateStore;
  readonly accessLogStore: AccessLogStore;
  readonly memoryViewStore: MemoryViewStore;

  // ─── Cross-cutting ────────────────────────────────────────────────────
  readonly embeddingCache: EmbeddingCache;

  // ─── Observability ────────────────────────────────────────────────────
  readonly observabilityStore: ObservabilityStore;

  /** Initialize schema (create tables, indexes, load extensions). */
  initialize(): void;

  /** Close the database connection and release resources. */
  close(): void;
}

// ─── Database Options ───────────────────────────────────────────────────────

export interface DatabaseManagerOptions {
  /** Path to the SQLite database file. */
  dbPath: string;

  /** Embedding dimensions for vec0 virtual table. */
  embeddingDimensions: number;

  // ─── Optional overrides (plugin injection points) ─────────────────────
  // Pass your own implementation to replace any store.
  // Omit to use the built-in SQLite implementations.

  memoryStore?: MemoryStore;
  vectorIndex?: VectorIndex;
  ftsIndex?: FullTextIndex;
  graphStore?: GraphStore;
  coreMemoryStore?: CoreMemoryStore;
  reflectionStateStore?: ReflectionStateStore;
  accessLogStore?: AccessLogStore;
  memoryViewStore?: MemoryViewStore;
  embeddingCache?: EmbeddingCache;
  observabilityStore?: ObservabilityStore;
}
