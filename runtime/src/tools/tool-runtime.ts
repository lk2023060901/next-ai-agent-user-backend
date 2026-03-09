import type {
  AgentTool,
  ApprovalWorkflow,
  ToolContext,
  ToolResult,
  ToolRuntime,
} from "./tool-types.js";
import { ToolError } from "./tool-types.js";

export interface ToolRuntimeOptions {
  /** Default tool timeout in ms (used when tool.definition.timeout is unset). */
  defaultTimeoutMs: number;
  /** Approval workflow (optional — if absent, approval-required tools fail). */
  approvalWorkflow?: ApprovalWorkflow;
  /** Approval wait timeout in ms. Defaults to 15 minutes. */
  approvalTimeoutMs: number;
}

const DEFAULT_OPTIONS: ToolRuntimeOptions = {
  defaultTimeoutMs: 60_000,
  approvalTimeoutMs: 15 * 60_000,
};

/**
 * Executes tools with full lifecycle management:
 *
 * 1. Parameter validation (if tool provides validateParams)
 * 2. Approval gating (if tool.definition.requiresApproval)
 * 3. Timeout enforcement (per-tool or global default)
 * 4. Error normalization (all errors → ToolResult)
 * 5. Duration tracking
 */
export class DefaultToolRuntime implements ToolRuntime {
  private readonly options: ToolRuntimeOptions;

  constructor(options?: Partial<ToolRuntimeOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async execute(
    tool: AgentTool,
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const start = Date.now();
    const toolName = tool.definition.name;

    try {
      // 1. Validate parameters
      if (tool.validateParams) {
        const validation = tool.validateParams(params);
        if (!validation.valid) {
          throw new ToolError(
            `Invalid params: ${validation.errors?.join("; ") ?? "validation failed"}`,
            "INVALID_PARAMS",
            toolName,
          );
        }
      }

      // 2. Check abort before expensive operations
      if (context.abortSignal.aborted) {
        throw new ToolError("Tool execution aborted", "ABORTED", toolName);
      }

      // 3. Approval gating
      if (tool.definition.requiresApproval) {
        await this.handleApproval(tool, params, context);
      }

      // 4. Execute with timeout
      const timeoutMs = tool.definition.timeout ?? this.options.defaultTimeoutMs;
      const result = await this.executeWithTimeout(tool, params, context, timeoutMs);

      return {
        ...result,
        metadata: {
          durationMs: Date.now() - start,
          ...result.metadata,
        },
      };
    } catch (err) {
      return this.errorToResult(err, toolName, Date.now() - start);
    }
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async executeWithTimeout(
    tool: AgentTool,
    params: Record<string, unknown>,
    context: ToolContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    // Create a child AbortController that aborts on timeout or parent abort
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    const onParentAbort = () => ac.abort();
    context.abortSignal.addEventListener("abort", onParentAbort, { once: true });

    const childContext: ToolContext = { ...context, abortSignal: ac.signal };

    try {
      return await tool.execute(params, childContext);
    } finally {
      clearTimeout(timer);
      context.abortSignal.removeEventListener("abort", onParentAbort);
    }
  }

  private async handleApproval(
    tool: AgentTool,
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<void> {
    const workflow = this.options.approvalWorkflow;
    if (!workflow) {
      throw new ToolError(
        "Tool requires approval but no approval workflow is configured",
        "APPROVAL_REQUIRED",
        tool.definition.name,
      );
    }

    const approvalId = await workflow.request({
      runId: context.runId,
      toolCallId: context.toolCallId,
      toolName: tool.definition.name,
      params,
      riskLevel: tool.definition.riskLevel,
      reason: `Tool "${tool.definition.name}" (risk: ${tool.definition.riskLevel}) requires approval`,
      expiresAt: new Date(Date.now() + this.options.approvalTimeoutMs),
    });

    const decision = await workflow.waitForDecision(
      approvalId,
      this.options.approvalTimeoutMs,
    );

    if (decision === "rejected") {
      throw new ToolError(
        "Tool execution rejected by user",
        "APPROVAL_REJECTED",
        tool.definition.name,
      );
    }
    if (decision === "expired") {
      throw new ToolError(
        "Approval request expired",
        "APPROVAL_REJECTED",
        tool.definition.name,
      );
    }
  }

  private errorToResult(err: unknown, toolName: string, durationMs: number): ToolResult {
    if (err instanceof ToolError) {
      return {
        status: "error",
        data: null,
        error: `[${err.code}] ${err.message}`,
        metadata: { durationMs },
      };
    }

    const message = err instanceof Error ? err.message : String(err);

    // Detect abort/timeout from generic errors
    if (
      message.includes("aborted") ||
      message.includes("AbortError") ||
      (err instanceof DOMException && err.name === "AbortError")
    ) {
      return {
        status: "error",
        data: null,
        error: `[TIMEOUT] Tool "${toolName}" timed out`,
        metadata: { durationMs },
      };
    }

    return {
      status: "error",
      data: null,
      error: message,
      metadata: { durationMs },
    };
  }
}
