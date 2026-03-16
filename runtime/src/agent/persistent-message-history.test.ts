import test from "node:test";
import assert from "node:assert/strict";
import type { Message } from "../providers/adapter.js";
import {
  flushAllPersistentMessageHistoryWrites,
  PersistentMessageHistory,
} from "./persistent-message-history.js";

function buildMessage(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
  };
}

test("PersistentMessageHistory appendAsync waits for store persistence", async () => {
  let appendResolved = false;
  let appendCalls = 0;

  const store = {
    async saveSession() {},
    async getSession() { return null; },
    async getSessionByKey() { return null; },
    async listActiveSessions() { return []; },
    async updateSession() {},
    async getExpiredSessionIds() { return []; },
    async deleteSession() {},
    async appendMessage(_sessionId: string, _message: Message) {
      appendCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      appendResolved = true;
    },
    async getMessages() { return []; },
    async clearMessages() {},
    async replaceMessages() {},
  };

  const history = new PersistentMessageHistory("session-1", store);
  await history.appendAsync(buildMessage("hello"));

  assert.equal(appendCalls, 1);
  assert.equal(appendResolved, true);
  assert.equal(history.length, 1);
});

test("PersistentMessageHistory clearAsync waits for store clearing", async () => {
  let cleared = false;

  const store = {
    async saveSession() {},
    async getSession() { return null; },
    async getSessionByKey() { return null; },
    async listActiveSessions() { return []; },
    async updateSession() {},
    async getExpiredSessionIds() { return []; },
    async deleteSession() {},
    async appendMessage() {},
    async getMessages() { return [buildMessage("persisted")]; },
    async clearMessages() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      cleared = true;
    },
    async replaceMessages() {},
  };

  const history = new PersistentMessageHistory("session-2", store);
  await history.load();
  assert.equal(history.length, 1);

  await history.clearAsync();

  assert.equal(cleared, true);
  assert.equal(history.length, 0);
});

test("flushAllPersistentMessageHistoryWrites drains fire-and-forget writes before shutdown", async () => {
  let appendResolved = false;

  const store = {
    async saveSession() {},
    async getSession() { return null; },
    async getSessionByKey() { return null; },
    async listActiveSessions() { return []; },
    async updateSession() {},
    async getExpiredSessionIds() { return []; },
    async deleteSession() {},
    async appendMessage() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      appendResolved = true;
    },
    async getMessages() { return []; },
    async clearMessages() {},
    async replaceMessages() {},
  };

  const history = new PersistentMessageHistory("session-3", store);
  history.append(buildMessage("queued"));
  assert.equal(appendResolved, false);

  await flushAllPersistentMessageHistoryWrites();

  assert.equal(appendResolved, true);
});
