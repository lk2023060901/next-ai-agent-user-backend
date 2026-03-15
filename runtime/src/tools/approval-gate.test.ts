import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalGateImpl } from "./approval-gate.js";

test("approval gate resolves approved requests", async () => {
  const gate = new ApprovalGateImpl();
  let approvalId = "";

  const decisionPromise = gate.requestApproval({
    runId: "run-1",
    messageId: "msg-1",
    toolCallId: "tool-1",
    toolName: "git_push",
    args: { branch: "main" },
    emit: (event) => {
      if (event.type === "approval-request") {
        approvalId = event.approvalId;
      }
    },
    timeoutMs: 50,
  });

  assert.ok(approvalId);
  assert.equal(gate.approve(approvalId), "resolved");
  await assert.doesNotReject(decisionPromise.then((decision) => assert.equal(decision, "approved")));
});

test("approval gate reports expired approvals as expired to the API layer", async () => {
  const gate = new ApprovalGateImpl();
  let approvalId = "";

  const decisionPromise = gate.requestApproval({
    runId: "run-2",
    messageId: "msg-2",
    toolCallId: "tool-2",
    toolName: "dangerous_tool",
    args: {},
    emit: (event) => {
      if (event.type === "approval-request") {
        approvalId = event.approvalId;
      }
    },
    timeoutMs: 5,
  });

  const decision = await decisionPromise;
  assert.equal(decision, "expired");
  assert.equal(gate.approve(approvalId), "expired");
  assert.equal(gate.reject("missing-approval"), "missing");
});
