import { ProviderError } from "../providers/adapter.js";
import {
  NON_RETRYABLE_ERRORS,
  RETRYABLE_ERRORS,
  type RetryPolicy,
} from "./orchestrator-types.js";

/**
 * Execute a function with retry and exponential backoff.
 *
 * Retryable errors (rate limit, timeout, network) trigger backoff and
 * retry. Non-retryable errors (auth, content filter, context overflow)
 * are thrown immediately.
 *
 * After exhausting retries, the `onExhausted` callback is invoked —
 * this is the hook point for provider rotation.
 */
export async function executeWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  options?: {
    abortSignal?: AbortSignal;
    onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
    onExhausted?: (error: unknown) => void;
  },
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (options?.abortSignal?.aborted) {
        throw err;
      }

      if (!isRetryableError(err)) {
        throw err;
      }

      attempt++;
      if (attempt > policy.maxRetries) {
        options?.onExhausted?.(err);
        throw err;
      }

      const delayMs = calculateBackoff(attempt, policy, err);
      options?.onRetry?.(attempt, err, delayMs);

      await sleep(delayMs, options?.abortSignal);
    }
  }
}

// ─── Error Classification ────────────────────────────────────────────────────

function isRetryableError(err: unknown): boolean {
  if (err instanceof ProviderError) {
    if (NON_RETRYABLE_ERRORS.has(err.code)) return false;
    if (RETRYABLE_ERRORS.has(err.code)) return true;
    return err.retryable;
  }

  // Generic errors: retry on timeout/network heuristics
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("timeout") ||
      msg.includes("econnreset") ||
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("network")
    );
  }

  return false;
}

// ─── Backoff Calculation ─────────────────────────────────────────────────────

function calculateBackoff(
  attempt: number,
  policy: RetryPolicy,
  err: unknown,
): number {
  // If the provider tells us how long to wait, use that
  if (err instanceof ProviderError && err.retryAfterMs) {
    return Math.min(err.retryAfterMs, policy.maxBackoffMs);
  }

  // Exponential backoff with jitter
  const exponential = policy.backoffMs * Math.pow(policy.backoffMultiplier, attempt - 1);
  const capped = Math.min(exponential, policy.maxBackoffMs);
  const jitter = capped * 0.2 * Math.random(); // ±20% jitter
  return Math.floor(capped + jitter);
}

// ─── Sleep ───────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted during retry backoff"));
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted during retry backoff"));
      },
      { once: true },
    );
  });
}
