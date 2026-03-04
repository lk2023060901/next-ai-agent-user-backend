import { and, desc, eq } from "drizzle-orm";
import { promises as fs } from "fs";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import {
  aiModels,
  aiProviders,
  kbDocumentChunks,
  kbDocuments,
  knowledgeBases,
  tools,
  toolAuthorizations,
  workspaces,
} from "../../db/schema";

const DEFAULT_KB_CHUNK_SIZE = 1200;
const DEFAULT_KB_CHUNK_OVERLAP = 200;
const DEFAULT_KB_REQUESTED_DOCUMENT_CHUNKS = 5;
const KB_EMBEDDING_BATCH_SIZE = 16;
const MAX_SEARCH_TOP_K = 20;
const SUPPORTED_EMBEDDING_PROVIDER_TYPES = new Set([
  "openai",
  "qwen",
  "zhipu",
  "azure",
  "deepseek",
  "custom",
]);
const SUPPORTED_TEXT_FILE_TYPES = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "log",
]);

const runningKbDocumentProcessors = new Set<string>();

// Seed built-in tools on first call if empty
function ensureToolsSeed() {
  const count = db.select().from(tools).all().length;
  if (count > 0) return;

  const builtins = [
    { id: uuidv4(), name: "web_search", category: "web", description: "Search the web", riskLevel: "low", platform: "both", requiresApproval: false },
    { id: uuidv4(), name: "web_browser", category: "web", description: "Browse web pages", riskLevel: "medium", platform: "both", requiresApproval: false },
    { id: uuidv4(), name: "file_read", category: "filesystem", description: "Read files from disk", riskLevel: "low", platform: "local", requiresApproval: false },
    { id: uuidv4(), name: "file_write", category: "filesystem", description: "Write files to disk", riskLevel: "high", platform: "local", requiresApproval: true },
    { id: uuidv4(), name: "shell_exec", category: "system", description: "Execute shell commands", riskLevel: "high", platform: "local", requiresApproval: true },
    { id: uuidv4(), name: "code_interpreter", category: "code", description: "Run code in sandbox", riskLevel: "medium", platform: "both", requiresApproval: false },
    { id: uuidv4(), name: "image_generation", category: "media", description: "Generate images with AI", riskLevel: "low", platform: "both", requiresApproval: false },
    { id: uuidv4(), name: "email_send", category: "communication", description: "Send emails", riskLevel: "high", platform: "both", requiresApproval: true },
    { id: uuidv4(), name: "calendar_read", category: "productivity", description: "Read calendar events", riskLevel: "low", platform: "both", requiresApproval: false },
    { id: uuidv4(), name: "calendar_write", category: "productivity", description: "Create/update calendar events", riskLevel: "medium", platform: "both", requiresApproval: true },
  ];

  for (const tool of builtins) {
    db.insert(tools).values(tool).run();
  }
}

export function listTools(category?: string) {
  ensureToolsSeed();
  const all = db.select().from(tools).all();
  if (category) return all.filter((t) => t.category === category);
  return all;
}

export function listToolAuthorizations(workspaceId: string) {
  ensureToolsSeed();
  const allTools = db.select().from(tools).all();
  const auths = db
    .select()
    .from(toolAuthorizations)
    .where(eq(toolAuthorizations.workspaceId, workspaceId))
    .all();

  const authMap = new Map(auths.map((a) => [a.toolId, a]));

  return allTools.map((tool) => {
    const auth = authMap.get(tool.id);
    return {
      id: auth?.id ?? "",
      workspaceId,
      toolId: tool.id,
      authorized: auth?.authorized ?? false,
      updatedAt: auth?.updatedAt ?? "",
      tool,
    };
  });
}

export function upsertToolAuthorization(data: {
  workspaceId: string;
  toolId: string;
  authorized: boolean;
}) {
  const existing = db
    .select()
    .from(toolAuthorizations)
    .where(eq(toolAuthorizations.workspaceId, data.workspaceId))
    .all()
    .find((a) => a.toolId === data.toolId);

  const now = new Date().toISOString();

  if (existing) {
    db.update(toolAuthorizations)
      .set({ authorized: data.authorized, updatedAt: now })
      .where(eq(toolAuthorizations.id, existing.id))
      .run();
    return { ...existing, authorized: data.authorized, updatedAt: now };
  }

  const id = uuidv4();
  db.insert(toolAuthorizations)
    .values({ id, workspaceId: data.workspaceId, toolId: data.toolId, authorized: data.authorized })
    .run();

  const tool = db.select().from(tools).where(eq(tools.id, data.toolId)).get();
  return {
    id,
    workspaceId: data.workspaceId,
    toolId: data.toolId,
    authorized: data.authorized,
    updatedAt: now,
    tool,
  };
}

export function listKnowledgeBases(workspaceId: string) {
  return db
    .select()
    .from(knowledgeBases)
    .where(eq(knowledgeBases.workspaceId, workspaceId))
    .orderBy(desc(knowledgeBases.updatedAt))
    .all();
}

function ensureWorkspaceExists(workspaceId: string) {
  const workspace = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!workspace) {
    throw Object.assign(new Error("Workspace not found"), { code: "NOT_FOUND" });
  }
}

function ensureKnowledgeBaseExists(knowledgeBaseId: string) {
  const kb = db.select().from(knowledgeBases).where(eq(knowledgeBases.id, knowledgeBaseId)).get();
  if (!kb) {
    throw Object.assign(new Error("Knowledge base not found"), { code: "NOT_FOUND" });
  }
  return kb;
}

function countKnowledgeBaseDocuments(knowledgeBaseId: string): number {
  return db.select().from(kbDocuments).where(eq(kbDocuments.knowledgeBaseId, knowledgeBaseId)).all().length;
}

function inferDocumentType(name: string, fallback?: string | null): string {
  const normalized = (fallback ?? "").trim().toLowerCase();
  if (normalized) return normalized;
  const ext = name.split(".").pop()?.trim().toLowerCase() ?? "";
  if (!ext) return "txt";
  return ext;
}

function toFiniteInteger(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function normalizeChunkingParams(input: {
  chunkSize?: number | string | null;
  chunkOverlap?: number | string | null;
}): { chunkSize: number; chunkOverlap: number } {
  const chunkSizeRaw = toFiniteInteger(input.chunkSize);
  const chunkOverlapRaw = toFiniteInteger(input.chunkOverlap);

  const chunkSize = chunkSizeRaw == null || chunkSizeRaw <= 0
    ? DEFAULT_KB_CHUNK_SIZE
    : chunkSizeRaw;

  // Keep overlap default compatible with small chunk sizes.
  const defaultOverlap = Math.max(0, Math.min(DEFAULT_KB_CHUNK_OVERLAP, chunkSize - 1));
  const chunkOverlap = chunkOverlapRaw == null || chunkOverlapRaw < 0
    ? defaultOverlap
    : chunkOverlapRaw;

  if (chunkSize < 100 || chunkSize > 8000) {
    throw Object.assign(new Error("chunkSize must be between 100 and 8000"), {
      code: "INVALID_ARGUMENT",
    });
  }
  if (chunkOverlap >= chunkSize) {
    throw Object.assign(new Error("chunkOverlap must be less than chunkSize"), {
      code: "INVALID_ARGUMENT",
    });
  }
  if (chunkOverlap > 4000) {
    throw Object.assign(new Error("chunkOverlap is too large"), {
      code: "INVALID_ARGUMENT",
    });
  }
  return { chunkSize, chunkOverlap };
}

function normalizeRequestedDocumentChunks(raw: number | string | null | undefined): number {
  const parsed = toFiniteInteger(raw);
  const value = parsed == null || parsed <= 0 ? DEFAULT_KB_REQUESTED_DOCUMENT_CHUNKS : parsed;
  if (value < 1 || value > 50) {
    throw Object.assign(new Error("requestedDocumentChunks must be between 1 and 50"), {
      code: "INVALID_ARGUMENT",
    });
  }
  return value;
}

function normalizeOptionalString(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

function normalizeMatchingThreshold(raw: number | string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error("matchingThreshold must be a number between 0 and 1"), {
      code: "INVALID_ARGUMENT",
    });
  }
  const value = Number(parsed);
  if (value < 0 || value > 1) {
    throw Object.assign(new Error("matchingThreshold must be between 0 and 1"), {
      code: "INVALID_ARGUMENT",
    });
  }
  return Number(value.toFixed(4));
}

function normalizeProviderType(type: string | null | undefined): string {
  return (type ?? "").trim().toLowerCase();
}

function decryptApiKey(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8").trim();
}

function resolveDefaultEmbeddingBaseUrl(providerType: string): string {
  switch (providerType) {
    case "openai":
      return "https://api.openai.com/v1";
    case "qwen":
      return "https://dashscope.aliyuncs.com/compatible-mode/v1";
    case "zhipu":
      return "https://open.bigmodel.cn/api/paas/v4";
    default:
      throw Object.assign(new Error(`Provider type "${providerType}" does not define embedding endpoint`), {
        code: "INVALID_ARGUMENT",
      });
  }
}

interface EmbeddingRuntimeConfig {
  providerType: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
}

function resolveEmbeddingRuntimeConfig(knowledgeBaseId: string): EmbeddingRuntimeConfig {
  const kb = ensureKnowledgeBaseExists(knowledgeBaseId);
  const selector = (kb.embeddingModel ?? "").trim();
  if (!selector) {
    throw Object.assign(new Error("Knowledge base embedding model is required"), {
      code: "INVALID_ARGUMENT",
    });
  }

  const selectedById = db
    .select({
      modelName: aiModels.name,
      providerType: aiProviders.type,
      providerBaseUrl: aiProviders.baseUrl,
      providerApiKeyEncrypted: aiProviders.apiKeyEncrypted,
      providerStatus: aiProviders.status,
    })
    .from(aiModels)
    .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
    .where(and(
      eq(aiModels.id, selector),
      eq(aiProviders.workspaceId, kb.workspaceId),
    ))
    .get();

  const selectedByName = selectedById
    ? null
    : db
      .select({
        modelName: aiModels.name,
        providerType: aiProviders.type,
        providerBaseUrl: aiProviders.baseUrl,
        providerApiKeyEncrypted: aiProviders.apiKeyEncrypted,
        providerStatus: aiProviders.status,
      })
      .from(aiModels)
      .innerJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
      .where(and(
        eq(aiProviders.workspaceId, kb.workspaceId),
        eq(aiModels.name, selector),
      ))
      .get();

  const selected = selectedById ?? selectedByName;
  if (!selected) {
    throw Object.assign(new Error("Embedding model not found in current workspace providers"), {
      code: "NOT_FOUND",
    });
  }

  const providerType = normalizeProviderType(selected.providerType);
  if (!SUPPORTED_EMBEDDING_PROVIDER_TYPES.has(providerType)) {
    throw Object.assign(new Error(`Provider type "${providerType}" is not supported for embeddings`), {
      code: "INVALID_ARGUMENT",
    });
  }
  if (selected.providerStatus && selected.providerStatus !== "active") {
    throw Object.assign(new Error("Embedding provider is not active"), {
      code: "INVALID_ARGUMENT",
    });
  }
  if (!selected.providerApiKeyEncrypted) {
    throw Object.assign(new Error("Embedding provider API key is required"), {
      code: "INVALID_ARGUMENT",
    });
  }

  const apiKey = decryptApiKey(selected.providerApiKeyEncrypted);
  if (!apiKey) {
    throw Object.assign(new Error("Embedding provider API key is invalid"), {
      code: "INVALID_ARGUMENT",
    });
  }

  const baseUrl = (selected.providerBaseUrl ?? "").trim() || resolveDefaultEmbeddingBaseUrl(providerType);
  return {
    providerType,
    modelName: selected.modelName,
    baseUrl,
    apiKey,
  };
}

function buildEmbeddingsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (/\/embeddings$/i.test(normalized)) return normalized;
  return `${normalized}/embeddings`;
}

interface OpenAICompatibleEmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
  error?: { message?: string };
}

async function fetchEmbeddingsBatch(config: EmbeddingRuntimeConfig, inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const endpoint = buildEmbeddingsEndpoint(config.baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.modelName,
      input: inputs,
      encoding_format: "float",
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const rawText = await response.text();
  let payload: OpenAICompatibleEmbeddingsResponse;
  try {
    payload = JSON.parse(rawText) as OpenAICompatibleEmbeddingsResponse;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const message = payload.error?.message?.trim() || rawText || `Embedding request failed with status ${response.status}`;
    throw Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
  }

  const vectors = Array.isArray(payload.data)
    ? payload.data.map((item) => item.embedding).filter((item): item is number[] => Array.isArray(item))
    : [];

  if (vectors.length !== inputs.length) {
    throw Object.assign(new Error("Embedding response length mismatch"), { code: "INVALID_ARGUMENT" });
  }

  for (const vector of vectors) {
    if (vector.length === 0 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw Object.assign(new Error("Embedding response contains invalid vector values"), {
        code: "INVALID_ARGUMENT",
      });
    }
  }
  return vectors;
}

function splitTextIntoChunks(rawText: string, chunkSize: number, chunkOverlap: number): string[] {
  const normalized = rawText.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(normalized.length, start + chunkSize);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - chunkOverlap);
  }
  return chunks;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA <= 0 || normB <= 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function parseEmbeddingJson(raw: string): number[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const vector = parsed.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (vector.length !== parsed.length || vector.length === 0) return null;
    return vector;
  } catch {
    return null;
  }
}

async function readDocumentTextContent(doc: typeof kbDocuments.$inferSelect): Promise<string> {
  if (!doc.filePath) {
    throw Object.assign(new Error("Uploaded file path is missing"), { code: "INVALID_ARGUMENT" });
  }

  const type = inferDocumentType(doc.name, doc.type);
  if (!SUPPORTED_TEXT_FILE_TYPES.has(type)) {
    throw Object.assign(new Error(`Unsupported file type for vectorization: ${type}`), {
      code: "INVALID_ARGUMENT",
    });
  }

  const content = await fs.readFile(doc.filePath, "utf-8");
  if (!content.trim()) {
    throw Object.assign(new Error("Document content is empty"), { code: "INVALID_ARGUMENT" });
  }
  return content;
}

function queueKnowledgeBaseDocumentProcessing(documentId: string) {
  if (runningKbDocumentProcessors.has(documentId)) return;
  runningKbDocumentProcessors.add(documentId);
  setImmediate(() => {
    void processKnowledgeBaseDocument(documentId)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[kb] processing failed: doc=${documentId} error=${message}`);
      })
      .finally(() => {
        runningKbDocumentProcessors.delete(documentId);
      });
  });
}

async function processKnowledgeBaseDocument(documentId: string): Promise<void> {
  const documentRow = db
    .select()
    .from(kbDocuments)
    .where(eq(kbDocuments.id, documentId))
    .get();
  if (!documentRow) return;
  if (documentRow.status === "indexed") return;

  const startedAt = new Date().toISOString();
  db.update(kbDocuments)
    .set({
      status: "processing",
      errorMessage: null,
      processedAt: null,
    })
    .where(eq(kbDocuments.id, documentId))
    .run();

  try {
    const kb = ensureKnowledgeBaseExists(documentRow.knowledgeBaseId);
    const chunking = normalizeChunkingParams({
      chunkSize: kb.chunkSize,
      chunkOverlap: kb.chunkOverlap,
    });
    const runtime = resolveEmbeddingRuntimeConfig(documentRow.knowledgeBaseId);
    const content = await readDocumentTextContent(documentRow);
    const chunks = splitTextIntoChunks(content, chunking.chunkSize, chunking.chunkOverlap);
    if (chunks.length === 0) {
      throw Object.assign(new Error("Document does not contain indexable text"), {
        code: "INVALID_ARGUMENT",
      });
    }

    db.delete(kbDocumentChunks)
      .where(eq(kbDocumentChunks.documentId, documentId))
      .run();

    for (let offset = 0; offset < chunks.length; offset += KB_EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + KB_EMBEDDING_BATCH_SIZE);
      const vectors = await fetchEmbeddingsBatch(runtime, batch);
      for (let i = 0; i < batch.length; i += 1) {
        const vector = vectors[i];
        const chunkIndex = offset + i;
        db.insert(kbDocumentChunks)
          .values({
            id: uuidv4(),
            knowledgeBaseId: documentRow.knowledgeBaseId,
            documentId,
            chunkIndex,
            content: batch[i],
            embeddingJson: JSON.stringify(vector),
            embeddingDim: vector.length,
            createdAt: startedAt,
          })
          .run();
      }
    }

    const finishedAt = new Date().toISOString();
    db.update(kbDocuments)
      .set({
        status: "indexed",
        chunkCount: chunks.length,
        processedAt: finishedAt,
        errorMessage: null,
      })
      .where(eq(kbDocuments.id, documentId))
      .run();

    db.update(knowledgeBases)
      .set({ updatedAt: finishedAt })
      .where(eq(knowledgeBases.id, documentRow.knowledgeBaseId))
      .run();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    db.delete(kbDocumentChunks)
      .where(eq(kbDocumentChunks.documentId, documentId))
      .run();
    db.update(kbDocuments)
      .set({
        status: "failed",
        chunkCount: 0,
        processedAt: new Date().toISOString(),
        errorMessage: message.slice(0, 500),
      })
      .where(eq(kbDocuments.id, documentId))
      .run();
  }
}

export function createKnowledgeBase(data: {
  workspaceId: string;
  name: string;
  embeddingModel: string;
  chunkSize?: number | string;
  chunkOverlap?: number | string;
  requestedDocumentChunks?: number | string;
  documentProcessing?: string;
  rerankerModel?: string;
  matchingThreshold?: number | string;
}) {
  ensureWorkspaceExists(data.workspaceId);
  const name = data.name.trim();
  if (!name) {
    throw Object.assign(new Error("name is required"), { code: "INVALID_ARGUMENT" });
  }
  const chunking = normalizeChunkingParams({
    chunkSize: data.chunkSize,
    chunkOverlap: data.chunkOverlap,
  });
  const requestedDocumentChunks = normalizeRequestedDocumentChunks(data.requestedDocumentChunks);
  const matchingThreshold = normalizeMatchingThreshold(data.matchingThreshold);

  const now = new Date().toISOString();
  const id = uuidv4();

  db.insert(knowledgeBases)
    .values({
      id,
      workspaceId: data.workspaceId,
      name,
      embeddingModel: data.embeddingModel?.trim() || null,
      chunkSize: chunking.chunkSize,
      chunkOverlap: chunking.chunkOverlap,
      requestedDocumentChunks,
      documentProcessing: normalizeOptionalString(data.documentProcessing),
      rerankerModel: normalizeOptionalString(data.rerankerModel),
      matchingThreshold,
      documentCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return db.select().from(knowledgeBases).where(eq(knowledgeBases.id, id)).get()!;
}

export function updateKnowledgeBase(data: {
  id: string;
  name?: string;
  embeddingModel?: string;
  chunkSize?: number | string;
  chunkOverlap?: number | string;
  requestedDocumentChunks?: number | string;
  documentProcessing?: string;
  rerankerModel?: string;
  matchingThreshold?: number | string;
}) {
  const kb = ensureKnowledgeBaseExists(data.id);
  const patch: Partial<typeof knowledgeBases.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  let shouldReindex = false;

  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) {
      throw Object.assign(new Error("name is required"), { code: "INVALID_ARGUMENT" });
    }
    patch.name = name;
  }

  if (data.embeddingModel !== undefined) {
    const embeddingModel = data.embeddingModel.trim();
    if (!embeddingModel) {
      throw Object.assign(new Error("embeddingModel is required"), { code: "INVALID_ARGUMENT" });
    }
    patch.embeddingModel = embeddingModel;
    if (embeddingModel !== (kb.embeddingModel ?? "")) {
      shouldReindex = true;
    }
  }

  if (data.chunkSize !== undefined || data.chunkOverlap !== undefined) {
    const chunking = normalizeChunkingParams({
      chunkSize: data.chunkSize ?? kb.chunkSize,
      chunkOverlap: data.chunkOverlap ?? kb.chunkOverlap,
    });
    patch.chunkSize = chunking.chunkSize;
    patch.chunkOverlap = chunking.chunkOverlap;
    if (chunking.chunkSize !== kb.chunkSize || chunking.chunkOverlap !== kb.chunkOverlap) {
      shouldReindex = true;
    }
  }

  if (data.requestedDocumentChunks !== undefined) {
    patch.requestedDocumentChunks = normalizeRequestedDocumentChunks(data.requestedDocumentChunks);
  }

  if (data.documentProcessing !== undefined) {
    patch.documentProcessing = normalizeOptionalString(data.documentProcessing);
  }

  if (data.rerankerModel !== undefined) {
    patch.rerankerModel = normalizeOptionalString(data.rerankerModel);
  }

  if (data.matchingThreshold !== undefined) {
    patch.matchingThreshold = normalizeMatchingThreshold(data.matchingThreshold);
  }

  if (Object.keys(patch).length === 1) {
    return kb;
  }

  db.update(knowledgeBases)
    .set(patch)
    .where(eq(knowledgeBases.id, data.id))
    .run();

  if (shouldReindex) {
    requeueKnowledgeBaseDocumentsForReindex(data.id);
  }

  return db.select().from(knowledgeBases).where(eq(knowledgeBases.id, data.id)).get()!;
}

function requeueKnowledgeBaseDocumentsForReindex(knowledgeBaseId: string) {
  const docs = db
    .select({ id: kbDocuments.id, filePath: kbDocuments.filePath })
    .from(kbDocuments)
    .where(eq(kbDocuments.knowledgeBaseId, knowledgeBaseId))
    .all();
  if (docs.length === 0) return;

  db.delete(kbDocumentChunks)
    .where(eq(kbDocumentChunks.knowledgeBaseId, knowledgeBaseId))
    .run();

  const now = new Date().toISOString();
  for (const doc of docs) {
    if (!doc.filePath) {
      db.update(kbDocuments)
        .set({
          status: "failed",
          chunkCount: 0,
          processedAt: now,
          errorMessage: "Uploaded file path missing",
        })
        .where(eq(kbDocuments.id, doc.id))
        .run();
      continue;
    }
    db.update(kbDocuments)
      .set({
        status: "pending",
        chunkCount: 0,
        processedAt: null,
        errorMessage: null,
      })
      .where(eq(kbDocuments.id, doc.id))
      .run();
    queueKnowledgeBaseDocumentProcessing(doc.id);
  }
}

export function deleteKnowledgeBase(id: string) {
  ensureKnowledgeBaseExists(id);
  const docs = db
    .select({ filePath: kbDocuments.filePath })
    .from(kbDocuments)
    .where(eq(kbDocuments.knowledgeBaseId, id))
    .all();
  db.delete(knowledgeBases).where(eq(knowledgeBases.id, id)).run();
  for (const doc of docs) {
    if (!doc.filePath) continue;
    void fs.unlink(doc.filePath).catch(() => undefined);
  }
}

export function listKnowledgeBaseDocuments(knowledgeBaseId: string) {
  ensureKnowledgeBaseExists(knowledgeBaseId);
  const docs = db
    .select()
    .from(kbDocuments)
    .where(eq(kbDocuments.knowledgeBaseId, knowledgeBaseId))
    .orderBy(desc(kbDocuments.createdAt))
    .all();

  return docs.map((doc) => {
    if ((doc.status === "pending" || doc.status === "processing") && !doc.filePath) {
      const failedAt = new Date().toISOString();
      db.update(kbDocuments)
        .set({
          status: "failed",
          processedAt: failedAt,
          errorMessage: "Uploaded file path missing",
        })
        .where(eq(kbDocuments.id, doc.id))
        .run();
      return {
        ...doc,
        status: "failed",
        processedAt: failedAt,
        errorMessage: "Uploaded file path missing",
      };
    }

    if (doc.status === "pending" || doc.status === "processing") {
      queueKnowledgeBaseDocumentProcessing(doc.id);
    }
    return doc;
  });
}

export function createKnowledgeBaseDocument(data: {
  knowledgeBaseId: string;
  name: string;
  type?: string;
  size?: number | string;
  filePath?: string;
}) {
  ensureKnowledgeBaseExists(data.knowledgeBaseId);
  const name = data.name.trim();
  if (!name) {
    throw Object.assign(new Error("document name is required"), { code: "INVALID_ARGUMENT" });
  }

  const now = new Date().toISOString();
  const id = uuidv4();
  const docType = inferDocumentType(name, data.type);
  const rawSize = typeof data.size === "string" ? Number(data.size) : data.size;
  const size = Number.isFinite(rawSize) ? Math.max(0, Math.floor(rawSize!)) : 0;
  const filePath = data.filePath?.trim() || null;

  db.insert(kbDocuments)
    .values({
      id,
      knowledgeBaseId: data.knowledgeBaseId,
      name,
      type: docType,
      size,
      status: filePath ? "pending" : "failed",
      filePath,
      chunkCount: 0,
      processedAt: filePath ? null : now,
      errorMessage: filePath ? null : "Uploaded file path missing",
      createdAt: now,
    })
    .run();

  const nextCount = countKnowledgeBaseDocuments(data.knowledgeBaseId);
  db.update(knowledgeBases)
    .set({ documentCount: nextCount, updatedAt: now })
    .where(eq(knowledgeBases.id, data.knowledgeBaseId))
    .run();

  if (filePath) {
    queueKnowledgeBaseDocumentProcessing(id);
  }

  return db.select().from(kbDocuments).where(eq(kbDocuments.id, id)).get()!;
}

export function deleteKnowledgeBaseDocument(data: {
  knowledgeBaseId: string;
  documentId: string;
}) {
  ensureKnowledgeBaseExists(data.knowledgeBaseId);
  const doc = db
    .select()
    .from(kbDocuments)
    .where(and(
      eq(kbDocuments.id, data.documentId),
      eq(kbDocuments.knowledgeBaseId, data.knowledgeBaseId),
    ))
    .get();

  if (!doc) {
    throw Object.assign(new Error("Document not found"), { code: "NOT_FOUND" });
  }

  db.delete(kbDocumentChunks)
    .where(eq(kbDocumentChunks.documentId, data.documentId))
    .run();
  db.delete(kbDocuments).where(eq(kbDocuments.id, data.documentId)).run();

  if (doc.filePath) {
    void fs.unlink(doc.filePath).catch(() => undefined);
  }

  const now = new Date().toISOString();
  const nextCount = countKnowledgeBaseDocuments(data.knowledgeBaseId);
  db.update(knowledgeBases)
    .set({ documentCount: nextCount, updatedAt: now })
    .where(eq(knowledgeBases.id, data.knowledgeBaseId))
    .run();
}

export async function searchKnowledgeBase(data: {
  knowledgeBaseId: string;
  query: string;
  topK?: number;
}) {
  const kb = ensureKnowledgeBaseExists(data.knowledgeBaseId);
  const query = data.query.trim();
  if (!query) {
    throw Object.assign(new Error("query is required"), { code: "INVALID_ARGUMENT" });
  }

  const requestedDefault = normalizeRequestedDocumentChunks(kb.requestedDocumentChunks);
  const requestedTopK = typeof data.topK === "number" && data.topK > 0
    ? data.topK
    : requestedDefault;
  const topK = Math.max(1, Math.min(MAX_SEARCH_TOP_K, requestedTopK));
  const runtime = resolveEmbeddingRuntimeConfig(data.knowledgeBaseId);
  const [queryVector] = await fetchEmbeddingsBatch(runtime, [query]);
  if (!queryVector) return [];

  const chunks = db
    .select({
      id: kbDocumentChunks.id,
      documentId: kbDocumentChunks.documentId,
      documentName: kbDocuments.name,
      chunkIndex: kbDocumentChunks.chunkIndex,
      content: kbDocumentChunks.content,
      embeddingJson: kbDocumentChunks.embeddingJson,
    })
    .from(kbDocumentChunks)
    .innerJoin(kbDocuments, eq(kbDocuments.id, kbDocumentChunks.documentId))
    .where(and(
      eq(kbDocumentChunks.knowledgeBaseId, data.knowledgeBaseId),
      eq(kbDocuments.status, "indexed"),
    ))
    .all();

  if (chunks.length === 0) return [];

  const scored = chunks
    .map((chunk) => {
      const vector = parseEmbeddingJson(chunk.embeddingJson);
      if (!vector) return null;
      const cosine = cosineSimilarity(queryVector, vector);
      if (!Number.isFinite(cosine) || cosine < -1) return null;
      const score = Number(((cosine + 1) / 2).toFixed(6));
      return {
        id: chunk.id,
        documentId: chunk.documentId,
        documentName: chunk.documentName,
        content: chunk.content,
        score,
        chunkIndex: chunk.chunkIndex,
      };
    })
    .filter((item): item is {
      id: string;
      documentId: string;
      documentName: string;
      content: string;
      score: number;
      chunkIndex: number;
    } => item !== null)
    .filter((item) => {
      if (kb.matchingThreshold == null) return true;
      return item.score >= kb.matchingThreshold;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}
