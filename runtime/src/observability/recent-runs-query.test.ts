import test from "node:test";
import assert from "node:assert/strict";
import { loadRecentRunMetrics } from "./recent-runs-query.js";
import type { RuntimeServices } from "../bootstrap.js";

test("loadRecentRunMetrics returns empty when runtime db is unavailable", async () => {
  const rows = await loadRecentRunMetrics({
    services: { db: null } as unknown as RuntimeServices,
    workspaceId: "ws-1",
    days: 7,
  });

  assert.deepEqual(rows, []);
});

test("loadRecentRunMetrics filters by status and respects the limit", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const services = {
    db: {
      observabilityStore: {
        async getRunMetrics(params: Record<string, unknown>) {
          calls.push(params);
          return [
            {
              runId: "run-3",
              sessionId: "session-3",
              workspaceId: "ws-1",
              agentId: "agent-1",
              provider: "anthropic",
              model: "claude-sonnet-4",
              status: "failed",
              turnsUsed: 3,
              coordinatorInputTokens: 0,
              coordinatorOutputTokens: 0,
              subAgentInputTokens: 0,
              subAgentOutputTokens: 0,
              totalTokens: 300,
              toolCallCount: 2,
              subAgentCount: 1,
              durationMs: 3000,
              startedAt: 100,
              completedAt: 300,
            },
            {
              runId: "run-2",
              sessionId: "session-2",
              workspaceId: "ws-1",
              agentId: "agent-1",
              provider: "anthropic",
              model: "claude-sonnet-4",
              status: "completed",
              turnsUsed: 2,
              coordinatorInputTokens: 0,
              coordinatorOutputTokens: 0,
              subAgentInputTokens: 0,
              subAgentOutputTokens: 0,
              totalTokens: 200,
              toolCallCount: 1,
              subAgentCount: 0,
              durationMs: 2000,
              startedAt: 100,
              completedAt: 200,
            },
            {
              runId: "run-1",
              sessionId: "session-1",
              workspaceId: "ws-1",
              agentId: "agent-1",
              provider: "anthropic",
              model: "claude-sonnet-4",
              status: "failed",
              turnsUsed: 1,
              coordinatorInputTokens: 0,
              coordinatorOutputTokens: 0,
              subAgentInputTokens: 0,
              subAgentOutputTokens: 0,
              totalTokens: 100,
              toolCallCount: 1,
              subAgentCount: 0,
              durationMs: 1000,
              startedAt: 100,
              completedAt: 100,
            },
          ];
        },
      },
    },
  } as unknown as RuntimeServices;

  const rows = await loadRecentRunMetrics({
    services,
    workspaceId: "ws-1",
    days: 7,
    status: "failed",
    limit: 1,
    nowMs: Date.parse("2026-03-17T12:00:00.000Z"),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.workspaceId, "ws-1");
  assert.equal(calls[0]?.limit, 50);
  assert.deepEqual(rows.map((row) => row.runId), ["run-3"]);
});
