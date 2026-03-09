// ─── Database Module ────────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Replace the entire DatabaseManager:
//    Implement the DatabaseManager interface from database-types.ts
//    (e.g. PostgreSQL + pgvector + Meilisearch + Neo4j)
//
// 2. Replace individual storage backends:
//    Pass custom MemoryStore, VectorIndex, FullTextIndex, GraphStore,
//    or EmbeddingCache via DefaultDatabaseManagerOptions
//
// 3. Use the raw SQLite connection:
//    Access db.raw for custom queries or transactions
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  DatabaseManager,
  DatabaseManagerOptions,
} from "./database-types.js";

export type {
  ObservabilityStore,
  UsageRecord,
  RunMetric,
  ToolMetric,
  UsageQueryParams,
  UsageSummary,
  UsageByModel,
  UsageByAgent,
  UsageByProvider,
  RunAgentBreakdown,
  RunAgentUsage,
} from "./observability-types.js";

// ─── Schema ─────────────────────────────────────────────────────────────────

export { SCHEMA_SQL, vecTableSQL, entityVecTableSQL } from "./schema.js";

// ─── Default implementations ────────────────────────────────────────────────

export { DefaultDatabaseManager } from "./database-manager.impl.js";

// SQLite store implementations (can be used standalone)
export { SqliteMemoryStore } from "./sqlite-memory-store.js";
export { SqliteVectorIndex } from "./sqlite-vector-index.js";
export { SqliteFtsIndex } from "./sqlite-fts-index.js";
export { SqliteGraphStore } from "./sqlite-graph-store.js";
export { SqliteCoreMemoryStore } from "./sqlite-core-memory-store.js";
export { SqliteReflectionStateStore } from "./sqlite-reflection-state-store.js";
export { SqliteAccessLogStore } from "./sqlite-access-log-store.js";
export { SqliteMemoryViewStore } from "./sqlite-memory-view-store.js";
export { SqliteEmbeddingCache } from "./sqlite-embedding-cache.js";
export { SqliteObservabilityStore } from "./sqlite-observability-store.js";
