// ─── Observability Store ─────────────────────────────────────────────────────
//
// Persists token usage, run metrics, and tool execution data for the
// entire request→response lifecycle. Supports both write (from EventBus
// subscribers) and query (for dashboards, billing, quota enforcement).
//
// Accounting model:
// - Each UsageRecord is tied to a specific agentId (coordinator or sub-agent).
// - Queries support both aggregated view (all agents in a run) and
//   per-agent breakdown (each agent's independent consumption).
// - parentRunId links sub-agent records to the originating run.
//
// Plugin injection point: replace with ClickHouse, TimescaleDB, Prometheus
// push gateway, or any time-series / analytics backend.

// ─── Usage Record ───────────────────────────────────────────────────────────
//
// One record per LLM call. Each record is attributed to a specific agent.

export interface UsageRecord {
  id: string;
  runId: string;
  /** Parent run ID if this is a sub-agent call; null for coordinator. */
  parentRunId: string | null;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  /** "coordinator" | sub-agent's agentId. */
  scope: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  createdAt: number;
}

// ─── Run Metric ─────────────────────────────────────────────────────────────
//
// Aggregated per-run summary, written at run-end.
// Includes both coordinator and sub-agent totals.

export interface RunMetric {
  runId: string;
  sessionId: string;
  workspaceId: string;
  agentId: string;
  provider: string;
  model: string;
  status: string;
  turnsUsed: number;
  // Coordinator's own consumption
  coordinatorInputTokens: number;
  coordinatorOutputTokens: number;
  // Sub-agents' total consumption
  subAgentInputTokens: number;
  subAgentOutputTokens: number;
  // Grand total (coordinator + all sub-agents)
  totalTokens: number;
  toolCallCount: number;
  subAgentCount: number;
  durationMs: number;
  startedAt: number;
  completedAt: number;
}

// ─── Tool Metric ────────────────────────────────────────────────────────────

export interface ToolMetric {
  id: string;
  runId: string;
  workspaceId: string;
  agentId: string;
  toolName: string;
  status: "success" | "error";
  durationMs: number;
  createdAt: number;
}

// ─── Query Types ────────────────────────────────────────────────────────────

export interface UsageQueryParams {
  workspaceId: string;
  agentId?: string;
  provider?: string;
  model?: string;
  /** Unix ms range. */
  from?: number;
  to?: number;
  limit?: number;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRuns: number;
  totalToolCalls: number;
  avgDurationMs: number;
}

export interface UsageByModel {
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
}

export interface UsageByAgent {
  agentId: string;
  /** Whether this agent acted as coordinator or sub-agent. */
  scope: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
}

export interface UsageByProvider {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
  modelCount: number;
}

// ─── Per-Run Agent Breakdown ────────────────────────────────────────────────
//
// Shows each agent's independent consumption within a single run.

export interface RunAgentBreakdown {
  runId: string;
  /** All agents involved in this run (coordinator + sub-agents). */
  agents: RunAgentUsage[];
  /** Grand total across all agents. */
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
}

export interface RunAgentUsage {
  agentId: string;
  scope: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
  durationMs: number;
}

// ─── Observability Store Interface ──────────────────────────────────────────

export interface ObservabilityStore {
  // ─── Write ────────────────────────────────────────────────────────────
  recordUsage(record: UsageRecord): Promise<void>;
  recordUsageBatch(records: UsageRecord[]): Promise<void>;
  recordRunMetric(metric: RunMetric): Promise<void>;
  recordToolMetric(metric: ToolMetric): Promise<void>;
  recordToolMetricBatch(metrics: ToolMetric[]): Promise<void>;

  // ─── Aggregated Queries ───────────────────────────────────────────────
  /** Aggregated usage summary (all agents combined). */
  getUsageSummary(params: UsageQueryParams): Promise<UsageSummary>;

  /** Usage broken down by model + provider. */
  getUsageByModel(params: UsageQueryParams): Promise<UsageByModel[]>;

  /** Usage broken down by agent (each agent's independent consumption). */
  getUsageByAgent(params: UsageQueryParams): Promise<UsageByAgent[]>;

  /** Usage broken down by AI provider. */
  getUsageByProvider(params: UsageQueryParams): Promise<UsageByProvider[]>;

  // ─── Per-Run Queries ──────────────────────────────────────────────────
  /** Get run-level metrics (each run's aggregated totals). */
  getRunMetrics(params: UsageQueryParams): Promise<RunMetric[]>;

  /** Get per-agent breakdown for a specific run. */
  getRunAgentBreakdown(runId: string): Promise<RunAgentBreakdown>;

  /** Get tool execution metrics for a run. */
  getToolMetrics(runId: string): Promise<ToolMetric[]>;

  // ─── Maintenance ──────────────────────────────────────────────────────
  purge(olderThanMs: number): Promise<number>;
}
