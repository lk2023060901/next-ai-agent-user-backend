import type { Message, ProviderAdapter } from "../providers/adapter.js";
import type { AgentTool } from "../tools/tool-types.js";
import type { AgentConfig } from "../agent/agent-types.js";
import type {
  CoreMemorySnapshot,
  InjectedMemory,
  InjectionContext,
} from "../core/types.js";

// Re-export shared types for backward compatibility
export type { CoreMemorySnapshot, InjectedMemory, InjectionContext };

// ─── Context Engine ──────────────────────────────────────────────────────────

export interface ContextEngine {
  /** Assemble messages for an LLM turn (system prompt + memory + history). */
  assemble(params: AssembleParams): Promise<AssembledContext>;

  /** Ingest a tool result into context (may update working memory, etc.). */
  ingestToolResult(toolCallId: string, toolName: string, result: unknown): void;

  /** Post-turn hook (compaction check, memory extraction trigger). */
  afterTurn(summary: TurnSummary): Promise<void>;

  /** Post-run hook (memory extraction, reflection trigger, decay update). */
  afterRun(params: AfterRunParams): Promise<void>;

  /** Force compaction of message history. */
  compact(reason: CompactionReason): Promise<CompactionResult>;

  /** Release resources. */
  dispose(): Promise<void>;
}

// ─── Assemble ────────────────────────────────────────────────────────────────

export interface AssembleParams {
  agent: AgentConfig;
  tools: AgentTool[];
  messageHistory: Message[];
  tokenBudget: number;
  includeSystemPrompt?: boolean;  // Default: true
  includeCoreMemory?: boolean;    // Default: true
  includeInjectedMemories?: boolean; // Default: true
  coreMemorySnapshot?: CoreMemorySnapshot;
  injectedMemories?: InjectedMemory[];
  channelContext?: ChannelContext;
  /** Additional context to append to system prompt (e.g. web search results).
   *  Counted in the token budget so it doesn't silently overflow. */
  additionalSystemContext?: string;
}

export interface AssembledContext {
  messages: Message[];
  totalTokens: number;
  breakdown: TokenBreakdown;
}

export interface TokenBreakdown {
  systemPrompt: number;
  coreMemory: number;
  injectedMemories: number;
  messageHistory: number;
  reserved: number;
}

// ─── Turn Summary ────────────────────────────────────────────────────────────

export interface TurnSummary {
  turnIndex: number;
  assistantText: string;
  toolCalls: Array<{ toolName: string; toolCallId: string; result: unknown }>;
  inputTokens: number;
  outputTokens: number;
}

// ─── After Run ───────────────────────────────────────────────────────────────

export interface AfterRunParams {
  extractMemories?: boolean;
  checkReflection?: boolean;
  updateDecay?: boolean;
}

// ─── Compaction ──────────────────────────────────────────────────────────────

export type CompactionReason = "token_threshold" | "turn_count" | "context_limit" | "manual";

export interface CompactionResult {
  removedMessages: number;
  removedTokens: number;
  summaryTokens: number;
  compactedAt: number;
}

// ─── Prompt Builder ──────────────────────────────────────────────────────────

export interface PromptBuilder {
  build(params: PromptBuildParams): string;
}

export interface PromptBuildParams {
  agent: AgentConfig;
  tools: AgentTool[];
  coreMemory?: CoreMemorySnapshot;
  injectedMemories?: InjectedMemory[];
  channelContext?: ChannelContext;
  currentDate?: string;
}

// ─── Core Memory & Injected Memory ───────────────────────────────────────────
// Canonical definitions live in core/types.ts. Re-exported above.

// ─── Channel Context ─────────────────────────────────────────────────────────

export interface ChannelContext {
  channelType: string;
  channelName?: string;
  constraints?: string;
}

// ─── Token Budget Allocator ──────────────────────────────────────────────────

export interface TokenBudgetAllocator {
  allocate(totalBudget: number, params: AllocationParams): TokenAllocation;
}

export interface AllocationParams {
  systemPromptTokens: number;
  hasCoreMemory: boolean;
  hasInjectedMemories: boolean;
  maxOutputTokens?: number;
}

export interface TokenAllocation {
  systemPrompt: number;
  coreMemory: number;
  injectedMemories: number;
  messageHistory: number;
  outputReserved: number;
}

// ─── History Trimmer ─────────────────────────────────────────────────────────

export interface HistoryTrimmer {
  trim(messages: Message[], tokenBudget: number): TrimResult;
}

export interface TrimResult {
  kept: Message[];
  removed: Message[];
  summary?: string;
}

// ─── Compactor ───────────────────────────────────────────────────────────────

export interface ContextState {
  messageHistoryTokens: number;
  tokenBudget: number;
  turnCount: number;
  totalTokens: number;
  maxContextWindow: number;
}

export interface Compactor {
  shouldCompact(state: ContextState): boolean;
  compact(
    messages: Message[],
    provider: ProviderAdapter,
  ): Promise<CompactionResult & { summary: string }>;
}

// ─── Memory Injector ─────────────────────────────────────────────────────────
// InjectionContext canonical definition lives in core/types.ts.

export interface MemoryInjector {
  getRelevant(context: InjectionContext): Promise<InjectedMemory[]>;
}
