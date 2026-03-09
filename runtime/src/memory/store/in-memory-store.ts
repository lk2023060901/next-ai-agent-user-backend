import type {
  Entity,
  GraphResult,
  MemoryEntry,
  Relation,
} from "../memory-types.js";
import type {
  FullTextIndex,
  FullTextSearchResult,
  GraphStore,
  MemoryCountParams,
  MemoryListParams,
  MemoryStore,
  VectorIndex,
  VectorSearchResult,
} from "./interfaces.js";

// ─── In-Memory Memory Store ──────────────────────────────────────────────────

/**
 * In-memory MemoryStore for testing and single-process deployments.
 * Replaced by SQLite implementation when the db/ module is built.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async insert(entry: MemoryEntry): Promise<void> {
    this.entries.set(entry.id, { ...entry });
  }

  async insertBatch(entries: MemoryEntry[]): Promise<void> {
    for (const e of entries) {
      this.entries.set(e.id, { ...e });
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async update(id: string, fields: Partial<MemoryEntry>): Promise<void> {
    const existing = this.entries.get(id);
    if (!existing) return;
    this.entries.set(id, { ...existing, ...fields, updatedAt: Date.now() });
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }

  async list(params: MemoryListParams): Promise<MemoryEntry[]> {
    let results = [...this.entries.values()].filter(
      (e) => e.agentId === params.agentId && e.workspaceId === params.workspaceId,
    );

    if (params.types && params.types.length > 0) {
      const typeSet = new Set(params.types);
      results = results.filter((e) => typeSet.has(e.type));
    }
    if (params.visibility && params.visibility.length > 0) {
      const visSet = new Set(params.visibility);
      results = results.filter((e) => visSet.has(e.visibility));
    }
    if (params.minDecay !== undefined) {
      results = results.filter((e) => e.decayScore >= params.minDecay!);
    }
    if (params.consolidated !== undefined) {
      results = results.filter((e) => e.consolidated === params.consolidated);
    }

    // Sort
    const field = params.orderBy ?? "createdAt";
    const dir = params.orderDir === "asc" ? 1 : -1;
    results.sort((a, b) => {
      const av = a[field] as number;
      const bv = b[field] as number;
      return (av - bv) * dir;
    });

    // Pagination
    const offset = params.offset ?? 0;
    const limit = params.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  async count(params: MemoryCountParams): Promise<number> {
    let results = [...this.entries.values()].filter(
      (e) => e.agentId === params.agentId && e.workspaceId === params.workspaceId,
    );
    if (params.types && params.types.length > 0) {
      const typeSet = new Set(params.types);
      results = results.filter((e) => typeSet.has(e.type));
    }
    if (params.minDecay !== undefined) {
      results = results.filter((e) => e.decayScore >= params.minDecay!);
    }
    return results.length;
  }

  async sumUnreflectedImportance(agentId: string, workspaceId: string): Promise<number> {
    let sum = 0;
    for (const e of this.entries.values()) {
      if (
        e.agentId === agentId &&
        e.workspaceId === workspaceId &&
        e.type !== "reflection" &&
        e.type !== "meta_reflection" &&
        !e.consolidated
      ) {
        sum += e.importance;
      }
    }
    return sum;
  }

  async getStaleEntries(cutoffMs: number, limit: number): Promise<MemoryEntry[]> {
    return [...this.entries.values()]
      .filter((e) => e.lastAccessedAt < cutoffMs)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
      .slice(0, limit);
  }

  async batchUpdateDecay(updates: Array<{ id: string; decayScore: number }>): Promise<void> {
    for (const { id, decayScore } of updates) {
      const entry = this.entries.get(id);
      if (entry) {
        entry.decayScore = decayScore;
        entry.updatedAt = Date.now();
      }
    }
  }
}

// ─── In-Memory Vector Index ──────────────────────────────────────────────────

/**
 * In-memory vector index using brute-force cosine similarity.
 * Replaced by sqlite-vec when the db/ module is built.
 */
export class InMemoryVectorIndex implements VectorIndex {
  private readonly vectors = new Map<string, Float32Array>();

  async upsert(memoryId: string, embedding: Float32Array): Promise<void> {
    this.vectors.set(memoryId, embedding);
  }

  async upsertBatch(items: Array<{ memoryId: string; embedding: Float32Array }>): Promise<void> {
    for (const { memoryId, embedding } of items) {
      this.vectors.set(memoryId, embedding);
    }
  }

  async remove(memoryId: string): Promise<void> {
    this.vectors.delete(memoryId);
  }

  async search(query: Float32Array, limit: number): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = [];
    for (const [memoryId, embedding] of this.vectors) {
      const similarity = cosineSimilarity(query, embedding);
      results.push({ memoryId, similarity });
    }
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── In-Memory Full-Text Index ───────────────────────────────────────────────

/**
 * In-memory full-text index using simple substring matching.
 * Replaced by FTS5 when the db/ module is built.
 */
export class InMemoryFullTextIndex implements FullTextIndex {
  private readonly documents = new Map<string, string>();

  async upsert(memoryId: string, content: string): Promise<void> {
    this.documents.set(memoryId, content.toLowerCase());
  }

  async remove(memoryId: string): Promise<void> {
    this.documents.delete(memoryId);
  }

  async search(query: string, limit: number): Promise<FullTextSearchResult[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const results: FullTextSearchResult[] = [];
    for (const [memoryId, content] of this.documents) {
      let matchCount = 0;
      for (const term of terms) {
        if (content.includes(term)) matchCount++;
      }
      if (matchCount > 0) {
        results.push({ memoryId, score: matchCount / terms.length });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}

// ─── In-Memory Graph Store ───────────────────────────────────────────────────

/**
 * In-memory graph store using Maps.
 * Replaced by SQLite + recursive CTE when the db/ module is built.
 */
export class InMemoryGraphStore implements GraphStore {
  private readonly entities = new Map<string, Entity>();
  private readonly relations: Relation[] = [];
  private readonly memoryEntityLinks = new Map<string, Set<string>>(); // memoryId → entityIds

  async upsertEntity(entity: Entity): Promise<void> {
    this.entities.set(entity.id, { ...entity });
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.entities.get(id) ?? null;
  }

  async findEntitiesByName(name: string, limit: number): Promise<Entity[]> {
    const lower = name.toLowerCase();
    return [...this.entities.values()]
      .filter((e) => e.name.toLowerCase().includes(lower))
      .slice(0, limit);
  }

  async findEntitiesByEmbedding(embedding: Float32Array, limit: number): Promise<Entity[]> {
    const scored = [...this.entities.values()]
      .filter((e) => e.embedding)
      .map((e) => ({
        entity: e,
        sim: cosineSimilarity(embedding, e.embedding!),
      }))
      .sort((a, b) => b.sim - a.sim);
    return scored.slice(0, limit).map((s) => s.entity);
  }

  async addRelation(relation: Relation): Promise<void> {
    this.relations.push({ ...relation });
  }

  async invalidateRelation(id: string, tExpired: number): Promise<void> {
    const rel = this.relations.find((r) => r.id === id);
    if (rel) rel.tExpired = tExpired;
  }

  async traverse(entityId: string, maxHops: number): Promise<GraphResult> {
    const entity = this.entities.get(entityId);
    if (!entity) {
      return { entity: { id: entityId, name: "", type: "", description: "", source: "episode", createdAt: 0, updatedAt: 0 }, relations: [], connected: [] };
    }

    const visited = new Set<string>();
    const resultRelations: Relation[] = [];
    const connected: Entity[] = [];

    const queue: Array<{ id: string; depth: number }> = [{ id: entityId, depth: 0 }];
    visited.add(entityId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxHops) continue;

      for (const rel of this.relations) {
        if (rel.tExpired) continue; // Skip expired relations
        let targetId: string | null = null;
        if (rel.sourceEntityId === current.id) targetId = rel.targetEntityId;
        if (rel.targetEntityId === current.id) targetId = rel.sourceEntityId;
        if (!targetId || visited.has(targetId)) continue;

        visited.add(targetId);
        resultRelations.push(rel);
        const target = this.entities.get(targetId);
        if (target) {
          connected.push(target);
          queue.push({ id: targetId, depth: current.depth + 1 });
        }
      }
    }

    return { entity, relations: resultRelations, connected };
  }

  async getEntitiesForMemory(memoryId: string): Promise<Entity[]> {
    const entityIds = this.memoryEntityLinks.get(memoryId);
    if (!entityIds) return [];
    return [...entityIds]
      .map((id) => this.entities.get(id))
      .filter((e): e is Entity => !!e);
  }

  async linkMemoryToEntity(memoryId: string, entityId: string): Promise<void> {
    let set = this.memoryEntityLinks.get(memoryId);
    if (!set) {
      set = new Set();
      this.memoryEntityLinks.set(memoryId, set);
    }
    set.add(entityId);
  }
}
