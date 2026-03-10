import type { Message, ProviderAdapter } from "../providers/adapter.js";
import type {
  CompactionResult,
  Compactor,
  ContextState,
} from "./context-types.js";
import { estimateTokens } from "../utils/token-estimator.js";

/**
 * Automatic context compaction (design doc §6.5).
 *
 * Trigger conditions (any one triggers):
 * - Message history tokens > tokenBudget × 85%
 * - Turn count >= 20
 * - Total tokens > maxContextWindow × 90%
 *
 * Compaction flow:
 * 1. Split history into old (to compact) and recent (to keep)
 * 2. Call LLM to summarize old messages
 * 3. Replace old messages with a summary message
 * 4. Return compaction stats
 */
export class DefaultCompactor implements Compactor {
  private readonly turnThreshold: number;
  private readonly historyRatio: number;
  private readonly contextRatio: number;
  private readonly keepRecentTurns: number;

  constructor(options?: {
    turnThreshold?: number;
    historyRatio?: number;
    contextRatio?: number;
    keepRecentTurns?: number;
  }) {
    this.turnThreshold = options?.turnThreshold ?? 20;
    this.historyRatio = options?.historyRatio ?? 0.85;
    this.contextRatio = options?.contextRatio ?? 0.90;
    this.keepRecentTurns = options?.keepRecentTurns ?? 4;
  }

  shouldCompact(state: ContextState): boolean {
    return (
      state.messageHistoryTokens > state.tokenBudget * this.historyRatio ||
      state.turnCount >= this.turnThreshold ||
      state.totalTokens > state.maxContextWindow * this.contextRatio
    );
  }

  async compact(
    messages: Message[],
    provider: ProviderAdapter,
  ): Promise<CompactionResult & { summary: string }> {
    if (messages.length <= this.keepRecentTurns * 2) {
      // Too few messages to compact meaningfully
      return {
        removedMessages: 0,
        removedTokens: 0,
        summaryTokens: 0,
        compactedAt: Date.now(),
        summary: "",
      };
    }

    // Split: keep recent turns, compact the rest
    const splitIdx = findSplitIndex(messages, this.keepRecentTurns);
    const toCompact = messages.slice(0, splitIdx);
    const toKeep = messages.slice(splitIdx);

    if (toCompact.length === 0) {
      return {
        removedMessages: 0,
        removedTokens: 0,
        summaryTokens: 0,
        compactedAt: Date.now(),
        summary: "",
      };
    }

    // Generate summary via LLM
    const summary = await generateSummary(toCompact, provider);
    const removedTokens = estimateTokensMessages(toCompact);
    const summaryTokens = estimateTokens(summary);

    return {
      removedMessages: toCompact.length,
      removedTokens,
      summaryTokens,
      compactedAt: Date.now(),
      summary,
    };
  }
}

// ─── Summary Generation ──────────────────────────────────────────────────────

const COMPACTION_PROMPT = `Summarize the following conversation history concisely. Include:
- Active tasks and their current status
- Key decisions made and their reasoning
- Important facts or context established
- Open questions or pending items

Be concise but preserve all actionable information. Write in the same language as the conversation.`;

async function generateSummary(
  messages: Message[],
  provider: ProviderAdapter,
): Promise<string> {
  const conversationText = messages
    .map((m) => {
      const role = m.role.toUpperCase();
      const text = m.content
        .map((c) => {
          if ("text" in c) return c.text;
          if (c.type === "tool-call") return `[Tool call: ${c.toolName}]`;
          return "";
        })
        .filter(Boolean)
        .join(" ");
      return `${role}: ${text}`;
    })
    .join("\n");

  try {
    const result = await provider.complete({
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: COMPACTION_PROMPT }],
        },
        {
          role: "user",
          content: [{ type: "text", text: conversationText }],
        },
      ],
      temperature: 0,
      maxTokens: 1024,
    });

    return result.content;
  } catch {
    // Fallback: simple mechanical summary
    return `[Conversation summary: ${messages.length} messages covering the discussion so far]`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Find the split point: keep the last N turns.
 * A "turn" starts at a user message.
 */
function findSplitIndex(messages: Message[], turnsToKeep: number): number {
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      turnsSeen++;
      if (turnsSeen >= turnsToKeep) {
        return i;
      }
    }
  }
  return 0;
}

function estimateTokensMessages(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      if ("text" in block) {
        total += estimateTokens(block.text);
      } else if (block.type === "tool-call") {
        total += estimateTokens(block.toolName) + estimateTokens(block.args);
      }
    }
  }
  return total;
}
