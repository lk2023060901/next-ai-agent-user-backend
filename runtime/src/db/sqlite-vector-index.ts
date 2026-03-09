import type Database from "better-sqlite3";
import type {
  VectorIndex,
  VectorSearchResult,
} from "../memory/store/interfaces.js";

// ─── SQLite Vector Index (sqlite-vec) ───────────────────────────────────────
//
// Wraps the vec0 virtual table for KNN search over memory embeddings.
// sqlite-vec must be loaded as an extension before use.

export class SqliteVectorIndex implements VectorIndex {
  constructor(private readonly db: Database.Database) {}

  async upsert(memoryId: string, embedding: Float32Array): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (id, embedding)
      VALUES (@id, @embedding)
    `).run({
      id: memoryId,
      embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    });
  }

  async upsertBatch(items: Array<{ memoryId: string; embedding: Float32Array }>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (id, embedding)
      VALUES (@id, @embedding)
    `);
    const run = this.db.transaction((batch: typeof items) => {
      for (const { memoryId, embedding } of batch) {
        stmt.run({
          id: memoryId,
          embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
        });
      }
    });
    run(items);
  }

  async remove(memoryId: string): Promise<void> {
    this.db.prepare("DELETE FROM memory_embeddings WHERE id = ?").run(memoryId);
  }

  async search(query: Float32Array, limit: number): Promise<VectorSearchResult[]> {
    const queryBuf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);

    const rows = this.db.prepare(`
      SELECT id, distance
      FROM memory_embeddings
      WHERE embedding MATCH @query
      ORDER BY distance
      LIMIT @limit
    `).all({ query: queryBuf, limit }) as Array<{ id: string; distance: number }>;

    // sqlite-vec returns L2 distance; convert to cosine similarity approximation.
    // For normalized vectors: similarity ≈ 1 - distance²/2
    return rows.map((row) => ({
      memoryId: row.id,
      similarity: Math.max(0, 1 - (row.distance * row.distance) / 2),
    }));
  }
}
