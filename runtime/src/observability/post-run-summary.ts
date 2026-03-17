import type { ToolMetric } from "../db/observability-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const POST_RUN_PREFIX = "post_run:";

export interface PostRunFailureDay {
  date: string;
  failures: number;
}

export interface PostRunFailureStage {
  stage: string;
  failures: number;
  avgDurationMs: number;
  lastSeenAt: number;
}

export interface PostRunFailureSummary {
  totalFailures: number;
  daily: PostRunFailureDay[];
  stages: PostRunFailureStage[];
}

export function summarizePostRunFailures(
  metrics: ToolMetric[],
  days: number,
  nowMs = Date.now(),
): PostRunFailureSummary {
  const safeDays = Math.max(1, Math.min(90, Math.floor(days || 7)));
  const daily = buildDailyBuckets(safeDays, nowMs);
  const dailyIndex = new Map(daily.map((item, index) => [item.date, index]));
  const stageMap = new Map<
    string,
    { failures: number; totalDurationMs: number; lastSeenAt: number }
  >();

  for (const metric of metrics) {
    if (!metric.toolName.startsWith(POST_RUN_PREFIX) || metric.status !== "error") continue;

    const dayKey = toDateKey(metric.createdAt);
    const dayIndex = dailyIndex.get(dayKey);
    if (dayIndex != null) {
      daily[dayIndex]!.failures += 1;
    }

    const stage = metric.toolName.slice(POST_RUN_PREFIX.length);
    const current = stageMap.get(stage) ?? {
      failures: 0,
      totalDurationMs: 0,
      lastSeenAt: 0,
    };
    current.failures += 1;
    current.totalDurationMs += metric.durationMs;
    current.lastSeenAt = Math.max(current.lastSeenAt, metric.createdAt);
    stageMap.set(stage, current);
  }

  const stages = Array.from(stageMap.entries())
    .map(([stage, item]) => ({
      stage,
      failures: item.failures,
      avgDurationMs: Math.round(item.totalDurationMs / item.failures),
      lastSeenAt: item.lastSeenAt,
    }))
    .sort((a, b) => {
      if (b.failures !== a.failures) return b.failures - a.failures;
      return b.lastSeenAt - a.lastSeenAt;
    });

  return {
    totalFailures: stages.reduce((sum, item) => sum + item.failures, 0),
    daily,
    stages,
  };
}

function buildDailyBuckets(days: number, nowMs: number): PostRunFailureDay[] {
  const todayUtc = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );

  return Array.from({ length: days }, (_, index) => {
    const offset = days - index - 1;
    const date = toDateKey(todayUtc - offset * DAY_MS);
    return { date, failures: 0 };
  });
}

function toDateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}
