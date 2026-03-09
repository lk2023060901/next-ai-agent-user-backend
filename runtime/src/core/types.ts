import type { Message } from "../providers/adapter.js";

// ─── Shared Types ────────────────────────────────────────────────────────────
//
// Canonical definitions for types referenced by multiple modules.
// Before this file, CoreMemorySnapshot, InjectedMemory, and InjectionContext
// were independently declared in both context/ and memory/ modules.
// Now both import from here via re-export for backward compatibility.

/**
 * Pinned context blocks — always present in the system prompt.
 * Managed by CoreMemoryManager (memory/lifecycle/).
 */
export interface CoreMemorySnapshot {
  persona?: string;
  user?: string;
  working?: string;
  knowledgeSummary?: string;
}

/**
 * A memory entry selected for proactive injection into the next LLM turn.
 *
 * The context engine receives these from the MemoryInjector and includes
 * them in the system prompt alongside core memory blocks.
 */
export interface InjectedMemory {
  memoryId: string;
  content: string;
  source: string;      // MemoryType value or other source identifier
  score: number;        // Combined three-factor score
  reason?: string;      // Human-readable injection reason (set by memory module)
}

/**
 * Context provided to the MemoryInjector for relevance-based retrieval.
 */
export interface InjectionContext {
  currentMessage: string;
  recentMessages: Message[];
  agentId: string;
  workspaceId: string;
  tokenBudget: number;
}

// ─── Common Patterns ────────────────────────────────────────────────────────

/** Components that hold resources and must be explicitly released. */
export interface Disposable {
  dispose(): Promise<void>;
}
