import { eq, and } from "drizzle-orm"
import { db } from "../../db/index.js"
import { orgMembers, workspaces, channels, knowledgeBases, routingRules, chatSessions, scheduledTasks } from "../../db/schema.js"

/**
 * Verify userId is a member of orgId. Throws gRPC-compatible error if not.
 */
export function assertOrgMember(orgId: string, userId: string | undefined): void {
  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHENTICATED" })
  }
  const row = db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .get()
  if (!row) {
    throw Object.assign(new Error("Forbidden: not a member of this organization"), { code: "PERMISSION_DENIED" })
  }
}

/**
 * Verify userId has access to workspaceId (via org membership).
 */
export function assertWorkspaceMember(workspaceId: string, userId: string | undefined): void {
  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHENTICATED" })
  }
  const ws = db
    .select({ orgId: workspaces.orgId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .get()
  if (!ws) {
    throw Object.assign(new Error("Workspace not found"), { code: "NOT_FOUND" })
  }
  assertOrgMember(ws.orgId, userId)
}

/**
 * Verify userId has access to a channel (via the channel's workspace → org membership).
 */
export function assertChannelMember(channelId: string, userId: string | undefined): void {
  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHENTICATED" })
  }
  const ch = db
    .select({ workspaceId: channels.workspaceId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .get()
  if (!ch) {
    throw Object.assign(new Error("Channel not found"), { code: "NOT_FOUND" })
  }
  assertWorkspaceMember(ch.workspaceId, userId)
}

/**
 * Verify userId has access to a routing rule (rule → channel → workspace → org membership).
 */
export function assertRoutingRuleMember(ruleId: string, userId: string | undefined): void {
  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHENTICATED" })
  }
  const rule = db
    .select({ channelId: routingRules.channelId })
    .from(routingRules)
    .where(eq(routingRules.id, ruleId))
    .get()
  if (!rule) {
    throw Object.assign(new Error("Routing rule not found"), { code: "NOT_FOUND" })
  }
  assertChannelMember(rule.channelId, userId)
}

/**
 * Verify userId has access to a chat session (via the session's workspace → org membership).
 */
export function assertSessionMember(sessionId: string, userId: string | undefined): void {
  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHENTICATED" })
  }
  const session = db
    .select({ workspaceId: chatSessions.workspaceId })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .get()
  if (!session) {
    throw Object.assign(new Error("Session not found"), { code: "NOT_FOUND" })
  }
  assertWorkspaceMember(session.workspaceId, userId)
}

/**
 * Verify userId has access to a scheduler task (via the task's workspace → org membership).
 */
export function assertSchedulerTaskMember(taskId: string, userId: string | undefined): void {
  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHENTICATED" })
  }
  const task = db
    .select({ workspaceId: scheduledTasks.workspaceId })
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, taskId))
    .get()
  if (!task) {
    throw Object.assign(new Error("Task not found"), { code: "NOT_FOUND" })
  }
  assertWorkspaceMember(task.workspaceId, userId)
}

/**
 * Verify userId has access to a knowledge base (via the KB's workspace → org membership).
 */
export function assertKnowledgeBaseMember(knowledgeBaseId: string, userId: string | undefined): void {
  if (!userId) {
    throw Object.assign(new Error("Unauthorized"), { code: "UNAUTHENTICATED" })
  }
  const kb = db
    .select({ workspaceId: knowledgeBases.workspaceId })
    .from(knowledgeBases)
    .where(eq(knowledgeBases.id, knowledgeBaseId))
    .get()
  if (!kb) {
    throw Object.assign(new Error("Knowledge base not found"), { code: "NOT_FOUND" })
  }
  assertWorkspaceMember(kb.workspaceId, userId)
}
