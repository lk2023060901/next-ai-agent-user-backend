import { describe, it, expect } from "vitest";
import {
  assertWorkspaceMember,
  assertSessionMember,
  assertChannelMember,
  assertSchedulerTaskMember,
} from "../modules/authz/authz.service.js";

// Deterministic IDs — seeded by test-seed.ts (run: npx tsx src/__tests__/test-seed.ts)
const userId = "test-user-authz-001";
const otherUserId = "nonexistent-user-id";
const workspaceId = "test-ws-authz-001";
const sessionId = "test-session-authz-001";
const channelId = "test-channel-authz-001";
const taskId = "test-task-authz-001";

describe("assertWorkspaceMember", () => {
  it("allows org member to access workspace", () => {
    expect(() => assertWorkspaceMember(workspaceId, userId)).not.toThrow();
  });

  it("rejects null userId", () => {
    expect(() => assertWorkspaceMember(workspaceId, undefined)).toThrow("Unauthorized");
  });

  it("rejects non-member userId", () => {
    expect(() => assertWorkspaceMember(workspaceId, otherUserId)).toThrow("not a member");
  });

  it("rejects non-existent workspace", () => {
    expect(() => assertWorkspaceMember("nonexistent-ws-id", userId)).toThrow("not found");
  });
});

describe("assertSessionMember", () => {
  it("allows workspace member to access session", () => {
    expect(() => assertSessionMember(sessionId, userId)).not.toThrow();
  });

  it("rejects null userId", () => {
    expect(() => assertSessionMember(sessionId, undefined)).toThrow("Unauthorized");
  });

  it("rejects non-member userId", () => {
    expect(() => assertSessionMember(sessionId, otherUserId)).toThrow();
  });

  it("rejects non-existent session", () => {
    expect(() => assertSessionMember("nonexistent-session-id", userId)).toThrow("not found");
  });
});

describe("assertChannelMember", () => {
  it("allows workspace member to access channel", () => {
    expect(() => assertChannelMember(channelId, userId)).not.toThrow();
  });

  it("rejects non-member userId", () => {
    expect(() => assertChannelMember(channelId, otherUserId)).toThrow();
  });

  it("rejects non-existent channel", () => {
    expect(() => assertChannelMember("nonexistent-channel-id", userId)).toThrow("not found");
  });
});

describe("assertSchedulerTaskMember", () => {
  it("allows workspace member to access task", () => {
    expect(() => assertSchedulerTaskMember(taskId, userId)).not.toThrow();
  });

  it("rejects non-member userId", () => {
    expect(() => assertSchedulerTaskMember(taskId, otherUserId)).toThrow();
  });

  it("rejects non-existent task", () => {
    expect(() => assertSchedulerTaskMember("nonexistent-task-id", userId)).toThrow("not found");
  });
});
