import test from "node:test";
import assert from "node:assert/strict";
import { recordPostRunFailure } from "./post-run-observability.js";

test("recordPostRunFailure writes a post_run metric when store is available", async () => {
  const calls: Array<Record<string, unknown>> = [];

  await recordPostRunFailure({
    observabilityStore: {
      async recordUsage() {},
      async recordUsageBatch() {},
      async recordRunMetric() {},
      async recordToolMetric(metric) {
        calls.push(metric as unknown as Record<string, unknown>);
      },
      async recordToolMetricBatch() {},
      async getUsageSummary() { throw new Error("unused"); },
      async getUsageByModel() { throw new Error("unused"); },
      async getUsageByAgent() { throw new Error("unused"); },
      async getUsageByProvider() { throw new Error("unused"); },
      async getRunMetrics() { throw new Error("unused"); },
      async getRunAgentBreakdown() { throw new Error("unused"); },
      async getToolMetrics() { throw new Error("unused"); },
      async purge() { throw new Error("unused"); },
    },
    runId: "run-1",
    workspaceId: "ws-1",
    agentId: "agent-1",
    stage: "post_run:reflection",
    startedAt: Date.now() - 25,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.runId, "run-1");
  assert.equal(calls[0]?.workspaceId, "ws-1");
  assert.equal(calls[0]?.agentId, "agent-1");
  assert.equal(calls[0]?.toolName, "post_run:reflection");
  assert.equal(calls[0]?.status, "error");
  assert.equal(typeof calls[0]?.durationMs, "number");
});

test("recordPostRunFailure is a no-op without an observability store", async () => {
  await assert.doesNotReject(
    recordPostRunFailure({
      runId: "run-2",
      workspaceId: "ws-1",
      agentId: "agent-1",
      stage: "post_run:entity_extraction",
      startedAt: Date.now(),
    }),
  );
});
