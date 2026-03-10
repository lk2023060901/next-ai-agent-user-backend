import { eq, and } from "drizzle-orm"
import { db } from "../../db/index.js"
import { orgMembers, workspaces } from "../../db/schema.js"

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
