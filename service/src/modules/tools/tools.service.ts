import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import { tools, toolAuthorizations } from "../../db/schema";

// Seed built-in tools on first call if empty
function ensureToolsSeed() {
  const count = db.select().from(tools).all().length;
  if (count > 0) return;

  const builtins = [
    { id: uuidv4(), name: "web_search", category: "web", description: "Search the web", riskLevel: "low", platform: "all", requiresApproval: false },
    { id: uuidv4(), name: "web_browser", category: "web", description: "Browse web pages", riskLevel: "medium", platform: "all", requiresApproval: false },
    { id: uuidv4(), name: "file_read", category: "filesystem", description: "Read files from disk", riskLevel: "low", platform: "desktop", requiresApproval: false },
    { id: uuidv4(), name: "file_write", category: "filesystem", description: "Write files to disk", riskLevel: "high", platform: "desktop", requiresApproval: true },
    { id: uuidv4(), name: "shell_exec", category: "system", description: "Execute shell commands", riskLevel: "high", platform: "desktop", requiresApproval: true },
    { id: uuidv4(), name: "code_interpreter", category: "code", description: "Run code in sandbox", riskLevel: "medium", platform: "all", requiresApproval: false },
    { id: uuidv4(), name: "image_generation", category: "media", description: "Generate images with AI", riskLevel: "low", platform: "all", requiresApproval: false },
    { id: uuidv4(), name: "email_send", category: "communication", description: "Send emails", riskLevel: "high", platform: "all", requiresApproval: true },
    { id: uuidv4(), name: "calendar_read", category: "productivity", description: "Read calendar events", riskLevel: "low", platform: "all", requiresApproval: false },
    { id: uuidv4(), name: "calendar_write", category: "productivity", description: "Create/update calendar events", riskLevel: "medium", platform: "all", requiresApproval: true },
  ];

  for (const tool of builtins) {
    db.insert(tools).values(tool).run();
  }
}

export function listTools(category?: string) {
  ensureToolsSeed();
  const all = db.select().from(tools).all();
  if (category) return all.filter((t) => t.category === category);
  return all;
}

export function listToolAuthorizations(workspaceId: string) {
  ensureToolsSeed();
  const allTools = db.select().from(tools).all();
  const auths = db
    .select()
    .from(toolAuthorizations)
    .where(eq(toolAuthorizations.workspaceId, workspaceId))
    .all();

  const authMap = new Map(auths.map((a) => [a.toolId, a]));

  return allTools.map((tool) => {
    const auth = authMap.get(tool.id);
    return {
      id: auth?.id ?? "",
      workspaceId,
      toolId: tool.id,
      authorized: auth?.authorized ?? false,
      updatedAt: auth?.updatedAt ?? "",
      tool,
    };
  });
}

export function upsertToolAuthorization(data: {
  workspaceId: string;
  toolId: string;
  authorized: boolean;
}) {
  const existing = db
    .select()
    .from(toolAuthorizations)
    .where(eq(toolAuthorizations.workspaceId, data.workspaceId))
    .all()
    .find((a) => a.toolId === data.toolId);

  const now = new Date().toISOString();

  if (existing) {
    db.update(toolAuthorizations)
      .set({ authorized: data.authorized, updatedAt: now })
      .where(eq(toolAuthorizations.id, existing.id))
      .run();
    return { ...existing, authorized: data.authorized, updatedAt: now };
  }

  const id = uuidv4();
  db.insert(toolAuthorizations)
    .values({ id, workspaceId: data.workspaceId, toolId: data.toolId, authorized: data.authorized })
    .run();

  const tool = db.select().from(tools).where(eq(tools.id, data.toolId)).get();
  return {
    id,
    workspaceId: data.workspaceId,
    toolId: data.toolId,
    authorized: data.authorized,
    updatedAt: now,
    tool,
  };
}
