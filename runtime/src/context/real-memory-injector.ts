import type {
  InjectedMemory,
  InjectionContext,
  MemoryInjector,
} from "./context-types.js";
import type { MemoryManager } from "../memory/memory-types.js";
import type { EmbeddingService } from "../embedding/embedding-types.js";
import { estimateTokens } from "../utils/token-estimator.js";

/**
 * Real memory injector — delegates to MemoryManager for relevance-based retrieval.
 *
 * Replaces StubMemoryInjector. If an EmbeddingService is available, computes
 * a query embedding for vector search; otherwise falls back to FTS + graph.
 */
export class RealMemoryInjector implements MemoryInjector {
  constructor(
    private readonly memoryManager: MemoryManager,
    private readonly embeddingService?: EmbeddingService | null,
  ) {}

  async getRelevant(context: InjectionContext): Promise<InjectedMemory[]> {
    // Compute query embedding for vector search (optional)
    let queryEmbedding: Float32Array | undefined;
    if (this.embeddingService) {
      try {
        queryEmbedding = await this.embeddingService.embedOne(context.currentMessage);
      } catch {
        // Embedding failure is non-fatal — fall back to FTS + graph
      }
    }

    // Search with embedding-enhanced query when available
    const searchResults = await this.memoryManager.search({
      query: context.currentMessage,
      agentId: context.agentId,
      workspaceId: context.workspaceId,
      limit: 20,
      embedding: queryEmbedding,
    });

    // Score for injection and respect token budget
    const injections: InjectedMemory[] = [];
    let tokenCount = 0;

    for (const result of searchResults) {
      if (result.score < 0.35) continue;

      const contentTokens = estimateTokens(result.entry.content);
      if (tokenCount + contentTokens > context.tokenBudget) break;

      injections.push({
        memoryId: result.entry.id,
        content: result.entry.content,
        source: result.entry.type,
        score: result.score,
        reason: `${result.source} match (score: ${result.score.toFixed(2)})`,
      });

      tokenCount += contentTokens;

      // Refresh access for injected memories (bump decay)
      this.memoryManager.refreshAccess(result.entry.id, "injection").catch(() => {
        // Non-fatal
      });
    }

    return injections;
  }
}
