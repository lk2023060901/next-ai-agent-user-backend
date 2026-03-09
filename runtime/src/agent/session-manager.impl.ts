import { v4 as uuidv4 } from "uuid";
import type { EventBus } from "../events/event-types.js";
import type {
  AgentLoop,
  AgentSession,
  CreateSessionParams,
  SessionManager,
  SessionRecord,
  SessionStore,
  SessionSummary,
} from "./agent-types.js";
import { DefaultAgentSession } from "./agent-session.impl.js";

// ─── Options ─────────────────────────────────────────────────────────────────

/** Factory function for creating AgentSession instances. */
export type SessionFactory = (
  id: string,
  params: CreateSessionParams,
  deps: {
    agentLoop: AgentLoop;
    eventBus: EventBus;
    defaultTimeoutMs: number;
    sessionStore?: SessionStore;
  },
) => AgentSession;

export interface DefaultSessionManagerOptions {
  agentLoop: AgentLoop;
  eventBus: EventBus;
  /** Default run timeout in ms for new sessions. */
  defaultTimeoutMs?: number;

  // ─── Optional overrides (plugin injection points) ───────────────────────
  /** Custom session factory — replace how sessions are created. */
  sessionFactory?: SessionFactory;
  /** Session store — enables persistence across process restarts. */
  sessionStore?: SessionStore;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Session manager with optional SQLite-backed persistence.
 *
 * Sessions are cached in-memory for fast access. When a SessionStore is
 * provided, all mutations are persisted to the store, and sessions can
 * be restored from the store on cache miss (e.g., after process restart).
 *
 * Without a SessionStore, behaves as a pure in-memory manager (backward
 * compatible with the previous implementation).
 */
export class DefaultSessionManager implements SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly keyIndex = new Map<string, string>(); // sessionKey → sessionId
  private readonly agentLoop: AgentLoop;
  private readonly eventBus: EventBus;
  private readonly defaultTimeoutMs: number;
  private readonly sessionFactory: SessionFactory;
  private readonly sessionStore?: SessionStore;

  constructor(options: DefaultSessionManagerOptions) {
    this.agentLoop = options.agentLoop;
    this.eventBus = options.eventBus;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    this.sessionStore = options.sessionStore;
  }

  async create(params: CreateSessionParams): Promise<AgentSession> {
    const id = uuidv4();
    const now = Date.now();
    const session = this.sessionFactory(id, params, {
      agentLoop: this.agentLoop,
      eventBus: this.eventBus,
      defaultTimeoutMs: this.defaultTimeoutMs,
      sessionStore: this.sessionStore,
    });

    await session.initialize();

    // Cache
    this.sessions.set(id, session);
    this.keyIndex.set(params.sessionKey, id);

    // Persist
    if (this.sessionStore) {
      await this.sessionStore.saveSession({
        id,
        agentId: params.agentId,
        workspaceId: params.workspaceId,
        sessionKey: params.sessionKey,
        status: "idle",
        createdAt: now,
        lastActiveAt: now,
      });
    }

    return session;
  }

  async get(sessionId: string): Promise<AgentSession | null> {
    // Check in-memory cache first
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    // Try restoring from persistent store
    if (!this.sessionStore) return null;
    const record = await this.sessionStore.getSession(sessionId);
    if (!record || record.status === "closed") return null;

    return this.restoreSession(record);
  }

  async getOrCreate(
    sessionKey: string,
    params: CreateSessionParams,
  ): Promise<AgentSession> {
    // 1. Check in-memory cache by key
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

    // 2. Try restoring from persistent store by key
    if (this.sessionStore) {
      const record = await this.sessionStore.getSessionByKey(sessionKey);
      if (record && record.status !== "closed") {
        const session = await this.restoreSession(record);
        if (session.status === "suspended") {
          await session.resume();
        }
        return session;
      }
    }

    // 3. Create new session
    return this.create({ ...params, sessionKey });
  }

  async listActive(workspaceId: string): Promise<SessionSummary[]> {
    // Query from store if available (more accurate than cache)
    if (this.sessionStore) {
      const records = await this.sessionStore.listActiveSessions(workspaceId);
      return records.map((r) => ({
        id: r.id,
        sessionKey: r.sessionKey,
        agentId: r.agentId,
        workspaceId: r.workspaceId,
        status: r.status,
        createdAt: r.createdAt,
        lastActiveAt: r.lastActiveAt,
      }));
    }

    // Fallback to in-memory scan
    const results: SessionSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session.workspaceId === workspaceId && session.status !== "closed") {
        results.push({
          id: session.id,
          sessionKey: session.sessionKey,
          agentId: session.agentId,
          workspaceId: session.workspaceId,
          status: session.status,
          createdAt: session.lastActiveAt,
          lastActiveAt: session.lastActiveAt,
        });
      }
    }
    return results;
  }

  async cleanup(maxIdleMs: number): Promise<number> {
    // Use store for expired session discovery if available
    if (this.sessionStore) {
      const expiredIds = await this.sessionStore.getExpiredSessionIds(maxIdleMs);
      for (const id of expiredIds) {
        const session = this.sessions.get(id);
        if (session) {
          await session.close();
          this.sessions.delete(id);
          this.keyIndex.delete(session.sessionKey);
        } else {
          // Not in cache — update store directly
          await this.sessionStore.updateSession(id, {
            status: "closed",
            lastActiveAt: Date.now(),
          });
        }
      }
      return expiredIds.length;
    }

    // Fallback to in-memory scan
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
    if (session) {
      await session.close();
      this.sessions.delete(sessionId);
      this.keyIndex.delete(session.sessionKey);
    } else if (this.sessionStore) {
      // Not in cache — update store directly
      await this.sessionStore.updateSession(sessionId, {
        status: "closed",
        lastActiveAt: Date.now(),
      });
    }
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Reconstruct an AgentSession from a persistent SessionRecord.
   * The session's PersistentMessageHistory will load messages
   * from the store during initialize().
   */
  private async restoreSession(record: SessionRecord): Promise<AgentSession> {
    const session = this.sessionFactory(
      record.id,
      {
        agentId: record.agentId,
        workspaceId: record.workspaceId,
        sessionKey: record.sessionKey,
      },
      {
        agentLoop: this.agentLoop,
        eventBus: this.eventBus,
        defaultTimeoutMs: this.defaultTimeoutMs,
        sessionStore: this.sessionStore,
      },
    );

    // initialize() loads persisted message history
    await session.initialize();

    // Cache the restored session
    this.sessions.set(record.id, session);
    this.keyIndex.set(record.sessionKey, record.id);

    return session;
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
    sessionStore: deps.sessionStore,
  });
