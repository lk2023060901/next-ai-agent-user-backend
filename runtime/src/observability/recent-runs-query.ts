import type { RuntimeServices } from "../bootstrap.js";
import type { RunMetric } from "../db/observability-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface LoadRecentRunMetricsParams {
  services: RuntimeServices;
  workspaceId: string;
  days: number;
  status?: string;
  limit?: number;
  nowMs?: number;
}

export async function loadRecentRunMetrics(
  params: LoadRecentRunMetricsParams,
): Promise<RunMetric[]> {
  if (!params.services.db) return [];

  const safeDays = Math.max(1, Math.min(90, Math.floor(params.days || 7)));
  const safeLimit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 10)));
  const now = params.nowMs ?? Date.now();
  const normalizedStatus = params.status?.trim().toLowerCase();

  const metrics = await params.services.db.observabilityStore.getRunMetrics({
    workspaceId: params.workspaceId,
    from: now - safeDays * DAY_MS,
    to: now,
    limit: normalizedStatus ? Math.max(safeLimit * 5, 50) : safeLimit,
  });

  const filtered = normalizedStatus
    ? metrics.filter((metric) => metric.status.toLowerCase() === normalizedStatus)
    : metrics;

  return filtered.slice(0, safeLimit);
}
