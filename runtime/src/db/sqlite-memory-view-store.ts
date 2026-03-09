import type Database from "better-sqlite3";
import type {
  MemoryAccessLevel,
  MemoryViewStore,
} from "../memory/store/interfaces.js";

// ─── SQLite Memory View Store ───────────────────────────────────────────────
//
// Per-agent memory ACL. Complements the simple visibility field on
// MemoryEntry with fine-grained access control.

export class SqliteMemoryViewStore implements MemoryViewStore {
  constructor(private readonly db: Database.Database) {}

  async grant(memoryId: string, agentId: string, accessLevel: MemoryAccessLevel): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_memory_views (id, memory_entry_id, agent_id, access_level, created_at)
      VALUES (@id, @memoryId, @agentId, @accessLevel, @now)
      ON CONFLICT(memory_entry_id, agent_id) DO UPDATE SET
        access_level = @accessLevel
    `).run({
      id: `${memoryId}:${agentId}`,
      memoryId,
      agentId,
      accessLevel,
      now,
    });
  }

  async revoke(memoryId: string, agentId: string): Promise<void> {
    this.db.prepare(`
      DELETE FROM agent_memory_views
      WHERE memory_entry_id = @memoryId AND agent_id = @agentId
    `).run({ memoryId, agentId });
  }

  async hasAccess(memoryId: string, agentId: string): Promise<boolean> {
    const row = this.db.prepare(`
      SELECT 1 FROM agent_memory_views
      WHERE memory_entry_id = @memoryId AND agent_id = @agentId
    `).get({ memoryId, agentId });
    return !!row;
  }

  async getAccessibleMemoryIds(agentId: string, workspaceId: string): Promise<string[]> {
    const rows = this.db.prepare(`
      SELECT amv.memory_entry_id FROM agent_memory_views amv
      JOIN memory_entries me ON me.id = amv.memory_entry_id
      WHERE amv.agent_id = @agentId AND me.workspace_id = @workspaceId
    `).all({ agentId, workspaceId }) as Array<{ memory_entry_id: string }>;
    return rows.map((r) => r.memory_entry_id);
  }

  async getGrantedAgents(memoryId: string): Promise<Array<{ agentId: string; accessLevel: MemoryAccessLevel }>> {
    const rows = this.db.prepare(`
      SELECT agent_id, access_level FROM agent_memory_views
      WHERE memory_entry_id = @memoryId
    `).all({ memoryId }) as Array<{ agent_id: string; access_level: string }>;
    return rows.map((r) => ({
      agentId: r.agent_id,
      accessLevel: r.access_level as MemoryAccessLevel,
    }));
  }
}
