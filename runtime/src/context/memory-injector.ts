import type {
  InjectedMemory,
  InjectionContext,
  MemoryInjector,
} from "./context-types.js";

/**
 * No-op memory injector stub.
 *
 * Returns an empty list — no memories are injected into context.
 * The real implementation will be provided by the memory/ module,
 * which performs embedding-based similarity search across episodic
 * memory, knowledge base, and reflection archives.
 *
 * This stub exists so the ContextEngine can be instantiated without
 * the memory system being built yet.
 */
export class StubMemoryInjector implements MemoryInjector {
  async getRelevant(_context: InjectionContext): Promise<InjectedMemory[]> {
    return [];
  }
}
