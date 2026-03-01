import { config } from "../config.js";

export type PluginExecutionGuardErrorCode =
  | "plugin_cooldown_active"
  | "plugin_queue_timeout"
  | "plugin_execution_timeout"
  | "plugin_execution_error";

export interface PluginExecutionGuardMeta {
  queueWaitMs: number;
  executionMs: number;
  timeoutMs: number;
  maxConcurrency: number;
  failureStreak: number;
  cooldownUntilMs: number;
  cooldownRemainingMs: number;
}

export class PluginExecutionGuardError extends Error {
  readonly code: PluginExecutionGuardErrorCode;
  readonly pluginKey: string;
  readonly meta: PluginExecutionGuardMeta;

  constructor(params: {
    code: PluginExecutionGuardErrorCode;
    pluginKey: string;
    message: string;
    meta: PluginExecutionGuardMeta;
  }) {
    super(params.message);
    this.name = "PluginExecutionGuardError";
    this.code = params.code;
    this.pluginKey = params.pluginKey;
    this.meta = params.meta;
  }
}

interface PluginExecutionGuardOptions {
  executionTimeoutMs: number;
  queueTimeoutMs: number;
  maxConcurrencyPerPlugin: number;
  failureThreshold: number;
  failureCooldownMs: number;
}

interface QueueEntry {
  enqueuedAtMs: number;
  timeout: NodeJS.Timeout;
  resolve: (lease: ExecutionLease) => void;
  reject: (error: Error) => void;
}

interface ExecutionLease {
  queueWaitMs: number;
  release: () => void;
}

interface PluginExecutionState {
  running: number;
  queue: QueueEntry[];
  failureStreak: number;
  cooldownUntilMs: number;
}

export interface PluginGuardedExecutionResult<T> {
  result: T;
  guardMeta: PluginExecutionGuardMeta;
}

function safeNowMs(): number {
  return Date.now();
}

function isThenable<T>(input: unknown): input is PromiseLike<T> {
  return Boolean(input) && (typeof input === "object" || typeof input === "function") && "then" in (input as any);
}

export class PluginExecutionGuard {
  private readonly options: PluginExecutionGuardOptions;
  private readonly states = new Map<string, PluginExecutionState>();

  constructor(options: PluginExecutionGuardOptions) {
    this.options = options;
  }

  async run<T>(params: { pluginKey: string; execute: () => Promise<T> | T }): Promise<PluginGuardedExecutionResult<T>> {
    const pluginKey = params.pluginKey;
    const lease = await this.acquire(pluginKey);
    const executionStartedAtMs = safeNowMs();
    let released = false;

    const releaseOnce = () => {
      if (released) return;
      released = true;
      lease.release();
    };

    try {
      const execution = params.execute();
      const result = await this.withExecutionTimeout(pluginKey, execution, lease.queueWaitMs, executionStartedAtMs);
      const state = this.getState(pluginKey);
      state.failureStreak = 0;
      state.cooldownUntilMs = 0;
      const endedAtMs = safeNowMs();
      return {
        result,
        guardMeta: this.buildMeta({
          pluginKey,
          state,
          queueWaitMs: lease.queueWaitMs,
          executionMs: Math.max(0, endedAtMs - executionStartedAtMs),
        }),
      };
    } catch (error) {
      const state = this.getState(pluginKey);
      if (
        !(error instanceof PluginExecutionGuardError) ||
        error.code === "plugin_execution_timeout" ||
        error.code === "plugin_execution_error"
      ) {
        state.failureStreak += 1;
        if (state.failureStreak >= this.options.failureThreshold) {
          state.cooldownUntilMs = safeNowMs() + this.options.failureCooldownMs;
        }
      }
      const endedAtMs = safeNowMs();
      if (error instanceof PluginExecutionGuardError) {
        throw error;
      }
      throw new PluginExecutionGuardError({
        code: "plugin_execution_error",
        pluginKey,
        message: error instanceof Error ? error.message : String(error),
        meta: this.buildMeta({
          pluginKey,
          state,
          queueWaitMs: lease.queueWaitMs,
          executionMs: Math.max(0, endedAtMs - executionStartedAtMs),
        }),
      });
    } finally {
      releaseOnce();
    }
  }

  private getState(pluginKey: string): PluginExecutionState {
    const existing = this.states.get(pluginKey);
    if (existing) return existing;
    const state: PluginExecutionState = {
      running: 0,
      queue: [],
      failureStreak: 0,
      cooldownUntilMs: 0,
    };
    this.states.set(pluginKey, state);
    return state;
  }

  private async acquire(pluginKey: string): Promise<ExecutionLease> {
    const state = this.getState(pluginKey);
    this.ensureNotInCooldown(pluginKey, state, 0);
    if (state.running < this.options.maxConcurrencyPerPlugin) {
      state.running += 1;
      return {
        queueWaitMs: 0,
        release: () => this.release(pluginKey),
      };
    }

    const enqueuedAtMs = safeNowMs();
    return await new Promise<ExecutionLease>((resolve, reject) => {
      const entry: QueueEntry = {
        enqueuedAtMs,
        timeout: setTimeout(() => {
          const nextState = this.getState(pluginKey);
          const index = nextState.queue.indexOf(entry);
          if (index >= 0) {
            nextState.queue.splice(index, 1);
          }
          reject(
            new PluginExecutionGuardError({
              code: "plugin_queue_timeout",
              pluginKey,
              message: `plugin queue timeout after ${this.options.queueTimeoutMs}ms`,
              meta: this.buildMeta({
                pluginKey,
                state: nextState,
                queueWaitMs: this.options.queueTimeoutMs,
                executionMs: 0,
              }),
            }),
          );
          this.maybeCleanup(pluginKey, nextState);
        }, this.options.queueTimeoutMs),
        resolve,
        reject,
      };

      state.queue.push(entry);
    });
  }

  private release(pluginKey: string): void {
    const state = this.getState(pluginKey);
    if (state.running > 0) {
      state.running -= 1;
    }
    this.drainQueue(pluginKey, state);
    this.maybeCleanup(pluginKey, state);
  }

  private drainQueue(pluginKey: string, state: PluginExecutionState): void {
    while (state.running < this.options.maxConcurrencyPerPlugin && state.queue.length > 0) {
      const entry = state.queue.shift();
      if (!entry) break;
      clearTimeout(entry.timeout);
      const queueWaitMs = Math.max(0, safeNowMs() - entry.enqueuedAtMs);
      const now = safeNowMs();
      if (state.cooldownUntilMs > now) {
        entry.reject(
          new PluginExecutionGuardError({
            code: "plugin_cooldown_active",
            pluginKey,
            message: `plugin is cooling down, retry after ${Math.max(0, state.cooldownUntilMs - now)}ms`,
            meta: this.buildMeta({
              pluginKey,
              state,
              queueWaitMs,
              executionMs: 0,
            }),
          }),
        );
        continue;
      }
      state.running += 1;
      entry.resolve({
        queueWaitMs,
        release: () => this.release(pluginKey),
      });
    }
  }

  private withExecutionTimeout<T>(
    pluginKey: string,
    execution: Promise<T> | T,
    queueWaitMs: number,
    executionStartedAtMs: number,
  ): Promise<T> {
    const promise = isThenable<T>(execution) ? Promise.resolve(execution) : Promise.resolve(execution as T);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const state = this.getState(pluginKey);
        reject(
          new PluginExecutionGuardError({
            code: "plugin_execution_timeout",
            pluginKey,
            message: `plugin execution timeout after ${this.options.executionTimeoutMs}ms`,
            meta: this.buildMeta({
              pluginKey,
              state,
              queueWaitMs,
              executionMs: Math.max(0, safeNowMs() - executionStartedAtMs),
            }),
          }),
        );
      }, this.options.executionTimeoutMs);

      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private ensureNotInCooldown(pluginKey: string, state: PluginExecutionState, queueWaitMs: number): void {
    const now = safeNowMs();
    if (state.cooldownUntilMs > 0 && state.cooldownUntilMs <= now) {
      state.cooldownUntilMs = 0;
      state.failureStreak = 0;
    }
    if (state.cooldownUntilMs <= now) return;
    throw new PluginExecutionGuardError({
      code: "plugin_cooldown_active",
      pluginKey,
      message: `plugin is cooling down, retry after ${Math.max(0, state.cooldownUntilMs - now)}ms`,
      meta: this.buildMeta({
        pluginKey,
        state,
        queueWaitMs,
        executionMs: 0,
      }),
    });
  }

  private buildMeta(params: {
    pluginKey: string;
    state: PluginExecutionState;
    queueWaitMs: number;
    executionMs: number;
  }): PluginExecutionGuardMeta {
    const now = safeNowMs();
    return {
      queueWaitMs: Math.max(0, Math.floor(params.queueWaitMs)),
      executionMs: Math.max(0, Math.floor(params.executionMs)),
      timeoutMs: this.options.executionTimeoutMs,
      maxConcurrency: this.options.maxConcurrencyPerPlugin,
      failureStreak: Math.max(0, Math.floor(params.state.failureStreak)),
      cooldownUntilMs: Math.max(0, Math.floor(params.state.cooldownUntilMs)),
      cooldownRemainingMs: Math.max(0, Math.floor(params.state.cooldownUntilMs - now)),
    };
  }

  private maybeCleanup(pluginKey: string, state: PluginExecutionState): void {
    const now = safeNowMs();
    if (state.running > 0) return;
    if (state.queue.length > 0) return;
    if (state.failureStreak > 0) return;
    if (state.cooldownUntilMs > now) return;
    this.states.delete(pluginKey);
  }
}

export function isPluginExecutionGuardError(error: unknown): error is PluginExecutionGuardError {
  return error instanceof PluginExecutionGuardError;
}

export const runtimePluginExecutionGuard = new PluginExecutionGuard({
  executionTimeoutMs: config.pluginToolTimeoutMs,
  queueTimeoutMs: config.pluginToolQueueTimeoutMs,
  maxConcurrencyPerPlugin: config.pluginToolMaxConcurrencyPerPlugin,
  failureThreshold: config.pluginToolFailureThreshold,
  failureCooldownMs: config.pluginToolFailureCooldownMs,
});
