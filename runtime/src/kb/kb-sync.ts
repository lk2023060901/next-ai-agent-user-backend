import { getRuntimeServices } from "../bootstrap.js";
import type { MemoryEntry } from "../memory/memory-types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface KbSyncChunk {
  chunkIndex: number;
  content: string;
  embedding: number[];
}

export interface SyncDocumentParams {
  workspaceId: string;
  knowledgeBaseId: string;
  documentId: string;
  documentName: string;
  chunks: KbSyncChunk[];
}

export interface DeleteDocumentParams {
  documentId: string;
}

export interface DeleteKbParams {
  knowledgeBaseId: string;
  documentIds: string[];
}

// ─── Deterministic ID ───────────────────────────────────────────────────────
//
// KB memory entries use a deterministic ID scheme so that sync is idempotent
// and deletions don't require a secondary index or full table scan.

function kbEntryId(documentId: string, chunkIndex: number): string {
  return `kb:${documentId}:${chunkIndex}`;
}

// ─── Sync (upsert) ─────────────────────────────────────────────────────────

export async function syncKbDocument(params: SyncDocumentParams): Promise<{ synced: number }> {
  const services = getRuntimeServices();
  if (!services.db) {
    return { synced: 0 };
  }

  const { memoryStore, vectorIndex, ftsIndex } = services.db;

  // 1. Delete old entries for this document (idempotent re-sync)
  await deleteEntriesForDocument(params.documentId, memoryStore, vectorIndex, ftsIndex);

  // 2. Insert new entries
  const now = Date.now();
  for (const chunk of params.chunks) {
    const id = kbEntryId(params.documentId, chunk.chunkIndex);
    const embedding = new Float32Array(chunk.embedding);

    const entry: MemoryEntry = {
      id,
      type: "knowledge",
      agentId: "",
      workspaceId: params.workspaceId,
      content: chunk.content,
      embedding,
      importance: 8,
      decayScore: 1.0,
      halfLifeDays: 36500,
      accessCount: 0,
      lastAccessedAt: now,
      sourceIds: [`kb:${params.knowledgeBaseId}`, `doc:${params.documentId}`],
      depth: 0,
      visibility: "public",
      createdBy: "system",
      consolidated: false,
      createdAt: now,
      updatedAt: now,
    };

    await memoryStore.insert(entry);
    await vectorIndex.upsert(id, embedding);
    await ftsIndex.upsert(id, chunk.content);
  }

  return { synced: params.chunks.length };
}

// ─── Delete single document ─────────────────────────────────────────────────

export async function deleteKbDocument(params: DeleteDocumentParams): Promise<{ deleted: number }> {
  const services = getRuntimeServices();
  if (!services.db) {
    return { deleted: 0 };
  }

  const { memoryStore, vectorIndex, ftsIndex } = services.db;
  return deleteEntriesForDocument(params.documentId, memoryStore, vectorIndex, ftsIndex);
}

// ─── Delete entire KB ───────────────────────────────────────────────────────

export async function deleteKbEntireKnowledgeBase(params: DeleteKbParams): Promise<{ deleted: number }> {
  const services = getRuntimeServices();
  if (!services.db) {
    return { deleted: 0 };
  }

  const { memoryStore, vectorIndex, ftsIndex } = services.db;
  let total = 0;
  for (const docId of params.documentIds) {
    const result = await deleteEntriesForDocument(docId, memoryStore, vectorIndex, ftsIndex);
    total += result.deleted;
  }
  return { deleted: total };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

async function deleteEntriesForDocument(
  documentId: string,
  memoryStore: { get(id: string): Promise<MemoryEntry | null>; delete(id: string): Promise<void> },
  vectorIndex: { remove(memoryId: string): Promise<void> },
  ftsIndex: { remove(memoryId: string): Promise<void> },
): Promise<{ deleted: number }> {
  let deleted = 0;
  // Deterministic IDs: iterate chunk indices until we find a gap.
  // A single document should never exceed 10000 chunks (~12M chars at 1200/chunk).
  for (let i = 0; i < 10_000; i++) {
    const id = kbEntryId(documentId, i);
    const existing = await memoryStore.get(id);
    if (!existing) break;

    await memoryStore.delete(id);
    await vectorIndex.remove(id);
    await ftsIndex.remove(id);
    deleted++;
  }
  return { deleted };
}
