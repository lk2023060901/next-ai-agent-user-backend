import { createHash } from "node:crypto";
import type {
  BatchResult,
  CacheKey,
  EmbeddingCache,
  EmbeddingProvider,
} from "./embedding-types.js";

// ─── Batch Processor ────────────────────────────────────────────────────────
//
// Splits text arrays into provider-sized batches, checks cache first,
// calls the provider for misses, and writes results back to cache.
//
// Flow:
// 1. Hash each text → build cache keys
// 2. Bulk-lookup cache → separate hits from misses
// 3. Split misses into provider-sized batches
// 4. Call provider.embed() for each batch (with retry)
// 5. Write computed embeddings to cache
// 6. Reassemble results in original order

export interface BatchProcessorOptions {
  provider: EmbeddingProvider;
  model: string;
  cache: EmbeddingCache;
  batchSize: number;
  timeoutMs: number;
  maxRetries: number;
}

export class BatchProcessor {
  private readonly provider: EmbeddingProvider;
  private readonly model: string;
  private readonly cache: EmbeddingCache;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: BatchProcessorOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.cache = options.cache;
    this.batchSize = options.batchSize;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
  }

  async process(texts: string[]): Promise<BatchResult> {
    if (texts.length === 0) {
      return { embeddings: [], cached: 0, computed: 0 };
    }

    // 1. Build cache keys
    const keys: CacheKey[] = texts.map((t) => ({
      provider: this.provider.name,
      model: this.model,
      contentHash: contentHash(t),
    }));

    // 2. Check cache
    const cached = await this.cache.getMany(keys);
    const results: (Float32Array | null)[] = [...cached];

    // 3. Collect cache misses
    const misses: Array<{ index: number; text: string }> = [];
    for (let i = 0; i < texts.length; i++) {
      if (!results[i]) {
        misses.push({ index: i, text: texts[i]! });
      }
    }

    const cachedCount = texts.length - misses.length;
    let computedCount = 0;

    if (misses.length > 0) {
      // 4. Split into provider-sized batches and compute
      const batches = splitIntoBatches(misses, this.batchSize);

      for (const batch of batches) {
        const batchTexts = batch.map((m) => m.text);
        const embeddings = await this.callWithRetry(batchTexts);

        // 5. Assign results and write to cache
        const cacheEntries: Array<{ key: CacheKey; embedding: Float32Array }> = [];
        for (let j = 0; j < batch.length; j++) {
          const entry = batch[j]!;
          const embedding = embeddings[j]!;
          results[entry.index] = embedding;
          cacheEntries.push({ key: keys[entry.index]!, embedding });
        }

        await this.cache.setMany(cacheEntries);
        computedCount += batch.length;
      }
    }

    return {
      embeddings: results as Float32Array[],
      cached: cachedCount,
      computed: computedCount,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async callWithRetry(texts: string[]): Promise<Float32Array[]> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await withTimeout(
          this.provider.embed(texts, this.model),
          this.timeoutMs,
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isNonRetryable(lastError)) throw lastError;

        // Exponential backoff: 1s, 2s, 4s...
        if (attempt < this.maxRetries) {
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    }

    throw lastError ?? new Error("Embedding batch failed");
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function splitIntoBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function isNonRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes("invalid_api_key")
    || msg.includes("auth")
    || msg.includes("billing")
    || msg.includes("invalid_request");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Embedding timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
