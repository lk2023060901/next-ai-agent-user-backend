import { v4 as uuidv4 } from "uuid";
import type { Message, ProviderAdapter } from "../../providers/adapter.js";
import type { MemoryEntry, NewMemoryEntry } from "../memory-types.js";
import { getHalfLifeDays } from "../memory-types.js";

/**
 * Memory extractor (design doc §7.3).
 *
 * Extracts facts and observations from conversation turns.
 * Called after each run as part of the post-run pipeline.
 *
 * Extraction flow:
 * 1. Take the run's message history
 * 2. Ask LLM to extract discrete facts/observations
 * 3. Each fact gets an importance score (1-10)
 * 4. Facts are written as new memory entries
 */
export class MemoryExtractor {
  private readonly provider: ProviderAdapter;

  constructor(provider: ProviderAdapter) {
    this.provider = provider;
  }

  async extract(
    messages: Message[],
    agentId: string,
    workspaceId: string,
  ): Promise<NewMemoryEntry[]> {
    if (messages.length < 2) return [];

    // Build conversation text for extraction
    const conversationText = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => {
        const role = m.role.toUpperCase();
        const text = m.content
          .map((c) => ("text" in c ? c.text : ""))
          .filter(Boolean)
          .join(" ");
        return `${role}: ${text}`;
      })
      .join("\n")
      .slice(0, 8000); // Limit context size

    try {
      const result = await this.provider.complete({
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: EXTRACTION_PROMPT }],
          },
          {
            role: "user",
            content: [{ type: "text", text: conversationText }],
          },
        ],
        temperature: 0.1,
        maxTokens: 1024,
      });

      return parseExtractions(result.content, agentId, workspaceId);
    } catch {
      return [];
    }
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract discrete facts and observations from this conversation. Each fact should be a standalone statement that could be useful in future conversations.

Focus on:
- Decisions made and their reasoning
- User preferences and requirements
- Technical facts (APIs, configurations, patterns)
- Task context (what was done, what's pending)
- Important relationships between concepts

Do NOT extract:
- Trivial pleasantries or greetings
- Information that is temporary and won't be useful later
- Exact code snippets (too long)

Return a JSON array of objects: [{ "content": "...", "importance": N, "type": "episodic"|"semantic" }]
importance: 1 (trivial) to 10 (critical architectural decision)
type: "episodic" for events/actions, "semantic" for facts/knowledge`;

// ─── Parser ──────────────────────────────────────────────────────────────────

function parseExtractions(
  text: string,
  agentId: string,
  workspaceId: string,
): NewMemoryEntry[] {
  try {
    // Try to find JSON array in the response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isValidExtraction)
      .map((item) => ({
        type: item.type === "semantic" ? "semantic" as const : "episodic" as const,
        agentId,
        workspaceId,
        content: item.content,
        importance: Math.max(1, Math.min(10, Math.round(item.importance))),
        visibility: "private" as const,
      }));
  } catch {
    return [];
  }
}

function isValidExtraction(item: unknown): item is {
  content: string;
  importance: number;
  type: string;
} {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.content === "string" &&
    obj.content.length > 10 &&
    typeof obj.importance === "number" &&
    typeof obj.type === "string"
  );
}
