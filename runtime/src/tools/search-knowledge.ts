import { Type } from "@sinclair/typebox";
import type { RuntimeTool, ToolContext } from "./types.js";
import type { Reranker } from "../embedding/reranker.js";
import { grpcClient, type KBSearchResult, type KnowledgeBaseInfo } from "../grpc/client.js";

// ─── Parameters ─────────────────────────────────────────────────────────────

const SearchKnowledgeParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  knowledgeBaseId: Type.Optional(
    Type.String({ description: "Specific knowledge base ID. Omit to search all workspace KBs." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of results to return", default: 5 }),
  ),
});

// ─── Dependencies ───────────────────────────────────────────────────────────

export interface SearchKnowledgeDeps {
  workspaceId: string;
  /** Optional reranker — if provided, results are re-scored after initial retrieval. */
  reranker?: Reranker;
  /** Reranker model override (if not set, uses KB-configured rerankerModel). */
  rerankerModel?: string;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function makeSearchKnowledgeTool(
  deps: SearchKnowledgeDeps,
): RuntimeTool<typeof SearchKnowledgeParams> {
  // Cache KB configs per knowledge base (refreshed per search_knowledge call lifecycle)
  let kbConfigCache: Map<string, KnowledgeBaseInfo> | null = null;

  return {
    name: "search_knowledge",
    description:
      "Search the knowledge base for relevant information. " +
      "Returns document chunks ranked by relevance to the query.",
    parameters: SearchKnowledgeParams,

    execute: async (
      args: { query: string; knowledgeBaseId?: string; limit?: number },
      _context: ToolContext,
    ) => {
      const { query, knowledgeBaseId, limit = 5 } = args;

      // ─── 1. Determine which KBs to search ──────────────────────────────
      let kbIds: string[];
      if (knowledgeBaseId) {
        kbIds = [knowledgeBaseId];
      } else {
        // Search all workspace KBs
        const kbConfigs = await getKBConfigs(deps.workspaceId, kbConfigCache);
        kbConfigCache = kbConfigs;
        kbIds = [...kbConfigs.keys()];
      }

      if (kbIds.length === 0) {
        return { results: [], query, total: 0 };
      }

      // ─── 2. Initial retrieval via gRPC (service handles vector search) ─
      // Over-fetch for reranking: request 3x the desired limit
      const overFetchK = deps.reranker ? limit * 3 : limit;

      const searchPromises = kbIds.map((kbId) =>
        grpcClient
          .searchKnowledgeBase({
            knowledgeBaseId: kbId,
            query,
            topK: overFetchK,
          })
          .then((res) => res.results.map((r) => ({ ...r, knowledgeBaseId: kbId })))
          .catch(() => [] as Array<KBSearchResult & { knowledgeBaseId: string }>),
      );

      const allResults = (await Promise.all(searchPromises)).flat();

      if (allResults.length === 0) {
        return { results: [], query, total: 0 };
      }

      // ─── 3. Rerank (optional) ──────────────────────────────────────────
      let finalResults = allResults;

      if (deps.reranker && allResults.length > 1) {
        // Determine reranker model: explicit override > KB config > undefined (use default)
        let rerankerModel = deps.rerankerModel;
        if (!rerankerModel && kbConfigCache) {
          // Use the first KB's rerankerModel (all KBs in a workspace typically share config)
          const firstKB = kbConfigCache.get(kbIds[0]!);
          if (firstKB?.rerankerModel) {
            rerankerModel = firstKB.rerankerModel;
          }
        }

        try {
          const rerankResults = await deps.reranker.rerank({
            query,
            documents: allResults.map((r) => ({ id: r.id, content: r.content })),
            model: rerankerModel,
            topK: limit,
          });

          // Map rerank scores back to results
          const rerankMap = new Map(rerankResults.map((r) => [r.id, r.score]));
          finalResults = allResults
            .map((r) => ({
              ...r,
              // Use rerank score if available, otherwise keep original
              score: rerankMap.get(r.id) ?? r.score,
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
        } catch {
          // Reranker failure is non-fatal — fall back to original scores
          finalResults = allResults
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
        }
      } else {
        // No reranker — just sort by score and take top-K
        finalResults = allResults
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }

      // ─── 4. Format results for LLM consumption ────────────────────────
      return {
        results: finalResults.map((r) => ({
          id: r.id,
          documentId: r.documentId,
          documentName: r.documentName,
          content: r.content,
          score: r.score,
          chunkIndex: r.chunkIndex,
          knowledgeBaseId: r.knowledgeBaseId,
        })),
        query,
        total: finalResults.length,
      };
    },
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

async function getKBConfigs(
  workspaceId: string,
  cache: Map<string, KnowledgeBaseInfo> | null,
): Promise<Map<string, KnowledgeBaseInfo>> {
  if (cache) return cache;

  const { knowledgeBases } = await grpcClient.listKnowledgeBases(workspaceId);
  const map = new Map<string, KnowledgeBaseInfo>();
  for (const kb of knowledgeBases) {
    map.set(kb.id, kb);
  }
  return map;
}
