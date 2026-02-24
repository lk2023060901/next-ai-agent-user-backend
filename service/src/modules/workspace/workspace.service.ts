import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import { workspaces } from "../../db/schema";

function slugify(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

export function getWorkspace(workspaceId: string) {
  const ws = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws) throw Object.assign(new Error("Workspace not found"), { code: "NOT_FOUND" });
  return ws;
}

export function createWorkspace(data: {
  orgId: string;
  name: string;
  emoji?: string;
  description?: string;
}) {
  const id = uuidv4();
  const slug = slugify(data.name) + "-" + id.slice(0, 6);
  db.insert(workspaces)
    .values({
      id,
      slug,
      name: data.name,
      emoji: data.emoji ?? null,
      orgId: data.orgId,
      description: data.description ?? null,
    })
    .run();
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get()!;
}

export function updateWorkspace(
  workspaceId: string,
  data: { name?: string; emoji?: string; description?: string }
) {
  const ws = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws) throw Object.assign(new Error("Workspace not found"), { code: "NOT_FOUND" });

  db.update(workspaces)
    .set({
      ...(data.name && { name: data.name }),
      ...(data.emoji !== undefined && { emoji: data.emoji }),
      ...(data.description !== undefined && { description: data.description }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workspaces.id, workspaceId))
    .run();

  return db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()!;
}

export function deleteWorkspace(workspaceId: string) {
  const ws = db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws) throw Object.assign(new Error("Workspace not found"), { code: "NOT_FOUND" });
  db.delete(workspaces).where(eq(workspaces.id, workspaceId)).run();
}
