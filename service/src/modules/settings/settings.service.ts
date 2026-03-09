import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { db } from "../../db/index.js";
import { apiKeys, workspaceSettings, workspaces } from "../../db/schema.js";

// ─── Re-exports (unified public API for server.ts) ────────────────────────────
export type { CatalogModel, CatalogProvider, ProviderCatalog } from "./provider-catalog.js";
export { PROVIDER_CATALOG } from "./provider-catalog.js";
export type { UIModelView, ModelSeriesView } from "./model.service.js";
export {
  listProviders, createProvider, updateProvider, deleteProvider, testProvider,
} from "./provider.service.js";
export {
  listModels, listAllModels, createModel, updateModel, deleteModel,
  listModelSeries, listModelCatalog,
} from "./model.service.js";

// ─── Workspace Settings ───────────────────────────────────────────────────────

export interface WorkspaceSettingsView {
  id: string;
  name: string;
  description: string;
  defaultModel: string;
  defaultTemperature: number;
  maxTokensPerRequest: number;
  assistantModelIds: string[];
  fallbackModelIds: string[];
  codeModelIds: string[];
  agentModelIds: string[];
  subAgentModelIds: string[];
  ocrProvider: string;
  ocrConfigJson: string;
  documentProcessingProvider: string;
  documentProcessingConfigJson: string;
}

const DEFAULT_OCR_PROVIDER = "system_ocr";
const DEFAULT_DOCUMENT_PROCESSING_PROVIDER = "mineru";
const SUPPORTED_OCR_PROVIDERS = new Set(["system_ocr", "tesseract", "paddleocr"]);
const SUPPORTED_DOCUMENT_PROCESSING_PROVIDERS = new Set([
  "mineru", "doc2x", "mistral", "open_mineru", "paddleocr",
]);
const DEFAULT_DOCUMENT_PROCESSING_CONFIG = {
  mineru:      { apiKey: "", apiHost: "https://mineru.net" },
  doc2x:       { apiKey: "", apiHost: "https://api.doc2x.noedgeai.com" },
  mistral:     { apiKey: "", apiHost: "https://api.mistral.ai" },
  open_mineru: { apiKey: "", apiHost: "https://mineru.net" },
  paddleocr:   { token: "", apiHost: "" },
} satisfies Record<string, unknown>;

function parseModelIdList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const dedup = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const normalized = item.trim();
      if (normalized) dedup.add(normalized);
    }
    return Array.from(dedup);
  } catch { return []; }
}

function normalizeModelIdList(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const dedup = new Set<string>();
  for (const item of raw) {
    const normalized = typeof item === "string" ? item.trim() : "";
    if (normalized) dedup.add(normalized);
  }
  return Array.from(dedup);
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch { return {}; }
}

function normalizeOcrProvider(raw: string | null | undefined): string {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (!normalized) return DEFAULT_OCR_PROVIDER;
  return SUPPORTED_OCR_PROVIDERS.has(normalized) ? normalized : DEFAULT_OCR_PROVIDER;
}

function normalizeDocumentProcessingProvider(raw: string | null | undefined): string {
  const normalized = (raw ?? "").trim().toLowerCase();
  return SUPPORTED_DOCUMENT_PROCESSING_PROVIDERS.has(normalized) ? normalized : DEFAULT_DOCUMENT_PROCESSING_PROVIDER;
}

function normalizeConfigJson(raw: string | null | undefined, fallback: Record<string, unknown>): string {
  const parsed = parseJsonObject(raw);
  return JSON.stringify(Object.keys(parsed).length > 0 ? parsed : fallback);
}

function ensureWorkspaceSettingsRow(workspaceId: string) {
  const workspace = db.select({ id: workspaces.id, name: workspaces.name, description: workspaces.description })
    .from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!workspace) throw Object.assign(new Error("Workspace not found"), { code: "NOT_FOUND" });

  let row = db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).get();
  if (!row) {
    db.insert(workspaceSettings).values({
      workspaceId,
      defaultModel: "",
      defaultTemperature: 0.7,
      maxTokensPerRequest: 8192,
      assistantModelIds: "[]",
      fallbackModelIds: "[]",
      codeModelIds: "[]",
      agentModelIds: "[]",
      subAgentModelIds: "[]",
      ocrProvider: DEFAULT_OCR_PROVIDER,
      ocrConfigJson: "{}",
      documentProcessingProvider: DEFAULT_DOCUMENT_PROCESSING_PROVIDER,
      documentProcessingConfigJson: JSON.stringify(DEFAULT_DOCUMENT_PROCESSING_CONFIG),
    }).run();
    row = db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, workspaceId)).get();
  }
  if (!row) throw Object.assign(new Error("Workspace settings init failed"), { code: "INTERNAL" });
  return { workspace, row };
}

function toWorkspaceSettingsView(
  workspace: { id: string; name: string; description: string | null },
  row: typeof workspaceSettings.$inferSelect,
): WorkspaceSettingsView {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description ?? "",
    defaultModel: row.defaultModel ?? "",
    defaultTemperature: row.defaultTemperature ?? 0.7,
    maxTokensPerRequest: row.maxTokensPerRequest ?? 8192,
    assistantModelIds: parseModelIdList(row.assistantModelIds),
    fallbackModelIds: parseModelIdList(row.fallbackModelIds),
    codeModelIds: parseModelIdList(row.codeModelIds),
    agentModelIds: parseModelIdList(row.agentModelIds),
    subAgentModelIds: parseModelIdList(row.subAgentModelIds),
    ocrProvider: normalizeOcrProvider(row.ocrProvider),
    ocrConfigJson: normalizeConfigJson(row.ocrConfigJson, {}),
    documentProcessingProvider: normalizeDocumentProcessingProvider(row.documentProcessingProvider),
    documentProcessingConfigJson: normalizeConfigJson(row.documentProcessingConfigJson, DEFAULT_DOCUMENT_PROCESSING_CONFIG),
  };
}

export function getWorkspaceSettings(workspaceId: string): WorkspaceSettingsView {
  const { workspace, row } = ensureWorkspaceSettingsRow(workspaceId);
  return toWorkspaceSettingsView(workspace, row);
}

export function updateWorkspaceSettings(
  workspaceId: string,
  data: {
    name?: string; description?: string; defaultModel?: string;
    defaultTemperature?: number; maxTokensPerRequest?: number;
    assistantModelIds?: string[]; fallbackModelIds?: string[];
    codeModelIds?: string[]; agentModelIds?: string[]; subAgentModelIds?: string[];
    ocrProvider?: string; ocrConfigJson?: string;
    documentProcessingProvider?: string; documentProcessingConfigJson?: string;
    setName?: boolean; setDescription?: boolean; setDefaultModel?: boolean;
    setDefaultTemperature?: boolean; setMaxTokensPerRequest?: boolean;
    setAssistantModelIds?: boolean; setFallbackModelIds?: boolean;
    setCodeModelIds?: boolean; setAgentModelIds?: boolean; setSubAgentModelIds?: boolean;
    setOcrProvider?: boolean; setOcrConfigJson?: boolean;
    setDocumentProcessingProvider?: boolean; setDocumentProcessingConfigJson?: boolean;
  },
): WorkspaceSettingsView {
  ensureWorkspaceSettingsRow(workspaceId);
  const now = new Date().toISOString();

  const workspacePatch: Partial<typeof workspaces.$inferInsert> = {};
  if (data.setName)        workspacePatch.name        = (data.name ?? "").trim();
  if (data.setDescription) workspacePatch.description = (data.description ?? "").trim();
  if (Object.keys(workspacePatch).length > 0) {
    db.update(workspaces).set({ ...workspacePatch, updatedAt: now }).where(eq(workspaces.id, workspaceId)).run();
  }

  const settingsPatch: Partial<typeof workspaceSettings.$inferInsert> = {};
  if (data.setDefaultModel)         settingsPatch.defaultModel         = (data.defaultModel ?? "").trim();
  if (data.setDefaultTemperature)   settingsPatch.defaultTemperature   = data.defaultTemperature ?? 0.7;
  if (data.setMaxTokensPerRequest)  settingsPatch.maxTokensPerRequest  = Math.max(1, data.maxTokensPerRequest ?? 8192);
  if (data.setAssistantModelIds)    settingsPatch.assistantModelIds    = JSON.stringify(normalizeModelIdList(data.assistantModelIds));
  if (data.setFallbackModelIds)     settingsPatch.fallbackModelIds     = JSON.stringify(normalizeModelIdList(data.fallbackModelIds));
  if (data.setCodeModelIds)         settingsPatch.codeModelIds         = JSON.stringify(normalizeModelIdList(data.codeModelIds));
  if (data.setAgentModelIds)        settingsPatch.agentModelIds        = JSON.stringify(normalizeModelIdList(data.agentModelIds));
  if (data.setSubAgentModelIds)     settingsPatch.subAgentModelIds     = JSON.stringify(normalizeModelIdList(data.subAgentModelIds));
  if (data.setOcrProvider)          settingsPatch.ocrProvider          = normalizeOcrProvider(data.ocrProvider);
  if (data.setOcrConfigJson)        settingsPatch.ocrConfigJson        = normalizeConfigJson(data.ocrConfigJson, {});
  if (data.setDocumentProcessingProvider) {
    settingsPatch.documentProcessingProvider = normalizeDocumentProcessingProvider(data.documentProcessingProvider);
  }
  if (data.setDocumentProcessingConfigJson) {
    settingsPatch.documentProcessingConfigJson = normalizeConfigJson(data.documentProcessingConfigJson, DEFAULT_DOCUMENT_PROCESSING_CONFIG);
  }
  if (Object.keys(settingsPatch).length > 0) {
    db.update(workspaceSettings).set({ ...settingsPatch, updatedAt: now }).where(eq(workspaceSettings.workspaceId, workspaceId)).run();
  }

  return getWorkspaceSettings(workspaceId);
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

export function listApiKeys(workspaceId: string) {
  return db.select({
    id: apiKeys.id,
    workspaceId: apiKeys.workspaceId,
    name: apiKeys.name,
    keyPrefix: apiKeys.keyPrefix,
    expiresAt: apiKeys.expiresAt,
    createdAt: apiKeys.createdAt,
  }).from(apiKeys).where(eq(apiKeys.workspaceId, workspaceId)).all();
}

export function createApiKey(data: { workspaceId: string; name: string; expiresAt?: string }) {
  const id = uuidv4();
  const rawKey = "sk-" + crypto.randomBytes(32).toString("hex");
  const keyHash = crypto.createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 10);
  db.insert(apiKeys).values({ id, workspaceId: data.workspaceId, name: data.name, keyHash, keyPrefix, expiresAt: data.expiresAt ?? null }).run();
  const key = listApiKeys(data.workspaceId).find((k) => k.id === id)!;
  return { apiKey: key, rawKey };
}

export function deleteApiKey(id: string) {
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!key) throw Object.assign(new Error("API key not found"), { code: "NOT_FOUND" });
  db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
}
