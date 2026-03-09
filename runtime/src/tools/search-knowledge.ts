import { Type } from "@sinclair/typebox";
import type { RuntimeTool } from "./types.js";

const SearchKnowledgeParams = Type.Object({
  query: Type.String({ description: "Search query" }),
  knowledgeBaseId: Type.Optional(Type.String({ description: "Knowledge base ID to search in" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of results", default: 5 })),
});

export function makeSearchKnowledgeTool(): RuntimeTool<typeof SearchKnowledgeParams> {
  return {
    name: "search_knowledge",
    description: "Search the knowledge base for relevant information",
    parameters: SearchKnowledgeParams,
    execute: async ({ query, knowledgeBaseId, limit }) => {
      // Knowledge base search is a stub for MVP — returns empty results
      // In production this would call the service gRPC endpoint for vector search
      return {
        results: [],
        query,
        knowledgeBaseId: knowledgeBaseId ?? null,
        total: 0,
        note: "Knowledge base search not yet connected to embedding store",
      };
    },
  };
}
