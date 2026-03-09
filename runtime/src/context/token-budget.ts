import type {
  AllocationParams,
  TokenAllocation,
  TokenBudgetAllocator,
} from "./context-types.js";

/**
 * Token budget allocator (design doc §6.3).
 *
 * Distribution strategy:
 *   outputReserved = max(4096, total × 15%)
 *   available = total - outputReserved
 *   systemPrompt = actual (passed in)
 *   coreMemory = min(2000, available × 10%)
 *   injectedMemories = min(3000, available × 15%)
 *   messageHistory = available - systemPrompt - coreMemory - injectedMemories
 *
 * When components are absent (no core memory, no injected memories),
 * their budget is redistributed to messageHistory.
 */
export class DefaultTokenBudgetAllocator implements TokenBudgetAllocator {
  allocate(totalBudget: number, params: AllocationParams): TokenAllocation {
    const outputReserved = Math.max(4096, Math.floor(totalBudget * 0.15));
    const available = totalBudget - outputReserved;

    const systemPrompt = Math.min(params.systemPromptTokens, available);
    const afterSystem = available - systemPrompt;

    const coreMemory = params.hasCoreMemory
      ? Math.min(2000, Math.floor(afterSystem * 0.10))
      : 0;

    const injectedMemories = params.hasInjectedMemories
      ? Math.min(3000, Math.floor(afterSystem * 0.15))
      : 0;

    const messageHistory = Math.max(0, afterSystem - coreMemory - injectedMemories);

    return {
      systemPrompt,
      coreMemory,
      injectedMemories,
      messageHistory,
      outputReserved,
    };
  }
}
