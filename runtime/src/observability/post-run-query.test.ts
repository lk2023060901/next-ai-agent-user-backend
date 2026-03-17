import test from "node:test";
import assert from "node:assert/strict";
import {
  loadPostRunFailureDetails,
  loadPostRunFailureSummary,
} from "./post-run-query.js";
import type { RuntimeServices } from "../bootstrap.js";
import type { ToolMetricQueryParams } from "../db/observability-types.js";

test("loadPostRunFailureSummary queries post_run failures from the observability store", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const nowMs = Date.parse("2026-03-17T12:00:00.000Z");
  const services = {
    db: {
      observabilityStore: {
        async listToolMetrics(params: ToolMetricQueryParams) {
          calls.push(params as unknown as Record<string, unknown>);
          return [
            {
              id: "metric-1",
              runId: "run-1",
              workspaceId: "ws-1",
              agentId: "agent-1",
              toolName: "post_run:reflection",
              status: "error" as const,
              durationMs: 125,
              createdAt: Date.parse("2026-03-17T11:00:00.000Z"),
            },
          ];
        },
      },
    },
  } as unknown as RuntimeServices;

  const summary = await loadPostRunFailureSummary({
    services,
    workspaceId: "ws-1",
    days: 7,
    nowMs,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    workspaceId: "ws-1",
    toolNamePrefix: "post_run:",
    status: "error",
    from: nowMs - 7 * 24 * 60 * 60 * 1000,
    to: nowMs,
    limit: 5000,
  });
  assert.equal(summary.totalFailures, 1);
  assert.equal(summary.stages[0]?.stage, "reflection");
});

test("loadPostRunFailureSummary returns empty buckets when runtime db is unavailable", async () => {
  const services = {
    db: null,
  } as unknown as RuntimeServices;

  const summary = await loadPostRunFailureSummary({
    services,
    workspaceId: "ws-1",
    days: 3,
    nowMs: Date.parse("2026-03-17T12:00:00.000Z"),
  });

  assert.equal(summary.totalFailures, 0);
  assert.equal(summary.daily.length, 3);
  assert.equal(summary.stages.length, 0);
});

test("loadPostRunFailureDetails returns recent stage failures", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const nowMs = Date.parse("2026-03-17T12:00:00.000Z");
  const services = {
    db: {
      observabilityStore: {
        async listToolMetrics(params: ToolMetricQueryParams) {
          calls.push(params as unknown as Record<string, unknown>);
          return [
            {
              id: "metric-1",
              runId: "run-1",
              workspaceId: "ws-1",
              agentId: "agent-1",
              toolName: "post_run:reflection",
              status: "error" as const,
              durationMs: 210,
              createdAt: Date.parse("2026-03-17T11:30:00.000Z"),
            },
          ];
        },
        async getRunMetricById(runId: string) {
          assert.equal(runId, "run-1");
          return {
            runId,
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
            totalTokens: 0,
            toolCallCount: 0,
            subAgentCount: 0,
            durationMs: 210,
            startedAt: Date.parse("2026-03-17T11:29:00.000Z"),
            completedAt: Date.parse("2026-03-17T11:30:00.000Z"),
          };
        },
      },
    },
  } as unknown as RuntimeServices;

  const details = await loadPostRunFailureDetails({
    services,
    workspaceId: "ws-1",
    stage: "reflection",
    days: 7,
    limit: 10,
    nowMs,
  });

  assert.deepEqual(calls[0], {
    workspaceId: "ws-1",
    toolNamePrefix: "post_run:reflection",
    status: "error",
    from: nowMs - 7 * 24 * 60 * 60 * 1000,
    to: nowMs,
    limit: 10,
  });
  assert.deepEqual(details, [
    {
      id: "metric-1",
      runId: "run-1",
      sessionId: "session-1",
      agentId: "agent-1",
      stage: "reflection",
      durationMs: 210,
      createdAt: Date.parse("2026-03-17T11:30:00.000Z"),
    },
  ]);
});
