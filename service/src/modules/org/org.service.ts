import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import { organizations, orgMembers, workspaces, users, agents, chatSessions, channels } from "../../db/schema";

export function listOrgs(userId: string) {
  const memberRows = db
    .select({ orgId: orgMembers.orgId })
    .from(orgMembers)
    .where(eq(orgMembers.userId, userId))
    .all();
  const orgIds = memberRows.map((r) => r.orgId);
  if (orgIds.length === 0) return [];
  return orgIds.flatMap((id) =>
    db.select().from(organizations).where(eq(organizations.id, id)).all()
  );
}

export function getOrg(slug: string) {
  const org = db.select().from(organizations).where(eq(organizations.slug, slug)).get();
  if (!org) throw Object.assign(new Error("Organization not found"), { code: "NOT_FOUND" });
  return org;
}

export function updateOrg(slug: string, data: { name?: string; avatarUrl?: string }) {
  const org = db.select().from(organizations).where(eq(organizations.slug, slug)).get();
  if (!org) throw Object.assign(new Error("Organization not found"), { code: "NOT_FOUND" });

  db.update(organizations)
    .set({
      ...(data.name && { name: data.name }),
      ...(data.avatarUrl !== undefined && { avatarUrl: data.avatarUrl }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(organizations.slug, slug))
    .run();

  return db.select().from(organizations).where(eq(organizations.slug, slug)).get()!;
}

export function listMembers(orgId: string) {
  return db
    .select({
      id: orgMembers.id,
      userId: orgMembers.userId,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      role: orgMembers.role,
      joinedAt: orgMembers.joinedAt,
    })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.userId, users.id))
    .where(eq(orgMembers.orgId, orgId))
    .all();
}

export function listWorkspaces(orgId: string) {
  return db.select().from(workspaces).where(eq(workspaces.orgId, orgId)).all();
}

export function getDashboardStats(orgId: string) {
  const wsIds = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.orgId, orgId))
    .all()
    .map((w) => w.id);

  const zero = { value: 0, trend: 0, sparkline: [0, 0, 0, 0, 0, 0, 0] };

  if (wsIds.length === 0) {
    return { activeAgents: zero, todaySessions: zero, tokenUsage: zero, completedTasks: zero };
  }

  const totalAgents = wsIds.reduce((sum, wsId) => {
    return sum + db.select().from(agents).where(eq(agents.workspaceId, wsId)).all().length;
  }, 0);

  const totalSessions = wsIds.reduce((sum, wsId) => {
    return sum + db.select().from(chatSessions).where(eq(chatSessions.workspaceId, wsId)).all().length;
  }, 0);

  const activeChannels = wsIds.reduce((sum, wsId) => {
    return sum + db.select().from(channels).where(eq(channels.workspaceId, wsId)).all()
      .filter((c) => c.status === "active").length;
  }, 0);

  return {
    activeAgents:   { value: totalAgents,   trend: 0, sparkline: [0, 0, 0, 0, 0, 0, totalAgents] },
    todaySessions:  { value: totalSessions,  trend: 0, sparkline: [0, 0, 0, 0, 0, 0, totalSessions] },
    tokenUsage:     { value: 0,              trend: 0, sparkline: [0, 0, 0, 0, 0, 0, 0] },
    completedTasks: { value: activeChannels, trend: 0, sparkline: [0, 0, 0, 0, 0, 0, activeChannels] },
  };
}

export function createOrg(slug: string, name: string, userId: string) {
  const id = uuidv4();
  db.insert(organizations).values({ id, slug, name }).run();
  db.insert(orgMembers).values({ id: uuidv4(), orgId: id, userId, role: "owner" }).run();
  return db.select().from(organizations).where(eq(organizations.id, id)).get()!;
}
