// ─── Orchestrator Module ────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Replace the entire Orchestrator:
//    Implement the Orchestrator interface from orchestrator-types.ts
//
// 2. Replace SessionLock:
//    Implement the SessionLock interface (e.g. Redis distributed lock)
//
// 3. Replace ProviderRotator:
//    Implement the ProviderRotator interface for custom rotation logic
//
// 4. Customize lane configs:
//    Pass custom LaneConfig[] to DefaultOrchestratorOptions
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  Orchestrator,
  OrchestratorRunRequest,
  EnqueueResult,
  ExecutionLane,
  LaneConfig,
  RetryPolicy,
  TimeoutPolicy,
  ProviderProfile,
  ProviderRotator,
  FailureReason,
  SessionLock,
  LockRelease,
  RunHandler,
  RunHandlerContext,
  TrackedRun,
} from "./orchestrator-types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export {
  DEFAULT_LANE_CONFIGS,
  RETRYABLE_ERRORS,
  NON_RETRYABLE_ERRORS,
  DEFAULT_TIMEOUT_POLICY,
} from "./orchestrator-types.js";

// ─── Default implementations ────────────────────────────────────────────────

export {
  DefaultOrchestrator,
  type DefaultOrchestratorOptions,
} from "./orchestrator.impl.js";

export { LaneManager } from "./execution-lane.js";
export { RunExecutor } from "./run-executor.js";
export { InMemorySessionLock } from "./session-lock.js";
export { DefaultProviderRotator } from "./provider-rotator.js";
export { RunTimeoutController } from "./timeout-controller.js";
export { executeWithRetry } from "./retry-policy.js";
