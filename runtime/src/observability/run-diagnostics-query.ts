import type { RuntimeServices } from "../bootstrap.js";
import type { RunAgentBreakdown, RunMetric, ToolMetric } from "../db/observability-types.js";

export interface RuntimeRunDiagnostics {
  metric: RunMetric;
  breakdown: RunAgentBreakdown;
  toolMetrics: ToolMetric[];
}

interface LoadRuntimeRunDiagnosticsParams {
  services: RuntimeServices;
  workspaceId: string;
  runId: string;
}

export async function loadRuntimeRunDiagnostics(
  params: LoadRuntimeRunDiagnosticsParams,
): Promise<RuntimeRunDiagnostics | null> {
  const runId = params.runId.trim();
  if (!runId || !params.services.db) return null;

  const metric = await params.services.db.observabilityStore.getRunMetricById(runId);
  if (!metric || metric.workspaceId !== params.workspaceId) return null;

  const [breakdown, toolMetrics] = await Promise.all([
    params.services.db.observabilityStore.getRunAgentBreakdown(runId),
    params.services.db.observabilityStore.getToolMetrics(runId),
  ]);

  return {
    metric,
    breakdown,
    toolMetrics,
  };
}
