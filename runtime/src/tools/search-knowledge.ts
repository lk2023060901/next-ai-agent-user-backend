import { tool } from "ai";
import { z } from "zod";

export function makeSearchKnowledgeTool() {
  return tool({
    description: "Search the knowledge base for relevant information",
    parameters: z.object({
      query: z.string().describe("Search query"),
      knowledgeBaseId: z.string().optional().describe("Knowledge base ID to search in"),
      limit: z.number().optional().default(5).describe("Maximum number of results"),
    }),
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
  });
}
