export function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export function buildContinueRequest(userRequest: string, assistantContent: string): string {
  return [
    "请继续你上一条中断的回答。",
    "要求：不要重复已经输出的内容，直接从中断处续写并完成回答。",
    `用户原始问题：${userRequest}`,
    "你已经输出的部分（用于对齐上下文）：",
    assistantContent.trim().length > 0 ? assistantContent : "(空)",
  ].join("\n\n");
}

export function extractRunIdFromLocalMessageId(messageId: string): string | null {
  const normalized = messageId.trim();
  const matched = /^run-([0-9a-fA-F-]{36})-\d+$/.exec(normalized);
  return matched?.[1] ?? null;
}

export interface CancelSnapshotLike {
  state: string;
  terminal: boolean;
}

export type CancelHttpDecision =
  | { kind: "proceed" }
  | { kind: "error"; status: 404 | 409; error: string };

export function decideCancelResponse(snapshot: CancelSnapshotLike | null): CancelHttpDecision {
  if (!snapshot) {
    return { kind: "error", status: 404, error: "run not found or expired" };
  }
  if (snapshot.terminal) {
    return { kind: "error", status: 409, error: `run already ${snapshot.state}` };
  }
  return { kind: "proceed" };
}

export interface CancelFinalizeHttpDecision {
  status: 200 | 409;
  body: { ok: true } | { error: string };
}

export function decideCancelFinalizeResponse(cancelled: boolean): CancelFinalizeHttpDecision {
  if (!cancelled) {
    return {
      status: 409,
      body: { error: "run already completed during cancel" },
    };
  }
  return {
    status: 200,
    body: { ok: true },
  };
}

export type ApprovalResolveStatus = "resolved" | "expired" | "missing";

export interface ApprovalHttpDecision {
  status: 200 | 404 | 410;
  body: { ok: true } | { error: string };
}

export function decideApprovalResponse(result: ApprovalResolveStatus): ApprovalHttpDecision {
  if (result === "resolved") {
    return { status: 200, body: { ok: true } };
  }
  if (result === "expired") {
    return { status: 410, body: { error: "approval expired" } };
  }
  return { status: 404, body: { error: "approval not found" } };
}

export interface EnqueueFailureHttpDecision {
  status: 503;
  body: { error: string; runId: string };
}

export interface CreateRunSuccessHttpDecision {
  status: 200;
  body: { runId: string; deduplicated: boolean };
}

export function decideCreateRunSuccessResponse(params: {
  runId: string;
  deduplicated: boolean;
}): CreateRunSuccessHttpDecision {
  return {
    status: 200,
    body: {
      runId: params.runId,
      deduplicated: params.deduplicated,
    },
  };
}

export function decideEnqueueFailureResponse(params: {
  runId: string;
  reason: "rejected" | "error";
  detail?: string;
}): EnqueueFailureHttpDecision {
  if (params.reason === "rejected") {
    return {
      status: 503,
      body: {
        error: "Run rejected by orchestrator (lane full or shutting down)",
        runId: params.runId,
      },
    };
  }

  const detail = params.detail?.trim() || "unknown enqueue error";
  return {
    status: 503,
    body: {
      error: `Enqueue failed: ${detail}`,
      runId: params.runId,
    },
  };
}

export type ChannelReplyRetryDecision =
  | { kind: "retry"; delayMs: number }
  | { kind: "throw" };

export function decideChannelReplyRetry(params: {
  attempt: number;
  maxRetries: number;
  responseStatus?: number;
  error?: unknown;
}): ChannelReplyRetryDecision {
  if (params.attempt >= params.maxRetries) {
    return { kind: "throw" };
  }

  if (
    typeof params.responseStatus === "number" &&
    params.responseStatus >= 400 &&
    params.responseStatus < 500
  ) {
    return { kind: "throw" };
  }

  const isAbortError = params.error instanceof Error && params.error.name === "AbortError";
  if (isAbortError) {
    return { kind: "throw" };
  }

  return {
    kind: "retry",
    delayMs: 500 * Math.pow(2, params.attempt - 1),
  };
}
