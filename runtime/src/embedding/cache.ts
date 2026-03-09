import type { CacheKey, EmbeddingCache } from "./embedding-types.js";

// ─── In-Memory Embedding Cache ──────────────────────────────────────────────
//
// Keyed by (provider, model, contentHash). In production the SQLite
// embedding_cache table provides persistence; this in-memory version
// is used for testing and development.

interface CacheEntry {
  embedding: Float32Array;
  cachedAt: number;
}

export class InMemoryEmbeddingCache implements EmbeddingCache {
  private readonly store = new Map<string, CacheEntry>();

  async getMany(keys: CacheKey[]): Promise<(Float32Array | null)[]> {
    return keys.map((k) => {
      const entry = this.store.get(this.toKey(k));
      return entry ? entry.embedding : null;
    });
  }

  async setMany(entries: Array<{ key: CacheKey; embedding: Float32Array }>): Promise<void> {
    const now = Date.now();
    for (const { key, embedding } of entries) {
      this.store.set(this.toKey(key), { embedding, cachedAt: now });
    }
  }

  async evict(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let evicted = 0;
    for (const [key, entry] of this.store) {
      if (entry.cachedAt < cutoff) {
        this.store.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  get size(): number {
    return this.store.size;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private toKey(k: CacheKey): string {
    return `${k.provider}:${k.model}:${k.contentHash}`;
  }
}
