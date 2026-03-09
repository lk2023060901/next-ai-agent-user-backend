import type { EventBus } from "../events/event-types.js";
import type {
  AgentLoop,
  AgentSession,
  ExecuteRunParams,
  MessageHistory,
  RunContext,
  RunResult,
  SessionStatus,
  SessionStore,
} from "./agent-types.js";
import { DefaultMessageHistory } from "./message-history.js";
import { PersistentMessageHistory } from "./persistent-message-history.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DefaultAgentSessionOptions {
  id: string;
  agentId: string;
  workspaceId: string;
  sessionKey: string;
  agentLoop: AgentLoop;
  eventBus: EventBus;
  /** Optionally inject a pre-populated message history (e.g., resumed session). */
  messageHistory?: MessageHistory;
  /** Optional session store — enables persistence across process restarts. */
  sessionStore?: SessionStore;
  /** Default run timeout in ms. Can be overridden per-run. */
  defaultTimeoutMs?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Default AgentSession implementation.
 *
 * Manages session lifecycle (idle → running → idle) and delegates run
 * execution to the AgentLoop. Message history persists across runs
 * within the same session.
 *
 * If a SessionStore is provided, lifecycle state changes and message
 * history are persisted to SQLite (or any backend). Without a store,
 * the session is purely in-memory (backward compatible).
 *
 * Concurrency guard: only one run at a time per session. Attempting
 * to start a run while another is active throws immediately.
 */
export class DefaultAgentSession implements AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly workspaceId: string;
  readonly sessionKey: string;
  readonly messageHistory: MessageHistory;

  private _status: SessionStatus = "idle";
  private _currentRunId: string | null = null;
  private _lastActiveAt: number = Date.now();

  private readonly agentLoop: AgentLoop;
  private readonly eventBus: EventBus;
  private readonly defaultTimeoutMs: number;
  private readonly sessionStore?: SessionStore;
  private readonly persistentHistory?: PersistentMessageHistory;

  constructor(options: DefaultAgentSessionOptions) {
    this.id = options.id;
    this.agentId = options.agentId;
    this.workspaceId = options.workspaceId;
    this.sessionKey = options.sessionKey;
    this.agentLoop = options.agentLoop;
    this.eventBus = options.eventBus;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.sessionStore = options.sessionStore;

    // Priority: explicit messageHistory > persistent (from store) > in-memory
    if (options.messageHistory) {
      this.messageHistory = options.messageHistory;
    } else if (options.sessionStore) {
      this.persistentHistory = new PersistentMessageHistory(
        options.id,
        options.sessionStore,
      );
      this.messageHistory = this.persistentHistory;
    } else {
      this.messageHistory = new DefaultMessageHistory();
    }
  }

  get status(): SessionStatus {
    return this._status;
  }

  get currentRunId(): string | null {
    return this._currentRunId;
  }

  get lastActiveAt(): number {
    return this._lastActiveAt;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Hydrate persisted message history if available
    if (this.persistentHistory) {
      await this.persistentHistory.load();
    }
    this._status = "idle";
  }

  async suspend(): Promise<void> {
    if (this._status === "closed") return;
    this._status = "suspended";
    if (this.sessionStore) {
      await this.sessionStore.updateSession(this.id, {
        status: "suspended",
        lastActiveAt: this._lastActiveAt,
      });
    }
  }

  async resume(): Promise<void> {
    if (this._status !== "suspended") return;
    this._status = "idle";
    if (this.sessionStore) {
      await this.sessionStore.updateSession(this.id, {
        status: "idle",
        lastActiveAt: Date.now(),
      });
    }
  }

  async close(): Promise<void> {
    this._status = "closed";
    this._currentRunId = null;
    if (this.sessionStore) {
      await this.sessionStore.updateSession(this.id, {
        status: "closed",
        lastActiveAt: Date.now(),
      });
    }
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  async executeRun(params: ExecuteRunParams): Promise<RunResult> {
    if (this._status !== "idle") {
      throw new Error(
        `Cannot start run on session ${this.id}: status is "${this._status}"`,
      );
    }

    this._status = "running";
    this._currentRunId = params.runId;
    this._lastActiveAt = Date.now();

    // Persist running state
    if (this.sessionStore) {
      void this.sessionStore.updateSession(this.id, {
        status: "running",
        lastActiveAt: this._lastActiveAt,
      });
    }

    const runContext: RunContext = {
      id: params.runId,
      sessionId: this.id,
      workspaceId: this.workspaceId,
      coordinatorAgentId: params.agent.id,
      userRequest: params.userRequest,
      status: "running",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      startedAt: Date.now(),
      timeoutMs: params.timeoutMs ?? this.defaultTimeoutMs,
      abortController: new AbortController(),
    };

    // Link external abort signal to run's own controller
    if (params.abortSignal) {
      const onParentAbort = () => runContext.abortController.abort();
      params.abortSignal.addEventListener("abort", onParentAbort, { once: true });
    }

    try {
      const result = await this.agentLoop.execute({
        run: runContext,
        agent: params.agent,
        tools: params.tools,
        providerAdapter: params.providerAdapter,
        toolRuntime: params.toolRuntime,
        messageHistory: this.messageHistory,
        eventBus: this.eventBus,
        abortSignal: runContext.abortController.signal,
      });

      this._lastActiveAt = Date.now();
      return result;
    } finally {
      this._status = "idle";
      this._currentRunId = null;

      // Persist idle state after run completes
      if (this.sessionStore) {
        void this.sessionStore.updateSession(this.id, {
          status: "idle",
          lastActiveAt: this._lastActiveAt,
        });
      }
    }
  }
}
