// ─── Context Module ─────────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Replace the entire ContextEngine:
//    Implement the ContextEngine interface from context-types.ts
//
// 2. Replace individual sub-components:
//    Implement PromptBuilder, TokenBudgetAllocator, HistoryTrimmer,
//    Compactor, or MemoryInjector — inject via DefaultContextEngineOptions
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  ContextEngine,
  AssembleParams,
  AssembledContext,
  TokenBreakdown,
  TurnSummary,
  AfterRunParams,
  CompactionReason,
  CompactionResult,
  PromptBuilder,
  PromptBuildParams,
  ChannelContext,
  TokenBudgetAllocator,
  AllocationParams,
  TokenAllocation,
  HistoryTrimmer,
  TrimResult,
  ContextState,
  Compactor,
  MemoryInjector,
} from "./context-types.js";

// Shared types (canonical in core/types.ts, re-exported here)
export type {
  CoreMemorySnapshot,
  InjectedMemory,
  InjectionContext,
} from "./context-types.js";

// ─── Default implementations ────────────────────────────────────────────────

export {
  DefaultContextEngine,
  type DefaultContextEngineOptions,
} from "./context-engine.impl.js";

export { DefaultPromptBuilder } from "./prompt-builder.js";
export { DefaultTokenBudgetAllocator } from "./token-budget.js";
export { DefaultHistoryTrimmer } from "./history-trimmer.js";
export { DefaultCompactor } from "./compactor.js";
export { StubMemoryInjector } from "./memory-injector.js";
export { RealMemoryInjector } from "./real-memory-injector.js";
