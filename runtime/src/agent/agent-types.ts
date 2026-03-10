import type { EventBus } from "../events/event-types.js";
import type { Message, ProviderAdapter } from "../providers/adapter.js";
import type { AgentTool, ToolRuntime } from "../tools/tool-types.js";

// ─── Session Status ──────────────────────────────────────────────────────────

export type SessionStatus = "idle" | "running" | "suspended" | "closed";

// ─── AgentSession ────────────────────────────────────────────────────────────
//
// Long-lived execution entity. Multiple Runs execute within the same Session,
// sharing message history and (future) core memory.

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly sessionKey: string; // Structured key: agent:<agentId>:<scope>

  readonly status: SessionStatus;
  readonly currentRunId: string | null;
  readonly lastActiveAt: number;

  // Long-lived state (survives across Runs)
  readonly messageHistory: MessageHistory;

  // Lifecycle
  initialize(): Promise<void>;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;

  // Execution — caller resolves dependencies (tools, provider, config)
  executeRun(params: ExecuteRunParams): Promise<RunResult>;
}

// ─── Session Manager ────────────────────────────────────────────────────────

export interface CreateSessionParams {
  agentId: string;
  workspaceId: string;
  sessionKey: string;
}

export interface SessionSummary {
  id: string;
  sessionKey: string;
  agentId: string;
  workspaceId: string;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionManager {
  create(params: CreateSessionParams): Promise<AgentSession>;
  get(sessionId: string): Promise<AgentSession | null>;
  getOrCreate(sessionKey: string, params: CreateSessionParams): Promise<AgentSession>;
  listActive(workspaceId: string): Promise<SessionSummary[]>;
  cleanup(maxIdleMs: number): Promise<number>;
  close(sessionId: string): Promise<void>;
}

// ─── Session Store ──────────────────────────────────────────────────────────
//
// Persistence layer for sessions and their message history.
// Plugin injection point: replace with Redis, PostgreSQL, or any backend.

export interface SessionStore {
  // ─── Session CRUD ──────────────────────────────────────────────────────
  saveSession(record: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  getSessionByKey(sessionKey: string): Promise<SessionRecord | null>;
  listActiveSessions(workspaceId: string): Promise<SessionRecord[]>;
  updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "lastActiveAt">>,
  ): Promise<void>;
  getExpiredSessionIds(maxIdleMs: number): Promise<string[]>;
  deleteSession(sessionId: string): Promise<void>;

  // ─── Message History ───────────────────────────────────────────────────
  appendMessage(sessionId: string, message: Message): Promise<void>;
  getMessages(sessionId: string, limit?: number): Promise<Message[]>;
  clearMessages(sessionId: string): Promise<void>;
  replaceMessages(sessionId: string, messages: Message[]): Promise<void>;
}

export interface SessionRecord {
  id: string;
  agentId: string;
  workspaceId: string;
  sessionKey: string;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  fullText: string;
  usage: RunUsage;
  turnsUsed: number;
  error?: string;
}

// ─── Run Context ─────────────────────────────────────────────────────────────
//
// Short-lived execution context — one per Run. Created by the session
// at executeRun() time and passed into the AgentLoop.

export interface RunContext {
  readonly id: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly coordinatorAgentId: string;
  readonly userRequest: string;
  status: RunStatus;
  readonly usage: RunUsage;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly abortController: AbortController;
}

// ─── Execute Run Params ──────────────────────────────────────────────────────
//
// Everything needed to run — the session manages lifecycle, the caller
// provides resolved dependencies (agent config, tools, provider adapter).

export interface ExecuteRunParams {
  runId: string;
  userRequest: string;
  agent: AgentConfig;
  tools: AgentTool[];
  providerAdapter: ProviderAdapter;
  toolRuntime?: ToolRuntime;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

// ─── Agent Loop ──────────────────────────────────────────────────────────────
//
// The core execution loop. Emits events via EventBus and returns a RunResult.
//
// Design note: the design doc specifies AsyncGenerator<AgentEvent>, but the
// EventBus already handles event distribution to subscribers. Using Promise
// keeps the implementation simpler and matches the existing stream-loop.ts
// pattern. Generator-based control can be added later if back-pressure is
// needed.

export interface AgentLoop {
  execute(params: AgentLoopParams): Promise<RunResult>;
}

export interface AgentLoopParams {
  run: RunContext;
  agent: AgentConfig;
  tools: AgentTool[];
  providerAdapter: ProviderAdapter;
  toolRuntime?: ToolRuntime;
  messageHistory: MessageHistory;
  eventBus: EventBus;
  abortSignal: AbortSignal;
}

// ─── Agent Config ────────────────────────────────────────────────────────────
//
// The subset of agent configuration the loop needs.
// Full agent config (with policies, capabilities, etc.) lives in the service
// layer and is resolved before being passed here.

export interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  model: string;
  maxTurns: number;
  temperature?: number;
  maxTokens?: number;
  reasoning?: "off" | "low" | "high";
}

// ─── Message History ─────────────────────────────────────────────────────────
//
// Accumulates messages within a session across runs.
// Future context/ module will add token budgeting and compaction.

export interface MessageHistory {
  /** Add a message to the history. */
  append(message: Message): void;

  /** Get all messages (defensive copy). */
  getAll(): Message[];

  /** Get the N most recent messages. Omit to get all. */
  getRecent(maxMessages?: number): Message[];

  /** Remove all messages. */
  clear(): void;

  /** Current message count. */
  readonly length: number;
}

// ─── Sub-Agent ───────────────────────────────────────────────────────────────

export interface SubAgentSpawnParams {
  parentRunId: string;
  parentSessionId: string;
  workspaceId: string;
  targetAgentId: string;
  instruction: string;
  taskId: string;
  depth: number;
  maxDepth: number;
  agent: AgentConfig;
  tools: AgentTool[];
  providerAdapter: ProviderAdapter;
  toolRuntime?: ToolRuntime;
  eventBus: EventBus;
  abortSignal: AbortSignal;
}

export interface SubAgentResult {
  taskId: string;
  agentId: string;
  status: "completed" | "failed" | "cancelled";
  result: string;
  usage: RunUsage;
}
