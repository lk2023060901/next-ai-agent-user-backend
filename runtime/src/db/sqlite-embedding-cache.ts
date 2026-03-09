import type Database from "better-sqlite3";
import type { CacheKey, EmbeddingCache } from "../embedding/embedding-types.js";

// ─── SQLite Embedding Cache ─────────────────────────────────────────────────
//
// Persistent embedding cache backed by the embedding_cache table.
// Keyed by (content_hash, provider, model) to prevent redundant API calls.

export class SqliteEmbeddingCache implements EmbeddingCache {
  constructor(private readonly db: Database.Database) {}

  async getMany(keys: CacheKey[]): Promise<(Float32Array | null)[]> {
    const stmt = this.db.prepare(`
      SELECT embedding, dims FROM embedding_cache
      WHERE content_hash = @contentHash AND provider = @provider AND model = @model
    `);

    return keys.map((key) => {
      const row = stmt.get({
        contentHash: key.contentHash,
        provider: key.provider,
        model: key.model,
      }) as { embedding: Buffer; dims: number } | undefined;

      if (!row) return null;
      return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dims);
    });
  }

  async setMany(entries: Array<{ key: CacheKey; embedding: Float32Array }>): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embedding_cache (content_hash, provider, model, embedding, dims, created_at)
      VALUES (@contentHash, @provider, @model, @embedding, @dims, @createdAt)
    `);

    const now = Date.now();
    const run = this.db.transaction((items: typeof entries) => {
      for (const { key, embedding } of items) {
        stmt.run({
          contentHash: key.contentHash,
          provider: key.provider,
          model: key.model,
          embedding: Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
          dims: embedding.length,
          createdAt: now,
        });
      }
    });
    run(entries);
  }

  async evict(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare(
      "DELETE FROM embedding_cache WHERE created_at < @cutoff",
    ).run({ cutoff });
    return result.changes;
  }
}
