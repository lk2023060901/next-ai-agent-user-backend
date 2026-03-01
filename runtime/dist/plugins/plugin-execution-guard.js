import { config } from "../config.js";
export class PluginExecutionGuardError extends Error {
    code;
    pluginKey;
    meta;
    constructor(params) {
        super(params.message);
        this.name = "PluginExecutionGuardError";
        this.code = params.code;
        this.pluginKey = params.pluginKey;
        this.meta = params.meta;
    }
}
function safeNowMs() {
    return Date.now();
}
function isThenable(input) {
    return Boolean(input) && (typeof input === "object" || typeof input === "function") && "then" in input;
}
export class PluginExecutionGuard {
    options;
    states = new Map();
    constructor(options) {
        this.options = options;
    }
    async run(params) {
        const pluginKey = params.pluginKey;
        const lease = await this.acquire(pluginKey);
        const executionStartedAtMs = safeNowMs();
        let released = false;
        const releaseOnce = () => {
            if (released)
                return;
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
        }
        catch (error) {
            const state = this.getState(pluginKey);
            if (!(error instanceof PluginExecutionGuardError) ||
                error.code === "plugin_execution_timeout" ||
                error.code === "plugin_execution_error") {
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
        }
        finally {
            releaseOnce();
        }
    }
    getState(pluginKey) {
        const existing = this.states.get(pluginKey);
        if (existing)
            return existing;
        const state = {
            running: 0,
            queue: [],
            failureStreak: 0,
            cooldownUntilMs: 0,
        };
        this.states.set(pluginKey, state);
        return state;
    }
    async acquire(pluginKey) {
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
        return await new Promise((resolve, reject) => {
            const entry = {
                enqueuedAtMs,
                timeout: setTimeout(() => {
                    const nextState = this.getState(pluginKey);
                    const index = nextState.queue.indexOf(entry);
                    if (index >= 0) {
                        nextState.queue.splice(index, 1);
                    }
                    reject(new PluginExecutionGuardError({
                        code: "plugin_queue_timeout",
                        pluginKey,
                        message: `plugin queue timeout after ${this.options.queueTimeoutMs}ms`,
                        meta: this.buildMeta({
                            pluginKey,
                            state: nextState,
                            queueWaitMs: this.options.queueTimeoutMs,
                            executionMs: 0,
                        }),
                    }));
                    this.maybeCleanup(pluginKey, nextState);
                }, this.options.queueTimeoutMs),
                resolve,
                reject,
            };
            state.queue.push(entry);
        });
    }
    release(pluginKey) {
        const state = this.getState(pluginKey);
        if (state.running > 0) {
            state.running -= 1;
        }
        this.drainQueue(pluginKey, state);
        this.maybeCleanup(pluginKey, state);
    }
    drainQueue(pluginKey, state) {
        while (state.running < this.options.maxConcurrencyPerPlugin && state.queue.length > 0) {
            const entry = state.queue.shift();
            if (!entry)
                break;
            clearTimeout(entry.timeout);
            const queueWaitMs = Math.max(0, safeNowMs() - entry.enqueuedAtMs);
            const now = safeNowMs();
            if (state.cooldownUntilMs > now) {
                entry.reject(new PluginExecutionGuardError({
                    code: "plugin_cooldown_active",
                    pluginKey,
                    message: `plugin is cooling down, retry after ${Math.max(0, state.cooldownUntilMs - now)}ms`,
                    meta: this.buildMeta({
                        pluginKey,
                        state,
                        queueWaitMs,
                        executionMs: 0,
                    }),
                }));
                continue;
            }
            state.running += 1;
            entry.resolve({
                queueWaitMs,
                release: () => this.release(pluginKey),
            });
        }
    }
    withExecutionTimeout(pluginKey, execution, queueWaitMs, executionStartedAtMs) {
        const promise = isThenable(execution) ? Promise.resolve(execution) : Promise.resolve(execution);
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                const state = this.getState(pluginKey);
                reject(new PluginExecutionGuardError({
                    code: "plugin_execution_timeout",
                    pluginKey,
                    message: `plugin execution timeout after ${this.options.executionTimeoutMs}ms`,
                    meta: this.buildMeta({
                        pluginKey,
                        state,
                        queueWaitMs,
                        executionMs: Math.max(0, safeNowMs() - executionStartedAtMs),
                    }),
                }));
            }, this.options.executionTimeoutMs);
            promise.then((value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                resolve(value);
            }, (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    ensureNotInCooldown(pluginKey, state, queueWaitMs) {
        const now = safeNowMs();
        if (state.cooldownUntilMs > 0 && state.cooldownUntilMs <= now) {
            state.cooldownUntilMs = 0;
            state.failureStreak = 0;
        }
        if (state.cooldownUntilMs <= now)
            return;
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
    buildMeta(params) {
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
    maybeCleanup(pluginKey, state) {
        const now = safeNowMs();
        if (state.running > 0)
            return;
        if (state.queue.length > 0)
            return;
        if (state.failureStreak > 0)
            return;
        if (state.cooldownUntilMs > now)
            return;
        this.states.delete(pluginKey);
    }
}
export function isPluginExecutionGuardError(error) {
    return error instanceof PluginExecutionGuardError;
}
export const runtimePluginExecutionGuard = new PluginExecutionGuard({
    executionTimeoutMs: config.pluginToolTimeoutMs,
    queueTimeoutMs: config.pluginToolQueueTimeoutMs,
    maxConcurrencyPerPlugin: config.pluginToolMaxConcurrencyPerPlugin,
    failureThreshold: config.pluginToolFailureThreshold,
    failureCooldownMs: config.pluginToolFailureCooldownMs,
});
