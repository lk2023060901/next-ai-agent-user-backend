import type {
  AgentEvent,
  EventHandler,
  RunEventBuffer,
  Unsubscribe,
} from "./event-types.js";

export interface RunEventBufferOptions {
  maxEvents: number;
}

const DEFAULT_MAX_EVENTS = 10_000;

/**
 * In-memory ring buffer for a single run's event stream.
 *
 * - Drops oldest events when capacity is exceeded
 * - Supports subscriber notification on append
 * - Subscriber errors are silently caught (never break the buffer)
 */
export class DefaultRunEventBuffer implements RunEventBuffer {
  readonly runId: string;
  readonly maxEvents: number;

  private events: AgentEvent[] = [];
  private subscribers = new Map<number, EventHandler>();
  private nextSubId = 1;
  private disposed = false;

  constructor(runId: string, options?: Partial<RunEventBufferOptions>) {
    this.runId = runId;
    this.maxEvents = Math.max(100, options?.maxEvents ?? DEFAULT_MAX_EVENTS);
  }

  append(event: AgentEvent): void {
    if (this.disposed) return;

    this.events.push(event);

    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    for (const handler of this.subscribers.values()) {
      try {
        handler(event);
      } catch {
        // subscriber errors must not propagate
      }
    }
  }

  getFrom(fromSeq: number): AgentEvent[] {
    return this.events.filter((e) => e.seq > fromSeq);
  }

  getAll(): AgentEvent[] {
    return this.events.slice();
  }

  subscribe(handler: EventHandler): Unsubscribe {
    if (this.disposed) return () => {};
    const id = this.nextSubId++;
    this.subscribers.set(id, handler);
    return () => {
      this.subscribers.delete(id);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.subscribers.clear();
    this.events = [];
  }
}
