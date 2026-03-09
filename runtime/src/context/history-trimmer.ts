import type { Message } from "../providers/adapter.js";
import type { HistoryTrimmer, TrimResult } from "./context-types.js";

/**
 * History trimmer (design doc §6.4).
 *
 * Trimming rules:
 * 1. Always keep the first user message (task origin)
 * 2. Always keep the most recent 2 turns (4 messages: user+assistant × 2)
 * 3. Remove from oldest first
 * 4. Tool call + tool result are removed as a pair (never split)
 * 5. Removed messages generate a summary placeholder
 *
 * Token estimation: uses a rough 4-chars-per-token heuristic.
 * Full tokenizer integration comes with the embedding/ module.
 */
export class DefaultHistoryTrimmer implements HistoryTrimmer {
  private readonly minRecentTurns: number;

  constructor(minRecentTurns = 2) {
    this.minRecentTurns = minRecentTurns;
  }

  trim(messages: Message[], tokenBudget: number): TrimResult {
    if (messages.length === 0) {
      return { kept: [], removed: [] };
    }

    const currentTokens = estimateTokens(messages);
    if (currentTokens <= tokenBudget) {
      return { kept: [...messages], removed: [] };
    }

    // Identify protected ranges
    const protectedIndices = new Set<number>();

    // Rule 1: protect first user message
    const firstUserIdx = messages.findIndex((m) => m.role === "user");
    if (firstUserIdx >= 0) {
      protectedIndices.add(firstUserIdx);
    }

    // Rule 2: protect last N turns (each turn = contiguous assistant+tool block)
    const recentBoundary = findRecentBoundary(messages, this.minRecentTurns);
    for (let i = recentBoundary; i < messages.length; i++) {
      protectedIndices.add(i);
    }

    // Group messages into removable units (rule 4: tool pairs stay together)
    const groups = groupMessages(messages);

    // Remove groups from oldest, skipping protected indices
    const removed: Message[] = [];
    const removedIndices = new Set<number>();
    let tokensToFree = currentTokens - tokenBudget;

    for (const group of groups) {
      if (tokensToFree <= 0) break;

      // Skip if any message in this group is protected
      if (group.indices.some((i) => protectedIndices.has(i))) continue;

      const groupTokens = estimateTokens(group.messages);
      for (const idx of group.indices) {
        removedIndices.add(idx);
      }
      removed.push(...group.messages);
      tokensToFree -= groupTokens;
    }

    // Build kept messages, inserting summary placeholder where removals happened
    const kept: Message[] = [];
    let insertedSummary = false;

    for (let i = 0; i < messages.length; i++) {
      if (removedIndices.has(i)) {
        if (!insertedSummary && removed.length > 0) {
          kept.push({
            role: "system",
            content: [{
              type: "text",
              text: `[Earlier conversation summarized: ${removed.length} messages removed to fit context window]`,
            }],
          });
          insertedSummary = true;
        }
        continue;
      }
      kept.push(messages[i]!);
    }

    return {
      kept,
      removed,
      summary: removed.length > 0
        ? `Trimmed ${removed.length} messages (${estimateTokens(removed)} tokens)`
        : undefined,
    };
  }
}

// ─── Message Grouping ────────────────────────────────────────────────────────

interface MessageGroup {
  indices: number[];
  messages: Message[];
}

/**
 * Group messages into removable units.
 * Tool call (in assistant) + tool result are grouped together.
 * Regular user/assistant messages are individual groups.
 */
function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    // If this is a tool result, it should have been grouped with the
    // preceding assistant message — skip (shouldn't happen in practice)
    if (msg.role === "tool") {
      groups.push({ indices: [i], messages: [msg] });
      i++;
      continue;
    }

    // If this is an assistant message with tool calls, group with
    // all following tool results
    if (msg.role === "assistant" && hasToolCalls(msg)) {
      const group: MessageGroup = { indices: [i], messages: [msg] };
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === "tool") {
        group.indices.push(j);
        group.messages.push(messages[j]!);
        j++;
      }
      groups.push(group);
      i = j;
      continue;
    }

    // Regular message — own group
    groups.push({ indices: [i], messages: [msg] });
    i++;
  }

  return groups;
}

function hasToolCalls(msg: Message): boolean {
  return msg.content.some((c) => c.type === "tool-call");
}

// ─── Recent Boundary ─────────────────────────────────────────────────────────

/**
 * Find the index where the last N "turns" begin.
 * A turn = one user message + the following assistant/tool messages.
 */
function findRecentBoundary(messages: Message[], turnsToKeep: number): number {
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      turnsSeen++;
      if (turnsSeen >= turnsToKeep) {
        return i;
      }
    }
  }
  return 0; // Not enough turns — keep everything
}

// ─── Token Estimation ────────────────────────────────────────────────────────

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if ("text" in block) {
        chars += block.text.length;
      } else if (block.type === "tool-call") {
        chars += block.toolName.length + block.args.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}
