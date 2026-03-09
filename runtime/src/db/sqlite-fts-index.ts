import type Database from "better-sqlite3";
import type {
  FullTextIndex,
  FullTextSearchResult,
} from "../memory/store/interfaces.js";

// ─── SQLite Full-Text Index (FTS5) ─────────────────────────────────────────
//
// BM25 keyword search using the trigram tokenizer for CJK support.

export class SqliteFtsIndex implements FullTextIndex {
  constructor(private readonly db: Database.Database) {}

  async upsert(memoryId: string, content: string): Promise<void> {
    // FTS5 does not support UPSERT; delete first, then insert.
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);
    this.db.prepare(
      "INSERT INTO memory_fts (id, content) VALUES (@id, @content)",
    ).run({ id: memoryId, content });
  }

  async remove(memoryId: string): Promise<void> {
    this.db.prepare("DELETE FROM memory_fts WHERE id = ?").run(memoryId);
  }

  async search(query: string, limit: number): Promise<FullTextSearchResult[]> {
    if (!query.trim()) return [];

    // FTS5 trigram tokenizer: wrap query in double quotes for substring match
    const ftsQuery = `"${query.replace(/"/g, '""')}"`;

    const rows = this.db.prepare(`
      SELECT id, rank
      FROM memory_fts
      WHERE memory_fts MATCH @query
      ORDER BY rank
      LIMIT @limit
    `).all({ query: ftsQuery, limit }) as Array<{ id: string; rank: number }>;

    // FTS5 rank is negative (more negative = more relevant); normalize to positive
    return rows.map((row) => ({
      memoryId: row.id,
      score: -row.rank,
    }));
  }
}
