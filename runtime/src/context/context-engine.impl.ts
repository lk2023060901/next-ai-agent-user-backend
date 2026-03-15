import type { Message, ProviderAdapter } from "../providers/adapter.js";
import type {
  AfterRunParams,
  AssembleParams,
  AssembledContext,
  CompactionReason,
  CompactionResult,
  Compactor,
  ContextEngine,
  HistoryTrimmer,
  MemoryInjector,
  PromptBuilder,
  TokenBudgetAllocator,
  TurnSummary,
} from "./context-types.js";
import { DefaultCompactor } from "./compactor.js";
import { DefaultHistoryTrimmer } from "./history-trimmer.js";
import { StubMemoryInjector } from "./memory-injector.js";
import { DefaultPromptBuilder } from "./prompt-builder.js";
import { DefaultTokenBudgetAllocator } from "./token-budget.js";
import { estimateTokens } from "../utils/token-estimator.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DefaultContextEngineOptions {
  promptBuilder?: PromptBuilder;
  tokenBudgetAllocator?: TokenBudgetAllocator;
  historyTrimmer?: HistoryTrimmer;
  memoryInjector?: MemoryInjector;
  /** Custom compactor — replace compaction logic (LLM summarization strategy). */
  compactor?: Compactor;
  /** Provider adapter for compaction (LLM-based summarization). */
  providerAdapter?: ProviderAdapter;
  /** Max context window in tokens (from provider capabilities). */
  maxContextWindow?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Default context engine (design doc §6).
 *
 * Assembles the full message array for each LLM turn:
 * 1. Build system prompt (agent identity + core memory + tools + date)
 * 2. Inject relevant memories (from memory system)
 * 3. Trim message history to fit token budget
 * 4. Return assembled messages with token breakdown
 *
 * Also manages post-turn/post-run hooks and automatic compaction.
 */
export class DefaultContextEngine implements ContextEngine {
  private readonly promptBuilder: PromptBuilder;
  private readonly budgetAllocator: TokenBudgetAllocator;
  private readonly historyTrimmer: HistoryTrimmer;
  private readonly memoryInjector: MemoryInjector;
  private readonly compactor: Compactor;
  private readonly providerAdapter: ProviderAdapter | null;
  private readonly maxContextWindow: number;

  private turnCount = 0;

  constructor(options?: DefaultContextEngineOptions) {
    this.promptBuilder = options?.promptBuilder ?? new DefaultPromptBuilder();
    this.budgetAllocator = options?.tokenBudgetAllocator ?? new DefaultTokenBudgetAllocator();
    this.historyTrimmer = options?.historyTrimmer ?? new DefaultHistoryTrimmer();
    this.memoryInjector = options?.memoryInjector ?? new StubMemoryInjector();
    this.compactor = options?.compactor ?? new DefaultCompactor();
    this.providerAdapter = options?.providerAdapter ?? null;
    this.maxContextWindow = options?.maxContextWindow ?? 200_000;
  }

  async assemble(params: AssembleParams): Promise<AssembledContext> {
    const {
      agent,
      tools,
      messageHistory,
      tokenBudget,
      includeCoreMemory = true,
      includeInjectedMemories = true,
      coreMemorySnapshot,
      injectedMemories: preInjected,
      channelContext,
      additionalSystemContext,
    } = params;

    // 1. Build system prompt (includes additional context like web search results)
    let systemPrompt = this.promptBuilder.build({
      agent,
      tools,
      coreMemory: includeCoreMemory ? coreMemorySnapshot : undefined,
      injectedMemories: includeInjectedMemories ? preInjected : undefined,
      channelContext,
    });

    // H2: Append additional system context (web search, etc.) INSIDE assembly
    // so it counts toward the token budget instead of bypassing it.
    if (additionalSystemContext) {
      systemPrompt += "\n\n" + additionalSystemContext;
    }

    const systemPromptTokens = estimateTokens(systemPrompt);

    // 2. Allocate token budget
    const allocation = this.budgetAllocator.allocate(tokenBudget, {
      systemPromptTokens,
      hasCoreMemory: includeCoreMemory && !!coreMemorySnapshot,
      hasInjectedMemories: includeInjectedMemories && (preInjected ?? []).length > 0,
      maxOutputTokens: agent.maxTokens,
    });

    // 3. Trim message history to fit budget
    const { kept: trimmedHistory } = this.historyTrimmer.trim(
      messageHistory,
      allocation.messageHistory,
    );

    // 4. Assemble final messages
    const messages: Message[] = [];

    // System prompt message
    if (systemPrompt) {
      messages.push({
        role: "system",
        content: [{ type: "text", text: systemPrompt }],
      });
    }

    // Message history
    messages.push(...trimmedHistory);

    // 5. Calculate breakdown
    const historyTokens = estimateTokensMessages(trimmedHistory);
    const coreMemoryTokens = includeCoreMemory && coreMemorySnapshot
      ? estimateCoreMemoryTokens(coreMemorySnapshot)
      : 0;
    const injectedMemoryTokens = includeInjectedMemories && preInjected
      ? estimateInjectedMemoryTokens(preInjected)
      : 0;

    // ─── H1: Enforce token budget against context window ──────────────────
    // If total tokens exceed maxContextWindow (minus output reserve), trim
    // history more aggressively. estimateTokens uses char/4 which can be
    // 20-40% off, so add a 10% safety margin.
    const safetyMargin = 0.9;
    const effectiveLimit = Math.floor(this.maxContextWindow * safetyMargin) - allocation.outputReserved;
    let finalMessages = messages;
    let finalHistoryTokens = historyTokens;

    if (systemPromptTokens + historyTokens > effectiveLimit) {
      const historyBudget = Math.max(0, effectiveLimit - systemPromptTokens);
      const { kept } = this.historyTrimmer.trim(trimmedHistory, historyBudget);
      finalHistoryTokens = estimateTokensMessages(kept);
      finalMessages = [];
      if (systemPrompt) {
        finalMessages.push({
          role: "system",
          content: [{ type: "text", text: systemPrompt }],
        });
      }
      finalMessages.push(...kept);
    }

    return {
      messages: finalMessages,
      totalTokens: systemPromptTokens + finalHistoryTokens,
      breakdown: {
        systemPrompt: systemPromptTokens,
        coreMemory: coreMemoryTokens,
        injectedMemories: injectedMemoryTokens,
        messageHistory: finalHistoryTokens,
        reserved: allocation.outputReserved,
      },
    };
  }

  ingestToolResult(
    _toolCallId: string,
    _toolName: string,
    _result: unknown,
  ): void {
    // M6: Log so the no-op is visible during debugging
    console.debug(
      "[ContextEngine] ingestToolResult called (no-op) — tool results are added to message history by the AgentLoop",
    );
  }

  async afterTurn(summary: TurnSummary): Promise<void> {
    this.turnCount = summary.turnIndex + 1;
    console.debug(
      `[ContextEngine] afterTurn called (turn ${this.turnCount}) — compaction is triggered by the AgentLoop calling compact() directly`,
    );
  }

  async afterRun(_params: AfterRunParams): Promise<void> {
    console.debug(
      "[ContextEngine] afterRun called (no-op) — memory extraction/reflection delegated to memory module",
    );
    this.turnCount = 0;
  }

  async compact(_reason: CompactionReason): Promise<CompactionResult> {
    if (!this.providerAdapter) {
      return {
        removedMessages: 0,
        removedTokens: 0,
        summaryTokens: 0,
        compactedAt: Date.now(),
      };
    }

    // Compaction needs message history — caller should provide it
    // This is a placeholder; in practice, the AgentLoop passes messages
    return {
      removedMessages: 0,
      removedTokens: 0,
      summaryTokens: 0,
      compactedAt: Date.now(),
    };
  }

  /**
   * Check if compaction should trigger, given the current context state.
   * Called by the AgentLoop between turns.
   */
  shouldCompact(
    messageHistoryTokens: number,
    tokenBudget: number,
  ): boolean {
    return this.compactor.shouldCompact({
      messageHistoryTokens,
      tokenBudget,
      turnCount: this.turnCount,
      totalTokens: messageHistoryTokens, // Simplified; full calculation needs system prompt too
      maxContextWindow: this.maxContextWindow,
    });
  }

  /**
   * Compact messages using LLM summarization.
   * Returns the summary message to replace old messages with.
   */
  async compactMessages(
    messages: Message[],
  ): Promise<{
    summary: string;
    result: CompactionResult;
  }> {
    if (!this.providerAdapter) {
      return {
        summary: "",
        result: {
          removedMessages: 0,
          removedTokens: 0,
          summaryTokens: 0,
          compactedAt: Date.now(),
        },
      };
    }

    const compactionResult = await this.compactor.compact(
      messages,
      this.providerAdapter,
    );

    return {
      summary: compactionResult.summary,
      result: {
        removedMessages: compactionResult.removedMessages,
        removedTokens: compactionResult.removedTokens,
        summaryTokens: compactionResult.summaryTokens,
        compactedAt: compactionResult.compactedAt,
      },
    };
  }

  async dispose(): Promise<void> {
    this.turnCount = 0;
  }
}

// ─── Token Estimation ────────────────────────────────────────────────────────

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

function estimateCoreMemoryTokens(
  snapshot: NonNullable<AssembleParams["coreMemorySnapshot"]>,
): number {
  let total = 0;
  if (snapshot.persona) total += estimateTokens(snapshot.persona);
  if (snapshot.user) total += estimateTokens(snapshot.user);
  if (snapshot.working) total += estimateTokens(snapshot.working);
  if (snapshot.knowledgeSummary) total += estimateTokens(snapshot.knowledgeSummary);
  return total;
}

function estimateInjectedMemoryTokens(
  memories: NonNullable<AssembleParams["injectedMemories"]>,
): number {
  let total = 0;
  for (const m of memories) {
    total += estimateTokens(m.content);
  }
  return total;
}
