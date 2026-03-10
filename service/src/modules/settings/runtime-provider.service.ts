import { and, eq, inArray, sql } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { completeSimple, type Api, type Model } from "@mariozechner/pi-ai";
import { db } from "../../db/index.js";
import {
  aiModels,
  aiProviders,
  customModels,
  customProviders,
  modelOverrides,
  providerOverrides,
} from "../../db/schema.js";
import {
  PROVIDER_CATALOG,
  inferCatalogSeriesName,
  piAiInputToCapabilities,
  type CatalogProvider,
} from "./provider-catalog.js";

export interface RuntimeModelView {
  id: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  inputPrice: number;
  outputPrice: number;
  capabilities: string[];
  enabled: boolean;
  seriesName: string;
  source: "static" | "custom";
}

export interface RuntimeProviderView {
  id: string;
  workspaceId: string;
  name: string;
  type: string;
  baseUrl: string;
  status: string;
  createdAt: string;
  source: "static" | "custom";
  apiKeyEncrypted: string | null;
  models: RuntimeModelView[];
}

function nowIso(): string {
  return new Date().toISOString();
}

let runtimeOverlayTablesEnsured = false;

function ensureRuntimeOverlayTables() {
  if (runtimeOverlayTablesEnsured) return;

  db.run(sql`
    CREATE TABLE IF NOT EXISTS provider_overrides (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      name TEXT,
      type TEXT,
      base_url TEXT,
      api_key_encrypted TEXT,
      status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS provider_overrides_ws_provider_uq
    ON provider_overrides(workspace_id, provider_id)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS provider_overrides_workspace_idx
    ON provider_overrides(workspace_id)
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS custom_providers (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      base_url TEXT,
      api_key_encrypted TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS custom_providers_workspace_idx
    ON custom_providers(workspace_id)
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS model_overrides (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      display_name TEXT,
      context_window INTEGER,
      max_output INTEGER,
      input_price REAL,
      output_price REAL,
      capabilities_json TEXT,
      enabled INTEGER,
      series_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS model_overrides_ws_provider_model_uq
    ON model_overrides(workspace_id, provider_id, model_name)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS model_overrides_workspace_provider_idx
    ON model_overrides(workspace_id, provider_id)
  `);

  db.run(sql`
    CREATE TABLE IF NOT EXISTS custom_models (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window INTEGER NOT NULL DEFAULT 8192,
      max_output INTEGER NOT NULL DEFAULT 4096,
      input_price REAL NOT NULL DEFAULT 0,
      output_price REAL NOT NULL DEFAULT 0,
      capabilities_json TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      series_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    )
  `);
  db.run(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS custom_models_ws_provider_model_uq
    ON custom_models(workspace_id, provider_id, name)
  `);
  db.run(sql`
    CREATE INDEX IF NOT EXISTS custom_models_workspace_provider_idx
    ON custom_models(workspace_id, provider_id)
  `);

  runtimeOverlayTablesEnsured = true;
}

function normalizeProviderStatus(raw: string | null | undefined): string {
  const status = (raw ?? "").trim().toLowerCase();
  if (status === "disabled" || status === "inactive") return "disabled";
  if (status === "error") return "error";
  return "active";
}

function normalizeProviderType(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

function inferLegacyProviderId(providerId: string): string {
  return providerId;
}

function parseCapabilities(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

function sanitizeCapabilities(input: string[] | null | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

import { encryptSecret, decryptSecretCompat } from "../../utils/crypto.js";
import { config } from "../../config.js";

function encryptKey(key: string): string {
  return encryptSecret(key, config.encryptionSecret);
}

function decryptKey(encrypted: string): string {
  return decryptSecretCompat(encrypted, config.encryptionSecret);
}

function staticModelRuntimeId(providerId: string, modelName: string): string {
  const encoded = Buffer.from(modelName, "utf-8").toString("base64url");
  return `static:${providerId}:${encoded}`;
}

function parseStaticModelRuntimeId(runtimeId: string): { providerId: string; modelName: string } | null {
  if (!runtimeId.startsWith("static:")) return null;
  const parts = runtimeId.split(":");
  if (parts.length < 3) return null;
  const providerId = parts[1] ?? "";
  const encoded = parts.slice(2).join(":");
  if (!providerId || !encoded) return null;
  try {
    const modelName = Buffer.from(encoded, "base64url").toString("utf-8");
    if (!modelName) return null;
    return { providerId, modelName };
  } catch {
    return null;
  }
}

function buildStaticProvider(workspaceId: string, provider: CatalogProvider): RuntimeProviderView {
  const models: RuntimeModelView[] = provider.models.map((model) => ({
    id: staticModelRuntimeId(provider.name, model.id),
    name: model.id,
    displayName: model.displayName,
    contextWindow: Math.max(1, model.contextWindow),
    maxOutput: Math.max(1, Math.min(model.contextWindow, model.maxTokens)),
    inputPrice: Math.max(0, model.cost.inputPerMtok),
    outputPrice: Math.max(0, model.cost.outputPerMtok),
    capabilities: sanitizeCapabilities(piAiInputToCapabilities(model.input, model.reasoning)),
    enabled: true,
    seriesName: inferCatalogSeriesName(provider.name, model.id),
    source: "static",
  }));

  return {
    id: provider.name,
    workspaceId,
    name: provider.displayName,
    type: provider.name,
    baseUrl: provider.baseUrl,
    status: "active",
    createdAt: "",
    source: "static",
    apiKeyEncrypted: null,
    models,
  };
}

function toCustomModelView(row: typeof customModels.$inferSelect): RuntimeModelView {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    contextWindow: Math.max(1, row.contextWindow),
    maxOutput: Math.max(1, row.maxOutput),
    inputPrice: Math.max(0, row.inputPrice),
    outputPrice: Math.max(0, row.outputPrice),
    capabilities: sanitizeCapabilities(parseCapabilities(row.capabilitiesJson)),
    enabled: row.enabled,
    seriesName: row.seriesName || inferCatalogSeriesName("", row.name),
    source: "custom",
  };
}

function applyModelOverride(base: RuntimeModelView, row: typeof modelOverrides.$inferSelect): RuntimeModelView {
  return {
    ...base,
    ...(row.displayName ? { displayName: row.displayName } : {}),
    ...(typeof row.contextWindow === "number" ? { contextWindow: Math.max(1, row.contextWindow) } : {}),
    ...(typeof row.maxOutput === "number" ? { maxOutput: Math.max(1, row.maxOutput) } : {}),
    ...(typeof row.inputPrice === "number" ? { inputPrice: Math.max(0, row.inputPrice) } : {}),
    ...(typeof row.outputPrice === "number" ? { outputPrice: Math.max(0, row.outputPrice) } : {}),
    ...(row.capabilitiesJson ? { capabilities: sanitizeCapabilities(parseCapabilities(row.capabilitiesJson)) } : {}),
    ...(typeof row.enabled === "boolean" ? { enabled: row.enabled } : {}),
    ...(row.seriesName ? { seriesName: row.seriesName } : {}),
  };
}

function staticProviderIds(): Set<string> {
  return new Set(PROVIDER_CATALOG.map((provider) => provider.name));
}

function getProviderCatalog(providerId: string): CatalogProvider | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.name === providerId);
}

function mergeProviderModels(params: {
  workspaceId: string;
  providerId: string;
  baseModels: RuntimeModelView[];
  modelOverridesRows: Array<typeof modelOverrides.$inferSelect>;
  customModelRows: Array<typeof customModels.$inferSelect>;
}): RuntimeModelView[] {
  const byName = new Map<string, RuntimeModelView>();
  for (const model of params.baseModels) {
    byName.set(model.name, model);
  }

  for (const row of params.modelOverridesRows) {
    const existing = byName.get(row.modelName);
    if (existing) {
      byName.set(row.modelName, applyModelOverride(existing, row));
      continue;
    }

    const baseSynthetic: RuntimeModelView = {
      id: staticModelRuntimeId(params.providerId, row.modelName),
      name: row.modelName,
      displayName: row.displayName || row.modelName,
      contextWindow: Math.max(1, row.contextWindow ?? 8192),
      maxOutput: Math.max(1, row.maxOutput ?? 4096),
      inputPrice: Math.max(0, row.inputPrice ?? 0),
      outputPrice: Math.max(0, row.outputPrice ?? 0),
      capabilities: sanitizeCapabilities(parseCapabilities(row.capabilitiesJson) || ["text"]),
      enabled: row.enabled ?? true,
      seriesName: row.seriesName || inferCatalogSeriesName(params.providerId, row.modelName),
      source: "static",
    };
    byName.set(row.modelName, baseSynthetic);
  }

  for (const row of params.customModelRows) {
    byName.set(row.name, toCustomModelView(row));
  }

  return Array.from(byName.values())
    .filter((model) => model.enabled)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function listRuntimeProvidersDetailed(workspaceId: string): RuntimeProviderView[] {
  ensureRuntimeOverlayTables();
  const overrides = db
    .select()
    .from(providerOverrides)
    .where(eq(providerOverrides.workspaceId, workspaceId))
    .all();
  const customProviderRows = db
    .select()
    .from(customProviders)
    .where(eq(customProviders.workspaceId, workspaceId))
    .all();
  const modelOverrideRows = db
    .select()
    .from(modelOverrides)
    .where(eq(modelOverrides.workspaceId, workspaceId))
    .all();
  const customModelRows = db
    .select()
    .from(customModels)
    .where(eq(customModels.workspaceId, workspaceId))
    .all();

  const providerOverrideById = new Map(overrides.map((row) => [row.providerId, row]));
  const modelOverridesByProviderId = new Map<string, Array<typeof modelOverrides.$inferSelect>>();
  for (const row of modelOverrideRows) {
    const current = modelOverridesByProviderId.get(row.providerId) ?? [];
    current.push(row);
    modelOverridesByProviderId.set(row.providerId, current);
  }
  const customModelsByProviderId = new Map<string, Array<typeof customModels.$inferSelect>>();
  for (const row of customModelRows) {
    const current = customModelsByProviderId.get(row.providerId) ?? [];
    current.push(row);
    customModelsByProviderId.set(row.providerId, current);
  }

  const mergedStatic = PROVIDER_CATALOG.map((provider) => {
    const base = buildStaticProvider(workspaceId, provider);
    const override = providerOverrideById.get(provider.name);

    const mergedProvider: RuntimeProviderView = {
      ...base,
      ...(override?.name ? { name: override.name } : {}),
      ...(override?.type ? { type: normalizeProviderType(override.type) || base.type } : {}),
      ...(override?.baseUrl !== null && override?.baseUrl !== undefined ? { baseUrl: override.baseUrl } : {}),
      ...(override?.status ? { status: normalizeProviderStatus(override.status) } : {}),
      ...(override?.createdAt ? { createdAt: override.createdAt } : {}),
      ...(override?.apiKeyEncrypted !== undefined ? { apiKeyEncrypted: override.apiKeyEncrypted } : {}),
    };

    mergedProvider.models = mergeProviderModels({
      workspaceId,
      providerId: provider.name,
      baseModels: base.models,
      modelOverridesRows: modelOverridesByProviderId.get(provider.name) ?? [],
      customModelRows: customModelsByProviderId.get(provider.name) ?? [],
    });

    return mergedProvider;
  });

  const customProvidersMerged = customProviderRows.map((row) => {
    const providerId = row.id;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      type: normalizeProviderType(row.type) || "custom",
      baseUrl: row.baseUrl ?? "",
      status: normalizeProviderStatus(row.status),
      createdAt: row.createdAt,
      source: "custom" as const,
      apiKeyEncrypted: row.apiKeyEncrypted,
      models: mergeProviderModels({
        workspaceId,
        providerId,
        baseModels: [],
        modelOverridesRows: modelOverridesByProviderId.get(providerId) ?? [],
        customModelRows: customModelsByProviderId.get(providerId) ?? [],
      }),
    } satisfies RuntimeProviderView;
  });

  return [...mergedStatic, ...customProvidersMerged].sort((a, b) => a.name.localeCompare(b.name));
}

export function listRuntimeProviderModels(workspaceId: string, providerId: string): RuntimeModelView[] {
  ensureRuntimeOverlayTables();
  const provider = listRuntimeProvidersDetailed(workspaceId).find((item) => item.id === providerId);
  if (!provider) {
    return [];
  }
  return provider.models;
}

export function listRuntimeProviderCatalog(providerId: string): RuntimeModelView[] {
  const provider = getProviderCatalog(providerId);
  if (!provider) return [];
  return buildStaticProvider("", provider).models;
}

export function listRuntimeProviders(workspaceId: string) {
  ensureRuntimeOverlayTables();
  return listRuntimeProvidersDetailed(workspaceId).map((provider) => ({
    id: provider.id,
    workspaceId: provider.workspaceId,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    status: provider.status,
    createdAt: provider.createdAt,
  }));
}

export function createRuntimeProvider(data: {
  workspaceId: string;
  name: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  ensureRuntimeOverlayTables();
  const id = uuidv4();
  db.insert(customProviders).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    type: normalizeProviderType(data.type) || "custom",
    baseUrl: data.baseUrl ?? "",
    apiKeyEncrypted: data.apiKey ? encryptKey(data.apiKey) : null,
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }).run();

  return listRuntimeProviders(data.workspaceId).find((provider) => provider.id === id)!;
}

export function updateRuntimeProvider(
  workspaceId: string,
  providerId: string,
  data: { name?: string; apiKey?: string; baseUrl?: string; status?: string },
) {
  ensureRuntimeOverlayTables();
  const provider = listRuntimeProvidersDetailed(workspaceId).find((item) => item.id === providerId);
  if (!provider) {
    throw Object.assign(new Error("Provider not found"), { code: "NOT_FOUND" });
  }

  if (provider.source === "custom") {
    db.update(customProviders)
      .set({
        ...(typeof data.name === "string" ? { name: data.name.trim() } : {}),
        ...(typeof data.apiKey === "string" ? { apiKeyEncrypted: encryptKey(data.apiKey) } : {}),
        ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
        ...(typeof data.status === "string" ? { status: normalizeProviderStatus(data.status) } : {}),
        updatedAt: nowIso(),
      })
      .where(and(eq(customProviders.workspaceId, workspaceId), eq(customProviders.id, providerId)))
      .run();
    return listRuntimeProviders(workspaceId).find((item) => item.id === providerId)!;
  }

  const existing = db
    .select()
    .from(providerOverrides)
    .where(and(eq(providerOverrides.workspaceId, workspaceId), eq(providerOverrides.providerId, providerId)))
    .get();

  if (!existing) {
    db.insert(providerOverrides).values({
      id: uuidv4(),
      workspaceId,
      providerId,
      ...(typeof data.name === "string" ? { name: data.name.trim() } : {}),
      ...(typeof data.apiKey === "string" ? { apiKeyEncrypted: encryptKey(data.apiKey) } : {}),
      ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
      ...(typeof data.status === "string" ? { status: normalizeProviderStatus(data.status) } : {}),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }).run();
  } else {
    db.update(providerOverrides)
      .set({
        ...(typeof data.name === "string" ? { name: data.name.trim() } : {}),
        ...(typeof data.apiKey === "string" ? { apiKeyEncrypted: encryptKey(data.apiKey) } : {}),
        ...(data.baseUrl !== undefined ? { baseUrl: data.baseUrl } : {}),
        ...(typeof data.status === "string" ? { status: normalizeProviderStatus(data.status) } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(providerOverrides.id, existing.id))
      .run();
  }

  return listRuntimeProviders(workspaceId).find((item) => item.id === providerId)!;
}

export function deleteRuntimeProvider(workspaceId: string, providerId: string) {
  ensureRuntimeOverlayTables();
  const provider = listRuntimeProvidersDetailed(workspaceId).find((item) => item.id === providerId);
  if (!provider) {
    throw Object.assign(new Error("Provider not found"), { code: "NOT_FOUND" });
  }

  if (provider.source === "custom") {
    db.delete(customModels)
      .where(and(eq(customModels.workspaceId, workspaceId), eq(customModels.providerId, providerId)))
      .run();
    db.delete(modelOverrides)
      .where(and(eq(modelOverrides.workspaceId, workspaceId), eq(modelOverrides.providerId, providerId)))
      .run();
    db.delete(customProviders)
      .where(and(eq(customProviders.workspaceId, workspaceId), eq(customProviders.id, providerId)))
      .run();
    return;
  }

  db.delete(providerOverrides)
    .where(and(eq(providerOverrides.workspaceId, workspaceId), eq(providerOverrides.providerId, providerId)))
    .run();
  db.delete(modelOverrides)
    .where(and(eq(modelOverrides.workspaceId, workspaceId), eq(modelOverrides.providerId, providerId)))
    .run();
  db.delete(customModels)
    .where(and(eq(customModels.workspaceId, workspaceId), eq(customModels.providerId, providerId)))
    .run();
}

function applyOpenAICompletionsCompat(model: Model<"openai-completions">): Model<"openai-completions"> {
  const baseUrl = model.baseUrl ?? "";
  const isNative = baseUrl
    ? (() => { try { return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com"; } catch { return false; } })()
    : true;
  if (isNative) return model;
  const compat = model.compat;
  if (compat?.supportsDeveloperRole === false && compat?.supportsUsageInStreaming === false) return model;
  return { ...model, compat: { ...compat, supportsDeveloperRole: false, supportsUsageInStreaming: false } };
}

function buildTestModel(providerType: string, modelName: string, customBaseUrl: string | null | undefined): Model<Api> {
  const catalogBaseUrl = PROVIDER_CATALOG.find((provider) => provider.name === providerType)?.baseUrl ?? "";

  if (providerType === "anthropic") {
    let baseUrl = (customBaseUrl || catalogBaseUrl || "https://api.anthropic.com").replace(/\/$/, "");
    baseUrl = baseUrl.replace(/\/v1\/?$/, "");
    return {
      id: modelName,
      name: modelName,
      api: "anthropic-messages" as const,
      provider: "anthropic",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 5,
    };
  }

  const baseUrl = (customBaseUrl || catalogBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  return applyOpenAICompletionsCompat({
    id: modelName,
    name: modelName,
    api: "openai-completions" as const,
    provider: providerType,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 5,
  });
}

export async function testRuntimeProvider(workspaceId: string, providerId: string): Promise<{ success: boolean; message: string }> {
  ensureRuntimeOverlayTables();
  const provider = listRuntimeProvidersDetailed(workspaceId).find((item) => item.id === providerId);
  if (!provider) {
    throw Object.assign(new Error("Provider not found"), { code: "NOT_FOUND" });
  }

  const apiKey = provider.apiKeyEncrypted ? decryptKey(provider.apiKeyEncrypted) : "";
  const providerType = normalizeProviderType(provider.type);
  const modelName = provider.models[0]?.name ?? PROVIDER_CATALOG.find((item) => item.name === providerType)?.defaultModel ?? "gpt-5.3";

  try {
    const model = buildTestModel(providerType, modelName, provider.baseUrl);
    const result = await completeSimple(
      model,
      { messages: [{ role: "user", content: "ok", timestamp: Date.now() }] },
      { apiKey, maxTokens: 5, signal: AbortSignal.timeout(10_000) },
    );
    if (result.stopReason === "error") {
      return { success: false, message: result.errorMessage ?? "Request failed" };
    }
    return { success: true, message: `Connected successfully (model: ${modelName})` };
  } catch (error: unknown) {
    return { success: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function upsertRuntimeModel(
  workspaceId: string,
  providerId: string,
  input: {
    id?: string;
    name?: string;
    contextWindow?: number;
    costPer1kTokens?: number;
    displayName?: string;
    maxOutput?: number;
    inputPrice?: number;
    outputPrice?: number;
    capabilities?: string[];
    enabled?: boolean;
    seriesName?: string;
  },
): RuntimeModelView {
  ensureRuntimeOverlayTables();
  const staticProviderSet = staticProviderIds();
  const isStaticProvider = staticProviderSet.has(providerId);
  const catalogProvider = getProviderCatalog(providerId);

  const logicalModelName = (input.name ?? "").trim();
  if (!logicalModelName) {
    throw Object.assign(new Error("model name is required"), { code: "INVALID_ARGUMENT" });
  }

  const staticModelExists = Boolean(
    catalogProvider?.models.some((model) => model.id === logicalModelName),
  );

  const derivedInputPrice =
    typeof input.inputPrice === "number"
      ? input.inputPrice
      : typeof input.costPer1kTokens === "number"
        ? input.costPer1kTokens
        : undefined;
  const derivedOutputPrice =
    typeof input.outputPrice === "number"
      ? input.outputPrice
      : typeof input.costPer1kTokens === "number"
        ? input.costPer1kTokens
        : undefined;

  if (isStaticProvider && staticModelExists) {
    const existingOverride = db
      .select()
      .from(modelOverrides)
      .where(and(
        eq(modelOverrides.workspaceId, workspaceId),
        eq(modelOverrides.providerId, providerId),
        eq(modelOverrides.modelName, logicalModelName),
      ))
      .get();

    if (!existingOverride) {
      db.insert(modelOverrides).values({
        id: uuidv4(),
        workspaceId,
        providerId,
        modelName: logicalModelName,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(typeof input.contextWindow === "number" ? { contextWindow: input.contextWindow } : {}),
        ...(typeof input.maxOutput === "number" ? { maxOutput: input.maxOutput } : {}),
        ...(typeof derivedInputPrice === "number" ? { inputPrice: derivedInputPrice } : {}),
        ...(typeof derivedOutputPrice === "number" ? { outputPrice: derivedOutputPrice } : {}),
        ...(input.capabilities ? { capabilitiesJson: JSON.stringify(sanitizeCapabilities(input.capabilities)) } : {}),
        ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : { enabled: true }),
        ...(input.seriesName ? { seriesName: input.seriesName } : {}),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }).run();
    } else {
      db.update(modelOverrides)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(typeof input.contextWindow === "number" ? { contextWindow: input.contextWindow } : {}),
          ...(typeof input.maxOutput === "number" ? { maxOutput: input.maxOutput } : {}),
          ...(typeof derivedInputPrice === "number" ? { inputPrice: derivedInputPrice } : {}),
          ...(typeof derivedOutputPrice === "number" ? { outputPrice: derivedOutputPrice } : {}),
          ...(input.capabilities ? { capabilitiesJson: JSON.stringify(sanitizeCapabilities(input.capabilities)) } : {}),
          ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
          ...(input.seriesName !== undefined ? { seriesName: input.seriesName } : {}),
          updatedAt: nowIso(),
        })
        .where(eq(modelOverrides.id, existingOverride.id))
        .run();
    }

    const target = listRuntimeProviderModels(workspaceId, providerId)
      .find((model) => model.name === logicalModelName);
    if (!target) {
      throw Object.assign(new Error("Model not found after update"), { code: "INTERNAL" });
    }
    return target;
  }

  const customModelId = input.id && !input.id.startsWith("static:") ? input.id : uuidv4();
  const existingCustom = db
    .select()
    .from(customModels)
    .where(and(
      eq(customModels.workspaceId, workspaceId),
      eq(customModels.providerId, providerId),
      eq(customModels.name, logicalModelName),
    ))
    .get();

  if (!existingCustom) {
    db.insert(customModels).values({
      id: customModelId,
      workspaceId,
      providerId,
      name: logicalModelName,
      displayName: input.displayName?.trim() || logicalModelName,
      contextWindow: Math.max(1, input.contextWindow ?? 8192),
      maxOutput: Math.max(1, input.maxOutput ?? Math.min(input.contextWindow ?? 8192, 8192)),
      inputPrice: Math.max(0, derivedInputPrice ?? 0),
      outputPrice: Math.max(0, derivedOutputPrice ?? 0),
      capabilitiesJson: JSON.stringify(sanitizeCapabilities(input.capabilities ?? ["text"])),
      enabled: input.enabled ?? true,
      seriesName: input.seriesName || inferCatalogSeriesName(providerId, logicalModelName),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }).run();
  } else {
    db.update(customModels)
      .set({
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(typeof input.contextWindow === "number" ? { contextWindow: Math.max(1, input.contextWindow) } : {}),
        ...(typeof input.maxOutput === "number" ? { maxOutput: Math.max(1, input.maxOutput) } : {}),
        ...(typeof derivedInputPrice === "number" ? { inputPrice: Math.max(0, derivedInputPrice) } : {}),
        ...(typeof derivedOutputPrice === "number" ? { outputPrice: Math.max(0, derivedOutputPrice) } : {}),
        ...(input.capabilities ? { capabilitiesJson: JSON.stringify(sanitizeCapabilities(input.capabilities)) } : {}),
        ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
        ...(input.seriesName !== undefined ? { seriesName: input.seriesName } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(customModels.id, existingCustom.id))
      .run();
  }

  const created = listRuntimeProviderModels(workspaceId, providerId)
    .find((model) => model.name === logicalModelName && model.source === "custom");
  if (!created) {
    throw Object.assign(new Error("Model not found after create"), { code: "INTERNAL" });
  }
  return created;
}

export function updateRuntimeModel(
  workspaceId: string,
  runtimeModelId: string,
  input: {
    name?: string;
    contextWindow?: number;
    costPer1kTokens?: number;
    isDefault?: boolean;
  },
): RuntimeModelView {
  ensureRuntimeOverlayTables();
  const parsedStatic = parseStaticModelRuntimeId(runtimeModelId);
  if (parsedStatic) {
    const targetName = (input.name ?? "").trim() || parsedStatic.modelName;
    return upsertRuntimeModel(workspaceId, parsedStatic.providerId, {
      name: targetName,
      contextWindow: input.contextWindow,
      costPer1kTokens: input.costPer1kTokens,
      enabled: true,
    });
  }

  const customRow = db
    .select()
    .from(customModels)
    .where(and(eq(customModels.workspaceId, workspaceId), eq(customModels.id, runtimeModelId)))
    .get();
  if (!customRow) {
    throw Object.assign(new Error("Model not found"), { code: "NOT_FOUND" });
  }

  return upsertRuntimeModel(workspaceId, customRow.providerId, {
    id: customRow.id,
    name: input.name ?? customRow.name,
    contextWindow: input.contextWindow,
    costPer1kTokens: input.costPer1kTokens,
    enabled: customRow.enabled,
  });
}

export function deleteRuntimeModel(workspaceId: string, runtimeModelId: string) {
  ensureRuntimeOverlayTables();
  const parsedStatic = parseStaticModelRuntimeId(runtimeModelId);
  if (parsedStatic) {
    upsertRuntimeModel(workspaceId, parsedStatic.providerId, {
      name: parsedStatic.modelName,
      enabled: false,
    });
    return;
  }

  const customRow = db
    .select()
    .from(customModels)
    .where(and(eq(customModels.workspaceId, workspaceId), eq(customModels.id, runtimeModelId)))
    .get();
  if (!customRow) {
    throw Object.assign(new Error("Model not found"), { code: "NOT_FOUND" });
  }

  db.delete(customModels).where(eq(customModels.id, customRow.id)).run();
}

export function clearRuntimeModelOverride(workspaceId: string, providerId: string, modelName: string) {
  ensureRuntimeOverlayTables();
  db.delete(modelOverrides)
    .where(and(
      eq(modelOverrides.workspaceId, workspaceId),
      eq(modelOverrides.providerId, providerId),
      eq(modelOverrides.modelName, modelName),
    ))
    .run();
}

export function runtimeModelSeries(
  workspaceId: string,
  providerId: string,
): Array<{ id: string; name: string; models: RuntimeModelView[] }> {
  ensureRuntimeOverlayTables();
  const models = listRuntimeProviderModels(workspaceId, providerId);
  const grouped = new Map<string, RuntimeModelView[]>();

  for (const model of models) {
    const seriesName = model.seriesName || inferCatalogSeriesName(providerId, model.name);
    const current = grouped.get(seriesName) ?? [];
    current.push(model);
    grouped.set(seriesName, current);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([seriesName, items]) => ({
      id: `series-${providerId}-${seriesName}`,
      name: seriesName,
      models: items.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }));
}

export function runtimeModelCatalogSeries(providerId: string): Array<{ id: string; name: string; models: RuntimeModelView[] }> {
  const models = listRuntimeProviderCatalog(providerId);
  const grouped = new Map<string, RuntimeModelView[]>();

  for (const model of models) {
    const seriesName = model.seriesName || inferCatalogSeriesName(providerId, model.name);
    const current = grouped.get(seriesName) ?? [];
    current.push(model);
    grouped.set(seriesName, current);
  }

  return Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([seriesName, items], idx) => ({
      id: `catalog-${providerId}-${idx}`,
      name: seriesName,
      models: items.sort((a, b) => a.displayName.localeCompare(b.displayName)),
    }));
}

export function runtimeFlatModels(workspaceId: string): Array<{
  modelId: string;
  id: string;
  name: string;
  displayName: string;
  providerId: string;
  providerName: string;
  providerType: string;
  capabilities: string[];
  contextWindow: number;
  inputPrice: number;
  outputPrice: number;
}> {
  ensureRuntimeOverlayTables();
  const providers = listRuntimeProvidersDetailed(workspaceId)
    .filter((provider) => normalizeProviderStatus(provider.status) !== "disabled");

  syncRuntimeToLegacyTables(workspaceId, providers);

  const out: Array<{
    modelId: string;
    id: string;
    name: string;
    displayName: string;
    providerId: string;
    providerName: string;
    providerType: string;
    capabilities: string[];
    contextWindow: number;
    inputPrice: number;
    outputPrice: number;
  }> = [];

  for (const provider of providers) {
    for (const model of provider.models) {
      if (!model.enabled) continue;
      out.push({
        modelId: model.id,
        id: model.id,
        name: model.name,
        displayName: model.displayName,
        providerId: provider.id,
        providerName: provider.name,
        providerType: provider.type,
        capabilities: model.capabilities,
        contextWindow: model.contextWindow,
        inputPrice: model.inputPrice,
        outputPrice: model.outputPrice,
      });
    }
  }

  return out;
}

function syncRuntimeToLegacyTables(workspaceId: string, providers: RuntimeProviderView[]) {
  const now = nowIso();
  const existingProviders = db
    .select()
    .from(aiProviders)
    .where(eq(aiProviders.workspaceId, workspaceId))
    .all();
  const existingById = new Map(existingProviders.map((row) => [row.id, row]));

  for (const provider of providers) {
    const providerId = inferLegacyProviderId(provider.id);
    const existing = existingById.get(providerId);
    if (!existing) {
      db.insert(aiProviders).values({
        id: providerId,
        workspaceId,
        name: provider.name,
        type: provider.type,
        baseUrl: provider.baseUrl,
        apiKeyEncrypted: provider.apiKeyEncrypted,
        status: normalizeProviderStatus(provider.status),
        createdAt: provider.createdAt || now,
      }).run();
      continue;
    }

    db.update(aiProviders).set({
      name: provider.name,
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKeyEncrypted: provider.apiKeyEncrypted,
      status: normalizeProviderStatus(provider.status),
    }).where(eq(aiProviders.id, providerId)).run();
  }

  for (const provider of providers) {
    const providerId = inferLegacyProviderId(provider.id);
    const existingModels = db
      .select()
      .from(aiModels)
      .where(eq(aiModels.providerId, providerId))
      .all();
    const modelById = new Map(existingModels.map((row) => [row.id, row]));

    const targetModelIds = new Set<string>();
    for (const model of provider.models) {
      targetModelIds.add(model.id);
      const existing = modelById.get(model.id);
      const nextCost = Number.isFinite(model.inputPrice) ? model.inputPrice : 0;
      if (!existing) {
        db.insert(aiModels).values({
          id: model.id,
          providerId,
          name: model.name,
          contextWindow: Math.max(1, model.contextWindow),
          costPer1kTokens: Math.max(0, nextCost),
          isDefault: false,
        }).run();
        continue;
      }

      db.update(aiModels).set({
        name: model.name,
        contextWindow: Math.max(1, model.contextWindow),
        costPer1kTokens: Math.max(0, nextCost),
      }).where(eq(aiModels.id, model.id)).run();
    }

    const staleModelIds = existingModels
      .map((row) => row.id)
      .filter((modelId) => !targetModelIds.has(modelId));
    if (staleModelIds.length > 0) {
      db.delete(aiModels).where(inArray(aiModels.id, staleModelIds)).run();
    }
  }
}
