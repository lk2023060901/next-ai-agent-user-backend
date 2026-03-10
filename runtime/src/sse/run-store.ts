import type { SseEmitter, SseEvent } from "./emitter.js";

export type RunState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RunParams {
  sessionId: string;
  workspaceId: string;
  userRequest: string;
  coordinatorAgentId: string;
  startCandidateOffset?: number;
  modelIdOverride?: string;
}

interface StoredEvent {
  seq: number;
  event: SseEvent;
}

interface IdempotencyEntry {
  runId: string;
  fingerprint: string;
  createdAt: number;
}

interface RunEntry {
  runId: string;
  params: RunParams;
  state: RunState;
  createdAt: number;
  updatedAt: number;
  nextSeq: number;
  events: StoredEvent[];
  subscribers: Map<number, SseEmitter>;
  startPromise?: Promise<void>;
  terminal: boolean;
}

export interface RunSnapshot {
  runId: string;
  state: RunState;
  terminal: boolean;
  lastSeq: number;
}

export interface SubscribeResult {
  unsubscribe: () => void;
  replayed: number;
  snapshot: RunSnapshot;
}

export interface CreateRunResult {
  runId: string;
  deduplicated: boolean;
}

export interface RunStoreOptions {
  maxEventsPerRun: number;
  runRetentionMs: number;
  idempotencyTtlMs: number;
  cleanupIntervalMs: number;
}

export interface CreateRuntimeRunInput {
  params: RunParams;
  idempotencyKey?: string;
  fingerprint: string;
  createRun: () => Promise<{ runId: string }>;
}

export class IdempotencyConflictError extends Error {
  code = "IDEMPOTENCY_CONFLICT";
}

function nowMs(): number {
  return Date.now();
}

function isTerminalState(state: RunState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function parseNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

export class RunStore {
  private readonly runs = new Map<string, RunEntry>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly options: RunStoreOptions;
  private nextSubscriberId = 1;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options?: Partial<RunStoreOptions>) {
    this.options = {
      maxEventsPerRun: Math.max(100, Math.min(5000, parseNonNegativeInt(options?.maxEventsPerRun) || 1200)),
      runRetentionMs: Math.max(60_000, parseNonNegativeInt(options?.runRetentionMs) || 30 * 60_000),
      idempotencyTtlMs: Math.max(10_000, parseNonNegativeInt(options?.idempotencyTtlMs) || 10 * 60_000),
      cleanupIntervalMs: Math.max(10_000, parseNonNegativeInt(options?.cleanupIntervalMs) || 30_000),
    };
    this.cleanupTimer = setInterval(() => this.cleanup(), this.options.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  close(): void {
    clearInterval(this.cleanupTimer);
  }

  getSnapshot(runId: string): RunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      runId: run.runId,
      state: run.state,
      terminal: run.terminal,
      lastSeq: run.nextSeq - 1,
    };
  }

  async createRuntimeRun(input: CreateRuntimeRunInput): Promise<CreateRunResult> {
    const idempotencyKey = this.normalizeIdempotencyKey(input.params.workspaceId, input.idempotencyKey);
    const now = nowMs();

    if (idempotencyKey) {
      const cached = this.idempotency.get(idempotencyKey);
      if (cached && now - cached.createdAt <= this.options.idempotencyTtlMs) {
        if (cached.fingerprint !== input.fingerprint) {
          throw new IdempotencyConflictError("Idempotency key reused with different request payload");
        }
        if (this.runs.has(cached.runId)) {
          return { runId: cached.runId, deduplicated: true };
        }
        this.idempotency.delete(idempotencyKey);
      }
    }

    const { runId } = await input.createRun();
    this.registerRun(runId, input.params);

    if (idempotencyKey) {
      this.idempotency.set(idempotencyKey, {
        runId,
        fingerprint: input.fingerprint,
        createdAt: now,
      });
    }

    return { runId, deduplicated: false };
  }

  registerRun(runId: string, params: RunParams): void {
    if (this.runs.has(runId)) return;
    const now = nowMs();
    this.runs.set(runId, {
      runId,
      params,
      state: "queued",
      createdAt: now,
      updatedAt: now,
      nextSeq: 1,
      events: [],
      subscribers: new Map(),
      terminal: false,
    });
  }

  async startRun(
    runId: string,
    starter: (ctx: { runId: string; params: RunParams; emit: SseEmitter }) => Promise<void>
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found in runtime store: ${runId}`);
    }
    if (run.terminal) return;
    if (run.startPromise) return run.startPromise;

    if (run.state === "queued") {
      run.state = "running";
      run.updatedAt = nowMs();
    }

    run.startPromise = (async () => {
      try {
        await starter({
          runId,
          params: run.params,
          emit: (event: SseEvent) => this.emit(runId, event),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!run.terminal) {
          this.emit(runId, { type: "error", runId, message: msg });
          this.emit(runId, { type: "done", runId });
        }
      } finally {
        run.startPromise = undefined;
        run.updatedAt = nowMs();
      }
    })();

    return run.startPromise;
  }

  subscribe(runId: string, emit: SseEmitter, cursorSeq?: number): SubscribeResult {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    const subId = this.nextSubscriberId++;
    run.subscribers.set(subId, emit);

    const afterSeq = parseNonNegativeInt(cursorSeq);
    let replayed = 0;

    // M11: Detect event gap — if client's cursor is behind the oldest buffered event,
    // notify them that events were lost so the frontend can surface a warning.
    if (afterSeq > 0 && run.events.length > 0) {
      const oldestSeq = run.events[0]!.seq;
      if (afterSeq < oldestSeq) {
        const gapEvent: SseEvent = {
          type: "tool-result",
          runId,
          toolName: "_buffer_gap_warning",
          toolCallId: `gap-${Date.now()}`,
          result: {
            warning: `事件缓冲区溢出：序列 ${afterSeq + 1} 到 ${oldestSeq - 1} 的事件已丢失`,
            missedFrom: afterSeq + 1,
            missedTo: oldestSeq - 1,
          },
          status: "error",
        };
        emit(gapEvent);
      }
    }

    for (const row of run.events) {
      if (row.seq <= afterSeq) continue;
      emit(row.event);
      replayed += 1;
    }

    run.updatedAt = nowMs();

    return {
      replayed,
      snapshot: {
        runId: run.runId,
        state: run.state,
        terminal: run.terminal,
        lastSeq: run.nextSeq - 1,
      },
      unsubscribe: () => {
        const current = this.runs.get(runId);
        if (!current) return;
        current.subscribers.delete(subId);
        current.updatedAt = nowMs();
      },
    };
  }

  emit(runId: string, event: SseEvent): void {
    const run = this.runs.get(runId);
    if (!run) return;

    if (run.terminal) return;

    const seq = run.nextSeq++;
    const enriched: SseEvent = {
      ...event,
      seq,
      emittedAt: new Date().toISOString(),
    };

    run.events.push({ seq, event: enriched });
    if (run.events.length > this.options.maxEventsPerRun) {
      const overflow = run.events.length - this.options.maxEventsPerRun;
      run.events.splice(0, overflow);
    }

    if (event.type === "error") {
      if (run.state !== "cancelled") {
        run.state = "failed";
      }
    } else if (event.type === "done") {
      if (run.state === "running" || run.state === "queued") {
        run.state = "completed";
      }
      run.terminal = true;
    }

    run.updatedAt = nowMs();

    for (const subscriber of run.subscribers.values()) {
      try {
        subscriber(enriched);
      } catch {
        // ignore subscriber-level failures
      }
    }
  }

  /** H5: Emit an error event followed by done, so SSE clients are notified of enqueue failures. */
  emitError(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return;
    this.emit(runId, { type: "error", runId, message });
    this.emit(runId, { type: "done", runId });
  }

  cancel(runId: string, message?: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.terminal) return false;
    run.state = "cancelled";
    this.emit(runId, {
      type: "error",
      runId,
      message: message?.trim() || "Run cancelled by user",
    });
    this.emit(runId, { type: "done", runId });
    return true;
  }

  private normalizeIdempotencyKey(workspaceId: string, raw?: string): string | null {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return null;
    return `${workspaceId}:${trimmed}`;
  }

  private cleanup(): void {
    const now = nowMs();

    for (const [key, value] of this.idempotency) {
      if (now - value.createdAt > this.options.idempotencyTtlMs) {
        this.idempotency.delete(key);
      }
    }

    for (const [runId, run] of this.runs) {
      const stale = now - run.updatedAt > this.options.runRetentionMs;
      if (!stale) continue;
      if (!run.terminal && run.startPromise) continue;
      // Terminal stale runs: force-clean even with subscribers (leaked connections)
      run.subscribers.clear();
      this.runs.delete(runId);
    }
  }
}
