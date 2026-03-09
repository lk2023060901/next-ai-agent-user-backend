import { v4 as uuidv4 } from "uuid";
import type { EventBus } from "../events/event-types.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalWorkflow,
} from "./tool-types.js";

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * In-memory approval workflow.
 *
 * Flow:
 * 1. request() — creates a pending approval, emits approval-request event
 * 2. waitForDecision() — returns a Promise that resolves when approve/reject/expire
 * 3. approve()/reject() — resolves the pending Promise (called from API handler)
 *
 * The EventBus emits `approval-request` so the frontend can show a prompt.
 * The API handler calls approve()/reject() when the user responds.
 */
export class InMemoryApprovalWorkflow implements ApprovalWorkflow {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async request(params: ApprovalRequest): Promise<string> {
    const approvalId = uuidv4();

    // Emit the approval-request event so the frontend knows
    if (this.eventBus.hasRun(params.runId)) {
      this.eventBus.emit(params.runId, {
        type: "approval-request",
        data: {
          approvalId,
          toolCallId: params.toolCallId,
          toolName: params.toolName,
          params: params.params,
          riskLevel: params.riskLevel,
          reason: params.reason,
          expiresAt: params.expiresAt.getTime(),
        },
      });
    }

    return approvalId;
  }

  waitForDecision(approvalId: string, timeoutMs: number): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(approvalId);
        resolve("expired");
      }, timeoutMs);

      // Unref so this timer doesn't keep the process alive
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }

      // Store pending entry — resolve will be called by approve/reject
      const existing = this.pending.get(approvalId);
      if (existing) {
        clearTimeout(existing.timer);
      }

      this.pending.set(approvalId, {
        request: {
          runId: "",
          toolCallId: "",
          toolName: "",
          params: {},
          riskLevel: "low",
          reason: "",
          expiresAt: new Date(Date.now() + timeoutMs),
        },
        resolve,
        timer,
      });
    });
  }

  async approve(approvalId: string): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve("approved");
  }

  async reject(approvalId: string, _reason?: string): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(approvalId);
    entry.resolve("rejected");
  }
}
