import { and, desc, eq, inArray, lt, or, type SQL } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import {
  chatSessions,
  messages,
  agents,
  aiModels,
  aiProviders,
  agentTools,
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

function hydrateAgents(rows: Array<typeof agents.$inferSelect>) {
  if (rows.length === 0) return [];

  const modelIds = [...new Set(rows.map((a) => a.modelId).filter((id): id is string => Boolean(id)))];
  const modelRows = modelIds.length > 0
    ? db.select().from(aiModels).where(inArray(aiModels.id, modelIds)).all()
    : [];
  const modelNameById = new Map(modelRows.map((m) => [m.id, m.name]));

  const agentIds = rows.map((a) => a.id);
  const toolRows = db.select().from(agentTools).where(inArray(agentTools.agentId, agentIds)).all();
  const kbRows = db.select().from(agentKnowledgeBases).where(inArray(agentKnowledgeBases.agentId, agentIds)).all();

  const toolsByAgent = new Map<string, string[]>();
  for (const t of toolRows) {
    const cur = toolsByAgent.get(t.agentId) ?? [];
    cur.push(t.toolId);
    toolsByAgent.set(t.agentId, cur);
  }

  const knowledgeByAgent = new Map<string, string[]>();
  for (const k of kbRows) {
    const cur = knowledgeByAgent.get(k.agentId) ?? [];
    cur.push(k.knowledgeBaseId);
    knowledgeByAgent.set(k.agentId, cur);
  }

  return rows.map((a) => ({
    ...a,
    model: a.modelId ? (modelNameById.get(a.modelId) ?? a.model ?? "") : (a.model ?? ""),
    tools: toolsByAgent.get(a.id) ?? [],
    knowledgeBases: knowledgeByAgent.get(a.id) ?? [],
  }));
}

function replaceAgentRelations(agentId: string, tools: string[] | undefined, knowledgeBases: string[] | undefined) {
  if (tools !== undefined) {
    db.delete(agentTools).where(eq(agentTools.agentId, agentId)).run();
    const uniqTools = uniqueIds(tools);
    if (uniqTools.length > 0) {
      db.insert(agentTools).values(uniqTools.map((toolId) => ({ agentId, toolId }))).run();
    }
  }

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
  temperature?: number;
  outputFormat?: string;
  tools?: string[];
  knowledgeBases?: string[];
}) {
  if (!data.modelId) {
    throw Object.assign(new Error("modelId is required"), { code: "INVALID_ARGUMENT" });
  }
  const { model } = resolveWorkspaceModel(data.workspaceId, data.modelId);

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
      temperature: data.temperature ?? 0.7,
      outputFormat: data.outputFormat ?? "text",
      status: "active",
    })
    .run();
  replaceAgentRelations(id, data.tools, data.knowledgeBases);
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
  temperature?: number;
  outputFormat?: string;
  tools?: string[];
  knowledgeBases?: string[];
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

  db.update(agents)
    .set({
      name: data.name && data.name.trim().length > 0 ? data.name.trim() : current.name,
      role: data.role || current.role || null,
      modelId: nextModelId,
      model: nextModelName,
      color: data.color || current.color || null,
      description: data.description ?? current.description ?? null,
      systemPrompt: data.systemPrompt ?? current.systemPrompt ?? null,
      temperature: data.temperature && data.temperature > 0 ? data.temperature : (current.temperature ?? 0.7),
      outputFormat: data.outputFormat || current.outputFormat || "text",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agents.id, data.id))
    .run();

  replaceAgentRelations(data.id, data.tools, data.knowledgeBases);
  return getAgent(data.id);
}

export function deleteAgent(agentId: string) {
  const row = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!row) {
    throw Object.assign(new Error("Agent not found"), { code: "NOT_FOUND" });
  }
  db.delete(agents).where(eq(agents.id, agentId)).run();
}
