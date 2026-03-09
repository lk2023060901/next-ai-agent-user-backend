import type Database from "better-sqlite3";
import type { AccessType } from "../memory/memory-types.js";
import type {
  AccessLogEntry,
  AccessLogStore,
} from "../memory/store/interfaces.js";

// ─── SQLite Access Log Store ────────────────────────────────────────────────

export class SqliteAccessLogStore implements AccessLogStore {
  constructor(private readonly db: Database.Database) {}

  async log(entry: AccessLogEntry): Promise<void> {
    this.db.prepare(`
      INSERT INTO memory_access_log (memory_entry_id, agent_id, access_type, context_snippet, created_at)
      VALUES (@memoryId, @agentId, @accessType, @contextSnippet, @createdAt)
    `).run({
      memoryId: entry.memoryId,
      agentId: entry.agentId,
      accessType: entry.accessType,
      contextSnippet: entry.contextSnippet ?? null,
      createdAt: entry.createdAt,
    });
  }

  async logBatch(entries: AccessLogEntry[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO memory_access_log (memory_entry_id, agent_id, access_type, context_snippet, created_at)
      VALUES (@memoryId, @agentId, @accessType, @contextSnippet, @createdAt)
    `);
    const run = this.db.transaction((items: AccessLogEntry[]) => {
      for (const entry of items) {
        stmt.run({
          memoryId: entry.memoryId,
          agentId: entry.agentId,
          accessType: entry.accessType,
          contextSnippet: entry.contextSnippet ?? null,
          createdAt: entry.createdAt,
        });
      }
    });
    run(entries);
  }

  async getHistory(memoryId: string, limit = 50): Promise<AccessLogEntry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memory_access_log
      WHERE memory_entry_id = @memoryId
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ memoryId, limit }) as AccessLogRow[];

    return rows.map(rowToEntry);
  }

  async countByType(memoryId: string): Promise<Record<AccessType, number>> {
    const rows = this.db.prepare(`
      SELECT access_type, COUNT(*) as cnt
      FROM memory_access_log
      WHERE memory_entry_id = @memoryId
      GROUP BY access_type
    `).all({ memoryId }) as Array<{ access_type: string; cnt: number }>;

    const result: Record<string, number> = {
      search: 0,
      injection: 0,
      tool: 0,
      consolidation: 0,
    };
    for (const row of rows) {
      result[row.access_type] = row.cnt;
    }
    return result as Record<AccessType, number>;
  }
}

interface AccessLogRow {
  id: number;
  memory_entry_id: string;
  agent_id: string;
  access_type: string;
  context_snippet: string | null;
  created_at: number;
}

function rowToEntry(row: AccessLogRow): AccessLogEntry {
  return {
    memoryId: row.memory_entry_id,
    agentId: row.agent_id,
    accessType: row.access_type as AccessType,
    contextSnippet: row.context_snippet ?? undefined,
    createdAt: row.created_at,
  };
}
