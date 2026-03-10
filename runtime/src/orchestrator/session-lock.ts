import type { LockRelease, SessionLock } from "./orchestrator-types.js";

/**
 * Error thrown when a session lock acquisition times out.
 *
 * The error message contains "timeout" so the retry policy in
 * retry-policy.ts classifies it as retryable automatically.
 */
export class SessionLockTimeoutError extends Error {
  constructor(sessionId: string, timeoutMs: number) {
    super(
      `Session lock acquisition timed out for session ${sessionId} after ${timeoutMs}ms — ` +
      `previous holder has not released. Run rejected to prevent concurrent access.`,
    );
    this.name = "SessionLockTimeoutError";
  }
}

/**
 * In-memory session lock using promise chaining.
 *
 * Ensures that runs for the same session execute serially: each acquire()
 * waits for the previous lock holder to release before resolving.
 *
 * Timeout behavior: if the previous holder doesn't release within
 * timeoutMs, the new acquisition is **rejected** (throws
 * SessionLockTimeoutError) rather than proceeding. This prevents two
 * runs from operating on the same session concurrently.
 *
 * The chain is kept intact via a pass-through: when the previous holder
 * eventually releases, the timed-out slot automatically resolves so that
 * subsequent waiters are not permanently blocked.
 */
export class InMemorySessionLock implements SessionLock {
  private readonly chains = new Map<string, Promise<void>>();

  async acquire(sessionId: string, timeoutMs = 30_000): Promise<LockRelease> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();

    let releaseFn!: LockRelease;
    const next = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    this.chains.set(sessionId, next);

    // Wait for the previous holder — reject on timeout to prevent
    // concurrent access to the same session's message history.
    const result = await Promise.race([
      prev.then(() => "acquired" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
    ]);

    if (result === "timeout") {
      // Bridge: when prev eventually resolves, pass through to next
      // so the chain doesn't permanently deadlock for later waiters.
      void prev.then(releaseFn, releaseFn);
      throw new SessionLockTimeoutError(sessionId, timeoutMs);
    }

    return releaseFn;
  }

  /** Number of sessions with active lock chains. */
  get size(): number {
    return this.chains.size;
  }
}
