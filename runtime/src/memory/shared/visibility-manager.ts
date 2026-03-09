import type {
  MemoryEntry,
  MemoryVisibility,
} from "../memory-types.js";
import type { MemoryStore } from "../store/interfaces.js";

/**
 * Memory visibility manager (design doc §7.2-7.4).
 *
 * Controls which memories are visible to which agents:
 * - private: only the creating agent
 * - shared: all agents in the same workspace
 * - public: all agents across workspaces (platform-level knowledge)
 *
 * Promotion flow (experience propagation):
 * 1. Agent accumulates successful private memories
 * 2. Consolidation produces refined semantic memories
 * 3. VisibilityManager promotes them to "shared"
 * 4. Other agents can then retrieve these via search
 */
export class VisibilityManager {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  /**
   * Check if a memory is visible to a given agent.
   */
  isVisible(entry: MemoryEntry, agentId: string, workspaceId: string): boolean {
    if (entry.visibility === "public") return true;
    if (entry.visibility === "shared" && entry.workspaceId === workspaceId) return true;
    if (entry.visibility === "private" && entry.createdBy === agentId) return true;
    return false;
  }

  /**
   * Promote a memory's visibility.
   * Can only promote upward: private → shared → public.
   */
  async promote(
    memoryId: string,
    newVisibility: MemoryVisibility,
  ): Promise<void> {
    const entry = await this.store.get(memoryId);
    if (!entry) return;

    const order: Record<MemoryVisibility, number> = {
      private: 0,
      shared: 1,
      public: 2,
    };

    // Only allow upward promotion
    if (order[newVisibility] <= order[entry.visibility]) return;

    await this.store.update(memoryId, { visibility: newVisibility });
  }

  /**
   * Filter a list of memories by visibility for a given agent.
   */
  filterVisible(
    entries: MemoryEntry[],
    agentId: string,
    workspaceId: string,
  ): MemoryEntry[] {
    return entries.filter((e) => this.isVisible(e, agentId, workspaceId));
  }

  /**
   * Find memories that are candidates for promotion to shared.
   * Criteria: high importance, consolidated, private, frequently accessed.
   */
  async findPromotionCandidates(
    agentId: string,
    workspaceId: string,
    limit = 10,
  ): Promise<MemoryEntry[]> {
    const memories = await this.store.list({
      agentId,
      workspaceId,
      visibility: ["private"],
      consolidated: false,
      limit: limit * 3,
      orderBy: "importance",
      orderDir: "desc",
      minDecay: 0.3,
    });

    // Filter to high-importance, frequently-accessed memories
    return memories
      .filter((m) => m.importance >= 7 && m.accessCount >= 3)
      .slice(0, limit);
  }
}
