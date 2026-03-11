/**
 * Seed test data into the dev DB for authz tests.
 * Run once: npx tsx src/__tests__/test-seed.ts
 */
import { v4 as uuidv4 } from "uuid";
import { db } from "../db/index.js";
import {
  users,
  organizations,
  orgMembers,
  workspaces,
  chatSessions,
  channels,
  scheduledTasks,
} from "../db/schema.js";

const userId = "test-user-authz-001";
const orgId = "test-org-authz-001";
const workspaceId = "test-ws-authz-001";
const sessionId = "test-session-authz-001";
const channelId = "test-channel-authz-001";
const taskId = "test-task-authz-001";

function upsert(label: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (e: any) {
    if (e.message?.includes("UNIQUE") || e.code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      console.log(`• ${label} (exists)`);
    } else {
      throw e;
    }
  }
}

upsert("user", () => {
  db.insert(users).values({
    id: userId,
    email: "test-authz@example.com",
    name: "Authz Test User",
    passwordHash: "$2a$10$placeholder",
  }).run();
});

upsert("organization", () => {
  db.insert(organizations).values({ id: orgId, slug: "test-authz-org", name: "Authz Test Org" }).run();
});

upsert("orgMember", () => {
  db.insert(orgMembers).values({ id: uuidv4(), orgId, userId, role: "owner" }).run();
});

upsert("workspace", () => {
  db.insert(workspaces).values({ id: workspaceId, slug: "test-authz-ws", name: "Authz Test WS", orgId }).run();
});

upsert("chatSession", () => {
  db.insert(chatSessions).values({ id: sessionId, workspaceId, title: "Authz Test Session", status: "active", messageCount: 0 }).run();
});

upsert("channel", () => {
  db.insert(channels).values({ id: channelId, workspaceId, name: "Authz Test Channel", type: "slack", configJson: "{}", status: "active" }).run();
});

upsert("scheduledTask", () => {
  db.insert(scheduledTasks).values({ id: taskId, workspaceId, name: "Authz Test Task", scheduleType: "cron", status: "active" }).run();
});

console.log("\nSeed complete.");
