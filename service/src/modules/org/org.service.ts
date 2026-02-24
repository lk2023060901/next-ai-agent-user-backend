import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import { organizations, orgMembers, workspaces, users, agents, chatSessions, channels } from "../../db/schema";

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

  if (wsIds.length === 0) {
    return { totalAgents: 0, totalSessions: 0, totalMessages: 0, activeChannels: 0 };
  }

  // Count agents across all workspaces
  const totalAgents = wsIds.reduce((sum, wsId) => {
    const count = db.select().from(agents).where(eq(agents.workspaceId, wsId)).all().length;
    return sum + count;
  }, 0);

  const totalSessions = wsIds.reduce((sum, wsId) => {
    const count = db.select().from(chatSessions).where(eq(chatSessions.workspaceId, wsId)).all().length;
    return sum + count;
  }, 0);

  const activeChannels = wsIds.reduce((sum, wsId) => {
    const count = db
      .select()
      .from(channels)
      .where(eq(channels.workspaceId, wsId))
      .all()
      .filter((c) => c.status === "active").length;
    return sum + count;
  }, 0);

  return { totalAgents, totalSessions, totalMessages: 0, activeChannels };
}

export function createOrg(slug: string, name: string, userId: string) {
  const id = uuidv4();
  db.insert(organizations).values({ id, slug, name }).run();
  db.insert(orgMembers).values({ id: uuidv4(), orgId: id, userId, role: "owner" }).run();
  return db.select().from(organizations).where(eq(organizations.id, id)).get()!;
}
