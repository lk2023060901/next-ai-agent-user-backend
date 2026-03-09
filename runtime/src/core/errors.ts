// ─── Unified Error Hierarchy ────────────────────────────────────────────────
//
// Three error families:
// 1. RuntimeError — orchestrator, session, context overflow
// 2. ProviderError — LLM call failures (re-exported from providers/)
// 3. ToolError     — tool execution failures (re-exported from tools/)

export { ToolError, type ToolErrorCode } from "../tools/tool-types.js";
export { ProviderError, type ProviderErrorCode } from "../providers/adapter.js";

// ─── Runtime Error Codes ────────────────────────────────────────────────────

export type RuntimeErrorCode =
  | "ABORT"                  // Operation cancelled via AbortSignal
  | "TIMEOUT"                // Run/turn/tool exceeded time limit
  | "SESSION_CLOSED"         // Attempt to use a closed session
  | "SESSION_BUSY"           // Session already executing a run
  | "ORCHESTRATOR_FULL"      // All lane slots occupied
  | "ORCHESTRATOR_SHUTDOWN"  // Orchestrator is shutting down
  | "CONTEXT_OVERFLOW"       // Message history exceeds context window
  | "MAX_TURNS_EXCEEDED"     // AgentLoop hit maxTurns limit
  | "INTERNAL";              // Unexpected internal error

// ─── Base RuntimeError ──────────────────────────────────────────────────────

/**
 * Base error for runtime-level failures.
 *
 * Distinct from ProviderError (LLM layer) and ToolError (tool execution).
 * Used by orchestrator, session management, and context engine.
 */
export class RuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: RuntimeErrorCode,
    public readonly recoverable: boolean = false,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

// ─── Specialized Errors ─────────────────────────────────────────────────────

/** Thrown when an operation is aborted via AbortSignal. */
export class AbortError extends RuntimeError {
  constructor(message = "Operation aborted") {
    super(message, "ABORT", false);
    this.name = "AbortError";
  }
}

/** Thrown when an operation exceeds its timeout. */
export class TimeoutError extends RuntimeError {
  constructor(
    message = "Operation timed out",
    public readonly timeoutMs?: number,
  ) {
    super(message, "TIMEOUT", true);
    this.name = "TimeoutError";
  }
}
