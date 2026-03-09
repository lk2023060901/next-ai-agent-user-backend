import type { Message, ProviderAdapter } from "../providers/adapter.js";
import type {
  CoreMemorySnapshot,
  InjectedMemory,
  InjectionContext,
} from "../core/types.js";

// Re-export shared types for backward compatibility
export type { CoreMemorySnapshot, InjectedMemory, InjectionContext };

// ─── Memory Types ────────────────────────────────────────────────────────────

export type MemoryType =
  | "episodic"         // Conversation events ("User asked me to fix login bug on 3/9")
  | "semantic"         // Extracted facts ("JWT stored in localStorage and cookie")
  | "reflection"       // First-order reflections ("Auth system is a core concern")
  | "meta_reflection"  // Meta-reflections ("I tend to consult docs on auth topics")
  | "knowledge";       // KB document chunks

export type MemoryVisibility = "private" | "shared" | "public";

export type AccessType = "search" | "injection" | "tool" | "consolidation";

// ─── Memory Entry ────────────────────────────────────────────────────────────
//
// The central data type. Every memory (episodic, semantic, reflection, KB
// chunk) is represented as a MemoryEntry with unified scoring fields.

export interface MemoryEntry {
  id: string;
  type: MemoryType;
  agentId: string;
  workspaceId: string;
  content: string;

  // Embedding (nullable — computed async by embedding service)
  embedding?: Float32Array;

  // Importance — LLM-assessed 1-10 at write time
  importance: number;

  // Decay (Ebbinghaus forgetting curve)
  decayScore: number;       // Current retention 0–1 (1 = fresh, 0 = forgotten)
  halfLifeDays: number;     // Importance-based half-life
  accessCount: number;
  lastAccessedAt: number;   // Unix ms

  // Reflection metadata
  sourceIds: string[];      // Memory IDs that triggered this reflection
  depth: number;            // 0 = observation, 1 = reflection, 2+ = meta

  // Visibility (multi-agent sharing)
  visibility: MemoryVisibility;
  createdBy: string;        // Agent ID that created this memory

  // Lifecycle
  consolidated: boolean;

  // Timestamps
  createdAt: number;        // Unix ms
  updatedAt: number;        // Unix ms
}

// ─── New Memory Input ────────────────────────────────────────────────────────

export interface NewMemoryEntry {
  type: MemoryType;
  agentId: string;
  workspaceId: string;
  content: string;
  importance?: number;       // If omitted, LLM will assess
  sourceIds?: string[];
  depth?: number;
  visibility?: MemoryVisibility;
  embedding?: Float32Array;
}

// ─── Memory Search ───────────────────────────────────────────────────────────

export interface MemorySearchQuery {
  query: string;
  agentId: string;
  workspaceId: string;
  types?: MemoryType[];
  limit?: number;
  minScore?: number;
  includeDecayed?: boolean;  // Include memories with decay < 0.05
  embedding?: Float32Array;  // Pre-computed query embedding
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;             // Combined three-factor score
  breakdown: {
    recency: number;
    importance: number;
    relevance: number;
  };
  source: "vector" | "fts" | "graph";
}

// ─── Entity & Graph ──────────────────────────────────────────────────────────

export interface Entity {
  id: string;
  name: string;
  type: string;              // "person" | "concept" | "api" | "file" | "project" | ...
  description: string;
  embedding?: Float32Array;
  source: "kb" | "episode" | "reflection";
  createdAt: number;
  updatedAt: number;
}

export interface Relation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;      // "causes" | "precedes" | "contains" | "references" | ...
  description: string;
  weight: number;
  // Temporal validity (Graphiti bi-temporal model)
  tValid: number;            // Fact became true in reality
  tInvalid?: number;         // Fact ceased to be true
  tCreated: number;          // Fact entered the system
  tExpired?: number;         // Fact was superseded in the system
}

export interface EntitySource {
  type: "conversation" | "tool_result" | "kb_chunk";
  runId?: string;
  messageIndex?: number;
}

export interface GraphResult {
  entity: Entity;
  relations: Relation[];
  connected: Entity[];
}

// ─── Core Memory ─────────────────────────────────────────────────────────────
// CoreMemorySnapshot canonical definition lives in core/types.ts. Re-exported above.

export type CoreMemoryBlock = "persona" | "user" | "working" | "knowledgeSummary";

// ─── Reflection ──────────────────────────────────────────────────────────────

export interface ReflectionResult {
  reflections: MemoryEntry[];
  questionsGenerated: string[];
  memoriesConsidered: number;
}

// ─── Consolidation ───────────────────────────────────────────────────────────

export interface ConsolidationResult {
  summarized: number;
  merged: number;
  summaryMemoryIds: string[];
}

// ─── Decay ───────────────────────────────────────────────────────────────────

export interface DecayUpdateResult {
  updated: number;
  forgotten: number;   // decay < 0.05, effectively forgotten
}

// ─── Injection ───────────────────────────────────────────────────────────────
// InjectionContext and InjectedMemory canonical definitions live in core/types.ts.
// Re-exported above.

// ─── Memory Manager ──────────────────────────────────────────────────────────

export interface MemoryManager {
  // Write
  ingest(entry: NewMemoryEntry): Promise<string>;
  ingestBatch(entries: NewMemoryEntry[]): Promise<string[]>;

  // Unified search (across all sources)
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;

  // Core Memory
  getCoreMemory(agentId: string, workspaceId: string): Promise<CoreMemorySnapshot>;
  updateCoreMemory(
    agentId: string,
    workspaceId: string,
    block: CoreMemoryBlock,
    content: string,
  ): Promise<void>;

  // Knowledge graph
  extractEntities(text: string, source: EntitySource): Promise<Entity[]>;
  queryGraph(entityId: string, maxHops: number): Promise<GraphResult>;

  // Reflection
  checkReflectionTrigger(agentId: string, workspaceId: string): Promise<boolean>;
  executeReflection(agentId: string, workspaceId: string): Promise<ReflectionResult>;

  // Decay
  refreshAccess(memoryId: string, accessType: AccessType): Promise<void>;
  batchDecayUpdate(): Promise<DecayUpdateResult>;

  // Proactive injection
  getRelevantInjections(context: InjectionContext): Promise<InjectedMemory[]>;

  // Consolidation
  consolidate(agentId: string, workspaceId: string): Promise<ConsolidationResult>;
}

// ─── Half-Life Table (design doc §6.3) ───────────────────────────────────────

export const IMPORTANCE_HALF_LIFE: Record<string, number> = {
  temporary: 3,     // importance 1-2 → 3 days
  normal: 14,       // importance 3-4 → 14 days
  important: 60,    // importance 5-6 → 60 days
  critical: 180,    // importance 7-8 → 180 days
  permanent: 36500, // importance 9-10 → ~100 years (effectively permanent)
};

export function getHalfLifeDays(importance: number): number {
  if (importance <= 2) return IMPORTANCE_HALF_LIFE.temporary!;
  if (importance <= 4) return IMPORTANCE_HALF_LIFE.normal!;
  if (importance <= 6) return IMPORTANCE_HALF_LIFE.important!;
  if (importance <= 8) return IMPORTANCE_HALF_LIFE.critical!;
  return IMPORTANCE_HALF_LIFE.permanent!;
}

// ─── Scoring Weights ─────────────────────────────────────────────────────────

export const DEFAULT_SCORING_WEIGHTS = {
  recency: 0.3,
  importance: 0.3,
  relevance: 0.4,
} as const;

export const INJECTION_SCORING_WEIGHTS = {
  recency: 0.25,
  importance: 0.25,
  relevance: 0.50,
} as const;

/** Minimum injection score to be included in context. */
export const INJECTION_THRESHOLD = 0.35;

/** Decay below this value = effectively forgotten. */
export const DECAY_FORGOTTEN_THRESHOLD = 0.05;

/** Reflection trigger: cumulative importance of un-reflected memories. */
export const REFLECTION_IMPORTANCE_THRESHOLD = 150;

/** Consolidation trigger: cumulative tokens or turn count. */
export const CONSOLIDATION_TOKEN_THRESHOLD = 1400;
export const CONSOLIDATION_TURN_THRESHOLD = 8;
