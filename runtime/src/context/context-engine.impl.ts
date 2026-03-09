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
    } = params;

    // 1. Build system prompt
    const systemPrompt = this.promptBuilder.build({
      agent,
      tools,
      coreMemory: includeCoreMemory ? coreMemorySnapshot : undefined,
      injectedMemories: includeInjectedMemories ? preInjected : undefined,
      channelContext,
    });

    const systemPromptTokens = estimateTokens(systemPrompt);

    // 2. Allocate token budget
    const allocation = this.budgetAllocator.allocate(tokenBudget, {
      systemPromptTokens,
      hasCoreMemory: includeCoreMemory && !!coreMemorySnapshot,
      hasInjectedMemories: includeInjectedMemories && (preInjected ?? []).length > 0,
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

    return {
      messages,
      totalTokens: systemPromptTokens + historyTokens,
      breakdown: {
        systemPrompt: systemPromptTokens,
        coreMemory: coreMemoryTokens,
        injectedMemories: injectedMemoryTokens,
        messageHistory: historyTokens,
        reserved: allocation.outputReserved,
      },
    };
  }

  ingestToolResult(
    _toolCallId: string,
    _toolName: string,
    _result: unknown,
  ): void {
    // Future: update working memory, extract entities from tool results
    // For now, tool results are added to message history by the AgentLoop
  }

  async afterTurn(summary: TurnSummary): Promise<void> {
    this.turnCount = summary.turnIndex + 1;

    // Check if compaction is needed (only if we have a provider for LLM calls)
    // Actual compaction is triggered by the AgentLoop calling compact() directly
  }

  async afterRun(_params: AfterRunParams): Promise<void> {
    // Future: trigger memory extraction, reflection check, decay update
    // These will be delegated to the memory/ module when built
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateTokensMessages(messages: Message[]): number {
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

function estimateCoreMemoryTokens(
  snapshot: NonNullable<AssembleParams["coreMemorySnapshot"]>,
): number {
  let chars = 0;
  if (snapshot.persona) chars += snapshot.persona.length;
  if (snapshot.user) chars += snapshot.user.length;
  if (snapshot.working) chars += snapshot.working.length;
  if (snapshot.knowledgeSummary) chars += snapshot.knowledgeSummary.length;
  return Math.ceil(chars / 4);
}

function estimateInjectedMemoryTokens(
  memories: NonNullable<AssembleParams["injectedMemories"]>,
): number {
  let chars = 0;
  for (const m of memories) {
    chars += m.content.length;
  }
  return Math.ceil(chars / 4);
}
