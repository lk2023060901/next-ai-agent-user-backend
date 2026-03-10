/**
 * Run-level timeout controller.
 *
 * Wraps an AbortController with a timer. When the timer fires, the
 * abort signal fires and all downstream operations (LLM calls, tool
 * executions) are cancelled via AbortSignal propagation.
 *
 * Also chains to an optional parent signal (e.g., orchestrator shutdown).
 */
export class RunTimeoutController {
  private readonly ac = new AbortController();
  private timer: ReturnType<typeof setTimeout>;
  private onParentAbort: (() => void) | null = null;
  private parentSignal: AbortSignal | null = null;

  constructor(timeoutMs: number, parentSignal?: AbortSignal) {
    this.timer = setTimeout(() => this.ac.abort(), timeoutMs);

    // Unref so this timer doesn't keep the process alive
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }

    // Chain to parent signal (e.g., orchestrator shutdown)
    if (parentSignal) {
      this.parentSignal = parentSignal;
      this.onParentAbort = () => this.ac.abort();
      parentSignal.addEventListener("abort", this.onParentAbort, { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** Cancel the timeout (does NOT abort — used for normal completion). */
  clear(): void {
    clearTimeout(this.timer);
    if (this.onParentAbort && this.parentSignal) {
      this.parentSignal.removeEventListener("abort", this.onParentAbort);
      this.onParentAbort = null;
      this.parentSignal = null;
    }
  }

  /** Force abort immediately. */
  abort(): void {
    clearTimeout(this.timer);
    this.ac.abort();
  }
}
