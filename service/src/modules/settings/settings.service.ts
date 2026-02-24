import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { db } from "../../db";
import { aiProviders, aiModels, apiKeys } from "../../db/schema";

// ─── Providers ───────────────────────────────────────────────────────────────

function encryptKey(key: string): string {
  // Simple XOR-based obfuscation for local dev; replace with proper encryption in prod
  return Buffer.from(key).toString("base64");
}

export function listProviders(workspaceId: string) {
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
  db.insert(aiProviders).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    type: data.type,
    apiKeyEncrypted: data.apiKey ? encryptKey(data.apiKey) : null,
    baseUrl: data.baseUrl ?? null,
  }).run();
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

// ─── Models ──────────────────────────────────────────────────────────────────

export function listModels(providerId: string) {
  return db.select().from(aiModels).where(eq(aiModels.providerId, providerId)).all();
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
