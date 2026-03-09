import type {
  AgentEvent,
  EmitEvent,
  EventBus,
  EventHandler,
  EventType,
  RunEventBuffer,
  RunMetadata,
  Unsubscribe,
} from "./event-types.js";
import { EVENT_STREAMS } from "./event-types.js";
import { SequenceAllocator } from "./sequence-allocator.js";
import { DefaultRunEventBuffer } from "./run-event-buffer.js";

export interface EventBusOptions {
  /** Maximum events to buffer per run (default 10,000). */
  maxEventsPerRun: number;
}

const DEFAULT_OPTIONS: EventBusOptions = {
  maxEventsPerRun: 10_000,
};

/**
 * In-memory EventBus implementation.
 *
 * - Assigns monotonic seq numbers per run
 * - Derives `stream` from `type` automatically
 * - Buffers events in per-run ring buffers
 * - Fans out to per-run subscribers and global subscribers
 */
export class DefaultEventBus implements EventBus {
  private readonly seq = new SequenceAllocator();
  private readonly buffers = new Map<string, RunEventBuffer>();
  private readonly runMeta = new Map<string, RunMetadata>();
  private readonly globalHandlers = new Map<number, EventHandler>();
  private readonly options: EventBusOptions;
  private nextGlobalId = 1;

  constructor(options?: Partial<EventBusOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  emit<T extends EventType>(runId: string, event: EmitEvent<T>): number {
    const buffer = this.buffers.get(runId);
    if (!buffer) {
      throw new Error(`EventBus: run not registered — ${runId}`);
    }

    const seqNum = this.seq.next(runId);

    // Build the full AgentEvent envelope.
    // The `as AgentEvent` cast is safe: type and data are guaranteed consistent
    // by the EmitEvent<T> generic, but TS can't prove it for the mapped union.
    const agentEvent = {
      runId,
      seq: seqNum,
      stream: EVENT_STREAMS[event.type],
      type: event.type,
      ts: Date.now(),
      sessionKey: event.sessionKey,
      agentId: event.agentId,
      messageId: event.messageId,
      data: event.data,
    } as AgentEvent;

    // Buffer + per-run subscribers
    buffer.append(agentEvent);

    // Global subscribers
    for (const handler of this.globalHandlers.values()) {
      try {
        handler(agentEvent);
      } catch {
        // global subscriber errors must not break emission
      }
    }

    return seqNum;
  }

  subscribe(runId: string, handler: EventHandler): Unsubscribe {
    const buffer = this.buffers.get(runId);
    if (!buffer) {
      throw new Error(`EventBus: run not registered — ${runId}`);
    }
    return buffer.subscribe(handler);
  }

  subscribeAll(handler: EventHandler): Unsubscribe {
    const id = this.nextGlobalId++;
    this.globalHandlers.set(id, handler);
    return () => {
      this.globalHandlers.delete(id);
    };
  }

  replayFrom(runId: string, fromSeq: number): AgentEvent[] {
    const buffer = this.buffers.get(runId);
    if (!buffer) return [];
    return buffer.getFrom(fromSeq);
  }

  registerRun(runId: string, meta: RunMetadata): void {
    if (this.buffers.has(runId)) return;
    this.runMeta.set(runId, meta);
    this.buffers.set(
      runId,
      new DefaultRunEventBuffer(runId, { maxEvents: this.options.maxEventsPerRun }),
    );
  }

  unregisterRun(runId: string): void {
    const buffer = this.buffers.get(runId);
    if (buffer) {
      buffer.dispose();
      this.buffers.delete(runId);
    }
    this.runMeta.delete(runId);
    this.seq.reset(runId);
  }

  hasRun(runId: string): boolean {
    return this.buffers.has(runId);
  }
}
