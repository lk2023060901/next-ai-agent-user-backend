import {
  DECAY_FORGOTTEN_THRESHOLD,
  DEFAULT_SCORING_WEIGHTS,
  type MemoryEntry,
  type MemorySearchResult,
} from "../memory-types.js";

/**
 * Three-factor memory scoring (design doc §3.2, Stanford Generative Agents).
 *
 * score = α_recency × recency + α_importance × importance + α_relevance × relevance
 *
 * - Recency: exponential decay based on time since last access
 * - Importance: LLM-assessed 1-10, normalized to 0-1
 * - Relevance: cosine similarity between query and memory embeddings
 */

export interface ScoringWeights {
  recency: number;
  importance: number;
  relevance: number;
}

export function scoreMemory(
  entry: MemoryEntry,
  relevanceSimilarity: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): MemorySearchResult["breakdown"] & { score: number } {
  const recency = computeRecencyScore(entry);
  const importance = normalizeImportance(entry.importance);
  const relevance = Math.max(0, Math.min(1, relevanceSimilarity));

  const score =
    weights.recency * recency +
    weights.importance * importance +
    weights.relevance * relevance;

  return { score, recency, importance, relevance };
}

/**
 * Recency score: uses the entry's current decayScore directly.
 * The decay engine maintains this value via Ebbinghaus curve.
 */
function computeRecencyScore(entry: MemoryEntry): number {
  return entry.decayScore;
}

/**
 * Normalize importance from 1-10 to 0-1.
 */
function normalizeImportance(importance: number): number {
  return Math.max(0, Math.min(1, (importance - 1) / 9));
}

/**
 * Filter out effectively forgotten memories.
 */
export function isRemembered(entry: MemoryEntry): boolean {
  return entry.decayScore >= DECAY_FORGOTTEN_THRESHOLD;
}

/**
 * Reciprocal Rank Fusion — merge results from multiple search sources.
 *
 * RRF(d) = Σ 1 / (k + rank_i(d))
 * where k is a constant (typically 60) and rank_i is the rank in source i.
 */
export function reciprocalRankFusion(
  ...rankedLists: Array<Array<{ memoryId: string; score: number }>>
): Array<{ memoryId: string; fusedScore: number }> {
  const k = 60;
  const scores = new Map<string, number>();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank]!;
      const current = scores.get(item.memoryId) ?? 0;
      scores.set(item.memoryId, current + 1 / (k + rank + 1));
    }
  }

  return [...scores.entries()]
    .map(([memoryId, fusedScore]) => ({ memoryId, fusedScore }))
    .sort((a, b) => b.fusedScore - a.fusedScore);
}
