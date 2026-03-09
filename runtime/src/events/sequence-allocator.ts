/**
 * Per-run monotonically increasing sequence number allocator.
 *
 * Guarantees:
 * - Sequences within a runId are strictly monotonic, starting at 1
 * - No gaps — each call to next() increments by exactly 1
 * - Different runIds have independent counters
 * - Allocation is synchronous (safe for single-threaded event emission)
 */
export class SequenceAllocator {
  private readonly counters = new Map<string, number>();

  /** Allocate and return the next sequence number for the given runId. */
  next(runId: string): number {
    const current = this.counters.get(runId) ?? 0;
    const next = current + 1;
    this.counters.set(runId, next);
    return next;
  }

  /** Return the last allocated sequence number, or 0 if none. */
  current(runId: string): number {
    return this.counters.get(runId) ?? 0;
  }

  /** Remove the counter for a runId (e.g. when the run is unregistered). */
  reset(runId: string): void {
    this.counters.delete(runId);
  }
}
