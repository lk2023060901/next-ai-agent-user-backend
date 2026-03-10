# Phase 2: KB Unified Cognitive Architecture — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate KB document chunks into runtime's unified memory system (memory_entries + sqlite-vec + FTS5 + knowledge graph), enabling hybrid search across all knowledge sources.

**Architecture:** Service layer pushes KB chunks to runtime via HTTP sync endpoint after document processing. Runtime stores chunks as `memory_entries` (type='knowledge') with vector + FTS indexing. search_knowledge tool switches from gRPC-based per-KB search to unified HybridSearch. Entity extraction runs on synced chunks to build the knowledge graph.

**Tech Stack:** TypeScript (ESM), Fastify, SQLite (better-sqlite3), sqlite-vec, FTS5

**Key Decision:** Plan B — KB data flows from service to runtime at write time. Runtime becomes the single search authority. Service retains its own `kbDocumentChunks` table as the source of truth; runtime's `memory_entries` is a derived index.

---

## Data Flow Overview

```
Service (port 50051)
  processKnowledgeBaseDocument()
    split text into chunks
    fetch embeddings (OpenAI/Qwen/etc)
    store in kbDocumentChunks (JSON embedding)
    POST /runtime/ws/:wsId/kb/sync  <-- NEW

  deleteKnowledgeBaseDocument() / deleteKnowledgeBase()
    delete chunks from service DB
    POST /runtime/ws/:wsId/kb/sync (action=delete)  <-- NEW

                    |
                    v

Runtime (port 8082)
  POST /runtime/ws/:wsId/kb/sync   <-- NEW ENDPOINT
    KBSyncService.sync()
      memory_entries (type='knowledge')
      memory_embeddings (sqlite-vec)
      memory_fts (FTS5)
      kb_memory_links (metadata lookup)
      [async] entity extraction -> entities + relations

  search_knowledge tool  <-- REFACTORED
    memoryManager.search({ types: ['knowledge'] })
    HybridSearch (vector + FTS + graph fusion)
    optional reranker
    return structured results
```

---

## Task 1: Add `kb_memory_links` table to runtime schema

**Files:**
- Modify: `runtime/src/db/schema.ts`

This table links `memory_entries` to their KB source metadata, enabling efficient deletion by knowledgeBaseId/documentId and result formatting.

**Step 1: Add table definition to schema.ts**

In `runtime/src/db/schema.ts`, append to `SCHEMA_SQL` (before the closing backtick):

```sql
-- KB chunk to memory entry association
CREATE TABLE IF NOT EXISTS kb_memory_links (
  memory_id         TEXT PRIMARY KEY REFERENCES memory_entries(id) ON DELETE CASCADE,
  workspace_id      TEXT NOT NULL,
  knowledge_base_id TEXT NOT NULL,
  document_id       TEXT NOT NULL,
  document_name     TEXT NOT NULL,
  chunk_index       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_links_ws ON kb_memory_links(workspace_id);
CREATE INDEX IF NOT EXISTS idx_kb_links_kb ON kb_memory_links(knowledge_base_id);
CREATE INDEX IF NOT EXISTS idx_kb_links_doc ON kb_memory_links(document_id);
```

**Step 2: No additional init needed**

The schema is executed via `db.exec(SCHEMA_SQL)` in `database-manager.impl.ts:91`. The `IF NOT EXISTS` makes it idempotent.

**Step 3: Verify**

Run runtime with DB_PATH set. Expected: starts without errors.

**Step 4: Commit**

```
feat(runtime): add kb_memory_links table for KB-memory association
```

---

## Task 2: Create KB sync types

**Files:**
- Create: `runtime/src/kb/kb-sync-types.ts`

**Step 1: Create directory and types file**

```typescript
// runtime/src/kb/kb-sync-types.ts

export interface KBSyncChunk {
  id: string;
  knowledgeBaseId: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  embedding?: number[];
  embeddingDim?: number;
}

export interface KBSyncRequest {
  action: "sync_chunks" | "delete_document" | "delete_kb";
  knowledgeBaseId: string;
  documentId?: string;
  chunks?: KBSyncChunk[];
}

export interface KBSyncResponse {
  ok: boolean;
  synced?: number;
  deleted?: number;
  error?: string;
}
```

**Step 2: Commit**

```
feat(runtime): add KB sync type definitions
```

---

## Task 3: Create KB sync service

**Files:**
- Create: `runtime/src/kb/kb-sync-service.ts`

This is the core of H1+H2. It writes KB chunks into `memory_entries` + `memory_embeddings` + `memory_fts` + `kb_memory_links`.

**Step 1: Implement KBSyncService**

```typescript
// runtime/src/kb/kb-sync-service.ts

import Database from "better-sqlite3";
import type { MemoryEntry } from "../memory/memory-types.js";
import type { VectorIndex, FullTextIndex } from "../memory/store/interfaces.js";
import type { EmbeddingService } from "../embedding/embedding-types.js";
import type { MemoryManager } from "../memory/memory-types.js";
import type { KBSyncRequest, KBSyncResponse, KBSyncChunk } from "./kb-sync-types.js";

export interface KBSyncServiceDeps {
  db: Database.Database;
  vectorIndex: VectorIndex;
  ftsIndex: FullTextIndex;
  embedding: EmbeddingService | null;
  memoryManager: MemoryManager | null;
}

export class KBSyncService {
  private readonly db: Database.Database;
  private readonly vectorIndex: VectorIndex;
  private readonly ftsIndex: FullTextIndex;
  private readonly embedding: EmbeddingService | null;
  private readonly memoryManager: MemoryManager | null;

  constructor(deps: KBSyncServiceDeps) {
    this.db = deps.db;
    this.vectorIndex = deps.vectorIndex;
    this.ftsIndex = deps.ftsIndex;
    this.embedding = deps.embedding;
    this.memoryManager = deps.memoryManager;
  }

  async sync(workspaceId: string, request: KBSyncRequest): Promise<KBSyncResponse> {
    switch (request.action) {
      case "sync_chunks":
        return this.syncChunks(workspaceId, request);
      case "delete_document":
        return this.deleteDocument(workspaceId, request);
      case "delete_kb":
        return this.deleteKnowledgeBase(workspaceId, request);
      default:
        return { ok: false, error: `Unknown action` };
    }
  }

  private async syncChunks(
    workspaceId: string,
    request: KBSyncRequest,
  ): Promise<KBSyncResponse> {
    const chunks = request.chunks ?? [];
    if (chunks.length === 0) return { ok: true, synced: 0 };
    if (!request.documentId) {
      return { ok: false, error: "documentId required for sync_chunks" };
    }

    // Delete existing chunks for this document first (idempotent re-sync)
    await this.deleteByDocument(workspaceId, request.documentId);

    const now = Date.now();
    let synced = 0;

    for (const chunk of chunks) {
      const memoryId = `kb:${chunk.id}`;

      // 1. Insert memory_entry
      this.db
        .prepare(
          `INSERT OR REPLACE INTO memory_entries
           (id, workspace_id, agent_id, session_id, type, depth, content,
            importance, decay_score, half_life_days, access_count, last_accessed_at,
            source_ids, visibility, created_by, consolidated, created_at, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?,
                   ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memoryId, workspaceId, "", "knowledge", 0, chunk.content,
          8, 1.0, 36500, 0, now,
          "[]", "shared", "kb-sync", 0, now, now,
        );

      // 2. Insert kb_memory_links
      this.db
        .prepare(
          `INSERT OR REPLACE INTO kb_memory_links
           (memory_id, workspace_id, knowledge_base_id, document_id, document_name, chunk_index)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(memoryId, workspaceId, chunk.knowledgeBaseId, chunk.documentId, chunk.documentName, chunk.chunkIndex);

      // 3. Index in FTS5
      await this.ftsIndex.upsert(memoryId, chunk.content);

      // 4. Index embedding in sqlite-vec
      let embedding: Float32Array | undefined;
      if (chunk.embedding && chunk.embedding.length > 0) {
        embedding = new Float32Array(chunk.embedding);
      } else if (this.embedding) {
        try {
          embedding = await this.embedding.embedOne(chunk.content);
        } catch {
          // Embedding failure is non-fatal; FTS still works
        }
      }
      if (embedding) {
        await this.vectorIndex.upsert(memoryId, embedding);
      }

      synced++;
    }

    // Queue background entity extraction (H3)
    if (this.memoryManager && synced > 0) {
      const chunksForExtraction = chunks.map((c) => ({
        memoryId: `kb:${c.id}`,
        content: c.content,
      }));
      setImmediate(() => {
        this.extractEntitiesFromChunks(chunksForExtraction).catch((err) => {
          console.warn("[kb-sync] entity extraction failed:", err);
        });
      });
    }

    return { ok: true, synced };
  }

  private async deleteDocument(
    workspaceId: string,
    request: KBSyncRequest,
  ): Promise<KBSyncResponse> {
    if (!request.documentId) {
      return { ok: false, error: "documentId required for delete_document" };
    }
    const deleted = await this.deleteByDocument(workspaceId, request.documentId);
    return { ok: true, deleted };
  }

  private async deleteKnowledgeBase(
    workspaceId: string,
    request: KBSyncRequest,
  ): Promise<KBSyncResponse> {
    const deleted = await this.deleteByKB(workspaceId, request.knowledgeBaseId);
    return { ok: true, deleted };
  }

  // --- Internal ---

  private async deleteByDocument(workspaceId: string, documentId: string): Promise<number> {
    const rows = this.db
      .prepare("SELECT memory_id FROM kb_memory_links WHERE workspace_id = ? AND document_id = ?")
      .all(workspaceId, documentId) as Array<{ memory_id: string }>;

    for (const row of rows) {
      await this.vectorIndex.remove(row.memory_id);
      await this.ftsIndex.remove(row.memory_id);
    }

    this.db
      .prepare(
        `DELETE FROM memory_entries WHERE id IN (
           SELECT memory_id FROM kb_memory_links WHERE workspace_id = ? AND document_id = ?
         )`,
      )
      .run(workspaceId, documentId);

    return rows.length;
  }

  private async deleteByKB(workspaceId: string, knowledgeBaseId: string): Promise<number> {
    const rows = this.db
      .prepare("SELECT memory_id FROM kb_memory_links WHERE workspace_id = ? AND knowledge_base_id = ?")
      .all(workspaceId, knowledgeBaseId) as Array<{ memory_id: string }>;

    for (const row of rows) {
      await this.vectorIndex.remove(row.memory_id);
      await this.ftsIndex.remove(row.memory_id);
    }

    this.db
      .prepare(
        `DELETE FROM memory_entries WHERE id IN (
           SELECT memory_id FROM kb_memory_links WHERE workspace_id = ? AND knowledge_base_id = ?
         )`,
      )
      .run(workspaceId, knowledgeBaseId);

    return rows.length;
  }

  private async extractEntitiesFromChunks(
    chunks: Array<{ memoryId: string; content: string }>,
  ): Promise<void> {
    if (!this.memoryManager) return;
    for (const chunk of chunks) {
      try {
        await this.memoryManager.extractEntities(chunk.content, { type: "kb_chunk" });
      } catch {
        // Entity extraction failure is non-fatal
      }
    }
  }
}
```

**Key design decisions:**

- **Deterministic IDs** (`kb:{chunkId}`): Enables idempotent sync. `INSERT OR REPLACE` handles upserts.
- **Direct SQL for memory_entries**: Bypasses `MemoryManager.ingest()` to control the ID.
- **Delete-before-insert**: `syncChunks` deletes existing chunks for the document first, ensuring clean re-sync on reindex.
- **KB entries are `shared` visibility**: All agents in the workspace can search KB content.
- **Permanent decay** (`halfLifeDays: 36500`): KB content never forgets.
- **Entity extraction is background + non-fatal**: Requires LazyProvider to be set (first agent run).

**Step 2: Commit**

```
feat(runtime): KB sync service for unified memory integration (H1+H2+H3)
```

---

## Task 4: Add KB sync HTTP endpoint and bootstrap wiring

**Files:**
- Modify: `runtime/src/bootstrap.ts`
- Modify: `runtime/src/main.ts`

**Step 1: Expose KBSyncService from bootstrap**

In `runtime/src/bootstrap.ts`:

1. Import KBSyncService:
```typescript
import { KBSyncService } from "./kb/kb-sync-service.js";
```

2. Add to RuntimeServices interface:
```typescript
export interface RuntimeServices {
  db: DatabaseManager | null;
  embedding: EmbeddingService | null;
  memoryManager: MemoryManager | null;
  sessionStore: SessionStore | null;
  kbSyncService: KBSyncService | null;
  setMemoryProvider(provider: ProviderAdapter): void;
}
```

3. In `initializeServices()`, after creating memoryManager, create KBSyncService:
```typescript
const kbSyncService = new KBSyncService({
  db: db.raw,
  vectorIndex: db.vectorIndex,
  ftsIndex: db.ftsIndex,
  embedding,
  memoryManager,
});
```

4. Include in return object (both DB and no-DB paths).

**Step 2: Add the HTTP endpoint in main.ts**

After the approval endpoints, add:

```typescript
import type { KBSyncRequest } from "./kb/kb-sync-types.js";

app.post<{
  Params: { wsId: string };
  Body: KBSyncRequest;
}>("/runtime/ws/:wsId/kb/sync", async (request, reply) => {
  const runtimeSecretHeader = request.headers["x-runtime-secret"];
  const providedSecret = Array.isArray(runtimeSecretHeader)
    ? (runtimeSecretHeader[0] ?? "")
    : (runtimeSecretHeader ?? "");
  if (providedSecret !== config.runtimeSecret) {
    return reply.status(401).send({ error: "invalid runtime secret" });
  }

  const { wsId } = request.params;
  const body = request.body;

  if (!body?.action || !body?.knowledgeBaseId) {
    return reply.status(400).send({ error: "action and knowledgeBaseId required" });
  }

  const services = getRuntimeServices();
  if (!services.kbSyncService) {
    return reply.status(503).send({ error: "memory system not available" });
  }

  try {
    const result = await services.kbSyncService.sync(wsId, body);
    if (!result.ok) {
      return reply.status(400).send(result);
    }
    return reply.send(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.error({ err, wsId, action: body.action }, "KB sync failed");
    return reply.status(500).send({ ok: false, error: message });
  }
});
```

**Step 3: Verify**

```bash
curl -s -X POST http://localhost:8082/runtime/ws/test-ws/kb/sync \
  -H "Content-Type: application/json" \
  -H "X-Runtime-Secret: dev-runtime-secret" \
  -d '{"action":"sync_chunks","knowledgeBaseId":"kb1","documentId":"doc1","chunks":[]}'
```
Expected: `{ "ok": true, "synced": 0 }`

**Step 4: Commit**

```
feat(runtime): add KB sync HTTP endpoint POST /runtime/ws/:wsId/kb/sync
```

---

## Task 5: Service calls runtime on KB changes

**Files:**
- Modify: `service/src/modules/tools/tools.service.ts`

**Step 1: Add config constants**

Near the top of `tools.service.ts`:

```typescript
const RUNTIME_ADDR = process.env.RUNTIME_ADDR || "http://localhost:8082";
const RUNTIME_SECRET = process.env.RUNTIME_SECRET || "dev-runtime-secret";
```

**Step 2: Create sync helper function**

```typescript
async function notifyRuntimeKBSync(
  workspaceId: string,
  payload: {
    action: "sync_chunks" | "delete_document" | "delete_kb";
    knowledgeBaseId: string;
    documentId?: string;
    chunks?: Array<{
      id: string;
      knowledgeBaseId: string;
      documentId: string;
      documentName: string;
      chunkIndex: number;
      content: string;
      embedding?: number[];
      embeddingDim?: number;
    }>;
  },
): Promise<void> {
  try {
    const url = `${RUNTIME_ADDR}/runtime/ws/${encodeURIComponent(workspaceId)}/kb/sync`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runtime-Secret": RUNTIME_SECRET,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`[kb-sync] runtime sync failed (${response.status}): ${text}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[kb-sync] runtime sync error: ${message}`);
  }
}
```

**Step 3: Hook into processKnowledgeBaseDocument**

After the document is successfully indexed (after status set to "indexed", around line 573), add:

```typescript
// Sync chunks to runtime memory system
const syncChunks = db
  .select({
    id: kbDocumentChunks.id,
    content: kbDocumentChunks.content,
    chunkIndex: kbDocumentChunks.chunkIndex,
    embeddingJson: kbDocumentChunks.embeddingJson,
    embeddingDim: kbDocumentChunks.embeddingDim,
  })
  .from(kbDocumentChunks)
  .where(eq(kbDocumentChunks.documentId, documentId))
  .all();

const docName = documentRow.name ?? db
  .select({ name: kbDocuments.name })
  .from(kbDocuments)
  .where(eq(kbDocuments.id, documentId))
  .get()?.name ?? "unknown";

void notifyRuntimeKBSync(kb.workspaceId, {
  action: "sync_chunks",
  knowledgeBaseId: documentRow.knowledgeBaseId,
  documentId,
  chunks: syncChunks.map((c) => ({
    id: c.id,
    knowledgeBaseId: documentRow.knowledgeBaseId,
    documentId,
    documentName: docName,
    chunkIndex: c.chunkIndex,
    content: c.content,
    embedding: parseEmbeddingJson(c.embeddingJson) ?? undefined,
    embeddingDim: c.embeddingDim,
  })),
});
```

Note: `documentRow` is the variable from the beginning of the function (line 501-505) which has `.name` from `kbDocuments`. Check if it has `name` field; if not, query it separately.

**Step 4: Hook into deleteKnowledgeBaseDocument**

In `deleteKnowledgeBaseDocument()`, capture the workspaceId before deletion and notify after:

```typescript
const kbRow = db
  .select({ workspaceId: knowledgeBases.workspaceId })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.id, data.knowledgeBaseId))
  .get();

// ... existing deletion code ...

if (kbRow) {
  void notifyRuntimeKBSync(kbRow.workspaceId, {
    action: "delete_document",
    knowledgeBaseId: data.knowledgeBaseId,
    documentId: data.documentId,
  });
}
```

**Step 5: Hook into deleteKnowledgeBase**

In `deleteKnowledgeBase()`, capture workspaceId before deletion:

```typescript
const kbRow = db
  .select({ workspaceId: knowledgeBases.workspaceId })
  .from(knowledgeBases)
  .where(eq(knowledgeBases.id, id))
  .get();

// ... existing deletion code ...

if (kbRow) {
  void notifyRuntimeKBSync(kbRow.workspaceId, {
    action: "delete_kb",
    knowledgeBaseId: id,
  });
}
```

**Step 6: Reindex is handled automatically**

`requeueKnowledgeBaseDocumentsForReindex()` queues documents for re-processing. Each goes through `processKnowledgeBaseDocument()` which now calls sync. The sync does delete-before-insert. No changes needed.

**Step 7: Commit**

```
feat(service): sync KB changes to runtime memory system
```

---

## Task 6: Unified search_knowledge tool (H4)

**Files:**
- Modify: `runtime/src/tools/search-knowledge.ts`

**Step 1: Update SearchKnowledgeDeps**

```typescript
import type { MemoryManager } from "../memory/memory-types.js";
import type { EmbeddingService } from "../embedding/embedding-types.js";
import Database from "better-sqlite3";

export interface SearchKnowledgeDeps {
  workspaceId: string;
  memoryManager?: MemoryManager;
  embedding?: EmbeddingService;
  db?: Database.Database;
  reranker?: Reranker;
  rerankerModel?: string;
}
```

**Step 2: Refactor execute to dispatch**

Replace the execute body:

```typescript
execute: async (args, _context) => {
  const { query, knowledgeBaseId, limit = 5 } = args;

  if (deps.memoryManager && deps.db) {
    return searchViaMemorySystem(deps, query, knowledgeBaseId, limit);
  }

  return searchViaGrpc(deps, query, knowledgeBaseId, limit);
},
```

**Step 3: Implement unified search function**

```typescript
async function searchViaMemorySystem(
  deps: SearchKnowledgeDeps,
  query: string,
  knowledgeBaseId: string | undefined,
  limit: number,
) {
  let queryEmbedding: Float32Array | undefined;
  if (deps.embedding) {
    try {
      queryEmbedding = await deps.embedding.embedOne(query);
    } catch { /* vector search skipped */ }
  }

  const overFetchLimit = deps.reranker ? limit * 3 : limit;
  const searchResults = await deps.memoryManager!.search({
    query,
    agentId: "",
    workspaceId: deps.workspaceId,
    types: ["knowledge"],
    limit: overFetchLimit,
    embedding: queryEmbedding,
    includeDecayed: true,
  });

  if (searchResults.length === 0) {
    return { results: [], query, total: 0 };
  }

  const getLink = deps.db!.prepare(
    `SELECT knowledge_base_id, document_id, document_name, chunk_index
     FROM kb_memory_links WHERE memory_id = ?`,
  );

  type LinkRow = { knowledge_base_id: string; document_id: string; document_name: string; chunk_index: number };

  let enrichedResults = searchResults
    .map((r) => {
      const link = getLink.get(r.entry.id) as LinkRow | undefined;
      if (!link) return null;
      if (knowledgeBaseId && link.knowledge_base_id !== knowledgeBaseId) return null;
      return {
        id: r.entry.id,
        documentId: link.document_id,
        documentName: link.document_name,
        content: r.entry.content,
        score: r.score,
        chunkIndex: link.chunk_index,
        knowledgeBaseId: link.knowledge_base_id,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (deps.reranker && enrichedResults.length > 1) {
    try {
      const rerankResults = await deps.reranker.rerank({
        query,
        documents: enrichedResults.map((r) => ({ id: r.id, content: r.content })),
        model: deps.rerankerModel,
        topK: limit,
      });
      const rerankMap = new Map(rerankResults.map((rr) => [rr.id, rr.score]));
      enrichedResults = enrichedResults
        .map((r) => ({ ...r, score: rerankMap.get(r.id) ?? r.score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    } catch {
      enrichedResults = enrichedResults.slice(0, limit);
    }
  } else {
    enrichedResults = enrichedResults.slice(0, limit);
  }

  return { results: enrichedResults, query, total: enrichedResults.length };
}
```

**Step 4: Extract existing gRPC search into named function**

Move the current execute body (gRPC-based search) into `searchViaGrpc()` as a fallback.

**Step 5: Wire new deps in coordinator.ts**

Where `makeSearchKnowledgeTool` is called, pass the new deps:

```typescript
const services = getRuntimeServices();

const searchKnowledgeTool = makeSearchKnowledgeTool({
  workspaceId,
  memoryManager: services.memoryManager ?? undefined,
  embedding: services.embedding ?? undefined,
  db: services.db?.raw ?? undefined,
});
```

**Step 6: Commit**

```
feat(runtime): unified search_knowledge via HybridSearch (H4)
```

---

## Task 7: Fix HybridSearch visibility filter for KB entries

**Files:**
- Modify: `runtime/src/memory/retrieval/hybrid-search.ts`

KB entries have `agentId: ""` with `visibility: "shared"`. The current filter logic already handles this correctly (private check fails on visibility, not agentId), but reorder for clarity.

**Step 1: Update filter**

In `hybrid-search.ts` lines 53-55, change to:

```typescript
if (entry.visibility === "private" && entry.agentId !== query.agentId) continue;
if (entry.workspaceId !== query.workspaceId && entry.visibility !== "public") continue;
```

**Step 2: Commit**

```
fix(runtime): clarify HybridSearch visibility filter for KB entries
```

---

## Verification Checklist

After all tasks complete:

1. Schema: `kb_memory_links` table exists in runtime DB
2. Sync on upload: Upload a document -> service processes -> runtime receives sync -> memory_entries populated
3. Vector search: Query embedding matches KB chunk embeddings in sqlite-vec
4. FTS search: Keyword search finds KB chunks via FTS5
5. Delete propagation: Delete a document -> runtime removes corresponding memory_entries
6. KB delete propagation: Delete entire KB -> runtime removes all associated memory_entries
7. Reindex propagation: Change KB embedding model -> old chunks deleted, new chunks synced
8. Unified search: search_knowledge tool uses HybridSearch instead of gRPC
9. Entity extraction: Entities extracted from KB chunks appear in entities table
10. Search result format: Results still contain documentName, knowledgeBaseId, chunkIndex

---

## Environment Variables (new for service)

| Variable | Default | Where | Purpose |
|----------|---------|-------|---------|
| `RUNTIME_ADDR` | `http://localhost:8082` | service | Runtime HTTP address for KB sync |
| `RUNTIME_SECRET` | `dev-runtime-secret` | service | Auth header for runtime calls |

Runtime's `RUNTIME_SECRET` already exists. Service needs these to call runtime.
