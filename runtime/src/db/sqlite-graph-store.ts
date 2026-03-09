import type Database from "better-sqlite3";
import type { Entity, GraphResult, Relation } from "../memory/memory-types.js";
import type { GraphStore } from "../memory/store/interfaces.js";

// ─── SQLite Graph Store ─────────────────────────────────────────────────────
//
// Entity-relation graph backed by SQLite tables + recursive CTE for traversal.

export class SqliteGraphStore implements GraphStore {
  constructor(private readonly db: Database.Database) {}

  // ─── Entity CRUD ──────────────────────────────────────────────────────

  async upsertEntity(entity: Entity): Promise<void> {
    this.db.prepare(`
      INSERT INTO entities (id, workspace_id, name, name_normalized, type, description, source, created_at, updated_at)
      VALUES (@id, @workspaceId, @name, @nameNormalized, @type, @description, @source, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        name = @name,
        name_normalized = @nameNormalized,
        description = COALESCE(@description, entities.description),
        mention_count = entities.mention_count + 1,
        updated_at = @updatedAt
    `).run({
      id: entity.id,
      workspaceId: (entity as EntityWithWorkspace).workspaceId ?? "",
      name: entity.name,
      nameNormalized: entity.name.toLowerCase().replace(/\s+/g, ""),
      type: entity.type,
      description: entity.description || null,
      source: entity.source,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    });

    // Upsert embedding if present
    if (entity.embedding) {
      this.db.prepare(`
        INSERT OR REPLACE INTO entity_embeddings (id, embedding)
        VALUES (@id, @embedding)
      `).run({
        id: entity.id,
        embedding: Buffer.from(
          entity.embedding.buffer,
          entity.embedding.byteOffset,
          entity.embedding.byteLength,
        ),
      });
    }
  }

  async getEntity(id: string): Promise<Entity | null> {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  async findEntitiesByName(name: string, limit: number): Promise<Entity[]> {
    const normalized = name.toLowerCase().replace(/\s+/g, "");
    const rows = this.db.prepare(`
      SELECT * FROM entities
      WHERE name_normalized LIKE @pattern
      ORDER BY mention_count DESC
      LIMIT @limit
    `).all({ pattern: `%${normalized}%`, limit }) as EntityRow[];
    return rows.map(rowToEntity);
  }

  async findEntitiesByEmbedding(embedding: Float32Array, limit: number): Promise<Entity[]> {
    const queryBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    const rows = this.db.prepare(`
      SELECT e.*, ee.distance
      FROM entity_embeddings ee
      JOIN entities e ON e.id = ee.id
      WHERE ee.embedding MATCH @query
      ORDER BY ee.distance
      LIMIT @limit
    `).all({ query: queryBuf, limit }) as EntityRow[];

    return rows.map(rowToEntity);
  }

  // ─── Relation CRUD ────────────────────────────────────────────────────

  async addRelation(relation: Relation): Promise<void> {
    this.db.prepare(`
      INSERT INTO relations (
        id, workspace_id, source_entity_id, target_entity_id,
        relation_type, description, weight,
        t_valid, t_invalid, t_created, t_expired
      ) VALUES (
        @id, @workspaceId, @sourceEntityId, @targetEntityId,
        @relationType, @description, @weight,
        @tValid, @tInvalid, @tCreated, @tExpired
      )
    `).run({
      id: relation.id,
      workspaceId: (relation as RelationWithWorkspace).workspaceId ?? "",
      sourceEntityId: relation.sourceEntityId,
      targetEntityId: relation.targetEntityId,
      relationType: relation.relationType,
      description: relation.description || null,
      weight: relation.weight,
      tValid: relation.tValid,
      tInvalid: relation.tInvalid ?? null,
      tCreated: relation.tCreated,
      tExpired: relation.tExpired ?? null,
    });
  }

  async invalidateRelation(id: string, tExpired: number): Promise<void> {
    this.db.prepare("UPDATE relations SET t_expired = @tExpired WHERE id = @id")
      .run({ id, tExpired });
  }

  // ─── Graph Traversal (Recursive CTE) ─────────────────────────────────

  async traverse(entityId: string, maxHops: number): Promise<GraphResult> {
    const entity = await this.getEntity(entityId);
    if (!entity) {
      return {
        entity: { id: entityId, name: "", type: "", description: "", source: "episode" as const, createdAt: 0, updatedAt: 0 },
        relations: [],
        connected: [],
      };
    }

    // Recursive CTE for BFS traversal
    const rows = this.db.prepare(`
      WITH RECURSIVE graph_walk(entity_id, depth) AS (
        -- Base case
        SELECT @rootId, 0

        UNION ALL

        -- Recursive step: follow outgoing and incoming relations
        SELECT
          CASE
            WHEN r.source_entity_id = gw.entity_id THEN r.target_entity_id
            ELSE r.source_entity_id
          END,
          gw.depth + 1
        FROM graph_walk gw
        JOIN relations r ON (
          r.source_entity_id = gw.entity_id OR r.target_entity_id = gw.entity_id
        )
        WHERE gw.depth < @maxHops
          AND r.t_expired IS NULL
      )
      SELECT DISTINCT entity_id FROM graph_walk WHERE entity_id != @rootId
    `).all({ rootId: entityId, maxHops }) as Array<{ entity_id: string }>;

    const connectedIds = rows.map((r) => r.entity_id);

    // Fetch connected entities
    const connected: Entity[] = [];
    if (connectedIds.length > 0) {
      const placeholders = connectedIds.map(() => "?").join(", ");
      const entityRows = this.db.prepare(
        `SELECT * FROM entities WHERE id IN (${placeholders})`,
      ).all(...connectedIds) as EntityRow[];
      connected.push(...entityRows.map(rowToEntity));
    }

    // Fetch all relations between root and connected
    const allIds = [entityId, ...connectedIds];
    const relPlaceholders = allIds.map(() => "?").join(", ");
    const relationRows = this.db.prepare(`
      SELECT * FROM relations
      WHERE t_expired IS NULL
        AND source_entity_id IN (${relPlaceholders})
        AND target_entity_id IN (${relPlaceholders})
    `).all(...allIds, ...allIds) as RelationRow[];

    const relations = relationRows.map(rowToRelation);

    return { entity, relations, connected };
  }

  // ─── Memory-Entity Links ──────────────────────────────────────────────

  async getEntitiesForMemory(memoryId: string): Promise<Entity[]> {
    const rows = this.db.prepare(`
      SELECT e.* FROM entities e
      JOIN memory_entity_links mel ON mel.entity_id = e.id
      WHERE mel.memory_id = @memoryId
    `).all({ memoryId }) as EntityRow[];
    return rows.map(rowToEntity);
  }

  async linkMemoryToEntity(memoryId: string, entityId: string): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO memory_entity_links (memory_id, entity_id)
      VALUES (@memoryId, @entityId)
    `).run({ memoryId, entityId });
  }
}

// ─── Row Types & Converters ─────────────────────────────────────────────────

interface EntityRow {
  id: string;
  workspace_id: string;
  name: string;
  name_normalized: string;
  type: string;
  description: string | null;
  source: string;
  mention_count: number;
  created_at: number;
  updated_at: number;
}

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description ?? "",
    source: row.source as Entity["source"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface RelationRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  description: string | null;
  weight: number;
  t_valid: number | null;
  t_invalid: number | null;
  t_created: number;
  t_expired: number | null;
}

function rowToRelation(row: RelationRow): Relation {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationType: row.relation_type,
    description: row.description ?? "",
    weight: row.weight,
    tValid: row.t_valid ?? 0,
    tInvalid: row.t_invalid ?? undefined,
    tCreated: row.t_created,
    tExpired: row.t_expired ?? undefined,
  };
}

// ─── Extended types (internal — workspace_id is stored in DB but not on interface)

interface EntityWithWorkspace extends Entity {
  workspaceId?: string;
}

interface RelationWithWorkspace extends Relation {
  workspaceId?: string;
}
