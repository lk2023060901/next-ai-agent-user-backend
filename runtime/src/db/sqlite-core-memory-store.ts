import type Database from "better-sqlite3";
import type { CoreMemoryBlock, CoreMemorySnapshot } from "../memory/memory-types.js";
import type { CoreMemoryStore } from "../memory/store/interfaces.js";

// ─── SQLite Core Memory Store ───────────────────────────────────────────────

export class SqliteCoreMemoryStore implements CoreMemoryStore {
  constructor(private readonly db: Database.Database) {}

  async get(agentId: string, workspaceId: string): Promise<CoreMemorySnapshot> {
    const rows = this.db.prepare(`
      SELECT block_type, content FROM core_memory_blocks
      WHERE agent_id = @agentId AND workspace_id = @workspaceId
    `).all({ agentId, workspaceId }) as Array<{ block_type: string; content: string }>;

    const snapshot: CoreMemorySnapshot = {};
    for (const row of rows) {
      const block = row.block_type as CoreMemoryBlock;
      snapshot[block] = row.content;
    }
    return snapshot;
  }

  async upsert(
    agentId: string,
    workspaceId: string,
    block: CoreMemoryBlock,
    content: string,
  ): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO core_memory_blocks (id, agent_id, workspace_id, block_type, content, created_at, updated_at)
      VALUES (@id, @agentId, @workspaceId, @blockType, @content, @now, @now)
      ON CONFLICT(agent_id, workspace_id, block_type) DO UPDATE SET
        content = @content,
        updated_at = @now
    `).run({
      id: `core:${agentId}:${workspaceId}:${block}`,
      agentId,
      workspaceId,
      blockType: block,
      content,
      now,
    });
  }

  async delete(agentId: string, workspaceId: string, block: CoreMemoryBlock): Promise<void> {
    this.db.prepare(`
      DELETE FROM core_memory_blocks
      WHERE agent_id = @agentId AND workspace_id = @workspaceId AND block_type = @blockType
    `).run({ agentId, workspaceId, blockType: block });
  }
}
