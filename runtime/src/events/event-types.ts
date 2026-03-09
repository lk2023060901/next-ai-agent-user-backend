// ─── Event Stream Categories ─────────────────────────────────────────────────

export type EventStream = "lifecycle" | "assistant" | "tool" | "memory" | "error";

// ─── Event Types ─────────────────────────────────────────────────────────────

export type EventType =
  // Lifecycle
  | "run-start"
  | "run-end"
  | "agent-start"
  | "agent-end"
  | "compaction-start"
  | "compaction-end"
  // Assistant
  | "message-start"
  | "message-end"
  | "text-delta"
  | "reasoning-delta"
  | "reasoning"
  // Tool
  | "tool-call"
  | "tool-result"
  | "approval-request"
  | "approval-response"
  // Sub-agent
  | "agent-switch"
  | "task-progress"
  | "task-complete"
  | "task-failed"
  // Memory
  | "memory-injection"
  | "memory-extracted"
  | "reflection-triggered"
  | "entity-discovered"
  // Usage
  | "usage"
  // Terminal
  | "done"
  | "error";

// ─── Event Data Payloads ─────────────────────────────────────────────────────

export interface RunUsageSummary {
  coordinatorInputTokens: number;
  coordinatorOutputTokens: number;
  subAgentInputTokens: number;
  subAgentOutputTokens: number;
  totalTokens: number;
}

export interface EventDataMap {
  // Lifecycle
  "run-start": {
    sessionKey: string;
    userRequest: string;
    coordinatorAgentId: string;
  };
  "run-end": {
    status: "completed" | "failed" | "cancelled" | "timeout";
    usage?: RunUsageSummary;
    /** Total run duration in ms (observability). */
    durationMs?: number;
    turnsUsed?: number;
  };
  "agent-start": {
    instruction?: string;
  };
  "agent-end": {
    status: "completed" | "failed" | "cancelled";
    /** Agent execution duration in ms (observability). */
    durationMs?: number;
  };
  "compaction-start": Record<string, never>;
  "compaction-end": {
    removedTokens: number;
    summaryTokens: number;
    /** Compaction duration in ms (observability). */
    durationMs?: number;
  };

  // Assistant
  "message-start": {
    messageId: string;
  };
  "message-end": {
    messageId: string;
    /** LLM response duration in ms (observability: time-to-first-token excluded). */
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  "text-delta": {
    delta: string;
  };
  "reasoning-delta": {
    delta: string;
  };
  "reasoning": {
    text: string;
  };

  // Tool
  "tool-call": {
    toolCallId: string;
    toolName: string;
    args: unknown;
  };
  "tool-result": {
    toolCallId: string;
    toolName: string;
    result: unknown;
    status: "success" | "error";
    /** Tool execution duration in ms (observability). */
    durationMs?: number;
  };
  "approval-request": {
    approvalId: string;
    toolCallId: string;
    toolName: string;
    params: Record<string, unknown>;
    riskLevel: string;
    reason: string;
    expiresAt: number;
  };
  "approval-response": {
    approvalId: string;
    decision: "approved" | "rejected" | "expired";
    reason?: string;
  };

  // Sub-agent
  "agent-switch": {
    targetAgentId: string;
    taskId?: string;
  };
  "task-progress": {
    taskId: string;
    progress: number;
  };
  "task-complete": {
    taskId: string;
    result: string;
  };
  "task-failed": {
    taskId: string;
    error: string;
  };

  // Memory
  "memory-injection": {
    memories: Array<{ memoryId: string; source: string; score: number }>;
  };
  "memory-extracted": {
    memoryIds: string[];
  };
  "reflection-triggered": Record<string, never>;
  "entity-discovered": {
    entities: Array<{ id: string; name: string; type: string }>;
  };

  // Usage
  "usage": {
    scope: "coordinator" | "sub_agent";
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    taskId?: string;
  };

  // Terminal
  "done": Record<string, never>;
  "error": {
    message: string;
    code?: string;
  };
}

// ─── Stream Mapping ──────────────────────────────────────────────────────────

export const EVENT_STREAMS: Readonly<Record<EventType, EventStream>> = {
  "run-start": "lifecycle",
  "run-end": "lifecycle",
  "agent-start": "lifecycle",
  "agent-end": "lifecycle",
  "compaction-start": "lifecycle",
  "compaction-end": "lifecycle",
  "message-start": "assistant",
  "message-end": "assistant",
  "text-delta": "assistant",
  "reasoning-delta": "assistant",
  "reasoning": "assistant",
  "tool-call": "tool",
  "tool-result": "tool",
  "approval-request": "tool",
  "approval-response": "tool",
  "agent-switch": "lifecycle",
  "task-progress": "lifecycle",
  "task-complete": "lifecycle",
  "task-failed": "lifecycle",
  "memory-injection": "memory",
  "memory-extracted": "memory",
  "reflection-triggered": "memory",
  "entity-discovered": "memory",
  "usage": "lifecycle",
  "done": "lifecycle",
  "error": "error",
};

// ─── AgentEvent ──────────────────────────────────────────────────────────────

/**
 * Discriminated union envelope — narrowing on `type` narrows `data`.
 *
 * Envelope fields (runId, seq, stream, ts) are managed by EventBus.
 * Metadata fields (sessionKey, agentId, messageId) are set by the emitter.
 */
export type AgentEvent = {
  [K in EventType]: {
    readonly runId: string;
    readonly seq: number;
    readonly stream: EventStream;
    readonly type: K;
    readonly ts: number;
    readonly sessionKey?: string;
    readonly agentId?: string;
    readonly messageId?: string;
    readonly data: EventDataMap[K];
  };
}[EventType];

/** Extract the AgentEvent variant for a specific event type. */
export type AgentEventOf<T extends EventType> = Extract<AgentEvent, { type: T }>;

// ─── Emit Input ──────────────────────────────────────────────────────────────

/** Input to EventBus.emit — stream/seq/ts are auto-assigned by the bus. */
export type EmitEvent<T extends EventType = EventType> = {
  type: T;
  data: EventDataMap[T];
  sessionKey?: string;
  agentId?: string;
  messageId?: string;
};

// ─── EventBus Interface ─────────────────────────────────────────────────────

export type EventHandler = (event: AgentEvent) => void;
export type Unsubscribe = () => void;

export interface RunMetadata {
  sessionId: string;
  workspaceId: string;
  coordinatorAgentId: string;
}

export interface EventBus {
  /** Emit an event; returns the assigned seq number. */
  emit<T extends EventType>(runId: string, event: EmitEvent<T>): number;

  /** Subscribe to events for a specific run. */
  subscribe(runId: string, handler: EventHandler): Unsubscribe;

  /** Subscribe to events across all runs. */
  subscribeAll(handler: EventHandler): Unsubscribe;

  /** Replay buffered events with seq > fromSeq. */
  replayFrom(runId: string, fromSeq: number): AgentEvent[];

  /** Register a new run (creates buffer, initializes sequence counter). */
  registerRun(runId: string, meta: RunMetadata): void;

  /** Unregister a run (disposes buffer, resets sequence counter). */
  unregisterRun(runId: string): void;

  /** Check if a run is currently registered. */
  hasRun(runId: string): boolean;
}

// ─── RunEventBuffer Interface ───────────────────────────────────────────────

export interface RunEventBuffer {
  readonly runId: string;
  readonly maxEvents: number;

  /** Append a fully-formed event to the buffer. */
  append(event: AgentEvent): void;

  /** Get all events with seq > fromSeq. */
  getFrom(fromSeq: number): AgentEvent[];

  /** Get all buffered events (defensive copy). */
  getAll(): AgentEvent[];

  /** Subscribe to new events appended after this call. */
  subscribe(handler: EventHandler): Unsubscribe;

  /** Release resources and clear subscribers. */
  dispose(): void;
}
