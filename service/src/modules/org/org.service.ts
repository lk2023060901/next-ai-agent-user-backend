import { eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import {
  organizations,
  orgMembers,
  workspaces,
  users,
  agents,
  chatSessions,
  channels,
  agentRuns,
} from "../../db/schema";

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

export function listMembers(orgSlug: string) {
  const org = db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, orgSlug)).get();
  if (!org) return [];
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
    .where(eq(orgMembers.orgId, org.id))
    .all();
}

export function listWorkspaces(orgSlug: string) {
  const org = db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, orgSlug)).get();
  if (!org) return [];
  return db.select().from(workspaces).where(eq(workspaces.orgId, org.id)).all();
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

  const todayKey = new Date().toISOString().slice(0, 10);
  const dateKeys: string[] = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dateKeys.push(d.toISOString().slice(0, 10));
  }
  const dateToIndex = new Map(dateKeys.map((d, i) => [d, i]));
  const currentDateSet = new Set(dateKeys);

  const prevDateSet = new Set<string>();
  for (let i = 13; i >= 7; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    prevDateSet.add(d.toISOString().slice(0, 10));
  }

  const totalAgents = wsIds.reduce((sum, wsId) => {
    return sum + db.select().from(agents).where(eq(agents.workspaceId, wsId)).all().length;
  }, 0);

  const totalSessions = wsIds.reduce((sum, wsId) => {
    return sum + db.select().from(chatSessions).where(eq(chatSessions.workspaceId, wsId)).all()
      .filter((s) => (s.createdAt ?? "").slice(0, 10) === todayKey).length;
  }, 0);

  const runRows = db.select().from(agentRuns).where(inArray(agentRuns.workspaceId, wsIds)).all();
  const tokenSparkline = [0, 0, 0, 0, 0, 0, 0];
  let currentTokenTotal = 0;
  let previousTokenTotal = 0;
  let currentCompletedTasks = 0;
  let previousCompletedTasks = 0;

  for (const run of runRows) {
    const day = (run.endedAt ?? run.updatedAt ?? run.createdAt ?? "").slice(0, 10);
    if (!day) continue;
    const totalTokens = run.totalTokens ?? 0;
    const completedTasks = run.taskSuccessCount ?? 0;

    if (currentDateSet.has(day)) {
      currentTokenTotal += totalTokens;
      currentCompletedTasks += completedTasks;
      const idx = dateToIndex.get(day);
      if (idx !== undefined) tokenSparkline[idx] += totalTokens;
    } else if (prevDateSet.has(day)) {
      previousTokenTotal += totalTokens;
      previousCompletedTasks += completedTasks;
    }
  }

  const tokenTrend =
    previousTokenTotal === 0
      ? (currentTokenTotal > 0 ? 100 : 0)
      : Math.round(((currentTokenTotal - previousTokenTotal) / previousTokenTotal) * 100);
  const completedTasksTrend =
    previousCompletedTasks === 0
      ? (currentCompletedTasks > 0 ? 100 : 0)
      : Math.round(((currentCompletedTasks - previousCompletedTasks) / previousCompletedTasks) * 100);

  const activeChannels = wsIds.reduce((sum, wsId) => {
    return sum + db.select().from(channels).where(eq(channels.workspaceId, wsId)).all()
      .filter((c) => c.status === "active").length;
  }, 0);

  return {
    activeAgents:   { value: totalAgents,   trend: 0, sparkline: [0, 0, 0, 0, 0, 0, totalAgents] },
    todaySessions:  { value: totalSessions, trend: 0, sparkline: [0, 0, 0, 0, 0, 0, totalSessions] },
    tokenUsage:     { value: currentTokenTotal, trend: tokenTrend, sparkline: tokenSparkline },
    completedTasks: {
      value: currentCompletedTasks || activeChannels,
      trend: completedTasksTrend,
      sparkline: [0, 0, 0, 0, 0, 0, currentCompletedTasks || activeChannels],
    },
  };
}

export function createOrg(slug: string, name: string, userId: string) {
  const id = uuidv4();
  db.insert(organizations).values({ id, slug, name }).run();
  db.insert(orgMembers).values({ id: uuidv4(), orgId: id, userId, role: "owner" }).run();
  return db.select().from(organizations).where(eq(organizations.id, id)).get()!;
}
