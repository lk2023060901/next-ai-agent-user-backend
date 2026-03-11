import { v4 as uuidv4 } from "uuid";
import type { ProviderAdapter } from "../../providers/adapter.js";
import type { EmbeddingService } from "../../embedding/embedding-types.js";
import type {
  MemoryEntry,
  MemorySearchQuery,
  ReflectionResult,
} from "../memory-types.js";
import {
  getHalfLifeDays,
  REFLECTION_IMPORTANCE_THRESHOLD,
} from "../memory-types.js";
import type { FullTextIndex, MemoryStore, VectorIndex } from "../store/interfaces.js";
import { HybridSearch } from "../retrieval/hybrid-search.js";

/**
 * Reflection engine (design doc §3, Stanford Generative Agents).
 *
 * Reflection flow:
 * 1. Check if cumulative importance of un-reflected memories > threshold (150)
 * 2. Take the 100 most recent memories
 * 3. Ask LLM to generate 3 high-level questions
 * 4. For each question, retrieve relevant memories via hybrid search
 * 5. Ask LLM to synthesize reflections from retrieved memories
 * 6. Write reflections back as new memory entries (can recurse)
 *
 * Expected frequency: ~2-3 reflections per day per agent.
 */
export class ReflectionEngine {
  private readonly store: MemoryStore;
  private readonly provider: ProviderAdapter;
  private readonly search: HybridSearch;
  private readonly ftsIndex: FullTextIndex | undefined;
  private readonly vectorIndex: VectorIndex | undefined;
  private readonly embeddingService: EmbeddingService | undefined;

  constructor(
    store: MemoryStore,
    provider: ProviderAdapter,
    search: HybridSearch,
    ftsIndex?: FullTextIndex,
    vectorIndex?: VectorIndex,
    embeddingService?: EmbeddingService,
  ) {
    this.store = store;
    this.provider = provider;
    this.search = search;
    this.ftsIndex = ftsIndex;
    this.vectorIndex = vectorIndex;
    this.embeddingService = embeddingService;
  }

  async shouldTrigger(agentId: string, workspaceId: string): Promise<boolean> {
    const sum = await this.store.sumUnreflectedImportance(agentId, workspaceId);
    return sum >= REFLECTION_IMPORTANCE_THRESHOLD;
  }

  async execute(agentId: string, workspaceId: string): Promise<ReflectionResult> {
    // 1. Get recent memories
    const recentMemories = await this.store.list({
      agentId,
      workspaceId,
      types: ["episodic", "semantic"],
      minDecay: 0.05,
      limit: 100,
      orderBy: "createdAt",
      orderDir: "desc",
    });

    if (recentMemories.length < 5) {
      return { reflections: [], questionsGenerated: [], memoriesConsidered: 0 };
    }

    // 2. Generate high-level questions
    const questions = await this.generateQuestions(recentMemories);

    // 3. For each question, search and synthesize
    const reflections: MemoryEntry[] = [];

    for (const question of questions) {
      const searchQuery: MemorySearchQuery = {
        query: question,
        agentId,
        workspaceId,
        limit: 15,
      };

      const searchResults = await this.search.search(searchQuery);
      if (searchResults.length === 0) continue;

      const reflection = await this.synthesize(
        question,
        searchResults.map((r) => r.entry),
        agentId,
        workspaceId,
      );

      if (reflection) {
        reflections.push(reflection);
        await this.store.insert(reflection);

        // Index the reflection for FTS and vector search so it can be
        // retrieved in future injection/search queries.
        if (this.ftsIndex) {
          try {
            await this.ftsIndex.upsert(reflection.id, reflection.content);
          } catch (err) {
            console.warn("[reflection] FTS indexing failed:", err instanceof Error ? err.message : err);
          }
        }
        if (this.vectorIndex && this.embeddingService) {
          try {
            const embedding = await this.embeddingService.embedOne(reflection.content);
            await this.vectorIndex.upsert(reflection.id, embedding);
          } catch (err) {
            console.warn("[reflection] vector indexing failed:", err instanceof Error ? err.message : err);
          }
        }
      }
    }

    return {
      reflections,
      questionsGenerated: questions,
      memoriesConsidered: recentMemories.length,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async generateQuestions(memories: MemoryEntry[]): Promise<string[]> {
    const memoryTexts = memories
      .slice(0, 50) // Limit context size
      .map((m, i) => `${i + 1}. [${m.type}] ${m.content}`)
      .join("\n");

    try {
      const result = await this.provider.complete({
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: QUESTION_GENERATION_PROMPT }],
          },
          {
            role: "user",
            content: [{ type: "text", text: `Recent observations:\n${memoryTexts}` }],
          },
        ],
        temperature: 0.7,
        maxTokens: 512,
      });

      return parseQuestions(result.content);
    } catch {
      return [];
    }
  }

  private async synthesize(
    question: string,
    relevantMemories: MemoryEntry[],
    agentId: string,
    workspaceId: string,
  ): Promise<MemoryEntry | null> {
    const memoryTexts = relevantMemories
      .map((m, i) => `${i + 1}. [${m.type}] ${m.content}`)
      .join("\n");

    try {
      const result = await this.provider.complete({
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: REFLECTION_SYNTHESIS_PROMPT }],
          },
          {
            role: "user",
            content: [{
              type: "text",
              text: `Question: ${question}\n\nRelevant memories:\n${memoryTexts}`,
            }],
          },
        ],
        temperature: 0.3,
        maxTokens: 512,
      });

      const parsed = parseReflection(result.content);
      if (!parsed) return null;

      const now = Date.now();
      const importance = parsed.importance;

      return {
        id: uuidv4(),
        type: "reflection",
        agentId,
        workspaceId,
        content: parsed.reflection,
        importance,
        decayScore: 1,
        halfLifeDays: getHalfLifeDays(importance),
        accessCount: 0,
        lastAccessedAt: now,
        sourceIds: relevantMemories.map((m) => m.id),
        depth: Math.max(...relevantMemories.map((m) => m.depth)) + 1,
        visibility: "private",
        createdBy: agentId,
        consolidated: false,
        createdAt: now,
        updatedAt: now,
      };
    } catch {
      return null;
    }
  }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const QUESTION_GENERATION_PROMPT = `Given a list of recent observations and memories, generate exactly 3 high-level questions that can be answered by synthesizing the information. These questions should seek patterns, insights, or overarching themes.

Return ONLY a JSON array of 3 strings. Example: ["What are the main priorities?", "How do these relate?", "What patterns emerge?"]`;

const REFLECTION_SYNTHESIS_PROMPT = `Given a question and relevant memories, synthesize a high-level reflection that answers the question. The reflection should be an insight or pattern, not just a summary.

Return ONLY a JSON object: { "reflection": "...", "importance": N }
where importance is 1-10 (higher for significant insights about patterns or strategies).`;

// ─── Parsers ─────────────────────────────────────────────────────────────────

function parseQuestions(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (Array.isArray(parsed)) {
      return parsed.filter((q): q is string => typeof q === "string").slice(0, 3);
    }
  } catch {
    // Fallback: extract lines that look like questions
    return text
      .split("\n")
      .map((l) => l.replace(/^\d+\.\s*/, "").trim())
      .filter((l) => l.endsWith("?"))
      .slice(0, 3);
  }
  return [];
}

function parseReflection(text: string): { reflection: string; importance: number } | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (
      typeof parsed === "object" && parsed !== null &&
      "reflection" in parsed && "importance" in parsed
    ) {
      const obj = parsed as { reflection: unknown; importance: unknown };
      if (typeof obj.reflection === "string" && typeof obj.importance === "number") {
        return {
          reflection: obj.reflection,
          importance: Math.max(1, Math.min(10, Math.round(obj.importance))),
        };
      }
    }
  } catch {
    // Cannot parse — skip this reflection
  }
  return null;
}
