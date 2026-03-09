import type Database from "better-sqlite3";
import type { MemoryEntry } from "../memory/memory-types.js";
import type {
  MemoryCountParams,
  MemoryListParams,
  MemoryStore,
} from "../memory/store/interfaces.js";

// ─── SQLite Memory Store ────────────────────────────────────────────────────

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly db: Database.Database) {}

  async insert(entry: MemoryEntry): Promise<void> {
    this.db.prepare(`
      INSERT INTO memory_entries (
        id, workspace_id, agent_id, type, content,
        importance, decay_score, half_life_days, access_count, last_accessed_at,
        source_ids, depth, visibility, created_by, consolidated,
        created_at, updated_at
      ) VALUES (
        @id, @workspaceId, @agentId, @type, @content,
        @importance, @decayScore, @halfLifeDays, @accessCount, @lastAccessedAt,
        @sourceIds, @depth, @visibility, @createdBy, @consolidated,
        @createdAt, @updatedAt
      )
    `).run({
      id: entry.id,
      workspaceId: entry.workspaceId,
      agentId: entry.agentId,
      type: entry.type,
      content: entry.content,
      importance: entry.importance,
      decayScore: entry.decayScore,
      halfLifeDays: entry.halfLifeDays,
      accessCount: entry.accessCount,
      lastAccessedAt: entry.lastAccessedAt,
      sourceIds: JSON.stringify(entry.sourceIds),
      depth: entry.depth,
      visibility: entry.visibility,
      createdBy: entry.createdBy,
      consolidated: entry.consolidated ? 1 : 0,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  }

  async insertBatch(entries: MemoryEntry[]): Promise<void> {
    const insert = this.db.transaction((items: MemoryEntry[]) => {
      for (const entry of items) {
        // Reuse insert logic synchronously inside transaction
        this.db.prepare(`
          INSERT INTO memory_entries (
            id, workspace_id, agent_id, type, content,
            importance, decay_score, half_life_days, access_count, last_accessed_at,
            source_ids, depth, visibility, created_by, consolidated,
            created_at, updated_at
          ) VALUES (
            @id, @workspaceId, @agentId, @type, @content,
            @importance, @decayScore, @halfLifeDays, @accessCount, @lastAccessedAt,
            @sourceIds, @depth, @visibility, @createdBy, @consolidated,
            @createdAt, @updatedAt
          )
        `).run({
          id: entry.id,
          workspaceId: entry.workspaceId,
          agentId: entry.agentId,
          type: entry.type,
          content: entry.content,
          importance: entry.importance,
          decayScore: entry.decayScore,
          halfLifeDays: entry.halfLifeDays,
          accessCount: entry.accessCount,
          lastAccessedAt: entry.lastAccessedAt,
          sourceIds: JSON.stringify(entry.sourceIds),
          depth: entry.depth,
          visibility: entry.visibility,
          createdBy: entry.createdBy,
          consolidated: entry.consolidated ? 1 : 0,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        });
      }
    });
    insert(entries);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  async update(id: string, fields: Partial<MemoryEntry>): Promise<void> {
    const sets: string[] = [];
    const values: Record<string, unknown> = { id };

    if (fields.content !== undefined) { sets.push("content = @content"); values.content = fields.content; }
    if (fields.importance !== undefined) { sets.push("importance = @importance"); values.importance = fields.importance; }
    if (fields.decayScore !== undefined) { sets.push("decay_score = @decayScore"); values.decayScore = fields.decayScore; }
    if (fields.halfLifeDays !== undefined) { sets.push("half_life_days = @halfLifeDays"); values.halfLifeDays = fields.halfLifeDays; }
    if (fields.accessCount !== undefined) { sets.push("access_count = @accessCount"); values.accessCount = fields.accessCount; }
    if (fields.lastAccessedAt !== undefined) { sets.push("last_accessed_at = @lastAccessedAt"); values.lastAccessedAt = fields.lastAccessedAt; }
    if (fields.visibility !== undefined) { sets.push("visibility = @visibility"); values.visibility = fields.visibility; }
    if (fields.consolidated !== undefined) { sets.push("consolidated = @consolidated"); values.consolidated = fields.consolidated ? 1 : 0; }

    if (sets.length === 0) return;

    sets.push("updated_at = @updatedAt");
    values.updatedAt = Date.now();

    this.db.prepare(`UPDATE memory_entries SET ${sets.join(", ")} WHERE id = @id`).run(values);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM memory_entries WHERE id = ?").run(id);
  }

  async list(params: MemoryListParams): Promise<MemoryEntry[]> {
    const conditions = ["agent_id = @agentId", "workspace_id = @workspaceId"];
    const values: Record<string, unknown> = {
      agentId: params.agentId,
      workspaceId: params.workspaceId,
    };

    if (params.types && params.types.length > 0) {
      const placeholders = params.types.map((_, i) => `@type${i}`);
      conditions.push(`type IN (${placeholders.join(", ")})`);
      params.types.forEach((t, i) => { values[`type${i}`] = t; });
    }
    if (params.visibility && params.visibility.length > 0) {
      const placeholders = params.visibility.map((_, i) => `@vis${i}`);
      conditions.push(`visibility IN (${placeholders.join(", ")})`);
      params.visibility.forEach((v, i) => { values[`vis${i}`] = v; });
    }
    if (params.minDecay !== undefined) {
      conditions.push("decay_score >= @minDecay");
      values.minDecay = params.minDecay;
    }
    if (params.consolidated !== undefined) {
      conditions.push("consolidated = @consolidated");
      values.consolidated = params.consolidated ? 1 : 0;
    }

    const orderCol = ORDER_COLUMN_MAP[params.orderBy ?? "createdAt"] ?? "created_at";
    const orderDir = params.orderDir === "asc" ? "ASC" : "DESC";

    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;

    const sql = `
      SELECT * FROM memory_entries
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${orderCol} ${orderDir}
      LIMIT @limit OFFSET @offset
    `;
    values.limit = limit;
    values.offset = offset;

    const rows = this.db.prepare(sql).all(values) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  async count(params: MemoryCountParams): Promise<number> {
    const conditions = ["agent_id = @agentId", "workspace_id = @workspaceId"];
    const values: Record<string, unknown> = {
      agentId: params.agentId,
      workspaceId: params.workspaceId,
    };

    if (params.types && params.types.length > 0) {
      const placeholders = params.types.map((_, i) => `@type${i}`);
      conditions.push(`type IN (${placeholders.join(", ")})`);
      params.types.forEach((t, i) => { values[`type${i}`] = t; });
    }
    if (params.minDecay !== undefined) {
      conditions.push("decay_score >= @minDecay");
      values.minDecay = params.minDecay;
    }

    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memory_entries WHERE ${conditions.join(" AND ")}`,
    ).get(values) as { cnt: number };
    return row.cnt;
  }

  async sumUnreflectedImportance(agentId: string, workspaceId: string): Promise<number> {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(importance), 0) as total
      FROM memory_entries
      WHERE agent_id = @agentId
        AND workspace_id = @workspaceId
        AND type NOT IN ('reflection', 'meta_reflection')
        AND consolidated = 0
    `).get({ agentId, workspaceId }) as { total: number };
    return row.total;
  }

  async getStaleEntries(cutoffMs: number, limit: number): Promise<MemoryEntry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memory_entries
      WHERE last_accessed_at < @cutoff
      ORDER BY last_accessed_at ASC
      LIMIT @limit
    `).all({ cutoff: cutoffMs, limit }) as MemoryRow[];
    return rows.map(rowToEntry);
  }

  async batchUpdateDecay(updates: Array<{ id: string; decayScore: number }>): Promise<void> {
    const stmt = this.db.prepare(
      "UPDATE memory_entries SET decay_score = @decayScore, updated_at = @now WHERE id = @id",
    );
    const now = Date.now();
    const run = this.db.transaction((items: Array<{ id: string; decayScore: number }>) => {
      for (const { id, decayScore } of items) {
        stmt.run({ id, decayScore, now });
      }
    });
    run(updates);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

const ORDER_COLUMN_MAP: Record<string, string> = {
  createdAt: "created_at",
  importance: "importance",
  lastAccessedAt: "last_accessed_at",
  decayScore: "decay_score",
};

interface MemoryRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  type: string;
  content: string;
  importance: number;
  decay_score: number;
  half_life_days: number;
  access_count: number;
  last_accessed_at: number;
  source_ids: string | null;
  depth: number;
  visibility: string;
  created_by: string;
  consolidated: number;
  created_at: number;
  updated_at: number;
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    type: row.type as MemoryEntry["type"],
    content: row.content,
    importance: row.importance,
    decayScore: row.decay_score,
    halfLifeDays: row.half_life_days,
    accessCount: row.access_count,
    lastAccessedAt: row.last_accessed_at,
    sourceIds: row.source_ids ? JSON.parse(row.source_ids) : [],
    depth: row.depth,
    visibility: row.visibility as MemoryEntry["visibility"],
    createdBy: row.created_by,
    consolidated: row.consolidated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
