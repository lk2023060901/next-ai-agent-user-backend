import type Database from "better-sqlite3";
import type { Message, MessageContent } from "../providers/adapter.js";
import type {
  SessionStore,
  SessionRecord,
  SessionStatus,
} from "../agent/agent-types.js";

// ─── SQLite Session Store ───────────────────────────────────────────────────
//
// Persists session metadata and message history to SQLite.
// Message content (MessageContent[]) is stored as JSON text.

export class SqliteSessionStore implements SessionStore {
  private readonly stmts: ReturnType<typeof prepareStatements>;

  constructor(private readonly db: Database.Database) {
    this.stmts = prepareStatements(db);
  }

  // ─── Session CRUD ──────────────────────────────────────────────────────

  async saveSession(record: SessionRecord): Promise<void> {
    this.stmts.insertSession.run({
      id: record.id,
      agent_id: record.agentId,
      workspace_id: record.workspaceId,
      session_key: record.sessionKey,
      status: record.status,
      created_at: record.createdAt,
      last_active_at: record.lastActiveAt,
    });
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const row = this.stmts.getById.get({ id: sessionId }) as SessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  async getSessionByKey(sessionKey: string): Promise<SessionRecord | null> {
    const row = this.stmts.getByKey.get({ session_key: sessionKey }) as SessionRow | undefined;
    return row ? toRecord(row) : null;
  }

  async listActiveSessions(workspaceId: string): Promise<SessionRecord[]> {
    const rows = this.stmts.listActive.all({ workspace_id: workspaceId }) as SessionRow[];
    return rows.map(toRecord);
  }

  async updateSession(
    sessionId: string,
    updates: Partial<Pick<SessionRecord, "status" | "lastActiveAt">>,
  ): Promise<void> {
    if (updates.status !== undefined && updates.lastActiveAt !== undefined) {
      this.stmts.updateStatusAndTime.run({
        id: sessionId,
        status: updates.status,
        last_active_at: updates.lastActiveAt,
      });
    } else if (updates.status !== undefined) {
      this.stmts.updateStatus.run({ id: sessionId, status: updates.status });
    } else if (updates.lastActiveAt !== undefined) {
      this.stmts.updateTime.run({ id: sessionId, last_active_at: updates.lastActiveAt });
    }
  }

  async getExpiredSessionIds(maxIdleMs: number): Promise<string[]> {
    const cutoff = Date.now() - maxIdleMs;
    const rows = this.stmts.getExpired.all({ cutoff }) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async deleteSession(sessionId: string): Promise<void> {
    // CASCADE deletes session_messages automatically
    this.stmts.deleteSession.run({ id: sessionId });
  }

  // ─── Message History ───────────────────────────────────────────────────

  async appendMessage(sessionId: string, message: Message): Promise<void> {
    // Get next sequence number
    const row = this.stmts.maxSeq.get({ session_id: sessionId }) as { max_seq: number | null } | undefined;
    const seq = (row?.max_seq ?? -1) + 1;

    this.stmts.insertMessage.run({
      session_id: sessionId,
      seq,
      role: message.role,
      content: JSON.stringify(message.content),
      tool_call_id: message.toolCallId ?? null,
      tool_name: message.toolName ?? null,
      is_error: message.isError ? 1 : 0,
      created_at: Date.now(),
    });
  }

  async getMessages(sessionId: string, limit?: number): Promise<Message[]> {
    let rows: MessageRow[];
    if (limit !== undefined) {
      rows = this.stmts.getRecentMessages.all({
        session_id: sessionId,
        limit,
      }) as MessageRow[];
      // getRecentMessages returns in DESC order; reverse to get chronological
      rows.reverse();
    } else {
      rows = this.stmts.getMessages.all({ session_id: sessionId }) as MessageRow[];
    }
    return rows.map(toMessage);
  }

  async clearMessages(sessionId: string): Promise<void> {
    this.stmts.clearMessages.run({ session_id: sessionId });
  }
}

// ─── Internal Types ─────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  agent_id: string;
  workspace_id: string;
  session_key: string;
  status: string;
  created_at: number;
  last_active_at: number;
}

interface MessageRow {
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  is_error: number;
}

// ─── Row ↔ Record Converters ────────────────────────────────────────────────

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    sessionKey: row.session_key,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

function toMessage(row: MessageRow): Message {
  const msg: Message = {
    role: row.role as Message["role"],
    content: JSON.parse(row.content) as MessageContent[],
  };
  if (row.tool_call_id) msg.toolCallId = row.tool_call_id;
  if (row.tool_name) msg.toolName = row.tool_name;
  if (row.is_error) msg.isError = true;
  return msg;
}

// ─── Prepared Statements ────────────────────────────────────────────────────

function prepareStatements(db: Database.Database) {
  return {
    insertSession: db.prepare(`
      INSERT INTO sessions (id, agent_id, workspace_id, session_key, status, created_at, last_active_at)
      VALUES (@id, @agent_id, @workspace_id, @session_key, @status, @created_at, @last_active_at)
    `),

    getById: db.prepare(`SELECT * FROM sessions WHERE id = @id`),

    getByKey: db.prepare(`SELECT * FROM sessions WHERE session_key = @session_key`),

    listActive: db.prepare(`
      SELECT * FROM sessions WHERE workspace_id = @workspace_id AND status != 'closed'
      ORDER BY last_active_at DESC
    `),

    updateStatusAndTime: db.prepare(`
      UPDATE sessions SET status = @status, last_active_at = @last_active_at WHERE id = @id
    `),

    updateStatus: db.prepare(`UPDATE sessions SET status = @status WHERE id = @id`),

    updateTime: db.prepare(`UPDATE sessions SET last_active_at = @last_active_at WHERE id = @id`),

    getExpired: db.prepare(`
      SELECT id FROM sessions WHERE status = 'idle' AND last_active_at < @cutoff
    `),

    deleteSession: db.prepare(`DELETE FROM sessions WHERE id = @id`),

    maxSeq: db.prepare(`
      SELECT MAX(seq) as max_seq FROM session_messages WHERE session_id = @session_id
    `),

    insertMessage: db.prepare(`
      INSERT INTO session_messages (session_id, seq, role, content, tool_call_id, tool_name, is_error, created_at)
      VALUES (@session_id, @seq, @role, @content, @tool_call_id, @tool_name, @is_error, @created_at)
    `),

    getMessages: db.prepare(`
      SELECT role, content, tool_call_id, tool_name, is_error
      FROM session_messages WHERE session_id = @session_id ORDER BY seq ASC
    `),

    getRecentMessages: db.prepare(`
      SELECT role, content, tool_call_id, tool_name, is_error
      FROM session_messages WHERE session_id = @session_id ORDER BY seq DESC LIMIT @limit
    `),

    clearMessages: db.prepare(`DELETE FROM session_messages WHERE session_id = @session_id`),
  };
}
