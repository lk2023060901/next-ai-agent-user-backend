import test from "node:test";
import assert from "node:assert/strict";
import { summarizePostRunFailures } from "./post-run-summary.js";

test("summarizePostRunFailures groups failures by day and stage", () => {
  const nowMs = Date.parse("2026-03-17T10:00:00.000Z");
  const summary = summarizePostRunFailures(
    [
      {
        id: "metric-1",
        runId: "run-1",
        workspaceId: "ws-1",
        agentId: "agent-1",
        toolName: "post_run:reflection",
        status: "error",
        durationMs: 120,
        createdAt: Date.parse("2026-03-17T09:00:00.000Z"),
      },
      {
        id: "metric-2",
        runId: "run-2",
        workspaceId: "ws-1",
        agentId: "agent-1",
        toolName: "post_run:reflection",
        status: "error",
        durationMs: 180,
        createdAt: Date.parse("2026-03-16T09:00:00.000Z"),
      },
      {
        id: "metric-3",
        runId: "run-3",
        workspaceId: "ws-1",
        agentId: "agent-2",
        toolName: "post_run:semantic_extraction",
        status: "error",
        durationMs: 80,
        createdAt: Date.parse("2026-03-17T08:00:00.000Z"),
      },
      {
        id: "metric-4",
        runId: "run-4",
        workspaceId: "ws-1",
        agentId: "agent-2",
        toolName: "search_web",
        status: "error",
        durationMs: 90,
        createdAt: Date.parse("2026-03-17T07:00:00.000Z"),
      },
      {
        id: "metric-5",
        runId: "run-5",
        workspaceId: "ws-1",
        agentId: "agent-2",
        toolName: "post_run:decay_update",
        status: "success",
        durationMs: 30,
        createdAt: Date.parse("2026-03-15T07:00:00.000Z"),
      },
    ],
    3,
    nowMs,
  );

  assert.equal(summary.totalFailures, 3);
  assert.deepEqual(summary.daily, [
    { date: "2026-03-15", failures: 0 },
    { date: "2026-03-16", failures: 1 },
    { date: "2026-03-17", failures: 2 },
  ]);
  assert.deepEqual(summary.stages, [
    {
      stage: "reflection",
      failures: 2,
      avgDurationMs: 150,
      lastSeenAt: Date.parse("2026-03-17T09:00:00.000Z"),
    },
    {
      stage: "semantic_extraction",
      failures: 1,
      avgDurationMs: 80,
      lastSeenAt: Date.parse("2026-03-17T08:00:00.000Z"),
    },
  ]);
});
