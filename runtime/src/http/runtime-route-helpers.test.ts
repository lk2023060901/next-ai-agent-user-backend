import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContinueRequest,
  decideApprovalResponse,
  decideCancelFinalizeResponse,
  decideCancelResponse,
  decideChannelReplyRetry,
  decideCreateRunSuccessResponse,
  decideEnqueueFailureResponse,
  extractRunIdFromLocalMessageId,
  firstHeaderValue,
} from "./runtime-route-helpers.js";

test("firstHeaderValue returns the first header value", () => {
  assert.equal(firstHeaderValue("token"), "token");
  assert.equal(firstHeaderValue(["token-1", "token-2"]), "token-1");
  assert.equal(firstHeaderValue(undefined), "");
});

test("buildContinueRequest preserves the original prompt and partial reply", () => {
  const value = buildContinueRequest("用户问题", "已有回答");
  assert.match(value, /用户原始问题：用户问题/);
  assert.match(value, /已有回答/);
});

test("extractRunIdFromLocalMessageId extracts run ids from local message ids", () => {
  const runId = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(extractRunIdFromLocalMessageId(`run-${runId}-2`), runId);
  assert.equal(extractRunIdFromLocalMessageId("assistant-1"), null);
});

test("decideCancelResponse enforces not-found and terminal checks", () => {
  assert.deepEqual(decideCancelResponse(null), {
    kind: "error",
    status: 404,
    error: "run not found or expired",
  });
  assert.deepEqual(decideCancelResponse({ state: "completed", terminal: true }), {
    kind: "error",
    status: 409,
    error: "run already completed",
  });
  assert.deepEqual(decideCancelResponse({ state: "running", terminal: false }), {
    kind: "proceed",
  });
});

test("decideCancelFinalizeResponse returns 409 when the run finishes during cancel", () => {
  assert.deepEqual(decideCancelFinalizeResponse(false), {
    status: 409,
    body: { error: "run already completed during cancel" },
  });
  assert.deepEqual(decideCancelFinalizeResponse(true), {
    status: 200,
    body: { ok: true },
  });
});

test("decideApprovalResponse distinguishes resolved, expired, and missing", () => {
  assert.deepEqual(decideApprovalResponse("resolved"), {
    status: 200,
    body: { ok: true },
  });
  assert.deepEqual(decideApprovalResponse("expired"), {
    status: 410,
    body: { error: "approval expired" },
  });
  assert.deepEqual(decideApprovalResponse("missing"), {
    status: 404,
    body: { error: "approval not found" },
  });
});

test("decideCreateRunSuccessResponse returns the standard create-run payload", () => {
  assert.deepEqual(
    decideCreateRunSuccessResponse({
      runId: "run-123",
      deduplicated: true,
    }),
    {
      status: 200,
      body: {
        runId: "run-123",
        deduplicated: true,
      },
    },
  );
});

test("decideEnqueueFailureResponse formats rejected and thrown enqueue failures", () => {
  assert.deepEqual(
    decideEnqueueFailureResponse({ runId: "run-1", reason: "rejected" }),
    {
      status: 503,
      body: {
        error: "Run rejected by orchestrator (lane full or shutting down)",
        runId: "run-1",
      },
    },
  );

  assert.deepEqual(
    decideEnqueueFailureResponse({
      runId: "run-2",
      reason: "error",
      detail: "backend unavailable",
    }),
    {
      status: 503,
      body: {
        error: "Enqueue failed: backend unavailable",
        runId: "run-2",
      },
    },
  );
});

test("decideChannelReplyRetry only retries the current send node for retryable cases", () => {
  assert.deepEqual(
    decideChannelReplyRetry({
      attempt: 1,
      maxRetries: 3,
      responseStatus: 503,
    }),
    { kind: "retry", delayMs: 500 },
  );

  assert.deepEqual(
    decideChannelReplyRetry({
      attempt: 2,
      maxRetries: 3,
      error: new Error("fetch failed"),
    }),
    { kind: "retry", delayMs: 1000 },
  );

  assert.deepEqual(
    decideChannelReplyRetry({
      attempt: 1,
      maxRetries: 3,
      responseStatus: 400,
    }),
    { kind: "throw" },
  );

  const abortError = new Error("aborted");
  abortError.name = "AbortError";
  assert.deepEqual(
    decideChannelReplyRetry({
      attempt: 1,
      maxRetries: 3,
      error: abortError,
    }),
    { kind: "throw" },
  );

  assert.deepEqual(
    decideChannelReplyRetry({
      attempt: 3,
      maxRetries: 3,
      responseStatus: 503,
    }),
    { kind: "throw" },
  );
});
