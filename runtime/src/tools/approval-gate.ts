import { v4 as uuidv4 } from "uuid";
import type { SseEmitter } from "../sse/emitter.js";
import { config } from "../config.js";

// ─── Approval Gate ──────────────────────────────────────────────────────────
//
// Lightweight approval mechanism for the stream-loop execution path.
// When a tool has `requiresApproval: true`, the gate:
// 1. Emits an `approval-request` SSE event to the frontend
// 2. Blocks until the user approves, rejects, or the request expires
// 3. The API handler calls resolve() to unblock
//
// This is a process-wide singleton shared across all runs.
// Pending approvals are keyed by approvalId and automatically expire.

export type ApprovalDecision = "approved" | "rejected" | "expired";
export type ApprovalResolveStatus = "resolved" | "expired" | "missing";

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalGateImpl {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly expired = new Map<string, number>();
  private readonly expiredTtlMs = 5 * 60_000;

  /**
   * Request approval for a tool execution.
   * Emits an SSE event and blocks until the user responds or timeout.
   */
  async requestApproval(params: {
    runId: string;
    messageId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    emit: SseEmitter;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }): Promise<ApprovalDecision> {
    const approvalId = uuidv4();
    const timeoutMs = params.timeoutMs ?? config.approvalTimeoutMs;
    const expiresAt = Date.now() + timeoutMs;

    // Emit SSE event so the frontend can show an approval prompt
    params.emit({
      type: "approval-request",
      runId: params.runId,
      messageId: params.messageId,
      approvalId,
      toolCallId: params.toolCallId,
      toolName: params.toolName,
      args: params.args,
      message: `Tool "${params.toolName}" requires approval before execution.`,
      expiresAt,
    });

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        this.markExpired(approvalId);
        resolve("expired");
      }, timeoutMs);

      // Unref so this timer doesn't keep the process alive
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      this.pending.set(approvalId, { resolve, timer });

      // Abort signal → expire immediately
      if (params.abortSignal) {
        const onAbort = () => {
          if (this.pending.has(approvalId)) {
            clearTimeout(timer);
            this.pending.delete(approvalId);
            this.markExpired(approvalId);
            resolve("expired");
          }
        };
        if (params.abortSignal.aborted) {
          onAbort();
        } else {
          params.abortSignal.addEventListener("abort", onAbort, { once: true });
        }
      }
    });
  }

  /**
   * Approve a pending request. Called by the API handler.
   */
  approve(approvalId: string): ApprovalResolveStatus {
    return this.resolve(approvalId, "approved");
  }

  /**
   * Reject a pending request. Called by the API handler.
   */
  reject(approvalId: string): ApprovalResolveStatus {
    return this.resolve(approvalId, "rejected");
  }

  private resolve(approvalId: string, decision: ApprovalDecision): ApprovalResolveStatus {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      this.cleanupExpired();
      return this.expired.has(approvalId) ? "expired" : "missing";
    }
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve(decision);
    this.expired.delete(approvalId);
    return "resolved";
  }

  private markExpired(approvalId: string): void {
    this.cleanupExpired();
    this.expired.set(approvalId, Date.now());
  }

  private cleanupExpired(): void {
    const cutoff = Date.now() - this.expiredTtlMs;
    for (const [approvalId, expiredAt] of this.expired) {
      if (expiredAt < cutoff) {
        this.expired.delete(approvalId);
      }
    }
  }

  /** Number of pending approvals (for diagnostics). */
  get pendingCount(): number {
    return this.pending.size;
  }
}

/** Process-wide singleton. */
export const approvalGate = new ApprovalGateImpl();
