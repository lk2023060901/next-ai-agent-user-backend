import type {
  CoreMemoryBlock,
  CoreMemorySnapshot,
} from "../memory-types.js";
import type { MemoryStore } from "../store/interfaces.js";

/**
 * Core memory manager (design doc §4.2).
 *
 * Core memory is "pinned" in context — always present in the system
 * prompt. It consists of 4 blocks:
 * - persona: Agent's role and personality
 * - user: User/task profile
 * - working: Current working context (frequently updated)
 * - knowledgeSummary: High-frequency KB citations
 *
 * Total budget: ~2000 tokens. Agent can self-edit via memory tools.
 *
 * Storage: each block is stored as a separate MemoryEntry with
 * type="semantic" and a conventional ID pattern:
 * core:<agentId>:<workspaceId>:<blockType>
 */
export class CoreMemoryManager {
  private readonly store: MemoryStore;

  constructor(store: MemoryStore) {
    this.store = store;
  }

  async get(agentId: string, workspaceId: string): Promise<CoreMemorySnapshot> {
    const blocks = await Promise.all(
      BLOCK_TYPES.map(async (block) => {
        const entry = await this.store.get(coreMemoryId(agentId, workspaceId, block));
        return [block, entry?.content] as const;
      }),
    );

    const snapshot: CoreMemorySnapshot = {};
    for (const [block, content] of blocks) {
      if (content) {
        snapshot[block] = content;
      }
    }
    return snapshot;
  }

  async update(
    agentId: string,
    workspaceId: string,
    block: CoreMemoryBlock,
    content: string,
  ): Promise<void> {
    const id = coreMemoryId(agentId, workspaceId, block);
    const existing = await this.store.get(id);

    if (existing) {
      await this.store.update(id, {
        content,
        updatedAt: Date.now(),
      });
    } else {
      await this.store.insert({
        id,
        type: "semantic",
        agentId,
        workspaceId,
        content,
        importance: 10, // Core memory is always max importance
        decayScore: 1,
        halfLifeDays: 36500, // Effectively permanent
        accessCount: 0,
        lastAccessedAt: Date.now(),
        sourceIds: [],
        depth: 0,
        visibility: "private",
        createdBy: agentId,
        consolidated: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  async clear(
    agentId: string,
    workspaceId: string,
    block: CoreMemoryBlock,
  ): Promise<void> {
    await this.store.delete(coreMemoryId(agentId, workspaceId, block));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BLOCK_TYPES: CoreMemoryBlock[] = ["persona", "user", "working", "knowledgeSummary"];

function coreMemoryId(agentId: string, workspaceId: string, block: string): string {
  return `core:${agentId}:${workspaceId}:${block}`;
}
