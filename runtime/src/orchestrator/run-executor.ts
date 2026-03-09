import type { RunResult } from "../agent/agent-types.js";
import type {
  LaneConfig,
  OrchestratorRunRequest,
  RunHandler,
  SessionLock,
} from "./orchestrator-types.js";
import { executeWithRetry } from "./retry-policy.js";
import { RunTimeoutController } from "./timeout-controller.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface RunExecutorOptions {
  sessionLock: SessionLock;
  runHandler: RunHandler;
  /** Lock acquisition timeout in ms. */
  lockTimeoutMs?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Run executor — ties session lock, timeout, and retry together.
 *
 * Execution flow:
 * 1. Acquire session lock (serial execution per session)
 * 2. Create timeout controller (run-level abort)
 * 3. Execute with retry policy (backoff + provider rotation hook)
 * 4. Release session lock
 *
 * The actual run logic is delegated to the injected RunHandler.
 * The orchestrator provides the handler at construction time.
 */
export class RunExecutor {
  private readonly sessionLock: SessionLock;
  private readonly runHandler: RunHandler;
  private readonly lockTimeoutMs: number;

  constructor(options: RunExecutorOptions) {
    this.sessionLock = options.sessionLock;
    this.runHandler = options.runHandler;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  }

  async execute(
    request: OrchestratorRunRequest,
    laneConfig: LaneConfig,
    parentSignal?: AbortSignal,
  ): Promise<RunResult> {
    // 1. Acquire session lock
    const release = await this.sessionLock.acquire(
      request.sessionKey,
      this.lockTimeoutMs,
    );

    // 2. Create timeout controller
    const timeout = new RunTimeoutController(laneConfig.timeoutMs, parentSignal);

    try {
      // 3. Execute with retry
      const result = await executeWithRetry(
        async (attempt) => {
          if (timeout.signal.aborted) {
            throw new Error("Run timed out");
          }

          return this.runHandler(request, {
            abortSignal: timeout.signal,
            timeoutMs: laneConfig.timeoutMs,
            retryAttempt: attempt,
          });
        },
        laneConfig.retryPolicy,
        {
          abortSignal: timeout.signal,
          onRetry: (attempt, error, delayMs) => {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(
              `[run-executor] retry ${attempt}/${laneConfig.retryPolicy.maxRetries}`,
              { runId: request.runId, delay: delayMs, error: msg },
            );
          },
        },
      );

      return result;
    } finally {
      timeout.clear();
      release();
    }
  }
}
