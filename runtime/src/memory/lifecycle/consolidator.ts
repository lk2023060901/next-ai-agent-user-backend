import { v4 as uuidv4 } from "uuid";
import type { ProviderAdapter } from "../../providers/adapter.js";
import type {
  ConsolidationResult,
  MemoryEntry,
} from "../memory-types.js";
import { getHalfLifeDays } from "../memory-types.js";
import type { MemoryStore } from "../store/interfaces.js";

/**
 * Memory consolidation engine (design doc §6.6-6.7).
 *
 * Trigger: cumulative tokens > 1400 or every 8 turns.
 *
 * Flow:
 * 1. Select top 18 high-importance un-consolidated memories
 * 2. LLM generates a compressed summary
 * 3. Summary written as new semantic memory
 * 4. Original memories marked as consolidated (decay continues)
 * 5. Similar memories can be merged into one refined summary
 */
export class Consolidator {
  private readonly store: MemoryStore;
  private readonly provider: ProviderAdapter;

  constructor(store: MemoryStore, provider: ProviderAdapter) {
    this.store = store;
    this.provider = provider;
  }

  async consolidate(
    agentId: string,
    workspaceId: string,
  ): Promise<ConsolidationResult> {
    // 1. Get un-consolidated memories, ordered by importance
    const candidates = await this.store.list({
      agentId,
      workspaceId,
      types: ["episodic", "semantic"],
      consolidated: false,
      limit: 18,
      orderBy: "importance",
      orderDir: "desc",
      minDecay: 0.05,
    });

    if (candidates.length < 3) {
      return { summarized: 0, merged: 0, summaryMemoryIds: [] };
    }

    // 2. Group similar memories for potential merging
    const groups = groupBySimilarity(candidates);

    const summaryIds: string[] = [];
    let totalSummarized = 0;
    let totalMerged = 0;

    for (const group of groups) {
      // 3. Generate consolidated summary
      const summary = await this.generateSummary(group);
      if (!summary) continue;

      // 4. Create summary memory
      const avgImportance = Math.round(
        group.reduce((sum, m) => sum + m.importance, 0) / group.length,
      );
      const now = Date.now();
      const summaryEntry: MemoryEntry = {
        id: uuidv4(),
        type: "semantic",
        agentId,
        workspaceId,
        content: summary,
        importance: Math.min(10, avgImportance + 1), // Slightly boost consolidated
        decayScore: 1,
        halfLifeDays: getHalfLifeDays(avgImportance + 1),
        accessCount: 0,
        lastAccessedAt: now,
        sourceIds: group.map((m) => m.id),
        depth: 0,
        visibility: "private",
        createdBy: agentId,
        consolidated: false,
        createdAt: now,
        updatedAt: now,
      };

      await this.store.insert(summaryEntry);
      summaryIds.push(summaryEntry.id);

      // 5. Mark originals as consolidated
      for (const mem of group) {
        await this.store.update(mem.id, { consolidated: true });
      }

      totalSummarized += group.length;
      if (group.length > 1) totalMerged += group.length - 1;
    }

    return {
      summarized: totalSummarized,
      merged: totalMerged,
      summaryMemoryIds: summaryIds,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async generateSummary(memories: MemoryEntry[]): Promise<string | null> {
    const memoryTexts = memories
      .map((m) => `- [importance=${m.importance}] ${m.content}`)
      .join("\n");

    try {
      const result = await this.provider.complete({
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: CONSOLIDATION_PROMPT }],
          },
          {
            role: "user",
            content: [{ type: "text", text: `Memories to consolidate:\n${memoryTexts}` }],
          },
        ],
        temperature: 0.2,
        maxTokens: 512,
      });

      const summary = result.content.trim();
      return summary.length > 0 ? summary : null;
    } catch {
      return null;
    }
  }
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const CONSOLIDATION_PROMPT = `Consolidate the following memories into a concise summary. Preserve all important facts, decisions, and actionable information. Merge duplicates and remove redundancy. Write in the same language as the memories.

Return only the consolidated text, no JSON or explanation.`;

// ─── Similarity Grouping ─────────────────────────────────────────────────────

/**
 * Simple grouping by content similarity (keyword overlap).
 * Full embedding-based grouping comes with the embedding/ module.
 */
function groupBySimilarity(memories: MemoryEntry[]): MemoryEntry[][] {
  if (memories.length <= 5) {
    // Small batch — consolidate as one group
    return [memories];
  }

  // Split into groups of ~5 based on simple keyword overlap
  const groups: MemoryEntry[][] = [];
  const used = new Set<number>();

  for (let i = 0; i < memories.length; i++) {
    if (used.has(i)) continue;

    const group: MemoryEntry[] = [memories[i]!];
    used.add(i);

    const wordsA = extractWords(memories[i]!.content);

    for (let j = i + 1; j < memories.length; j++) {
      if (used.has(j) || group.length >= 6) continue;

      const wordsB = extractWords(memories[j]!.content);
      const overlap = countOverlap(wordsA, wordsB);

      if (overlap >= 3) {
        group.push(memories[j]!);
        used.add(j);
      }
    }

    groups.push(group);
  }

  return groups;
}

function extractWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/\W+/).filter((w) => w.length > 3),
  );
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) {
    if (b.has(word)) count++;
  }
  return count;
}
