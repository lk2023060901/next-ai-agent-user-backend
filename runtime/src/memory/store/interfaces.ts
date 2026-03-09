import type {
  AccessType,
  CoreMemoryBlock,
  CoreMemorySnapshot,
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

// ─── Core Memory Store ──────────────────────────────────────────────────────
//
// Dedicated store for pinned core memory blocks (persona, user, working,
// knowledgeSummary). Backed by the core_memory_blocks table.

export interface CoreMemoryStore {
  /** Get the full core memory snapshot for an agent. */
  get(agentId: string, workspaceId: string): Promise<CoreMemorySnapshot>;

  /** Create or update a core memory block. */
  upsert(agentId: string, workspaceId: string, block: CoreMemoryBlock, content: string): Promise<void>;

  /** Remove a core memory block. */
  delete(agentId: string, workspaceId: string, block: CoreMemoryBlock): Promise<void>;
}

// ─── Reflection State Store ─────────────────────────────────────────────────
//
// Tracks per-agent reflection trigger state. Backed by the reflection_state table.

export interface ReflectionStateStore {
  /** Get the current reflection state. */
  get(agentId: string, workspaceId: string): Promise<ReflectionState | null>;

  /** Update cumulative importance (add delta). */
  addImportance(agentId: string, workspaceId: string, delta: number): Promise<void>;

  /** Reset after a reflection is completed. */
  recordReflection(agentId: string, workspaceId: string): Promise<void>;
}

export interface ReflectionState {
  agentId: string;
  workspaceId: string;
  cumulativeImportance: number;
  lastReflectionAt: number | null;
  reflectionCount: number;
}

// ─── Access Log Store ───────────────────────────────────────────────────────
//
// Audit trail for memory access events. Drives decay reinforcement analysis.
// Backed by the memory_access_log table.

export interface AccessLogStore {
  /** Log a memory access event. */
  log(entry: AccessLogEntry): Promise<void>;

  /** Log multiple access events in a batch. */
  logBatch(entries: AccessLogEntry[]): Promise<void>;

  /** Get access history for a memory. */
  getHistory(memoryId: string, limit?: number): Promise<AccessLogEntry[]>;

  /** Count accesses by type for a memory. */
  countByType(memoryId: string): Promise<Record<AccessType, number>>;
}

export interface AccessLogEntry {
  memoryId: string;
  agentId: string;
  accessType: AccessType;
  contextSnippet?: string;
  createdAt: number;
}

// ─── Memory View Store ──────────────────────────────────────────────────────
//
// Fine-grained per-agent memory ACL. Extends beyond the simple visibility
// field on MemoryEntry. Backed by the agent_memory_views table.

export interface MemoryViewStore {
  /** Grant an agent access to a memory. */
  grant(memoryId: string, agentId: string, accessLevel: MemoryAccessLevel): Promise<void>;

  /** Revoke an agent's access to a memory. */
  revoke(memoryId: string, agentId: string): Promise<void>;

  /** Check if an agent has access to a memory. */
  hasAccess(memoryId: string, agentId: string): Promise<boolean>;

  /** Get all memory IDs accessible to an agent in a workspace. */
  getAccessibleMemoryIds(agentId: string, workspaceId: string): Promise<string[]>;

  /** Get all agents who have access to a memory. */
  getGrantedAgents(memoryId: string): Promise<Array<{ agentId: string; accessLevel: MemoryAccessLevel }>>;
}

export type MemoryAccessLevel = "read" | "write" | "admin";
