import type { EventBus } from "../events/event-types.js";

// ─── Tool Metadata ───────────────────────────────────────────────────────────

export type ToolCategory =
  | "file"
  | "browser"
  | "terminal"
  | "system"
  | "api"
  | "memory"
  | "agent"
  | "knowledge"
  | "plugin";

export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Declarative tool definition — what the tool is, what it accepts,
 * and how it should be governed. Separate from execution logic.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  riskLevel: RiskLevel;
  /** JSON Schema for the tool's parameters. */
  parameters: Record<string, unknown>;
  /** If true, ToolRuntime gates execution behind ApprovalWorkflow. */
  requiresApproval?: boolean;
  /** If true, only workspace owners can invoke this tool. */
  ownerOnly?: boolean;
  /** If true, the tool runs locally (vs. remote API). */
  isLocal?: boolean;
  /** Per-tool execution timeout in ms (overrides global default). */
  timeout?: number;
}

// ─── Tool Implementation ─────────────────────────────────────────────────────

/**
 * A registered tool — combines declarative definition with execution logic.
 */
export interface AgentTool {
  definition: ToolDefinition;

  /** Execute the tool with validated parameters. */
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;

  /** Optional: pre-validate parameters before execution. */
  validateParams?(params: unknown): ValidationResult;

  /** Optional: format the result for LLM consumption. */
  formatResult?(result: ToolResult): string;
}

// ─── Tool Context ────────────────────────────────────────────────────────────

/**
 * Execution context passed to every tool invocation.
 * The agent loop constructs this per tool call.
 */
export interface ToolContext {
  toolCallId: string;
  runId: string;
  sessionId: string;
  agentId: string;
  workspaceId: string;
  abortSignal: AbortSignal;
  eventBus: EventBus;
}

// ─── Tool Result ─────────────────────────────────────────────────────────────

export interface ToolResult {
  status: "success" | "error";
  data: unknown;
  error?: string;
  metadata?: {
    durationMs: number;
    tokensUsed?: number;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

// ─── Tool Error ──────────────────────────────────────────────────────────────

export type ToolErrorCode =
  | "INVALID_PARAMS"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "ABORTED"
  | "RATE_LIMIT"
  | "EXECUTION_ERROR"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_REJECTED"
  | "SANDBOX_VIOLATION";

export class ToolError extends Error {
  override readonly name = "ToolError";

  constructor(
    message: string,
    public readonly code: ToolErrorCode,
    public readonly toolName: string,
    public readonly recoverable: boolean = false,
  ) {
    super(message);
  }
}

// ─── Tool Registry Interface ─────────────────────────────────────────────────

export interface ToolRegistry {
  /** Register a single tool. Overwrites if name already exists. */
  register(tool: AgentTool): void;

  /** Register multiple tools at once. */
  registerBatch(tools: AgentTool[]): void;

  /** Lookup a tool by name. */
  get(name: string): AgentTool | undefined;

  /** List all registered tools. */
  list(): AgentTool[];

  /** List tools in a specific category. */
  listByCategory(category: ToolCategory): AgentTool[];

  /** Return tools filtered by a resolved policy. */
  resolve(policy: ResolvedToolPolicy): AgentTool[];
}

// ─── Tool Runtime Interface ──────────────────────────────────────────────────

export interface ToolRuntime {
  /**
   * Execute a tool with full lifecycle management:
   * param validation → approval check → timeout → error normalization.
   */
  execute(
    tool: AgentTool,
    params: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}

// ─── Policy Types ────────────────────────────────────────────────────────────

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

/**
 * Resolved policy — merged from all pipeline layers.
 * allow: glob patterns (empty = all allowed). deny: glob patterns (union).
 */
export interface ResolvedToolPolicy {
  allow: string[];
  deny: string[];
}

export interface PolicyContext {
  agentId: string;
  providerId?: string;
  channelType?: string;
  subAgentDepth: number;
  maxDepth: number;
}

export interface PolicyLayer {
  name: string;
  resolve(context: PolicyContext): ToolPolicy;
}

export interface ToolPolicyPipeline {
  /** Resolve all layers into a single merged policy. */
  resolve(context: PolicyContext): ResolvedToolPolicy;
}

// ─── Approval Types ──────────────────────────────────────────────────────────

export interface ApprovalRequest {
  runId: string;
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  riskLevel: RiskLevel;
  reason: string;
  expiresAt: Date;
}

export type ApprovalDecision = "approved" | "rejected" | "expired";

export interface ApprovalWorkflow {
  /** Create an approval request. Returns the approval ID. */
  request(params: ApprovalRequest): Promise<string>;

  /** Block until a decision is made or timeout fires. */
  waitForDecision(approvalId: string, timeoutMs: number): Promise<ApprovalDecision>;

  /** User approves. */
  approve(approvalId: string): Promise<void>;

  /** User rejects. */
  reject(approvalId: string, reason?: string): Promise<void>;
}
