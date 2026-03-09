// ─── Tools Module ───────────────────────────────────────────────────────────
//
// Plugin/skill integration points:
//
// 1. Register custom tools:
//    Implement the AgentTool interface, register via ToolRegistry
//
// 2. Replace ToolRuntime:
//    Implement the ToolRuntime interface for custom execution lifecycle
//
// 3. Replace ApprovalWorkflow:
//    Implement the ApprovalWorkflow interface (e.g. Slack, webhook)
//
// 4. Add policy layers:
//    Implement the PolicyLayer interface, add to ToolPolicyPipeline
//
// All interfaces and default implementations are exported below.

// ─── Interfaces (implement these in your plugin) ────────────────────────────

export type {
  AgentTool,
  ToolDefinition,
  ToolCategory,
  RiskLevel,
  ToolContext,
  ToolResult,
  ValidationResult,
  ToolRegistry,
  ToolRuntime,
  ToolPolicy,
  ResolvedToolPolicy,
  PolicyContext,
  PolicyLayer,
  ToolPolicyPipeline,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalWorkflow,
} from "./tool-types.js";

export { ToolError, type ToolErrorCode } from "./tool-types.js";

// ─── Default implementations ────────────────────────────────────────────────

export { DefaultToolRegistry } from "./tool-registry.js";
export { DefaultToolRuntime, type ToolRuntimeOptions } from "./tool-runtime.js";
export { DefaultToolPolicyPipeline, SubAgentDepthLayer } from "./policy-pipeline.js";
export { InMemoryApprovalWorkflow } from "./approval-workflow.js";
