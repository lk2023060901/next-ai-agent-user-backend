import { eq, desc } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import { chatSessions, messages, agents } from "../../db/schema";

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function listSessions(workspaceId: string) {
  return db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.workspaceId, workspaceId))
    .orderBy(desc(chatSessions.createdAt))
    .all();
}

export function createSession(workspaceId: string, title: string) {
  const id = uuidv4();
  db.insert(chatSessions)
    .values({ id, workspaceId, title: title || "新对话", status: "active", messageCount: 0 })
    .run();
  return db.select().from(chatSessions).where(eq(chatSessions.id, id)).get()!;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function listMessages(sessionId: string) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });
  return db
    .select()
    .from(messages)
    .where(eq(messages.sessionId, sessionId))
    .orderBy(messages.createdAt)
    .all();
}

export function saveUserMessage(sessionId: string, content: string) {
  const session = db.select().from(chatSessions).where(eq(chatSessions.id, sessionId)).get();
  if (!session) throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" });

  const id = uuidv4();
  db.insert(messages)
    .values({ id, sessionId, role: "user", content, status: "done" })
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
  return db
    .select()
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(agents.createdAt)
    .all();
}

export function createAgent(data: {
  workspaceId: string;
  name: string;
  role?: string;
  model?: string;
  color?: string;
  description?: string;
  systemPrompt?: string;
}) {
  const id = uuidv4();
  db.insert(agents)
    .values({
      id,
      workspaceId: data.workspaceId,
      name: data.name,
      role: data.role ?? null,
      model: data.model ?? "claude-sonnet-4-6",
      color: data.color ?? null,
      description: data.description ?? null,
      systemPrompt: data.systemPrompt ?? null,
      status: "active",
    })
    .run();
  return db.select().from(agents).where(eq(agents.id, id)).get()!;
}
