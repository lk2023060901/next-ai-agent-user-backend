import type {
  MemoryEntry,
  MemorySearchQuery,
  MemorySearchResult,
} from "../memory-types.js";
import { DECAY_FORGOTTEN_THRESHOLD, DEFAULT_SCORING_WEIGHTS } from "../memory-types.js";
import type { FullTextIndex, GraphStore, MemoryStore, VectorIndex } from "../store/interfaces.js";
import { reciprocalRankFusion, scoreMemory } from "./scoring.js";

/**
 * Hybrid search (design doc §5.5, §7.2).
 *
 * Three-path retrieval:
 * 1. Vector KNN (embedding similarity)
 * 2. FTS5 BM25 (keyword relevance)
 * 3. Graph traversal (entity-based expansion)
 *
 * Results are merged using Reciprocal Rank Fusion (RRF), then
 * scored with the three-factor formula (recency × importance × relevance).
 */
export class HybridSearch {
  constructor(
    private readonly memoryStore: MemoryStore,
    private readonly vectorIndex: VectorIndex,
    private readonly ftsIndex: FullTextIndex,
    private readonly graphStore: GraphStore,
  ) {}

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    const candidateLimit = (query.limit ?? 10) * 3; // Over-fetch for fusion

    // Run three search paths in parallel
    const [vectorResults, ftsResults, graphResults] = await Promise.all([
      this.vectorSearch(query, candidateLimit),
      this.ftsSearch(query, candidateLimit),
      this.graphSearch(query, candidateLimit),
    ]);

    // Fuse results using RRF
    const fused = reciprocalRankFusion(vectorResults, ftsResults, graphResults);

    // Load full entries and compute three-factor scores
    const limit = query.limit ?? 10;
    const minScore = query.minScore ?? 0;
    const results: MemorySearchResult[] = [];

    for (const { memoryId, fusedScore } of fused) {
      if (results.length >= limit) break;

      const entry = await this.memoryStore.get(memoryId);
      if (!entry) continue;

      // Filter by agent/workspace
      if (entry.agentId !== query.agentId && entry.visibility === "private") continue;
      if (entry.workspaceId !== query.workspaceId && entry.visibility !== "public") continue;

      // Filter by type
      if (query.types && query.types.length > 0 && !query.types.includes(entry.type)) continue;

      // Filter forgotten
      if (!query.includeDecayed && entry.decayScore < DECAY_FORGOTTEN_THRESHOLD) continue;

      // Compute three-factor score
      const { score, recency, importance, relevance } = scoreMemory(
        entry,
        fusedScore, // Use fused score as relevance proxy
        DEFAULT_SCORING_WEIGHTS,
      );

      if (score < minScore) continue;

      // Determine primary source
      const source = determineSource(memoryId, vectorResults, ftsResults, graphResults);

      results.push({
        entry,
        score,
        breakdown: { recency, importance, relevance },
        source,
      });
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async vectorSearch(
    query: MemorySearchQuery,
    limit: number,
  ): Promise<Array<{ memoryId: string; score: number }>> {
    if (!query.embedding) return [];
    const results = await this.vectorIndex.search(query.embedding, limit);
    return results.map((r) => ({ memoryId: r.memoryId, score: r.similarity }));
  }

  private async ftsSearch(
    query: MemorySearchQuery,
    limit: number,
  ): Promise<Array<{ memoryId: string; score: number }>> {
    if (!query.query) return [];
    const results = await this.ftsIndex.search(query.query, limit);
    return results.map((r) => ({ memoryId: r.memoryId, score: r.score }));
  }

  private async graphSearch(
    query: MemorySearchQuery,
    limit: number,
  ): Promise<Array<{ memoryId: string; score: number }>> {
    // Graph search: find entities matching the query, then traverse
    if (!query.query) return [];

    const entities = await this.graphStore.findEntitiesByName(query.query, 5);
    if (entities.length === 0) return [];

    const memoryIds = new Set<string>();
    for (const entity of entities) {
      const graph = await this.graphStore.traverse(entity.id, 2);
      // Get memories linked to the entity and its neighbors
      const allEntityIds = [entity.id, ...graph.connected.map((e) => e.id)];
      for (const eid of allEntityIds) {
        const memories = await this.graphStore.getEntitiesForMemory(eid);
        // Note: getEntitiesForMemory returns entities, we need the reverse
        // This is simplified — in practice, the graph store would have a
        // getMemoriesForEntity method
      }
    }

    // For now, return empty — full graph-based memory retrieval needs
    // a reverse index (entity → memories) which the in-memory store
    // doesn't efficiently support. The SQLite implementation will use
    // a proper join.
    return [];
  }
}

function determineSource(
  memoryId: string,
  vectorResults: Array<{ memoryId: string; score: number }>,
  ftsResults: Array<{ memoryId: string; score: number }>,
  graphResults: Array<{ memoryId: string; score: number }>,
): "vector" | "fts" | "graph" {
  const vIdx = vectorResults.findIndex((r) => r.memoryId === memoryId);
  const fIdx = ftsResults.findIndex((r) => r.memoryId === memoryId);
  const gIdx = graphResults.findIndex((r) => r.memoryId === memoryId);

  // Return the source where this memory ranked highest
  const scores: Array<[MemorySearchResult["source"], number]> = [];
  if (vIdx >= 0) scores.push(["vector", vectorResults[vIdx]!.score]);
  if (fIdx >= 0) scores.push(["fts", ftsResults[fIdx]!.score]);
  if (gIdx >= 0) scores.push(["graph", graphResults[gIdx]!.score]);

  if (scores.length === 0) return "vector";
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0]![0];
}
