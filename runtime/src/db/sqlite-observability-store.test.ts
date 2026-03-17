import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { SqliteObservabilityStore } from "./sqlite-observability-store.js";

test("SqliteObservabilityStore.listToolMetrics filters by workspace, prefix, and status", async () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  const store = new SqliteObservabilityStore(db);

  await store.recordToolMetric({
    id: "metric-1",
    runId: "run-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    toolName: "post_run:reflection",
    status: "error",
    durationMs: 120,
    createdAt: 100,
  });
  await store.recordToolMetric({
    id: "metric-2",
    runId: "run-2",
    workspaceId: "ws-1",
    agentId: "agent-1",
    toolName: "post_run:semantic_extraction",
    status: "success",
    durationMs: 90,
    createdAt: 200,
  });
  await store.recordToolMetric({
    id: "metric-3",
    runId: "run-3",
    workspaceId: "ws-2",
    agentId: "agent-2",
    toolName: "post_run:reflection",
    status: "error",
    durationMs: 50,
    createdAt: 300,
  });

  const rows = await store.listToolMetrics({
    workspaceId: "ws-1",
    toolNamePrefix: "post_run:",
    status: "error",
  });

  assert.deepEqual(rows.map((row) => row.id), ["metric-1"]);
  db.close();
});

test("SqliteObservabilityStore.getRunMetricById returns the recorded session context", async () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  const store = new SqliteObservabilityStore(db);

  await store.recordRunMetric({
    runId: "run-42",
    sessionId: "session-42",
    workspaceId: "ws-1",
    agentId: "agent-1",
    provider: "anthropic",
    model: "claude-sonnet-4",
    status: "failed",
    turnsUsed: 2,
    coordinatorInputTokens: 100,
    coordinatorOutputTokens: 50,
    subAgentInputTokens: 30,
    subAgentOutputTokens: 20,
    totalTokens: 200,
    toolCallCount: 3,
    subAgentCount: 1,
    durationMs: 900,
    startedAt: 100,
    completedAt: 1000,
  });

  const metric = await store.getRunMetricById("run-42");

  assert.equal(metric?.runId, "run-42");
  assert.equal(metric?.sessionId, "session-42");
  assert.equal(metric?.workspaceId, "ws-1");
  assert.equal(metric?.status, "failed");
  db.close();
});
