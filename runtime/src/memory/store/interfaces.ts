import type {
  Entity,
  GraphResult,
  MemoryEntry,
  MemoryType,
  MemoryVisibility,
  NewMemoryEntry,
  Relation,
} from "../memory-types.js";

// ─── Memory Store ────────────────────────────────────────────────────────────
//
// CRUD for MemoryEntry records. The primary persistence interface.
// SQLite implementation comes with the db/ module.

export interface MemoryStore {
  insert(entry: MemoryEntry): Promise<void>;
  insertBatch(entries: MemoryEntry[]): Promise<void>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, fields: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;

  /** List memories by agent + workspace, optionally filtered by type. */
  list(params: MemoryListParams): Promise<MemoryEntry[]>;

  /** Count memories matching criteria. */
  count(params: MemoryCountParams): Promise<number>;

  /** Sum importance of un-reflected memories (for reflection trigger). */
  sumUnreflectedImportance(agentId: string, workspaceId: string): Promise<number>;

  /** Get memories that need decay update (lastAccessedAt older than cutoff). */
  getStaleEntries(cutoffMs: number, limit: number): Promise<MemoryEntry[]>;

  /** Batch update decay scores. */
  batchUpdateDecay(updates: Array<{ id: string; decayScore: number }>): Promise<void>;
}

export interface MemoryListParams {
  agentId: string;
  workspaceId: string;
  types?: MemoryType[];
  visibility?: MemoryVisibility[];
  minDecay?: number;
  consolidated?: boolean;
  limit?: number;
  offset?: number;
  orderBy?: "createdAt" | "importance" | "lastAccessedAt" | "decayScore";
  orderDir?: "asc" | "desc";
}

export interface MemoryCountParams {
  agentId: string;
  workspaceId: string;
  types?: MemoryType[];
  minDecay?: number;
}

// ─── Vector Index ────────────────────────────────────────────────────────────
//
// KNN search over memory embeddings. Backed by sqlite-vec.

export interface VectorIndex {
  /** Index a memory's embedding. */
  upsert(memoryId: string, embedding: Float32Array): Promise<void>;

  /** Batch upsert. */
  upsertBatch(items: Array<{ memoryId: string; embedding: Float32Array }>): Promise<void>;

  /** Remove from the index. */
  remove(memoryId: string): Promise<void>;

  /** KNN search. Returns memory IDs with cosine similarity scores. */
  search(query: Float32Array, limit: number): Promise<VectorSearchResult[]>;
}

export interface VectorSearchResult {
  memoryId: string;
  similarity: number; // Cosine similarity 0–1
}

// ─── Full-Text Index ─────────────────────────────────────────────────────────
//
// BM25 keyword search. Backed by SQLite FTS5.

export interface FullTextIndex {
  /** Index a memory's content. */
  upsert(memoryId: string, content: string): Promise<void>;

  /** Remove from the index. */
  remove(memoryId: string): Promise<void>;

  /** BM25 search. Returns memory IDs with relevance scores. */
  search(query: string, limit: number): Promise<FullTextSearchResult[]>;
}

export interface FullTextSearchResult {
  memoryId: string;
  score: number; // BM25 score (higher = more relevant)
}

// ─── Graph Store ─────────────────────────────────────────────────────────────
//
// Entity-relation graph. Backed by SQLite tables + recursive CTE.

export interface GraphStore {
  // Entity CRUD
  upsertEntity(entity: Entity): Promise<void>;
  getEntity(id: string): Promise<Entity | null>;
  findEntitiesByName(name: string, limit: number): Promise<Entity[]>;
  findEntitiesByEmbedding(embedding: Float32Array, limit: number): Promise<Entity[]>;

  // Relation CRUD
  addRelation(relation: Relation): Promise<void>;
  invalidateRelation(id: string, tExpired: number): Promise<void>;

  // Graph traversal (recursive CTE)
  traverse(entityId: string, maxHops: number): Promise<GraphResult>;

  // Entity search by associated memory
  getEntitiesForMemory(memoryId: string): Promise<Entity[]>;
  linkMemoryToEntity(memoryId: string, entityId: string): Promise<void>;
}
