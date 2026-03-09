import type { DecayUpdateResult, MemoryEntry } from "../memory-types.js";
import { DECAY_FORGOTTEN_THRESHOLD, getHalfLifeDays } from "../memory-types.js";
import type { MemoryStore } from "../store/interfaces.js";

/**
 * Ebbinghaus forgetting curve engine (design doc §6).
 *
 * Retention formula:
 *   R = e^(-λ × age_days)
 *   where λ = ln(2) / half_life_days
 *
 * Spaced repetition reinforcement:
 *   Each access increases half-life by 15%:
 *   new_half_life = current_half_life × 1.15
 *
 * Effectively forgotten: decay < 0.05
 */
export class DecayEngine {
  private readonly store: MemoryStore;
  private readonly batchSize: number;

  constructor(store: MemoryStore, batchSize = 500) {
    this.store = store;
    this.batchSize = batchSize;
  }

  /**
   * Compute the current decay score for a memory entry.
   */
  computeDecay(entry: MemoryEntry, now = Date.now()): number {
    const ageDays = (now - entry.lastAccessedAt) / (24 * 3600_000);
    if (ageDays <= 0) return 1;

    const lambda = Math.LN2 / entry.halfLifeDays;
    return Math.exp(-lambda * ageDays);
  }

  /**
   * Refresh a memory's access — called when the memory is retrieved,
   * injected, or accessed via tool.
   *
   * Effects:
   * - Reset decay score to 1 (freshly accessed)
   * - Increase half-life by 15% (spaced repetition)
   * - Increment access count
   * - Update last accessed timestamp
   */
  async refreshAccess(memoryId: string): Promise<void> {
    const entry = await this.store.get(memoryId);
    if (!entry) return;

    const newHalfLife = entry.halfLifeDays * 1.15;

    await this.store.update(memoryId, {
      decayScore: 1,
      halfLifeDays: newHalfLife,
      accessCount: entry.accessCount + 1,
      lastAccessedAt: Date.now(),
    });
  }

  /**
   * Batch update decay scores for all stale entries.
   * Called periodically (e.g., after each run, or on a timer).
   */
  async batchUpdate(): Promise<DecayUpdateResult> {
    const now = Date.now();
    // Process entries that haven't been updated in the last hour
    const cutoff = now - 3600_000;
    const staleEntries = await this.store.getStaleEntries(cutoff, this.batchSize);

    if (staleEntries.length === 0) {
      return { updated: 0, forgotten: 0 };
    }

    const updates: Array<{ id: string; decayScore: number }> = [];
    let forgotten = 0;

    for (const entry of staleEntries) {
      const newDecay = this.computeDecay(entry, now);
      updates.push({ id: entry.id, decayScore: newDecay });

      if (newDecay < DECAY_FORGOTTEN_THRESHOLD) {
        forgotten++;
      }
    }

    await this.store.batchUpdateDecay(updates);

    return { updated: updates.length, forgotten };
  }

  /**
   * Initialize decay fields for a new memory entry.
   */
  initializeDecay(importance: number): {
    decayScore: number;
    halfLifeDays: number;
    lastAccessedAt: number;
  } {
    return {
      decayScore: 1, // Fresh memory
      halfLifeDays: getHalfLifeDays(importance),
      lastAccessedAt: Date.now(),
    };
  }
}
