import { v4 as uuidv4 } from "uuid";
import type { ProviderAdapter } from "../../providers/adapter.js";
import type { Entity, EntitySource } from "../memory-types.js";

/**
 * Entity extractor (design doc §5.3).
 *
 * Extracts named entities from text for knowledge graph construction.
 *
 * Pipeline:
 * 1. Process current message + recent context
 * 2. LLM extracts entities (with reflexion to reduce hallucination)
 * 3. Entity names are prepared for embedding (done by embedding service)
 * 4. Cosine similarity search for disambiguation (done by graph store)
 *
 * This module handles steps 1-2. Steps 3-4 are performed by the caller
 * (MemoryManager) using the embedding service and graph store.
 */
export class EntityExtractor {
  private readonly provider: ProviderAdapter;

  constructor(provider: ProviderAdapter) {
    this.provider = provider;
  }

  async extract(text: string, source: EntitySource): Promise<Entity[]> {
    if (text.length < 20) return [];

    try {
      const result = await this.provider.complete({
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: ENTITY_EXTRACTION_PROMPT }],
          },
          {
            role: "user",
            content: [{ type: "text", text: text.slice(0, 4000) }],
          },
        ],
        temperature: 0,
        maxTokens: 512,
      });

      return parseEntities(result.content, source);
    } catch {
      return [];
    }
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const ENTITY_EXTRACTION_PROMPT = `Extract named entities from the following text. Focus on:
- People, roles, and teams
- Technical concepts (APIs, frameworks, protocols)
- Projects and products
- Files and code artifacts
- Configurations and settings

Return a JSON array: [{ "name": "...", "type": "person"|"concept"|"api"|"file"|"project"|"config"|"other", "description": "brief description" }]

Only extract entities that are clearly identifiable. Do not guess or hallucinate entities.`;

// ─── Parser ──────────────────────────────────────────────────────────────────

function parseEntities(text: string, source: EntitySource): Entity[] {
  try {
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];

    const now = Date.now();
    const entitySource = source.type === "kb_chunk" ? "kb" as const
      : source.type === "conversation" ? "episode" as const
      : "episode" as const;

    return parsed
      .filter(isValidEntity)
      .map((item) => ({
        id: uuidv4(),
        name: item.name,
        type: item.type,
        description: item.description || "",
        source: entitySource,
        createdAt: now,
        updatedAt: now,
      }));
  } catch {
    return [];
  }
}

function isValidEntity(item: unknown): item is {
  name: string;
  type: string;
  description?: string;
} {
  if (typeof item !== "object" || item === null) return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    obj.name.length > 0 &&
    typeof obj.type === "string"
  );
}
