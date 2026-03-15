import test from "node:test";
import assert from "node:assert/strict";
import { InMemorySessionLock, SessionLockTimeoutError } from "./session-lock.js";

test("InMemorySessionLock rejects a waiter that exceeds the wait limit", async () => {
  const lock = new InMemorySessionLock();
  const release = await lock.acquire("session-1", 50);

  await assert.rejects(lock.acquire("session-1", 10), (error: unknown) => {
    assert.ok(error instanceof SessionLockTimeoutError);
    assert.match(error.message, /wait limit exceeded/);
    return true;
  });

  release();
});

test("InMemorySessionLock keeps the chain intact after a timed-out waiter", async () => {
  const lock = new InMemorySessionLock();
  const releaseFirst = await lock.acquire("session-2", 50);

  const timedOut = lock.acquire("session-2", 10).then(
    () => "acquired" as const,
    () => "timed-out" as const,
  );

  const thirdAcquire = lock.acquire("session-2", 100);

  assert.equal(await timedOut, "timed-out");

  let thirdResolved = false;
  void thirdAcquire.then(() => {
    thirdResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(thirdResolved, false);

  releaseFirst();

  const releaseThird = await thirdAcquire;
  assert.equal(typeof releaseThird, "function");
  assert.equal(lock.size, 1);

  releaseThird();
  assert.equal(lock.size, 0);
});
