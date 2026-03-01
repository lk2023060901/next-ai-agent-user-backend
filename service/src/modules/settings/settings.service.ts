import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { db } from "../../db";
import { aiProviders, aiModels, apiKeys } from "../../db/schema";

// ─── Providers ───────────────────────────────────────────────────────────────

type DefaultProviderType = "openai" | "anthropic" | "zhipu" | "qwen";

interface DefaultProviderSpec {
  type: DefaultProviderType;
  name: string;
  baseUrl: string;
  defaultModel: string;
  requiredModels: string[];
}

const DEFAULT_PROVIDER_SPECS: DefaultProviderSpec[] = [
  {
    type: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.3",
    requiredModels: ["gpt-5.3", "gpt-5.2"],
  },
  {
    type: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    requiredModels: ["claude-sonnet-4-6", "claude-opus-4-6"],
  },
  {
    type: "zhipu",
    name: "Z-AI (Zhipu)",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
    defaultModel: "glm-5",
    requiredModels: ["glm-5"],
  },
  {
    type: "qwen",
    name: "Qwen DashScope",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3.5-plus",
    requiredModels: ["qwen3.5-plus"],
  },
];

function normalizeProviderType(raw: string | undefined | null): string {
  return (raw ?? "").trim().toLowerCase();
}

function inferProviderTypeByName(rawName: string | undefined | null): DefaultProviderType | null {
  const name = (rawName ?? "").trim().toLowerCase();
  if (!name) return null;
  if (name.includes("qwen") || name.includes("dashscope")) return "qwen";
  if (name.includes("zhipu") || name.includes("z-ai") || name.includes("glm")) return "zhipu";
  return null;
}

function ensureProviderRequiredModels(
  providerId: string,
  requiredModels: string[],
  defaultModelName: string,
) {
  const models = db
    .select({ id: aiModels.id, name: aiModels.name })
    .from(aiModels)
    .where(eq(aiModels.providerId, providerId))
    .all();
  const byName = new Map(models.map((item) => [item.name, item.id]));

  const ensureModel = (modelName: string): string => {
    const existingId = byName.get(modelName);
    if (existingId) return existingId;
    const insertedId = uuidv4();
    db.insert(aiModels)
      .values({
        id: insertedId,
        providerId,
        name: modelName,
        contextWindow: null,
        costPer1kTokens: null,
        isDefault: false,
      })
      .run();
    byName.set(modelName, insertedId);
    return insertedId;
  };

  for (const modelName of requiredModels) {
    ensureModel(modelName);
  }
  const targetModelId = ensureModel(defaultModelName);

  db.update(aiModels)
    .set({ isDefault: false })
    .where(eq(aiModels.providerId, providerId))
    .run();
  db.update(aiModels)
    .set({ isDefault: true })
    .where(eq(aiModels.id, targetModelId))
    .run();
}

function ensureWorkspaceDefaultProviders(workspaceId: string) {
  const existing = db
    .select({
      id: aiProviders.id,
      type: aiProviders.type,
      name: aiProviders.name,
      baseUrl: aiProviders.baseUrl,
    })
    .from(aiProviders)
    .where(eq(aiProviders.workspaceId, workspaceId))
    .all();

  for (const provider of existing) {
    const normalizedType = normalizeProviderType(provider.type);
    if (normalizedType !== "openai") continue;
    const inferred = inferProviderTypeByName(provider.name);
    if (!inferred) continue;
    db.update(aiProviders)
      .set({
        type: inferred,
        ...(provider.baseUrl ? {} : { baseUrl: DEFAULT_PROVIDER_SPECS.find((s) => s.type === inferred)?.baseUrl ?? null }),
      })
      .where(eq(aiProviders.id, provider.id))
      .run();
  }

  const providersAfterNormalization = db
    .select({
      id: aiProviders.id,
      type: aiProviders.type,
      name: aiProviders.name,
      baseUrl: aiProviders.baseUrl,
    })
    .from(aiProviders)
    .where(eq(aiProviders.workspaceId, workspaceId))
    .all();

  const byType = new Map<string, { id: string; type: string; name: string; baseUrl: string | null }>();
  for (const provider of providersAfterNormalization) {
    const t = normalizeProviderType(provider.type);
    if (!byType.has(t)) byType.set(t, provider);
  }

  for (const spec of DEFAULT_PROVIDER_SPECS) {
    const existingProvider = byType.get(spec.type);
    if (!existingProvider) {
      const id = uuidv4();
      db.insert(aiProviders)
        .values({
          id,
          workspaceId,
          name: spec.name,
          type: spec.type,
          baseUrl: spec.baseUrl,
          apiKeyEncrypted: null,
          status: "active",
        })
        .run();
      ensureProviderRequiredModels(id, spec.requiredModels, spec.defaultModel);
      continue;
    }

    if (!existingProvider.baseUrl) {
      db.update(aiProviders)
        .set({ baseUrl: spec.baseUrl })
        .where(eq(aiProviders.id, existingProvider.id))
        .run();
    }
    ensureProviderRequiredModels(
      existingProvider.id,
      spec.requiredModels,
      spec.defaultModel,
    );
  }
}

function encryptKey(key: string): string {
  // Simple XOR-based obfuscation for local dev; replace with proper encryption in prod
  return Buffer.from(key).toString("base64");
}

function decryptKey(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

export function listProviders(workspaceId: string) {
  ensureWorkspaceDefaultProviders(workspaceId);
  return db.select({
    id: aiProviders.id,
    workspaceId: aiProviders.workspaceId,
    name: aiProviders.name,
    type: aiProviders.type,
    baseUrl: aiProviders.baseUrl,
    status: aiProviders.status,
    createdAt: aiProviders.createdAt,
  }).from(aiProviders).where(eq(aiProviders.workspaceId, workspaceId)).all();
}

export function createProvider(data: {
  workspaceId: string;
  name: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
}) {
  const id = uuidv4();
  const normalizedType = normalizeProviderType(data.type);
  const matchedDefault = DEFAULT_PROVIDER_SPECS.find((item) => item.type === normalizedType);
  const baseUrl = data.baseUrl ?? matchedDefault?.baseUrl ?? null;

  db.insert(aiProviders).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    type: normalizedType || data.type,
    apiKeyEncrypted: data.apiKey ? encryptKey(data.apiKey) : null,
    baseUrl,
  }).run();

  if (matchedDefault) {
    ensureProviderRequiredModels(
      id,
      matchedDefault.requiredModels,
      matchedDefault.defaultModel,
    );
  }
  return listProviders(data.workspaceId).find((p) => p.id === id)!;
}

export function updateProvider(id: string, data: {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  status?: string;
}) {
  const provider = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
  if (!provider) throw Object.assign(new Error("Provider not found"), { code: "NOT_FOUND" });

  db.update(aiProviders).set({
    ...(data.name && { name: data.name }),
    ...(data.apiKey && { apiKeyEncrypted: encryptKey(data.apiKey) }),
    ...(data.baseUrl !== undefined && { baseUrl: data.baseUrl }),
    ...(data.status && { status: data.status }),
  }).where(eq(aiProviders.id, id)).run();

  return listProviders(provider.workspaceId).find((p) => p.id === id)!;
}

export function deleteProvider(id: string) {
  const provider = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
  if (!provider) throw Object.assign(new Error("Provider not found"), { code: "NOT_FOUND" });
  db.delete(aiProviders).where(eq(aiProviders.id, id)).run();
}

// Default test model per provider type
const DEFAULT_TEST_MODELS: Record<string, string> = {
  openai: "gpt-5.3",
  anthropic: "claude-sonnet-4-6",
  zhipu: "glm-5",
  qwen: "qwen3.5-plus",
  google: "gemini-1.5-flash",
  mistral: "mistral-small-latest",
};

export async function testProvider(id: string): Promise<{ success: boolean; message: string }> {
  const provider = db.select().from(aiProviders).where(eq(aiProviders.id, id)).get();
  if (!provider) throw Object.assign(new Error("Provider not found"), { code: "NOT_FOUND" });

  const apiKey = provider.apiKeyEncrypted ? decryptKey(provider.apiKeyEncrypted) : "";
  const providerType = normalizeProviderType(provider.type);

  // Resolve test model: prefer first configured model, fall back to known defaults
  const defaultModel = db
    .select({ name: aiModels.name })
    .from(aiModels)
    .where(and(eq(aiModels.providerId, id), eq(aiModels.isDefault, true)))
    .get();
  const firstModel = db.select({ name: aiModels.name }).from(aiModels)
    .where(eq(aiModels.providerId, id)).get();
  const modelName =
    defaultModel?.name ??
    firstModel?.name ??
    DEFAULT_TEST_MODELS[providerType] ??
    "gpt-5.3";

  try {
    let model;
    const type = providerType;

    if (type === "anthropic") {
      const anthropic = createAnthropic({ apiKey });
      model = anthropic(modelName);
    } else if (type === "google") {
      const google = createGoogleGenerativeAI({ apiKey });
      model = google(modelName);
    } else if (type === "mistral") {
      const mistral = createMistral({ apiKey });
      model = mistral(modelName);
    } else {
      // OpenAI-compatible (openai, qwen, zhipu, azure, custom)
      const openai = createOpenAI({
        apiKey,
        ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
      });
      model = openai(modelName);
    }

    await generateText({ model, prompt: "Reply with one word: ok", maxTokens: 5 });
    return { success: true, message: `Connected successfully (model: ${modelName})` };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}

// ─── Models ──────────────────────────────────────────────────────────────────

export function listModels(providerId: string) {
  return db.select().from(aiModels).where(eq(aiModels.providerId, providerId)).all();
}

export interface UIModelView {
  id: string;
  name: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  inputPrice: number;
  outputPrice: number;
  capabilities: string[];
  enabled: boolean;
}

export interface ModelSeriesView {
  id: string;
  name: string;
  models: UIModelView[];
}

function inferModelCapabilities(providerTypeRaw: string, modelNameRaw: string): string[] {
  const providerType = normalizeProviderType(providerTypeRaw);
  const modelName = (modelNameRaw ?? "").trim().toLowerCase();
  const caps = new Set<string>(["text"]);

  const add = (...items: string[]) => {
    for (const item of items) {
      if (item) caps.add(item);
    }
  };

  switch (providerType) {
    case "openai": {
      add("tools", "json");
      if (
        modelName.startsWith("gpt-5") ||
        modelName.startsWith("gpt-4o") ||
        modelName.startsWith("gpt-4.1") ||
        modelName.includes("vision")
      ) {
        add("vision");
      }
      if (
        modelName.startsWith("gpt-5") ||
        modelName.startsWith("o1") ||
        modelName.startsWith("o3") ||
        modelName.includes("reason")
      ) {
        add("reasoning");
      }
      break;
    }
    case "anthropic": {
      add("vision", "tools", "reasoning");
      if (
        modelName.includes("claude-opus-4") ||
        modelName.includes("claude-sonnet-4") ||
        modelName.includes("claude-3-7-sonnet")
      ) {
        add("computer_use");
      }
      break;
    }
    case "zhipu": {
      add("tools", "reasoning", "json");
      break;
    }
    case "qwen": {
      add("tools", "reasoning", "json");
      if (
        modelName.startsWith("qwen3.5-plus") ||
        modelName.startsWith("qwen-vl") ||
        modelName.includes("-vl")
      ) {
        add("vision");
      }
      break;
    }
    case "google": {
      add("vision", "tools");
      break;
    }
    case "deepseek": {
      add("tools");
      if (modelName.includes("reasoner") || modelName.includes("r1")) {
        add("reasoning");
      }
      break;
    }
    default: {
      if (modelName.includes("vision") || modelName.includes("-vl")) add("vision");
      if (modelName.includes("reason") || modelName.includes("thinking")) add("reasoning");
      if (modelName.includes("tool") || modelName.includes("function")) add("tools");
      break;
    }
  }

  return Array.from(caps);
}

function toUiModelView(model: ReturnType<typeof listModels>[number], providerType: string): UIModelView {
  const contextWindow = Math.max(1, model.contextWindow ?? 4096);
  const maxOutput = Math.min(contextWindow, 8192);
  const price = Math.max(0, model.costPer1kTokens ?? 0);
  return {
    id: model.id,
    name: model.name,
    displayName: model.name,
    contextWindow,
    maxOutput,
    inputPrice: price,
    outputPrice: price,
    capabilities: inferModelCapabilities(providerType, model.name),
    enabled: true,
  };
}

export function listModelSeries(providerId: string): ModelSeriesView[] {
  const provider = db
    .select({ type: aiProviders.type })
    .from(aiProviders)
    .where(eq(aiProviders.id, providerId))
    .get();
  const providerType = normalizeProviderType(provider?.type);
  const models = listModels(providerId).map((model) => toUiModelView(model, providerType));
  if (models.length === 0) return [];
  return [
    {
      id: `series-${providerId}`,
      name: "Configured Models",
      models,
    },
  ];
}

export function listModelCatalog(providerId: string): ModelSeriesView[] {
  return listModelSeries(providerId);
}

export function listAllModels(workspaceId: string) {
  const providerIds = db
    .select({ id: aiProviders.id })
    .from(aiProviders)
    .where(eq(aiProviders.workspaceId, workspaceId))
    .all()
    .map((p) => p.id);

  if (providerIds.length === 0) return [];

  return providerIds.flatMap((pid) =>
    db.select().from(aiModels).where(eq(aiModels.providerId, pid)).all()
  );
}

export function createModel(data: {
  providerId: string;
  name: string;
  contextWindow?: number;
  costPer1kTokens?: number;
  isDefault?: boolean;
}) {
  const id = uuidv4();
  db.insert(aiModels).values({
    id,
    providerId: data.providerId,
    name: data.name,
    contextWindow: data.contextWindow ?? null,
    costPer1kTokens: data.costPer1kTokens ?? null,
    isDefault: data.isDefault ?? false,
  }).run();
  return db.select().from(aiModels).where(eq(aiModels.id, id)).get()!;
}

export function updateModel(id: string, data: {
  name?: string;
  contextWindow?: number;
  costPer1kTokens?: number;
  isDefault?: boolean;
}) {
  const model = db.select().from(aiModels).where(eq(aiModels.id, id)).get();
  if (!model) throw Object.assign(new Error("Model not found"), { code: "NOT_FOUND" });

  db.update(aiModels).set({
    ...(data.name && { name: data.name }),
    ...(data.contextWindow !== undefined && { contextWindow: data.contextWindow }),
    ...(data.costPer1kTokens !== undefined && { costPer1kTokens: data.costPer1kTokens }),
    ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
  }).where(eq(aiModels.id, id)).run();

  return db.select().from(aiModels).where(eq(aiModels.id, id)).get()!;
}

export function deleteModel(id: string) {
  const model = db.select().from(aiModels).where(eq(aiModels.id, id)).get();
  if (!model) throw Object.assign(new Error("Model not found"), { code: "NOT_FOUND" });
  db.delete(aiModels).where(eq(aiModels.id, id)).run();
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

  db.insert(apiKeys).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    keyHash,
    keyPrefix,
    expiresAt: data.expiresAt ?? null,
  }).run();

  const key = listApiKeys(data.workspaceId).find((k) => k.id === id)!;
  return { apiKey: key, rawKey };
}

export function deleteApiKey(id: string) {
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!key) throw Object.assign(new Error("API key not found"), { code: "NOT_FOUND" });
  db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
}
