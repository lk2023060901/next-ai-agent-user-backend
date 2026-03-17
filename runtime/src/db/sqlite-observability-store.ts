import type Database from "better-sqlite3";
import type {
  ObservabilityStore,
  RunAgentBreakdown,
  RunAgentUsage,
  RunMetric,
  ToolMetric,
  ToolMetricQueryParams,
  UsageByAgent,
  UsageByModel,
  UsageByProvider,
  UsageQueryParams,
  UsageRecord,
  UsageSummary,
} from "./observability-types.js";

// ─── SQLite Observability Store ─────────────────────────────────────────────

export class SqliteObservabilityStore implements ObservabilityStore {
  constructor(private readonly db: Database.Database) {}

  // ─── Write ────────────────────────────────────────────────────────────

  async recordUsage(record: UsageRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO usage_records (
        id, run_id, parent_run_id, session_id, workspace_id, agent_id,
        scope, provider, model, input_tokens, output_tokens, total_tokens,
        duration_ms, created_at
      ) VALUES (
        @id, @runId, @parentRunId, @sessionId, @workspaceId, @agentId,
        @scope, @provider, @model, @inputTokens, @outputTokens, @totalTokens,
        @durationMs, @createdAt
      )
    `).run({
      id: record.id,
      runId: record.runId,
      parentRunId: record.parentRunId,
      sessionId: record.sessionId,
      workspaceId: record.workspaceId,
      agentId: record.agentId,
      scope: record.scope,
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      durationMs: record.durationMs,
      createdAt: record.createdAt,
    });
  }

  async recordUsageBatch(records: UsageRecord[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO usage_records (
        id, run_id, parent_run_id, session_id, workspace_id, agent_id,
        scope, provider, model, input_tokens, output_tokens, total_tokens,
        duration_ms, created_at
      ) VALUES (
        @id, @runId, @parentRunId, @sessionId, @workspaceId, @agentId,
        @scope, @provider, @model, @inputTokens, @outputTokens, @totalTokens,
        @durationMs, @createdAt
      )
    `);
    const run = this.db.transaction((items: UsageRecord[]) => {
      for (const r of items) {
        stmt.run({
          id: r.id, runId: r.runId, parentRunId: r.parentRunId,
          sessionId: r.sessionId, workspaceId: r.workspaceId, agentId: r.agentId,
          scope: r.scope, provider: r.provider, model: r.model,
          inputTokens: r.inputTokens, outputTokens: r.outputTokens,
          totalTokens: r.totalTokens, durationMs: r.durationMs, createdAt: r.createdAt,
        });
      }
    });
    run(records);
  }

  async recordRunMetric(metric: RunMetric): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO run_metrics (
        run_id, session_id, workspace_id, agent_id, provider, model,
        status, turns_used,
        coordinator_input_tokens, coordinator_output_tokens,
        sub_agent_input_tokens, sub_agent_output_tokens,
        total_tokens, tool_call_count, sub_agent_count,
        duration_ms, started_at, completed_at
      ) VALUES (
        @runId, @sessionId, @workspaceId, @agentId, @provider, @model,
        @status, @turnsUsed,
        @coordinatorInputTokens, @coordinatorOutputTokens,
        @subAgentInputTokens, @subAgentOutputTokens,
        @totalTokens, @toolCallCount, @subAgentCount,
        @durationMs, @startedAt, @completedAt
      )
    `).run({
      runId: metric.runId,
      sessionId: metric.sessionId,
      workspaceId: metric.workspaceId,
      agentId: metric.agentId,
      provider: metric.provider,
      model: metric.model,
      status: metric.status,
      turnsUsed: metric.turnsUsed,
      coordinatorInputTokens: metric.coordinatorInputTokens,
      coordinatorOutputTokens: metric.coordinatorOutputTokens,
      subAgentInputTokens: metric.subAgentInputTokens,
      subAgentOutputTokens: metric.subAgentOutputTokens,
      totalTokens: metric.totalTokens,
      toolCallCount: metric.toolCallCount,
      subAgentCount: metric.subAgentCount,
      durationMs: metric.durationMs,
      startedAt: metric.startedAt,
      completedAt: metric.completedAt,
    });
  }

  async recordToolMetric(metric: ToolMetric): Promise<void> {
    this.db.prepare(`
      INSERT INTO tool_metrics (id, run_id, workspace_id, agent_id, tool_name, status, duration_ms, created_at)
      VALUES (@id, @runId, @workspaceId, @agentId, @toolName, @status, @durationMs, @createdAt)
    `).run({
      id: metric.id, runId: metric.runId, workspaceId: metric.workspaceId,
      agentId: metric.agentId, toolName: metric.toolName, status: metric.status,
      durationMs: metric.durationMs, createdAt: metric.createdAt,
    });
  }

  async recordToolMetricBatch(metrics: ToolMetric[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO tool_metrics (id, run_id, workspace_id, agent_id, tool_name, status, duration_ms, created_at)
      VALUES (@id, @runId, @workspaceId, @agentId, @toolName, @status, @durationMs, @createdAt)
    `);
    const run = this.db.transaction((items: ToolMetric[]) => {
      for (const m of items) {
        stmt.run({
          id: m.id, runId: m.runId, workspaceId: m.workspaceId,
          agentId: m.agentId, toolName: m.toolName, status: m.status,
          durationMs: m.durationMs, createdAt: m.createdAt,
        });
      }
    });
    run(metrics);
  }

  // ─── Aggregated Queries ───────────────────────────────────────────────

  async getUsageSummary(params: UsageQueryParams): Promise<UsageSummary> {
    const { where, values } = buildWhereClause(params, "usage_records");

    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0)  as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(total_tokens), 0)  as total_tokens,
        COALESCE(AVG(duration_ms), 0)   as avg_duration
      FROM usage_records
      ${where}
    `).get(values) as { total_input: number; total_output: number; total_tokens: number; avg_duration: number };

    const runRow = this.db.prepare(`
      SELECT COUNT(DISTINCT run_id) as run_count FROM usage_records ${where}
    `).get(values) as { run_count: number };

    const toolRow = this.db.prepare(`
      SELECT COUNT(*) as tool_count FROM tool_metrics
      ${buildWhereClause(params, "tool_metrics").where}
    `).get(buildWhereClause(params, "tool_metrics").values) as { tool_count: number };

    return {
      totalInputTokens: row.total_input,
      totalOutputTokens: row.total_output,
      totalTokens: row.total_tokens,
      totalRuns: runRow.run_count,
      totalToolCalls: toolRow.tool_count,
      avgDurationMs: Math.round(row.avg_duration),
    };
  }

  async getUsageByModel(params: UsageQueryParams): Promise<UsageByModel[]> {
    const { where, values } = buildWhereClause(params, "usage_records");

    const rows = this.db.prepare(`
      SELECT
        model, provider,
        SUM(input_tokens)  as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(total_tokens)  as total_tokens,
        COUNT(*)           as call_count
      FROM usage_records
      ${where}
      GROUP BY provider, model
      ORDER BY total_tokens DESC
    `).all(values) as Array<{
      model: string; provider: string;
      input_tokens: number; output_tokens: number; total_tokens: number; call_count: number;
    }>;

    return rows.map((r) => ({
      model: r.model,
      provider: r.provider,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
      callCount: r.call_count,
    }));
  }

  async getUsageByAgent(params: UsageQueryParams): Promise<UsageByAgent[]> {
    const { where, values } = buildWhereClause(params, "usage_records");

    const rows = this.db.prepare(`
      SELECT
        agent_id, scope,
        SUM(input_tokens)  as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(total_tokens)  as total_tokens,
        COUNT(*)           as call_count
      FROM usage_records
      ${where}
      GROUP BY agent_id, scope
      ORDER BY total_tokens DESC
    `).all(values) as Array<{
      agent_id: string; scope: string;
      input_tokens: number; output_tokens: number; total_tokens: number; call_count: number;
    }>;

    return rows.map((r) => ({
      agentId: r.agent_id,
      scope: r.scope,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
      callCount: r.call_count,
    }));
  }

  async getUsageByProvider(params: UsageQueryParams): Promise<UsageByProvider[]> {
    const { where, values } = buildWhereClause(params, "usage_records");

    const rows = this.db.prepare(`
      SELECT
        provider,
        SUM(input_tokens)          as input_tokens,
        SUM(output_tokens)         as output_tokens,
        SUM(total_tokens)          as total_tokens,
        COUNT(*)                   as call_count,
        COUNT(DISTINCT model)      as model_count
      FROM usage_records
      ${where}
      GROUP BY provider
      ORDER BY total_tokens DESC
    `).all(values) as Array<{
      provider: string;
      input_tokens: number; output_tokens: number; total_tokens: number;
      call_count: number; model_count: number;
    }>;

    return rows.map((r) => ({
      provider: r.provider,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
      callCount: r.call_count,
      modelCount: r.model_count,
    }));
  }

  // ─── Per-Run Queries ──────────────────────────────────────────────────

  async getRunMetrics(params: UsageQueryParams): Promise<RunMetric[]> {
    const { where, values } = buildWhereClause(params, "run_metrics", "completed_at");

    const limit = params.limit ?? 100;
    const rows = this.db.prepare(`
      SELECT * FROM run_metrics ${where} ORDER BY completed_at DESC LIMIT @queryLimit
    `).all({ ...values, queryLimit: limit }) as RunMetricRow[];

    return rows.map(rowToRunMetric);
  }

  async getRunMetricById(runId: string): Promise<RunMetric | null> {
    const row = this.db.prepare(`
      SELECT * FROM run_metrics WHERE run_id = @runId
    `).get({ runId }) as RunMetricRow | undefined;

    return row ? rowToRunMetric(row) : null;
  }

  async getRunAgentBreakdown(runId: string): Promise<RunAgentBreakdown> {
    const rows = this.db.prepare(`
      SELECT
        agent_id, scope, provider, model,
        SUM(input_tokens)  as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(total_tokens)  as total_tokens,
        SUM(duration_ms)   as duration_ms
      FROM usage_records
      WHERE run_id = @runId OR parent_run_id = @runId
      GROUP BY agent_id, scope
      ORDER BY total_tokens DESC
    `).all({ runId }) as Array<{
      agent_id: string; scope: string; provider: string; model: string;
      input_tokens: number; output_tokens: number; total_tokens: number; duration_ms: number;
    }>;

    // Tool call counts per agent
    const toolRows = this.db.prepare(`
      SELECT agent_id, COUNT(*) as cnt FROM tool_metrics WHERE run_id = @runId GROUP BY agent_id
    `).all({ runId }) as Array<{ agent_id: string; cnt: number }>;
    const toolMap = new Map(toolRows.map((r) => [r.agent_id, r.cnt]));

    const agents: RunAgentUsage[] = rows.map((r) => ({
      agentId: r.agent_id,
      scope: r.scope,
      provider: r.provider,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalTokens: r.total_tokens,
      toolCallCount: toolMap.get(r.agent_id) ?? 0,
      durationMs: r.duration_ms,
    }));

    return {
      runId,
      agents,
      totalInputTokens: agents.reduce((s, a) => s + a.inputTokens, 0),
      totalOutputTokens: agents.reduce((s, a) => s + a.outputTokens, 0),
      totalTokens: agents.reduce((s, a) => s + a.totalTokens, 0),
    };
  }

  async getToolMetrics(runId: string): Promise<ToolMetric[]> {
    const rows = this.db.prepare(`
      SELECT * FROM tool_metrics WHERE run_id = @runId ORDER BY created_at ASC
    `).all({ runId }) as ToolMetricRow[];

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      workspaceId: r.workspace_id,
      agentId: r.agent_id,
      toolName: r.tool_name,
      status: r.status as "success" | "error",
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
  }

  async listToolMetrics(params: ToolMetricQueryParams): Promise<ToolMetric[]> {
    const { where, values } = buildToolMetricWhereClause(params);
    const limit = params.limit ?? 1000;
    const rows = this.db.prepare(`
      SELECT * FROM tool_metrics ${where} ORDER BY created_at DESC LIMIT @queryLimit
    `).all({ ...values, queryLimit: limit }) as ToolMetricRow[];

    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      workspaceId: r.workspace_id,
      agentId: r.agent_id,
      toolName: r.tool_name,
      status: r.status as "success" | "error",
      durationMs: r.duration_ms,
      createdAt: r.created_at,
    }));
  }

  // ─── Maintenance ──────────────────────────────────────────────────────

  async purge(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let total = 0;
    const purgeAll = this.db.transaction(() => {
      total += this.db.prepare("DELETE FROM usage_records WHERE created_at < @cutoff").run({ cutoff }).changes;
      total += this.db.prepare("DELETE FROM run_metrics WHERE completed_at < @cutoff").run({ cutoff }).changes;
      total += this.db.prepare("DELETE FROM tool_metrics WHERE created_at < @cutoff").run({ cutoff }).changes;
    });
    purgeAll();
    return total;
  }
}

// ─── Query Builder ──────────────────────────────────────────────────────────

function buildWhereClause(
  params: UsageQueryParams,
  table: string,
  timeCol = "created_at",
): { where: string; values: Record<string, unknown> } {
  const conditions: string[] = [`${table}.workspace_id = @workspaceId`];
  const values: Record<string, unknown> = { workspaceId: params.workspaceId };

  if (params.agentId) {
    conditions.push(`${table}.agent_id = @agentId`);
    values.agentId = params.agentId;
  }
  if (params.provider) {
    conditions.push(`${table}.provider = @provider`);
    values.provider = params.provider;
  }
  if (params.model) {
    conditions.push(`${table}.model = @model`);
    values.model = params.model;
  }
  if (params.from) {
    conditions.push(`${table}.${timeCol} >= @fromTs`);
    values.fromTs = params.from;
  }
  if (params.to) {
    conditions.push(`${table}.${timeCol} <= @toTs`);
    values.toTs = params.to;
  }

  return {
    where: `WHERE ${conditions.join(" AND ")}`,
    values,
  };
}

function buildToolMetricWhereClause(
  params: ToolMetricQueryParams,
): { where: string; values: Record<string, unknown> } {
  const conditions: string[] = ["workspace_id = @workspaceId"];
  const values: Record<string, unknown> = { workspaceId: params.workspaceId };

  if (params.agentId) {
    conditions.push("agent_id = @agentId");
    values.agentId = params.agentId;
  }
  if (params.toolNamePrefix) {
    conditions.push("tool_name LIKE @toolNamePrefix");
    values.toolNamePrefix = `${params.toolNamePrefix}%`;
  }
  if (params.status) {
    conditions.push("status = @status");
    values.status = params.status;
  }
  if (params.from) {
    conditions.push("created_at >= @fromTs");
    values.fromTs = params.from;
  }
  if (params.to) {
    conditions.push("created_at <= @toTs");
    values.toTs = params.to;
  }

  return {
    where: `WHERE ${conditions.join(" AND ")}`,
    values,
  };
}

// ─── Row Types ──────────────────────────────────────────────────────────────

interface RunMetricRow {
  run_id: string;
  session_id: string;
  workspace_id: string;
  agent_id: string;
  provider: string;
  model: string;
  status: string;
  turns_used: number;
  coordinator_input_tokens: number;
  coordinator_output_tokens: number;
  sub_agent_input_tokens: number;
  sub_agent_output_tokens: number;
  total_tokens: number;
  tool_call_count: number;
  sub_agent_count: number;
  duration_ms: number;
  started_at: number;
  completed_at: number;
}

function rowToRunMetric(row: RunMetricRow): RunMetric {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    provider: row.provider,
    model: row.model,
    status: row.status,
    turnsUsed: row.turns_used,
    coordinatorInputTokens: row.coordinator_input_tokens,
    coordinatorOutputTokens: row.coordinator_output_tokens,
    subAgentInputTokens: row.sub_agent_input_tokens,
    subAgentOutputTokens: row.sub_agent_output_tokens,
    totalTokens: row.total_tokens,
    toolCallCount: row.tool_call_count,
    subAgentCount: row.sub_agent_count,
    durationMs: row.duration_ms,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

interface ToolMetricRow {
  id: string;
  run_id: string;
  workspace_id: string;
  agent_id: string;
  tool_name: string;
  status: string;
  duration_ms: number;
  created_at: number;
}
