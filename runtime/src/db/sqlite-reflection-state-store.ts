import type Database from "better-sqlite3";
import type {
  ReflectionState,
  ReflectionStateStore,
} from "../memory/store/interfaces.js";

// ─── SQLite Reflection State Store ──────────────────────────────────────────

export class SqliteReflectionStateStore implements ReflectionStateStore {
  constructor(private readonly db: Database.Database) {}

  async get(agentId: string, workspaceId: string): Promise<ReflectionState | null> {
    const row = this.db.prepare(`
      SELECT * FROM reflection_state
      WHERE agent_id = @agentId AND workspace_id = @workspaceId
    `).get({ agentId, workspaceId }) as ReflectionRow | undefined;

    if (!row) return null;

    return {
      agentId: row.agent_id,
      workspaceId: row.workspace_id,
      cumulativeImportance: row.cumulative_importance,
      lastReflectionAt: row.last_reflection_at,
      reflectionCount: row.reflection_count,
    };
  }

  async addImportance(agentId: string, workspaceId: string, delta: number): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO reflection_state (agent_id, workspace_id, cumulative_importance, reflection_count, updated_at)
      VALUES (@agentId, @workspaceId, @delta, 0, @now)
      ON CONFLICT(agent_id, workspace_id) DO UPDATE SET
        cumulative_importance = reflection_state.cumulative_importance + @delta,
        updated_at = @now
    `).run({ agentId, workspaceId, delta, now });
  }

  async recordReflection(agentId: string, workspaceId: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      UPDATE reflection_state SET
        cumulative_importance = 0,
        last_reflection_at = @now,
        reflection_count = reflection_count + 1,
        updated_at = @now
      WHERE agent_id = @agentId AND workspace_id = @workspaceId
    `).run({ agentId, workspaceId, now });
  }
}

interface ReflectionRow {
  agent_id: string;
  workspace_id: string;
  cumulative_importance: number;
  last_reflection_at: number | null;
  reflection_count: number;
  updated_at: number;
}
