import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
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
import type { SessionStore } from "../agent/agent-types.js";
import type { ObservabilityStore } from "./observability-types.js";
import type { DatabaseManager, DatabaseManagerOptions } from "./database-types.js";
import { SCHEMA_SQL, vecTableSQL, entityVecTableSQL } from "./schema.js";
import { SqliteMemoryStore } from "./sqlite-memory-store.js";
import { SqliteVectorIndex } from "./sqlite-vector-index.js";
import { SqliteFtsIndex } from "./sqlite-fts-index.js";
import { SqliteGraphStore } from "./sqlite-graph-store.js";
import { SqliteEmbeddingCache } from "./sqlite-embedding-cache.js";
import { SqliteCoreMemoryStore } from "./sqlite-core-memory-store.js";
import { SqliteReflectionStateStore } from "./sqlite-reflection-state-store.js";
import { SqliteAccessLogStore } from "./sqlite-access-log-store.js";
import { SqliteMemoryViewStore } from "./sqlite-memory-view-store.js";
import { SqliteSessionStore } from "./sqlite-session-store.js";
import { SqliteObservabilityStore } from "./sqlite-observability-store.js";

// ─── Default Database Manager ───────────────────────────────────────────────
//
// Opens a single SQLite database file, loads sqlite-vec, creates schema,
// and exposes storage implementations for all modules.
//
// Plugin injection: pass custom implementations via options to skip
// the built-in SQLite stores for any subset of interfaces.

export class DefaultDatabaseManager implements DatabaseManager {
  readonly raw: Database.Database;

  // Primary stores
  readonly memoryStore: MemoryStore;
  readonly vectorIndex: VectorIndex;
  readonly ftsIndex: FullTextIndex;
  readonly graphStore: GraphStore;

  // Lifecycle stores
  readonly coreMemoryStore: CoreMemoryStore;
  readonly reflectionStateStore: ReflectionStateStore;
  readonly accessLogStore: AccessLogStore;
  readonly memoryViewStore: MemoryViewStore;

  // Cross-cutting
  readonly embeddingCache: EmbeddingCache;

  // Session persistence
  readonly sessionStore: SessionStore;

  // Observability
  readonly observabilityStore: ObservabilityStore;

  private readonly embeddingDimensions: number;

  constructor(options: DatabaseManagerOptions) {
    this.embeddingDimensions = options.embeddingDimensions;

    // Open SQLite
    this.raw = new Database(options.dbPath);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");

    // Use plugin overrides or built-in SQLite implementations
    this.memoryStore = options.memoryStore ?? new SqliteMemoryStore(this.raw);
    this.vectorIndex = options.vectorIndex ?? new SqliteVectorIndex(this.raw);
    this.ftsIndex = options.ftsIndex ?? new SqliteFtsIndex(this.raw);
    this.graphStore = options.graphStore ?? new SqliteGraphStore(this.raw);
    this.coreMemoryStore = options.coreMemoryStore ?? new SqliteCoreMemoryStore(this.raw);
    this.reflectionStateStore = options.reflectionStateStore ?? new SqliteReflectionStateStore(this.raw);
    this.accessLogStore = options.accessLogStore ?? new SqliteAccessLogStore(this.raw);
    this.memoryViewStore = options.memoryViewStore ?? new SqliteMemoryViewStore(this.raw);
    this.embeddingCache = options.embeddingCache ?? new SqliteEmbeddingCache(this.raw);
    this.sessionStore = options.sessionStore ?? new SqliteSessionStore(this.raw);
    this.observabilityStore = options.observabilityStore ?? new SqliteObservabilityStore(this.raw);
  }

  initialize(): void {
    // 1. Load sqlite-vec extension
    sqliteVec.load(this.raw);

    // 2. Create schema (idempotent)
    this.raw.exec(SCHEMA_SQL);

    // 3. Create vector tables (dimensions from config)
    this.raw.exec(vecTableSQL(this.embeddingDimensions));
    this.raw.exec(entityVecTableSQL(this.embeddingDimensions));
  }

  close(): void {
    this.raw.close();
  }
}
