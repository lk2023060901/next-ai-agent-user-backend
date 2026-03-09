import type { RunResult, RunStatus, RunUsage } from "../agent/agent-types.js";

// ─── Execution Lanes ────────────────────────────────────────────────────────

export type ExecutionLane =
  | "interactive" // User-initiated runs (highest priority)
  | "channel"     // Channel-triggered runs
  | "scheduled"   // Scheduled/cron runs
  | "background"; // Background tasks (memory consolidation, reflection)

export interface LaneConfig {
  lane: ExecutionLane;
  maxConcurrent: number;
  priority: number; // Lower = higher priority
  timeoutMs: number;
  retryPolicy: RetryPolicy;
}

export const DEFAULT_LANE_CONFIGS: readonly LaneConfig[] = [
  { lane: "interactive", maxConcurrent: 5,  priority: 0, timeoutMs: 300_000,  retryPolicy: { maxRetries: 2, backoffMs: 1000, backoffMultiplier: 2, maxBackoffMs: 10_000 } },
  { lane: "channel",     maxConcurrent: 10, priority: 1, timeoutMs: 180_000,  retryPolicy: { maxRetries: 3, backoffMs: 2000, backoffMultiplier: 2, maxBackoffMs: 30_000 } },
  { lane: "scheduled",   maxConcurrent: 3,  priority: 2, timeoutMs: 600_000,  retryPolicy: { maxRetries: 5, backoffMs: 5000, backoffMultiplier: 2, maxBackoffMs: 60_000 } },
  { lane: "background",  maxConcurrent: 2,  priority: 3, timeoutMs: 120_000,  retryPolicy: { maxRetries: 1, backoffMs: 3000, backoffMultiplier: 2, maxBackoffMs: 15_000 } },
];

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface OrchestratorRunRequest {
  runId: string;
  sessionKey: string;
  workspaceId: string;
  coordinatorAgentId: string;
  userRequest: string;
  lane: ExecutionLane;
  modelOverride?: string;
  idempotencyKey?: string;
}

export interface EnqueueResult {
  runId: string;
  status: "accepted" | "queued" | "rejected";
  position?: number;
  estimatedStartMs?: number;
}

export interface Orchestrator {
  enqueue(request: OrchestratorRunRequest): Promise<EnqueueResult>;
  getRunStatus(runId: string): RunStatus | undefined;
  getQueueDepth(): number;
  cancel(runId: string): Promise<void>;
  shutdown(): Promise<void>;
}

// ─── Retry Policy ────────────────────────────────────────────────────────────

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
}

/** Error codes from ProviderError that warrant a retry. */
export const RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  "RATE_LIMIT",
  "SERVICE_UNAVAILABLE",
  "TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_ERROR",
]);

/** Error codes that should never be retried. */
export const NON_RETRYABLE_ERRORS: ReadonlySet<string> = new Set([
  "AUTH_FAILED",
  "CONTENT_FILTER",
  "INVALID_REQUEST",
  "CONTEXT_LENGTH_EXCEEDED",
  "BILLING",
]);

// ─── Timeout Policy ─────────────────────────────────────────────────────────

export interface TimeoutPolicy {
  runTimeoutMs: number;
  turnTimeoutMs: number;
  toolTimeoutMs: number;
  gracefulShutdownMs: number;
}

export const DEFAULT_TIMEOUT_POLICY: TimeoutPolicy = {
  runTimeoutMs: 300_000,
  turnTimeoutMs: 120_000,
  toolTimeoutMs: 60_000,
  gracefulShutdownMs: 10_000,
};

// ─── Provider Rotator ────────────────────────────────────────────────────────

export type FailureReason =
  | "rate_limit"
  | "auth"
  | "billing"
  | "timeout"
  | "server_error";

export interface ProviderProfile {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  priority: number;
  cooldownUntil?: number; // Unix ms
  consecutiveFailures: number;
}

export interface ProviderRotator {
  current(): ProviderProfile | null;
  next(): ProviderProfile | null;
  markFailure(providerId: string, reason: FailureReason): void;
  markSuccess(providerId: string): void;
  isInCooldown(providerId: string): boolean;
}

// ─── Session Lock ────────────────────────────────────────────────────────────

export interface SessionLock {
  acquire(sessionId: string, timeoutMs?: number): Promise<LockRelease>;
}

export type LockRelease = () => void;

// ─── Run Handler ─────────────────────────────────────────────────────────────
//
// The orchestrator doesn't know how to resolve agent configs, build tools,
// or create provider adapters — that's the caller's job. The RunHandler is
// the callback provided at construction time that actually executes the run.

export interface RunHandlerContext {
  abortSignal: AbortSignal;
  timeoutMs: number;
  retryAttempt: number;
}

export type RunHandler = (
  request: OrchestratorRunRequest,
  context: RunHandlerContext,
) => Promise<RunResult>;

// ─── Internal Run Tracking ───────────────────────────────────────────────────

export interface TrackedRun {
  request: OrchestratorRunRequest;
  status: RunStatus;
  lane: ExecutionLane;
  abortController: AbortController;
  enqueuedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: RunResult;
}
