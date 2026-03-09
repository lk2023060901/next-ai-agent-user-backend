import { v4 as uuidv4 } from "uuid";
import type { EventBus } from "../events/event-types.js";
import type {
  AgentLoop,
  AgentSession,
  CreateSessionParams,
  SessionManager,
  SessionSummary,
} from "./agent-types.js";
import { DefaultAgentSession } from "./agent-session.impl.js";

// ─── Options ─────────────────────────────────────────────────────────────────

/** Factory function for creating AgentSession instances. */
export type SessionFactory = (
  id: string,
  params: CreateSessionParams,
  deps: { agentLoop: AgentLoop; eventBus: EventBus; defaultTimeoutMs: number },
) => AgentSession;

export interface DefaultSessionManagerOptions {
  agentLoop: AgentLoop;
  eventBus: EventBus;
  /** Default run timeout in ms for new sessions. */
  defaultTimeoutMs?: number;

  // ─── Optional override (plugin injection point) ───────────────────────
  /** Custom session factory — replace how sessions are created. */
  sessionFactory?: SessionFactory;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * In-memory session manager.
 *
 * Sessions are stored in a Map keyed by session ID. getOrCreate() also
 * maintains a secondary index by sessionKey for fast lookup.
 *
 * Persistence (to SQLite) will be added when the db/ module is built.
 * This implementation is sufficient for single-process deployments.
 */
export class DefaultSessionManager implements SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly keyIndex = new Map<string, string>(); // sessionKey → sessionId
  private readonly agentLoop: AgentLoop;
  private readonly eventBus: EventBus;
  private readonly defaultTimeoutMs: number;
  private readonly sessionFactory: SessionFactory;

  constructor(options: DefaultSessionManagerOptions) {
    this.agentLoop = options.agentLoop;
    this.eventBus = options.eventBus;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
  }

  async create(params: CreateSessionParams): Promise<AgentSession> {
    const id = uuidv4();
    const session = this.sessionFactory(id, params, {
      agentLoop: this.agentLoop,
      eventBus: this.eventBus,
      defaultTimeoutMs: this.defaultTimeoutMs,
    });

    await session.initialize();

    this.sessions.set(id, session);
    this.keyIndex.set(params.sessionKey, id);

    return session;
  }

  async get(sessionId: string): Promise<AgentSession | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getOrCreate(
    sessionKey: string,
    params: CreateSessionParams,
  ): Promise<AgentSession> {
    const existingId = this.keyIndex.get(sessionKey);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && existing.status !== "closed") {
        if (existing.status === "suspended") {
          await existing.resume();
        }
        return existing;
      }
    }

    return this.create({ ...params, sessionKey });
  }

  async listActive(workspaceId: string): Promise<SessionSummary[]> {
    const results: SessionSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId && session.status !== "closed") {
        results.push({
          id: session.id,
          sessionKey: session.sessionKey,
          agentId: session.agentId,
          workspaceId: session.workspaceId,
          status: session.status,
          createdAt: session.lastActiveAt, // Approximate; proper createdAt needs persistence
          lastActiveAt: session.lastActiveAt,
        });
      }
    }
    return results;
  }

  async cleanup(maxIdleMs: number): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      if (
        session.status === "idle" &&
        now - session.lastActiveAt > maxIdleMs
      ) {
        await session.close();
        this.sessions.delete(id);
        this.keyIndex.delete(session.sessionKey);
        cleaned++;
      }
    }

    return cleaned;
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await session.close();
    this.sessions.delete(sessionId);
    this.keyIndex.delete(session.sessionKey);
  }
}

// ─── Default Factory ────────────────────────────────────────────────────────

const defaultSessionFactory: SessionFactory = (id, params, deps) =>
  new DefaultAgentSession({
    id,
    agentId: params.agentId,
    workspaceId: params.workspaceId,
    sessionKey: params.sessionKey,
    agentLoop: deps.agentLoop,
    eventBus: deps.eventBus,
    defaultTimeoutMs: deps.defaultTimeoutMs,
  });
