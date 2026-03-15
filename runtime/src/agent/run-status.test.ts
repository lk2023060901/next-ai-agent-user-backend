import test from "node:test";
import assert from "node:assert/strict";
import { resolveTerminalRunStatus } from "./run-status.js";

test("resolveTerminalRunStatus returns cancelled when abort signal is already aborted", () => {
  const controller = new AbortController();
  controller.abort();

  assert.equal(
    resolveTerminalRunStatus(new Error("any failure"), { abortSignal: controller.signal }),
    "cancelled",
  );
});

test("resolveTerminalRunStatus returns cancelled for AbortError", () => {
  const error = new Error("aborted");
  error.name = "AbortError";

  assert.equal(resolveTerminalRunStatus(error), "cancelled");
});

test("resolveTerminalRunStatus returns failed for ordinary errors", () => {
  assert.equal(resolveTerminalRunStatus(new Error("boom")), "failed");
  assert.equal(resolveTerminalRunStatus("boom"), "failed");
});
