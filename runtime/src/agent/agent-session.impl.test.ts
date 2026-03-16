import test from "node:test";
import assert from "node:assert/strict";
import type { AgentLoop, AgentConfig, ExecuteRunParams, SessionStore } from "./agent-types.js";
import { DefaultAgentSession } from "./agent-session.impl.js";

function createAgent(): AgentConfig {
  return {
    id: "agent-1",
    name: "Agent",
    systemPrompt: "You are an agent.",
    model: "test-model",
    maxTurns: 4,
  };
}

function createEventBus() {
  return {
    emit() {},
    subscribe() {
      return { unsubscribe() {} };
    },
  };
}

function createParams(overrides?: Partial<ExecuteRunParams>): ExecuteRunParams {
  return {
    runId: "run-1",
    userRequest: "hello",
    agent: createAgent(),
    tools: [],
    providerAdapter: {} as ExecuteRunParams["providerAdapter"],
    ...overrides,
  };
}

function createStore(overrides?: Partial<SessionStore>): SessionStore {
  return {
    async saveSession() {},
    async getSession() { return null; },
    async getSessionByKey() { return null; },
    async listActiveSessions() { return []; },
    async updateSession() {},
    async getExpiredSessionIds() { return []; },
    async deleteSession() {},
    async appendMessage() {},
    async getMessages() { return []; },
    async clearMessages() {},
    async replaceMessages() {},
    ...overrides,
  };
}

test("DefaultAgentSession waits for running state persistence before executing the loop", async () => {
  let loopCalled = false;
  let updateResolved = false;

  const agentLoop: AgentLoop = {
    async execute() {
      loopCalled = true;
      assert.equal(updateResolved, true);
      return {
        runId: "run-1",
        status: "completed",
        fullText: "ok",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnsUsed: 1,
      };
    },
  };

  const store = createStore({
    async updateSession(_sessionId, updates) {
      if (updates.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        updateResolved = true;
      }
    },
  });

  const session = new DefaultAgentSession({
    id: "session-1",
    agentId: "agent-1",
    workspaceId: "ws-1",
    sessionKey: "agent:agent-1:run",
    agentLoop,
    eventBus: createEventBus() as never,
    sessionStore: store,
  });

  const result = await session.executeRun(createParams());

  assert.equal(loopCalled, true);
  assert.equal(result.status, "completed");
});

test("DefaultAgentSession aborts executeRun when running state persistence fails", async () => {
  let loopCalled = false;

  const agentLoop: AgentLoop = {
    async execute() {
      loopCalled = true;
      return {
        runId: "run-1",
        status: "completed",
        fullText: "ok",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnsUsed: 1,
      };
    },
  };

  const session = new DefaultAgentSession({
    id: "session-2",
    agentId: "agent-1",
    workspaceId: "ws-1",
    sessionKey: "agent:agent-1:run",
    agentLoop,
    eventBus: createEventBus() as never,
    sessionStore: createStore({
      async updateSession(_sessionId, updates) {
        if (updates.status === "running") {
          throw new Error("persist running failed");
        }
      },
    }),
  });

  await assert.rejects(session.executeRun(createParams({ runId: "run-2" })), /persist running failed/);
  assert.equal(loopCalled, false);
  assert.equal(session.status, "idle");
  assert.equal(session.currentRunId, null);
});
