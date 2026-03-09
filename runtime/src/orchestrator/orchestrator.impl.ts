import type { RunResult, RunStatus } from "../agent/agent-types.js";
import type { EventBus } from "../events/event-types.js";
import { LaneManager } from "./execution-lane.js";
import type {
  EnqueueResult,
  LaneConfig,
  Orchestrator,
  OrchestratorRunRequest,
  RunHandler,
  SessionLock,
  TrackedRun,
} from "./orchestrator-types.js";
import { DEFAULT_LANE_CONFIGS } from "./orchestrator-types.js";
import { RunExecutor } from "./run-executor.js";
import { InMemorySessionLock } from "./session-lock.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DefaultOrchestratorOptions {
  runHandler: RunHandler;
  eventBus: EventBus;
  laneConfigs?: readonly LaneConfig[];
  lockTimeoutMs?: number;

  // ─── Optional overrides (plugin injection points) ─────────────────────
  sessionLock?: SessionLock;
  laneManager?: LaneManager;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Default orchestrator.
 *
 * Ties lane-based scheduling, session locking, timeout control, and
 * retry together. The caller provides a RunHandler that performs the
 * actual execution (resolving agent config, building tools, calling
 * session.executeRun).
 *
 * Lifecycle:
 * 1. enqueue() — track the run, submit to lane manager
 * 2. Lane manager starts the run when a slot opens
 * 3. RunExecutor acquires session lock, applies timeout + retry
 * 4. RunHandler performs the actual work
 * 5. Completion/failure updates tracking and emits events
 */
export class DefaultOrchestrator implements Orchestrator {
  private readonly laneManager: LaneManager;
  private readonly runExecutor: RunExecutor;
  private readonly eventBus: EventBus;
  private readonly runs = new Map<string, TrackedRun>();
  private readonly shutdownAc = new AbortController();

  constructor(options: DefaultOrchestratorOptions) {
    const configs = options.laneConfigs ?? DEFAULT_LANE_CONFIGS;

    this.laneManager = options.laneManager ?? new LaneManager(configs);
    this.eventBus = options.eventBus;

    this.runExecutor = new RunExecutor({
      sessionLock: options.sessionLock ?? new InMemorySessionLock(),
      runHandler: options.runHandler,
      lockTimeoutMs: options.lockTimeoutMs,
    });
  }

  async enqueue(request: OrchestratorRunRequest): Promise<EnqueueResult> {
    if (this.laneManager.isShuttingDown) {
      return { runId: request.runId, status: "rejected" };
    }

    // Idempotency check
    if (this.runs.has(request.runId)) {
      const existing = this.runs.get(request.runId)!;
      return {
        runId: request.runId,
        status: existing.status === "pending" ? "queued" : "accepted",
      };
    }

    // Create tracked run
    const tracked: TrackedRun = {
      request,
      status: "pending",
      lane: request.lane,
      abortController: new AbortController(),
      enqueuedAt: Date.now(),
    };

    this.runs.set(request.runId, tracked);

    // Get lane config for timeout/retry
    const laneConfig = this.laneManager.getLaneConfig(request.lane);
    if (!laneConfig) {
      tracked.status = "failed";
      return { runId: request.runId, status: "rejected" };
    }

    // Submit to lane manager
    const { position, started } = this.laneManager.submit(
      tracked,
      () => this.executeTracked(tracked, laneConfig),
    );

    if (position < 0) {
      tracked.status = "failed";
      return { runId: request.runId, status: "rejected" };
    }

    return {
      runId: request.runId,
      status: started ? "accepted" : "queued",
      position: started ? undefined : position,
    };
  }

  getRunStatus(runId: string): RunStatus | undefined {
    return this.runs.get(runId)?.status;
  }

  getQueueDepth(): number {
    return this.laneManager.queuedCount();
  }

  async cancel(runId: string): Promise<void> {
    const tracked = this.runs.get(runId);
    if (!tracked) return;

    // If queued, remove from lane
    if (tracked.status === "pending") {
      this.laneManager.dequeue(runId);
      tracked.status = "cancelled";
      tracked.completedAt = Date.now();
      return;
    }

    // If running, abort
    if (tracked.status === "running") {
      tracked.abortController.abort();
      tracked.status = "cancelled";
      tracked.completedAt = Date.now();
    }
  }

  async shutdown(): Promise<void> {
    this.laneManager.shutdown();
    this.shutdownAc.abort();

    // Abort all running runs
    for (const tracked of this.runs.values()) {
      if (tracked.status === "running" || tracked.status === "pending") {
        tracked.abortController.abort();
        tracked.status = "cancelled";
        tracked.completedAt = Date.now();
      }
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async executeTracked(
    tracked: TrackedRun,
    laneConfig: LaneConfig,
  ): Promise<void> {
    // Combine run-level abort with orchestrator-level shutdown signal
    const combinedAc = new AbortController();
    const onRunAbort = () => combinedAc.abort();
    const onShutdown = () => combinedAc.abort();
    tracked.abortController.signal.addEventListener("abort", onRunAbort, { once: true });
    this.shutdownAc.signal.addEventListener("abort", onShutdown, { once: true });

    // Emit run-start
    if (this.eventBus.hasRun(tracked.request.runId)) {
      this.eventBus.emit(tracked.request.runId, {
        type: "run-start",
        data: {
          sessionKey: tracked.request.sessionKey,
          userRequest: tracked.request.userRequest,
          coordinatorAgentId: tracked.request.coordinatorAgentId,
        },
      });
    }

    try {
      const result = await this.runExecutor.execute(
        tracked.request,
        laneConfig,
        combinedAc.signal,
      );

      tracked.status = result.status === "completed" ? "completed" : "failed";
      tracked.result = result;
      tracked.completedAt = Date.now();

      // Emit run-end
      if (this.eventBus.hasRun(tracked.request.runId)) {
        this.eventBus.emit(tracked.request.runId, {
          type: "run-end",
          data: {
            status: result.status,
            usage: {
              coordinatorInputTokens: result.usage.inputTokens,
              coordinatorOutputTokens: result.usage.outputTokens,
              subAgentInputTokens: 0,
              subAgentOutputTokens: 0,
              totalTokens: result.usage.totalTokens,
            },
          },
        });
      }
    } catch (err) {
      tracked.status = "failed";
      tracked.completedAt = Date.now();

      const message = err instanceof Error ? err.message : String(err);

      if (this.eventBus.hasRun(tracked.request.runId)) {
        this.eventBus.emit(tracked.request.runId, {
          type: "error",
          data: { message },
        });

        this.eventBus.emit(tracked.request.runId, {
          type: "run-end",
          data: { status: "failed" },
        });
      }
    } finally {
      tracked.abortController.signal.removeEventListener("abort", onRunAbort);
      this.shutdownAc.signal.removeEventListener("abort", onShutdown);
    }
  }
}
