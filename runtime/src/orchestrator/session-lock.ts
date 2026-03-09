import type { LockRelease, SessionLock } from "./orchestrator-types.js";

/**
 * In-memory session lock using promise chaining.
 *
 * Ensures that runs for the same session execute serially: each acquire()
 * waits for the previous lock holder to release before resolving.
 *
 * Timeout: if the previous holder doesn't release within timeoutMs,
 * the lock is forcibly acquired (prevents permanent deadlock from
 * crashed runs).
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

    // Wait for the previous holder — with timeout to prevent deadlock
    await Promise.race([
      prev,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    return releaseFn;
  }

  /** Number of sessions with active lock chains. */
  get size(): number {
    return this.chains.size;
  }
}
