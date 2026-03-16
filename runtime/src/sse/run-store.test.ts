import test from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "./run-store.js";

test("RunStore records snapshot gap metadata when subscriber cursor falls behind the buffer", () => {
  const runStore = new RunStore({
    maxEventsPerRun: 100,
    runRetentionMs: 60_000,
    idempotencyTtlMs: 60_000,
    cleanupIntervalMs: 60_000,
  });

  runStore.registerRun("run-gap-1", {
    sessionId: "session-1",
    workspaceId: "ws-1",
    userRequest: "hello",
    coordinatorAgentId: "agent-1",
  });

  for (let i = 0; i < 120; i += 1) {
    runStore.emit("run-gap-1", {
      type: "text-delta",
      runId: "run-gap-1",
      text: `chunk-${i}`,
    });
  }

  const replayedEvents: Array<{ seq?: number }> = [];
  const subscription = runStore.subscribe(
    "run-gap-1",
    (event) => {
      replayedEvents.push({ seq: event.seq });
    },
    10,
  );

  assert.equal(subscription.snapshot.lastSeq, 120);
  assert.equal(subscription.snapshot.oldestBufferedSeq, 21);
  assert.equal(subscription.snapshot.gapFromSeq, 11);
  assert.equal(subscription.snapshot.gapToSeq, 20);
  assert.equal(subscription.replayed, 100);
  assert.equal(replayedEvents[0]?.seq, 21);
  assert.equal(replayedEvents.at(-1)?.seq, 120);

  subscription.unsubscribe();
  runStore.close();
});

test("RunStore snapshot omits gap metadata when cursor is still within the buffer", () => {
  const runStore = new RunStore({
    maxEventsPerRun: 100,
    runRetentionMs: 60_000,
    idempotencyTtlMs: 60_000,
    cleanupIntervalMs: 60_000,
  });

  runStore.registerRun("run-gap-2", {
    sessionId: "session-2",
    workspaceId: "ws-1",
    userRequest: "hello",
    coordinatorAgentId: "agent-1",
  });

  for (let i = 0; i < 20; i += 1) {
    runStore.emit("run-gap-2", {
      type: "text-delta",
      runId: "run-gap-2",
      text: `chunk-${i}`,
    });
  }

  const subscription = runStore.subscribe("run-gap-2", () => {}, 10);

  assert.equal(subscription.snapshot.lastSeq, 20);
  assert.equal(subscription.snapshot.oldestBufferedSeq, 1);
  assert.equal(subscription.snapshot.gapFromSeq, undefined);
  assert.equal(subscription.snapshot.gapToSeq, undefined);

  subscription.unsubscribe();
  runStore.close();
});
