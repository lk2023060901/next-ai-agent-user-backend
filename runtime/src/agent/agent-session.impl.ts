import type { EventBus } from "../events/event-types.js";
import type {
  AgentLoop,
  AgentSession,
  ExecuteRunParams,
  MessageHistory,
  RunContext,
  RunResult,
  SessionStatus,
} from "./agent-types.js";
import { DefaultMessageHistory } from "./message-history.js";

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

  constructor(options: DefaultAgentSessionOptions) {
    this.id = options.id;
    this.agentId = options.agentId;
    this.workspaceId = options.workspaceId;
    this.sessionKey = options.sessionKey;
    this.agentLoop = options.agentLoop;
    this.eventBus = options.eventBus;
    this.messageHistory = options.messageHistory ?? new DefaultMessageHistory();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
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
    // Future: load persisted state from DB (message history, core memory)
    this._status = "idle";
  }

  async suspend(): Promise<void> {
    if (this._status === "closed") return;
    // Future: serialize state to storage
    this._status = "suspended";
  }

  async resume(): Promise<void> {
    if (this._status !== "suspended") return;
    // Future: deserialize state from storage
    this._status = "idle";
  }

  async close(): Promise<void> {
    this._status = "closed";
    this._currentRunId = null;
    // Future: persist final state, release resources
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
    }
  }
}
