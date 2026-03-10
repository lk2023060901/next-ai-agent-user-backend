import { v4 as uuidv4 } from "uuid";
import type { ProviderAdapter } from "../providers/adapter.js";
import { estimateTokens } from "../utils/token-estimator.js";
import type {
  AccessType,
  ConsolidationResult,
  CoreMemoryBlock,
  CoreMemorySnapshot,
  DecayUpdateResult,
  Entity,
  EntitySource,
  GraphResult,
  InjectedMemory,
  InjectionContext,
  MemoryEntry,
  MemoryManager,
  MemorySearchQuery,
  MemorySearchResult,
  NewMemoryEntry,
  ReflectionResult,
} from "./memory-types.js";
import {
  INJECTION_SCORING_WEIGHTS,
  INJECTION_THRESHOLD,
  getHalfLifeDays,
} from "./memory-types.js";
import type {
  FullTextIndex,
  GraphStore,
  MemoryStore,
  VectorIndex,
} from "./store/interfaces.js";
import { EntityExtractor } from "./extraction/entity-extractor.js";
import { MemoryExtractor } from "./extraction/memory-extractor.js";
import { DecayEngine } from "./lifecycle/decay-engine.js";
import { CoreMemoryManager } from "./lifecycle/core-memory-manager.js";
import { Consolidator } from "./lifecycle/consolidator.js";
import { ReflectionEngine } from "./lifecycle/reflection-engine.js";
import { HybridSearch } from "./retrieval/hybrid-search.js";
import { scoreMemory } from "./retrieval/scoring.js";
import { VisibilityManager } from "./shared/visibility-manager.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DefaultMemoryManagerOptions {
  // ─── Required (storage + LLM) ─────────────────────────────────────────
  memoryStore: MemoryStore;
  vectorIndex: VectorIndex;
  ftsIndex: FullTextIndex;
  graphStore: GraphStore;
  provider: ProviderAdapter;

  // ─── Optional overrides (plugin injection points) ─────────────────────
  // Pass your own implementation to replace any sub-component.
  // Omit to use our defaults.
  hybridSearch?: HybridSearch;
  decayEngine?: DecayEngine;
  coreMemory?: CoreMemoryManager;
  consolidator?: Consolidator;
  reflectionEngine?: ReflectionEngine;
  memoryExtractor?: MemoryExtractor;
  entityExtractor?: EntityExtractor;
  visibility?: VisibilityManager;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Default MemoryManager — the unified entry point for all memory operations.
 *
 * Orchestrates:
 * - Write: ingest → compute decay → index (vector + FTS) → link entities
 * - Search: hybrid search (vector + FTS + graph) → three-factor scoring
 * - Core memory: read/write pinned context blocks
 * - Lifecycle: decay, consolidation, reflection
 * - Injection: proactive context-relevant memory retrieval
 * - Sharing: visibility management across agents
 */
export class DefaultMemoryManager implements MemoryManager {
  private readonly store: MemoryStore;
  private readonly vectorIndex: VectorIndex;
  private readonly ftsIndex: FullTextIndex;
  private readonly graphStore: GraphStore;

  private readonly hybridSearch: HybridSearch;
  private readonly decayEngine: DecayEngine;
  private readonly coreMemory: CoreMemoryManager;
  private readonly consolidator: Consolidator;
  private readonly reflectionEngine: ReflectionEngine;
  private readonly memoryExtractor: MemoryExtractor;
  private readonly entityExtractor: EntityExtractor;
  private readonly visibility: VisibilityManager;

  constructor(options: DefaultMemoryManagerOptions) {
    this.store = options.memoryStore;
    this.vectorIndex = options.vectorIndex;
    this.ftsIndex = options.ftsIndex;
    this.graphStore = options.graphStore;

    // Each sub-component: use plugin override if provided, otherwise our default
    this.hybridSearch = options.hybridSearch ?? new HybridSearch(
      this.store, this.vectorIndex, this.ftsIndex, this.graphStore,
    );
    this.decayEngine = options.decayEngine ?? new DecayEngine(this.store);
    this.coreMemory = options.coreMemory ?? new CoreMemoryManager(this.store);
    this.consolidator = options.consolidator ?? new Consolidator(this.store, options.provider);
    this.reflectionEngine = options.reflectionEngine ?? new ReflectionEngine(
      this.store, options.provider, this.hybridSearch,
    );
    this.memoryExtractor = options.memoryExtractor ?? new MemoryExtractor(options.provider);
    this.entityExtractor = options.entityExtractor ?? new EntityExtractor(options.provider);
    this.visibility = options.visibility ?? new VisibilityManager(this.store);
  }

  // ─── Write ──────────────────────────────────────────────────────────────

  async ingest(entry: NewMemoryEntry): Promise<string> {
    const id = uuidv4();
    const importance = entry.importance ?? 5;
    const decay = this.decayEngine.initializeDecay(importance);
    const now = Date.now();

    const memoryEntry: MemoryEntry = {
      id,
      type: entry.type,
      agentId: entry.agentId,
      workspaceId: entry.workspaceId,
      content: entry.content,
      embedding: entry.embedding,
      importance,
      ...decay,
      accessCount: 0,
      sourceIds: entry.sourceIds ?? [],
      depth: entry.depth ?? 0,
      visibility: entry.visibility ?? "private",
      createdBy: entry.agentId,
      consolidated: false,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.insert(memoryEntry);

    // Index for search
    await this.ftsIndex.upsert(id, entry.content);
    if (entry.embedding) {
      await this.vectorIndex.upsert(id, entry.embedding);
    }

    return id;
  }

  async ingestBatch(entries: NewMemoryEntry[]): Promise<string[]> {
    const ids: string[] = [];
    for (const entry of entries) {
      const id = await this.ingest(entry);
      ids.push(id);
    }
    return ids;
  }

  // ─── Search ─────────────────────────────────────────────────────────────

  async search(query: MemorySearchQuery): Promise<MemorySearchResult[]> {
    return this.hybridSearch.search(query);
  }

  // ─── Core Memory ────────────────────────────────────────────────────────

  async getCoreMemory(agentId: string, workspaceId: string): Promise<CoreMemorySnapshot> {
    return this.coreMemory.get(agentId, workspaceId);
  }

  async updateCoreMemory(
    agentId: string,
    workspaceId: string,
    block: CoreMemoryBlock,
    content: string,
  ): Promise<void> {
    await this.coreMemory.update(agentId, workspaceId, block, content);
  }

  // ─── Knowledge Graph ────────────────────────────────────────────────────

  async extractEntities(text: string, source: EntitySource): Promise<Entity[]> {
    const entities = await this.entityExtractor.extract(text, source);

    // Store extracted entities in the graph
    for (const entity of entities) {
      // Check for existing entity with same name (disambiguation)
      const existing = await this.graphStore.findEntitiesByName(entity.name, 1);
      if (existing.length > 0) {
        // Update existing entity
        const match = existing[0]!;
        await this.graphStore.upsertEntity({
          ...match,
          description: entity.description || match.description,
          updatedAt: Date.now(),
        });
      } else {
        await this.graphStore.upsertEntity(entity);
      }
    }

    return entities;
  }

  async queryGraph(entityId: string, maxHops: number): Promise<GraphResult> {
    return this.graphStore.traverse(entityId, maxHops);
  }

  // ─── Reflection ─────────────────────────────────────────────────────────

  async checkReflectionTrigger(agentId: string, workspaceId: string): Promise<boolean> {
    return this.reflectionEngine.shouldTrigger(agentId, workspaceId);
  }

  async executeReflection(agentId: string, workspaceId: string): Promise<ReflectionResult> {
    return this.reflectionEngine.execute(agentId, workspaceId);
  }

  // ─── Decay ──────────────────────────────────────────────────────────────

  async refreshAccess(memoryId: string, _accessType: AccessType): Promise<void> {
    await this.decayEngine.refreshAccess(memoryId);
  }

  async batchDecayUpdate(): Promise<DecayUpdateResult> {
    return this.decayEngine.batchUpdate();
  }

  // ─── Injection ──────────────────────────────────────────────────────────

  async getRelevantInjections(context: InjectionContext): Promise<InjectedMemory[]> {
    // Search for relevant memories
    const searchResults = await this.search({
      query: context.currentMessage,
      agentId: context.agentId,
      workspaceId: context.workspaceId,
      limit: 20,
      embedding: undefined, // Would need embedding service to compute this
    });

    // Score and filter for injection
    const injections: InjectedMemory[] = [];
    let tokenCount = 0;

    for (const result of searchResults) {
      const injectionScore = scoreMemory(
        result.entry,
        result.breakdown.relevance,
        INJECTION_SCORING_WEIGHTS,
      ).score;

      if (injectionScore < INJECTION_THRESHOLD) continue;

      const contentTokens = estimateTokens(result.entry.content);
      if (tokenCount + contentTokens > context.tokenBudget) break;

      injections.push({
        memoryId: result.entry.id,
        content: result.entry.content,
        source: result.entry.type,
        score: injectionScore,
        reason: `${result.source} match (score: ${injectionScore.toFixed(2)})`,
      });

      tokenCount += contentTokens;

      // Refresh access for injected memories
      await this.decayEngine.refreshAccess(result.entry.id);
    }

    return injections;
  }

  // ─── Consolidation ─────────────────────────────────────────────────────

  async consolidate(agentId: string, workspaceId: string): Promise<ConsolidationResult> {
    return this.consolidator.consolidate(agentId, workspaceId);
  }
}
