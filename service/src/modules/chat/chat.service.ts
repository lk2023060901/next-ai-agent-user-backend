import { and, desc, eq, gt, inArray, lt, or, type SQL } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import {
  getWorkspaceRuntimeMetrics,
  listWorkspaceUsageRecords,
  reportPluginUsageEvents,
  type ReportPluginUsageEventInput,
} from "../agent-run/agent-run.service";
import { normalizeAgentConfigJson, parseAgentConfigJson } from "./agent-config";
import {
  chatSessions,
  messages,
  agents,
  aiModels,
  aiProviders,
  agentKnowledgeBases,
} from "../../db/schema";

function resolveWorkspaceModel(workspaceId: string, modelId: string) {
  const model = db.select().from(aiModels).where(eq(aiModels.id, modelId)).get();
  if (!model) {
    throw Object.assign(new Error("Model not found"), { code: "NOT_FOUND" });
  }

  const provider = db.select().from(aiProviders).where(eq(aiProviders.id, model.providerId)).get();
  if (!provider || provider.workspaceId !== workspaceId) {
    throw Object.assign(new Error("Model does not belong to workspace"), { code: "INVALID_ARGUMENT" });
  }
  if ((provider.status ?? "active") !== "active") {
    throw Object.assign(new Error("Model provider is not active"), { code: "INVALID_ARGUMENT" });
  }

  return { model, provider };
}

function uniqueIds(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0))];
}

function validateAgentConfigModelBindings(workspaceId: string, configJson: string) {
  const config = parseAgentConfigJson(configJson);
  const configuredModelIds = new Set([
    ...config.llm.primaryModelIds,
    ...config.llm.fallbackModelIds,
  ]);
  for (const modelId of configuredModelIds) {
    resolveWorkspaceModel(workspaceId, modelId);
  }
}

function hydrateAgents(rows: Array<typeof agents.$inferSelect>) {
  if (rows.length === 0) return [];

  const modelIds = [...new Set(rows.map((a) => a.modelId).filter((id): id is string => Boolean(id)))];
  const modelRows = modelIds.length > 0
    ? db.select().from(aiModels).where(inArray(aiModels.id, modelIds)).all()
    : [];
  const modelNameById = new Map(modelRows.map((m) => [m.id, m.name]));

  const agentIds = rows.map((a) => a.id);
  const kbRows = db.select().from(agentKnowledgeBases).where(inArray(agentKnowledgeBases.agentId, agentIds)).all();

  const knowledgeByAgent = new Map<string, string[]>();
  for (const k of kbRows) {
    const cur = knowledgeByAgent.get(k.agentId) ?? [];
    cur.push(k.knowledgeBaseId);
    knowledgeByAgent.set(k.agentId, cur);
  }

  return rows.map((a) => ({
    ...a,
    model: a.modelId ? (modelNameById.get(a.modelId) ?? a.model ?? "") : (a.model ?? ""),
    knowledgeBases: knowledgeByAgent.get(a.id) ?? [],
  }));
}

function replaceAgentRelations(agentId: string, knowledgeBases: string[] | undefined) {
  if (knowledgeBases !== undefined) {
    db.delete(agentKnowledgeBases).where(eq(agentKnowledgeBases.agentId, agentId)).run();
    const uniqKnowledgeBases = uniqueIds(knowledgeBases);
    if (uniqKnowledgeBases.length > 0) {
      db.insert(agentKnowledgeBases)
        .values(uniqKnowledgeBases.map((knowledgeBaseId) => ({ agentId, knowledgeBaseId })))
        .run();
    }
  }
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function listSessions(workspaceId: string) {
  return db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.workspaceId, workspaceId))
    .orderBy(desc(chatSessions.isPinned), desc(chatSessions.pinnedAt), desc(chatSessions.createdAt))
    .all();
}

export function createSession(workspaceId: string, title: string) {
  const id = uuidv4();
  db.insert(chatSessions)
    .values({ id, workspaceId, title: title || "新对话", status: "active", messageCount: 0 })
    .run();
  return db.select().from(chatSessions).where(eq(chatSessions.id, id)).get()!;
}

export function updateSession(data: {
  sessionId: string;
  title?: string;
  isPinned?: boolean;
  updateTitle?: boolean;
  updateIsPinned?: boolean;
}) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, data.sessionId)).get();
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });

  const patch: Partial<typeof chatSessions.$inferInsert> = {};

  if (data.updateTitle) {
    const nextTitle = (data.title ?? "").trim();
    if (!nextTitle) {
      throw Object.assign(new Error("title is required"), { code: "INVALID_ARGUMENT" });
    }
    patch.title = nextTitle;
  }

  if (data.updateIsPinned) {
    const nextPinned = Boolean(data.isPinned);
    patch.isPinned = nextPinned;
    patch.pinnedAt = nextPinned ? new Date().toISOString() : null;
  }

  if (Object.keys(patch).length === 0) {
    return session;
  }

  db.update(chatSessions)
    .set(patch)
    .where(eq(chatSessions.id, data.sessionId))
    .run();

  return db.select().from(chatSessions).where(eq(chatSessions.id, data.sessionId)).get()!;
}

export function deleteSession(sessionId: string) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });

  db.delete(chatSessions).where(eq(chatSessions.id, sessionId)).run();
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function listMessages(
  sessionId: string,
  opts?: {
    limit?: number;
    beforeMessageId?: string;
  }
) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });

  const limit = Math.max(1, Math.min(100, opts?.limit ?? 40));
  const beforeMessageId = (opts?.beforeMessageId ?? "").trim();

  let whereExpr: SQL<unknown> = eq(messages.sessionId, sessionId);
  if (beforeMessageId) {
    const anchor = db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.id, beforeMessageId)))
      .get();
    if (!anchor) {
      return { messages: [], hasMore: false, nextBeforeMessageId: "" };
    }

    whereExpr = and(
      eq(messages.sessionId, sessionId),
      or(
        lt(messages.createdAt, anchor.createdAt),
        and(eq(messages.createdAt, anchor.createdAt), lt(messages.id, anchor.id))
      ),
    ) as SQL<unknown>;
  }

  const rowsDesc = db
    .select()
    .from(messages)
    .where(whereExpr)
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1)
    .all();

  const hasMore = rowsDesc.length > limit;
  const pageDesc = hasMore ? rowsDesc.slice(0, limit) : rowsDesc;
  const pageAsc = [...pageDesc].reverse();
  const nextBeforeMessageId = hasMore ? (pageAsc[0]?.id ?? "") : "";

  return {
    messages: pageAsc,
    hasMore,
    nextBeforeMessageId,
  };
}

export function saveUserMessage(sessionId: string, content: string) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });

  const id = uuidv4();
  db.insert(messages)
    .values({ id, sessionId, role: "user", content, status: "done", createdAt: new Date().toISOString() })
    .run();

  // Increment message count
  db.update(chatSessions)
    .set({ messageCount: (session.messageCount ?? 0) + 1, lastMessageAt: new Date().toISOString() })
    .where(eq(chatSessions.id, sessionId))
    .run();

  return db.select().from(messages).where(eq(messages.id, id)).get()!;
}

export function updateUserMessage(sessionId: string, messageId: string, content: string) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });

  const nextContent = content.trim();
  if (!nextContent) {
    throw Object.assign(new Error("content is required"), { code: "INVALID_ARGUMENT" });
  }

  const target = db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
    .get();
  if (!target) {
    throw Object.assign(new Error("Message not found"), { code: "NOT_FOUND" });
  }
  if (target.role !== "user") {
    throw Object.assign(new Error("Only user messages can be edited"), { code: "INVALID_ARGUMENT" });
  }

  const rowsToRemove = db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        or(
          gt(messages.createdAt, target.createdAt),
          and(eq(messages.createdAt, target.createdAt), gt(messages.id, target.id))
        ),
      ),
    )
    .all();

  const removedMessageIds = rowsToRemove.map((row) => row.id);
  if (removedMessageIds.length > 0) {
    db.delete(messages).where(inArray(messages.id, removedMessageIds)).run();
  }

  db.update(messages)
    .set({ content: nextContent, status: "done" })
    .where(and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
    .run();

  const updatedMessage = db
    .select()
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), eq(messages.id, messageId)))
    .get();
  if (!updatedMessage) {
    throw Object.assign(new Error("Message not found after update"), { code: "INTERNAL" });
  }

  const remainingDesc = db
    .select({ id: messages.id, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .all();

  db.update(chatSessions)
    .set({
      messageCount: remainingDesc.length,
      lastMessageAt: remainingDesc[0]?.createdAt ?? null,
    })
    .where(eq(chatSessions.id, sessionId))
    .run();

  return {
    message: updatedMessage,
    removedMessageIds,
  };
}

export function getRuntimeMetrics(workspaceId: string, days?: number) {
  return getWorkspaceRuntimeMetrics(workspaceId, days ?? 7);
}

export function listUsageRecords(
  workspaceId: string,
  opts?: {
    limit?: number;
    offset?: number;
    startDate?: string;
    endDate?: string;
  },
) {
  return listWorkspaceUsageRecords({
    workspaceId,
    limit: opts?.limit,
    offset: opts?.offset,
    startDate: opts?.startDate,
    endDate: opts?.endDate,
  });
}

export function reportWorkspacePluginUsageEvents(
  workspaceId: string,
  events: ReportPluginUsageEventInput[],
) {
  return reportPluginUsageEvents(workspaceId, events);
}

// ─── Agents ───────────────────────────────────────────────────────────────────

export function listAgents(workspaceId: string) {
  const rows = db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(agents.createdAt)
    .all();
  return hydrateAgents(rows);
}

export function getAgent(agentId: string) {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!row) {
    throw Object.assign(new Error("Agent not found"), { code: "NOT_FOUND" });
  }
  return hydrateAgents([row])[0]!;
}

export function createAgent(data: {
  workspaceId: string;
  name: string;
  role?: string;
  modelId: string;
  color?: string;
  description?: string;
  systemPrompt?: string;
  knowledgeBases?: string[];
  configJson?: string;
}) {
  if (!data.modelId) {
    throw Object.assign(new Error("modelId is required"), { code: "INVALID_ARGUMENT" });
  }
  const { model } = resolveWorkspaceModel(data.workspaceId, data.modelId);
  const normalizedConfigJson = normalizeAgentConfigJson(data.configJson);
  validateAgentConfigModelBindings(data.workspaceId, normalizedConfigJson);

  const id = uuidv4();
  db.insert(agents)
    .values({
      id,
      workspaceId: data.workspaceId,
      name: data.name,
      role: data.role ?? null,
      modelId: data.modelId,
      model: model.name,
      color: data.color ?? null,
      description: data.description ?? null,
      systemPrompt: data.systemPrompt ?? null,
      configJson: normalizedConfigJson,
      status: "idle",
    })
    .run();
  replaceAgentRelations(id, data.knowledgeBases);
  return getAgent(id);
}

export function updateAgent(data: {
  id: string;
  name?: string;
  role?: string;
  modelId?: string;
  color?: string;
  description?: string;
  systemPrompt?: string;
  knowledgeBases?: string[];
  configJson?: string;
}) {
  const current = db.select().from(agents).where(eq(agents.id, data.id)).get();
  if (!current) {
    throw Object.assign(new Error("Agent not found"), { code: "NOT_FOUND" });
  }

  const nextModelId = data.modelId || current.modelId;
  if (!nextModelId) {
    throw Object.assign(new Error("modelId is required"), { code: "INVALID_ARGUMENT" });
  }

  let nextModelName = current.model ?? "";
  if (nextModelId !== current.modelId) {
    const { model } = resolveWorkspaceModel(current.workspaceId, nextModelId);
    nextModelName = model.name;
  }
  const nextConfigJson = data.configJson !== undefined
    ? normalizeAgentConfigJson(data.configJson)
    : current.configJson;
  validateAgentConfigModelBindings(current.workspaceId, nextConfigJson);

  db.update(agents)
    .set({
      name: data.name && data.name.trim().length > 0 ? data.name.trim() : current.name,
      role: data.role || current.role || null,
      modelId: nextModelId,
      model: nextModelName,
      color: data.color || current.color || null,
      description: data.description ?? current.description ?? null,
      systemPrompt: data.systemPrompt ?? current.systemPrompt ?? null,
      configJson: nextConfigJson,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agents.id, data.id))
    .run();

  replaceAgentRelations(data.id, data.knowledgeBases);
  return getAgent(data.id);
}

export function deleteAgent(agentId: string) {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!row) {
    throw Object.assign(new Error("Agent not found"), { code: "NOT_FOUND" });
  }
  db.delete(agents).where(eq(agents.id, agentId)).run();
}
