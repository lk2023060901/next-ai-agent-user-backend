// ─── Events Module ──────────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Replace the EventBus:
//    Implement the EventBus interface (e.g. Redis Pub/Sub, NATS)
//
// 2. Replace the RunEventBuffer:
//    Implement the RunEventBuffer interface for custom event storage
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  EventBus,
  EventType,
  EventStream,
  EventDataMap,
  AgentEvent,
  AgentEventOf,
  EmitEvent,
  EventHandler,
  Unsubscribe,
  RunMetadata,
  RunUsageSummary,
  RunEventBuffer,
} from "./event-types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export { EVENT_STREAMS } from "./event-types.js";

// ─── Default implementations ────────────────────────────────────────────────

export {
  DefaultEventBus,
  type EventBusOptions,
} from "./event-bus.js";

export { DefaultRunEventBuffer } from "./run-event-buffer.js";
export { SequenceAllocator } from "./sequence-allocator.js";
