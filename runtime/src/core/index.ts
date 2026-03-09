// ─── Core Interface Contract Layer ───────────────────────────────────────────
//
// Unified import surface for the Agent Runtime's key abstractions.
//
// Usage:
//   import type { AgentSession, EventBus, ProviderAdapter } from "../core/index.js";
//
// Instead of:
//   import type { AgentSession } from "../agent/agent-types.js";
//   import type { EventBus } from "../events/event-types.js";
//   import type { ProviderAdapter } from "../providers/adapter.js";

// ─── Shared Types ───────────────────────────────────────────────────────────

export type {
  CoreMemorySnapshot,
  InjectedMemory,
  InjectionContext,
  Disposable,
} from "./types.js";

// ─── Errors ─────────────────────────────────────────────────────────────────

export {
  RuntimeError,
  AbortError,
  TimeoutError,
  ToolError,
  ProviderError,
} from "./errors.js";

export type {
  RuntimeErrorCode,
  ToolErrorCode,
  ProviderErrorCode,
} from "./errors.js";

// ─── Agent Session ──────────────────────────────────────────────────────────

export type {
  AgentSession,
  SessionStatus,
  CreateSessionParams,
  SessionSummary,
} from "./agent-session.js";

// ─── Session Manager ────────────────────────────────────────────────────────

export type { SessionManager } from "./session-manager.js";

// ─── Session Store ──────────────────────────────────────────────────────────

export type {
  SessionStore,
  SessionRecord,
} from "../agent/agent-types.js";

// ─── Agent Loop ─────────────────────────────────────────────────────────────

export type {
  AgentLoop,
  AgentLoopParams,
  AgentConfig,
  MessageHistory,
} from "./agent-loop.js";

// ─── Run Context ────────────────────────────────────────────────────────────

export type {
  RunContext,
  RunStatus,
  RunUsage,
  RunResult,
  ExecuteRunParams,
} from "./run-context.js";

// ─── Context Engine ─────────────────────────────────────────────────────────

export type {
  ContextEngine,
  AssembleParams,
  AssembledContext,
  TokenBreakdown,
  CompactionReason,
  CompactionResult,
  ChannelContext,
} from "./context-engine.js";

// ─── Cross-module Re-exports ────────────────────────────────────────────────
//
// Key interfaces from other modules, exposed here for convenience.
// Consumers can import everything from "core/index.js" instead of
// reaching into module-specific type files.

export type {
  EventBus,
  EventType,
  AgentEvent,
  EmitEvent,
  RunMetadata,
} from "../events/event-types.js";

export type {
  ProviderAdapter,
  Message,
  ProviderCapabilities,
  StreamChunk,
  CompleteResult,
} from "../providers/adapter.js";

export type {
  ToolRegistry,
  ToolRuntime,
  AgentTool,
  ToolContext,
  ToolResult,
  ToolDefinition,
} from "../tools/tool-types.js";

export type {
  Orchestrator,
  OrchestratorRunRequest,
  EnqueueResult,
  ExecutionLane,
} from "../orchestrator/orchestrator-types.js";

export type {
  MemoryManager,
  MemoryEntry,
  MemorySearchQuery,
  MemorySearchResult,
} from "../memory/memory-types.js";

export type {
  DatabaseManager,
  DatabaseManagerOptions,
} from "../db/database-types.js";

export type {
  ObservabilityStore,
  UsageRecord,
  RunMetric,
  ToolMetric,
  UsageQueryParams,
  UsageSummary,
  UsageByModel,
  UsageByAgent,
  UsageByProvider,
  RunAgentBreakdown,
  RunAgentUsage,
} from "../db/observability-types.js";
