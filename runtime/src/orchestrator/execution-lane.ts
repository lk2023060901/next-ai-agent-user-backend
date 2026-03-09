import type { RunResult } from "../agent/agent-types.js";
import type {
  ExecutionLane,
  LaneConfig,
  OrchestratorRunRequest,
  TrackedRun,
} from "./orchestrator-types.js";
import { DEFAULT_LANE_CONFIGS } from "./orchestrator-types.js";

// ─── Lane State ──────────────────────────────────────────────────────────────

interface LaneState {
  config: LaneConfig;
  queue: QueuedItem[];
  running: number;
}

interface QueuedItem {
  run: TrackedRun;
  execute: () => Promise<void>;
}

// ─── Lane Manager ────────────────────────────────────────────────────────────

/**
 * Lane-based execution queue (design doc §3.2–3.3).
 *
 * Runs are placed in lanes by type. Each lane has independent concurrency
 * limits. Scheduling priority: lower lane.priority runs first when
 * multiple lanes have queued items.
 *
 * When a run completes (or fails), the lane slot opens and the next
 * eligible run is automatically dequeued.
 */
export class LaneManager {
  private readonly lanes: Map<ExecutionLane, LaneState>;
  private shuttingDown = false;

  constructor(configs?: readonly LaneConfig[]) {
    const effectiveConfigs = configs ?? DEFAULT_LANE_CONFIGS;
    this.lanes = new Map();
    for (const config of effectiveConfigs) {
      this.lanes.set(config.lane, {
        config,
        queue: [],
        running: 0,
      });
    }
  }

  /**
   * Submit a run to its lane. If a slot is available, execution starts
   * immediately. Otherwise the run is queued.
   *
   * Returns the queue position (0 = executing now).
   */
  submit(
    run: TrackedRun,
    executeFn: () => Promise<void>,
  ): { position: number; started: boolean } {
    if (this.shuttingDown) {
      return { position: -1, started: false };
    }

    const lane = this.lanes.get(run.lane);
    if (!lane) {
      // Unknown lane — reject
      return { position: -1, started: false };
    }

    const item: QueuedItem = { run, execute: executeFn };

    if (lane.running < lane.config.maxConcurrent) {
      // Slot available — execute immediately
      this.startItem(lane, item);
      return { position: 0, started: true };
    }

    // Queue it
    lane.queue.push(item);
    return { position: lane.queue.length, started: false };
  }

  /** Remove a queued (not yet running) item by runId. Returns true if found. */
  dequeue(runId: string): boolean {
    for (const lane of this.lanes.values()) {
      const idx = lane.queue.findIndex((q) => q.run.request.runId === runId);
      if (idx >= 0) {
        lane.queue.splice(idx, 1);
        return true;
      }
    }
    return false;
  }

  /** Total items across all lanes (queued + running). */
  totalDepth(): number {
    let total = 0;
    for (const lane of this.lanes.values()) {
      total += lane.queue.length + lane.running;
    }
    return total;
  }

  /** Total queued items (not yet running). */
  queuedCount(): number {
    let total = 0;
    for (const lane of this.lanes.values()) {
      total += lane.queue.length;
    }
    return total;
  }

  /** Get lane config for a given lane type. */
  getLaneConfig(lane: ExecutionLane): LaneConfig | undefined {
    return this.lanes.get(lane)?.config;
  }

  /** Stop accepting new runs and drain queues. */
  shutdown(): void {
    this.shuttingDown = true;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private startItem(lane: LaneState, item: QueuedItem): void {
    lane.running++;
    item.run.status = "running";
    item.run.startedAt = Date.now();

    // Fire and forget — completion triggers drainNext
    item.execute().finally(() => {
      lane.running--;
      this.drainNext();
    });
  }

  /**
   * After a run completes, try to start the next queued run.
   * Checks lanes by priority order.
   */
  private drainNext(): void {
    if (this.shuttingDown) return;

    // Sort lanes by priority (lowest = highest priority)
    const sorted = [...this.lanes.values()].sort(
      (a, b) => a.config.priority - b.config.priority,
    );

    for (const lane of sorted) {
      if (lane.running < lane.config.maxConcurrent && lane.queue.length > 0) {
        const next = lane.queue.shift()!;
        this.startItem(lane, next);
        return; // Start one at a time, re-evaluate on next completion
      }
    }
  }
}
