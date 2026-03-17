import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeRunDiagnostics } from "./run-diagnostics-query.js";
import type { RuntimeServices } from "../bootstrap.js";

test("loadRuntimeRunDiagnostics returns null when runtime db is unavailable", async () => {
  const diagnostics = await loadRuntimeRunDiagnostics({
    services: { db: null } as unknown as RuntimeServices,
    workspaceId: "ws-1",
    runId: "run-1",
  });

  assert.equal(diagnostics, null);
});

test("loadRuntimeRunDiagnostics loads metric, breakdown, and tool metrics for one run", async () => {
  const calls: string[] = [];
  const services = {
    db: {
      observabilityStore: {
        async getRunMetricById(runId: string) {
          calls.push(`metric:${runId}`);
          return {
            runId,
            sessionId: "session-1",
            workspaceId: "ws-1",
            agentId: "agent-coordinator",
            provider: "anthropic",
            model: "claude-sonnet-4",
            status: "failed",
            turnsUsed: 3,
            coordinatorInputTokens: 500,
            coordinatorOutputTokens: 200,
            subAgentInputTokens: 150,
            subAgentOutputTokens: 80,
            totalTokens: 930,
            toolCallCount: 4,
            subAgentCount: 2,
            durationMs: 1200,
            startedAt: 100,
            completedAt: 1300,
          };
        },
        async getRunAgentBreakdown(runId: string) {
          calls.push(`breakdown:${runId}`);
          return {
            runId,
            agents: [
              {
                agentId: "agent-coordinator",
                scope: "coordinator",
                provider: "anthropic",
                model: "claude-sonnet-4",
                inputTokens: 500,
                outputTokens: 200,
                totalTokens: 700,
                toolCallCount: 4,
                durationMs: 800,
              },
            ],
            totalInputTokens: 500,
            totalOutputTokens: 200,
            totalTokens: 700,
          };
        },
        async getToolMetrics(runId: string) {
          calls.push(`tools:${runId}`);
          return [
            {
              id: "tool-1",
              runId,
              workspaceId: "ws-1",
              agentId: "agent-coordinator",
              toolName: "post_run:reflection",
              status: "error" as const,
              durationMs: 182,
              createdAt: 1200,
            },
          ];
        },
      },
    },
  } as unknown as RuntimeServices;

  const diagnostics = await loadRuntimeRunDiagnostics({
    services,
    workspaceId: "ws-1",
    runId: "run-1",
  });

  assert.deepEqual(calls, ["metric:run-1", "breakdown:run-1", "tools:run-1"]);
  assert.equal(diagnostics?.metric.runId, "run-1");
  assert.equal(diagnostics?.breakdown.agents[0]?.agentId, "agent-coordinator");
  assert.equal(diagnostics?.toolMetrics[0]?.toolName, "post_run:reflection");
});

test("loadRuntimeRunDiagnostics returns null when run belongs to another workspace", async () => {
  const services = {
    db: {
      observabilityStore: {
        async getRunMetricById(runId: string) {
          return {
            runId,
            sessionId: "session-2",
            workspaceId: "ws-other",
            agentId: "agent-1",
            provider: "anthropic",
            model: "claude-sonnet-4",
            status: "failed",
            turnsUsed: 1,
            coordinatorInputTokens: 0,
            coordinatorOutputTokens: 0,
            subAgentInputTokens: 0,
            subAgentOutputTokens: 0,
            totalTokens: 0,
            toolCallCount: 0,
            subAgentCount: 0,
            durationMs: 10,
            startedAt: 1,
            completedAt: 2,
          };
        },
        async getRunAgentBreakdown() {
          throw new Error("unused");
        },
        async getToolMetrics() {
          throw new Error("unused");
        },
      },
    },
  } as unknown as RuntimeServices;

  const diagnostics = await loadRuntimeRunDiagnostics({
    services,
    workspaceId: "ws-1",
    runId: "run-2",
  });

  assert.equal(diagnostics, null);
});
