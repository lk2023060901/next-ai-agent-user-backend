// ─── Providers Module ───────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Add a new LLM provider:
//    Implement the ProviderAdapter interface for any LLM backend
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  ProviderAdapter,
  ProviderCapabilities,
  Message,
  MessageRole,
  MessageContent,
  ProviderToolDefinition,
  StreamParams,
  StreamChunk,
  StopReason,
  CompleteParams,
  CompleteResult,
} from "./adapter.js";

export { ProviderError, type ProviderErrorCode } from "./adapter.js";
