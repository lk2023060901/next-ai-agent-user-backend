import type { EmbeddingProvider } from "../embedding-types.js";

// ─── OpenAI-Compatible Embedding Provider ───────────────────────────────────
//
// Works with OpenAI API, Azure OpenAI, and any OpenAI-compatible endpoint.

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  baseUrl?: string; // Default: https://api.openai.com/v1
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: OpenAIEmbeddingOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async embed(texts: string[], model: string): Promise<Float32Array[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: texts,
        encoding_format: "float",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embedding error (${response.status}): ${body}`);
    }

    const json = await response.json() as OpenAIEmbeddingResponse;

    // Sort by index to ensure correct ordering
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }
}

// ─── Response Types ─────────────────────────────────────────────────────────

interface OpenAIEmbeddingResponse {
  data: Array<{
    index: number;
    embedding: number[];
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}
