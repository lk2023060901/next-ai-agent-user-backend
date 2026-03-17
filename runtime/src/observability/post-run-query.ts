import type { RuntimeServices } from "../bootstrap.js";
import { summarizePostRunFailures, type PostRunFailureSummary } from "./post-run-summary.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PostRunFailureDetail {
  id: string;
  runId: string;
  agentId: string;
  stage: string;
  durationMs: number;
  createdAt: number;
}

interface LoadPostRunFailureSummaryParams {
  services: RuntimeServices;
  workspaceId: string;
  days: number;
  nowMs?: number;
}

export async function loadPostRunFailureSummary(
  params: LoadPostRunFailureSummaryParams,
): Promise<PostRunFailureSummary> {
  const safeDays = normalizeDays(params.days);
  const now = params.nowMs ?? Date.now();

  if (!params.services.db) {
    return summarizePostRunFailures([], safeDays, now);
  }

  const metrics = await params.services.db.observabilityStore.listToolMetrics({
    workspaceId: params.workspaceId,
    toolNamePrefix: "post_run:",
    status: "error",
    from: now - safeDays * DAY_MS,
    to: now,
    limit: 5000,
  });

  return summarizePostRunFailures(metrics, safeDays, now);
}

interface LoadPostRunFailureDetailsParams {
  services: RuntimeServices;
  workspaceId: string;
  stage: string;
  days: number;
  limit?: number;
  nowMs?: number;
}

export async function loadPostRunFailureDetails(
  params: LoadPostRunFailureDetailsParams,
): Promise<PostRunFailureDetail[]> {
  const safeDays = normalizeDays(params.days);
  const now = params.nowMs ?? Date.now();
  const safeStage = params.stage.trim();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(params.limit ?? 20)));

  if (!safeStage || !params.services.db) return [];

  const metrics = await params.services.db.observabilityStore.listToolMetrics({
    workspaceId: params.workspaceId,
    toolNamePrefix: `post_run:${safeStage}`,
    status: "error",
    from: now - safeDays * DAY_MS,
    to: now,
    limit: safeLimit,
  });

  return metrics.map((metric) => ({
    id: metric.id,
    runId: metric.runId,
    agentId: metric.agentId,
    stage: metric.toolName.slice("post_run:".length),
    durationMs: metric.durationMs,
    createdAt: metric.createdAt,
  }));
}

function normalizeDays(days: number): number {
  return Math.max(1, Math.min(90, Math.floor(days || 7)));
}
