import type {
  Reranker,
  RerankParams,
  RerankResult,
  RerankConfig,
} from "../reranker.js";

// ─── Default Reranker (Cohere/Jina/OpenAI-compatible) ───────────────────────
//
// Most reranking providers follow the same API format:
//   POST /rerank  { model, query, documents, top_n }
//   → { results: [{ index, relevance_score }] }
//
// Works with: Cohere (/v2/rerank), Jina (/v1/rerank), Voyage, and any
// OpenAI-compatible reranking endpoint.

const DEFAULT_TIMEOUT_MS = 30_000;

export class DefaultReranker implements Reranker {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor(config: RerankConfig) {
    this.apiKey = config.apiKey ?? "";
    this.baseUrl = (config.baseUrl ?? resolveBaseUrl(config.provider)).replace(/\/$/, "");
    this.defaultModel = config.model;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async rerank(params: RerankParams): Promise<RerankResult[]> {
    const model = params.model ?? this.defaultModel;
    const documents = params.documents.map((d) => d.content);

    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        query: params.query,
        documents,
        top_n: params.topK ?? documents.length,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Reranker error (${response.status}): ${body}`);
    }

    const json = await response.json() as RerankAPIResponse;

    return json.results.map((r) => ({
      id: params.documents[r.index]!.id,
      index: r.index,
      score: r.relevance_score,
    }));
  }
}

// ─── Provider URL Mapping ───────────────────────────────────────────────────

function resolveBaseUrl(provider: string): string {
  switch (provider) {
    case "cohere": return "https://api.cohere.ai/v2";
    case "jina": return "https://api.jina.ai/v1";
    case "voyage": return "https://api.voyageai.com/v1";
    default: return "https://api.cohere.ai/v2"; // Fallback
  }
}

// ─── Response Types ─────────────────────────────────────────────────────────

interface RerankAPIResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
}
