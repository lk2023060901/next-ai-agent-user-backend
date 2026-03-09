// ─── Reranker Types ─────────────────────────────────────────────────────────
//
// Reranking re-scores initial retrieval results using a cross-encoder model
// for higher accuracy than bi-encoder (embedding) similarity alone.
//
// Plugin injection point: replace with any reranking backend
// (Cohere, Jina, Voyage, local cross-encoder, etc.)

export interface Reranker {
  /** Rerank documents by relevance to the query. */
  rerank(params: RerankParams): Promise<RerankResult[]>;
}

export interface RerankParams {
  query: string;
  documents: RerankDocument[];
  /** Reranker model to use (e.g. "rerank-v3.5", "jina-reranker-v2-base-multilingual"). */
  model?: string;
  /** Return only the top-K results after reranking. */
  topK?: number;
}

export interface RerankDocument {
  /** Unique identifier (used to correlate results back to source). */
  id: string;
  /** Text content to score against the query. */
  content: string;
}

export interface RerankResult {
  id: string;
  /** Original index in the input documents array. */
  index: number;
  /** Relevance score (0–1, higher = more relevant). */
  score: number;
}

export interface RerankConfig {
  provider: string;        // "cohere" | "jina" | "voyage" | "custom"
  model: string;           // e.g. "rerank-v3.5"
  baseUrl?: string;        // Custom endpoint
  apiKey?: string;
  timeoutMs?: number;      // Default: 30_000
}
