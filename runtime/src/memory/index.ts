// ─── Memory Module ──────────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Replace the entire MemoryManager:
//    Implement the MemoryManager interface from memory-types.ts
//
// 2. Replace storage backends:
//    Implement MemoryStore, VectorIndex, FullTextIndex, GraphStore
//    from store/interfaces.ts (e.g. SQLite, PostgreSQL, Redis)
//
// 3. Replace individual lifecycle components:
//    Instantiate DefaultMemoryManager with custom sub-components
//    (DecayEngine, Consolidator, ReflectionEngine, etc.)
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  MemoryManager,
  MemoryEntry,
  NewMemoryEntry,
  MemoryType,
  MemoryVisibility,
  AccessType,
  MemorySearchQuery,
  MemorySearchResult,
  Entity,
  Relation,
  EntitySource,
  GraphResult,
  CoreMemoryBlock,
  ReflectionResult,
  ConsolidationResult,
  DecayUpdateResult,
} from "./memory-types.js";

export type {
  MemoryStore,
  VectorIndex,
  VectorSearchResult,
  FullTextIndex,
  FullTextSearchResult,
  GraphStore,
} from "./store/interfaces.js";

// ─── Shared types (from core/) ──────────────────────────────────────────────

export type {
  CoreMemorySnapshot,
  InjectedMemory,
  InjectionContext,
} from "./memory-types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export {
  IMPORTANCE_HALF_LIFE,
  getHalfLifeDays,
  DEFAULT_SCORING_WEIGHTS,
  INJECTION_SCORING_WEIGHTS,
  INJECTION_THRESHOLD,
  DECAY_FORGOTTEN_THRESHOLD,
  REFLECTION_IMPORTANCE_THRESHOLD,
  CONSOLIDATION_TOKEN_THRESHOLD,
  CONSOLIDATION_TURN_THRESHOLD,
} from "./memory-types.js";

// ─── Default implementations ────────────────────────────────────────────────

export {
  DefaultMemoryManager,
  type DefaultMemoryManagerOptions,
} from "./memory-manager.impl.js";

// Store (in-memory — swap with SQLite/etc. via plugin)
export {
  InMemoryMemoryStore,
  InMemoryVectorIndex,
  InMemoryFullTextIndex,
  InMemoryGraphStore,
} from "./store/in-memory-store.js";

// Lifecycle
export { DecayEngine } from "./lifecycle/decay-engine.js";
export { CoreMemoryManager } from "./lifecycle/core-memory-manager.js";
export { Consolidator } from "./lifecycle/consolidator.js";
export { ReflectionEngine } from "./lifecycle/reflection-engine.js";

// Extraction
export { MemoryExtractor } from "./extraction/memory-extractor.js";
export { EntityExtractor } from "./extraction/entity-extractor.js";

// Retrieval
export { HybridSearch } from "./retrieval/hybrid-search.js";
export { scoreMemory, reciprocalRankFusion } from "./retrieval/scoring.js";

// Sharing
export { VisibilityManager } from "./shared/visibility-manager.js";
