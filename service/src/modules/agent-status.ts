export const CANONICAL_AGENT_STATUSES = [
  "idle",
  "running",
  "paused",
  "error",
  "completed",
] as const;

export type CanonicalAgentStatus = (typeof CANONICAL_AGENT_STATUSES)[number];

const CANONICAL_STATUS_SET = new Set<string>(CANONICAL_AGENT_STATUSES);

export function isCanonicalAgentStatus(status: unknown): status is CanonicalAgentStatus {
  const raw = String(status ?? "").trim().toLowerCase();
  return CANONICAL_STATUS_SET.has(raw);
}

export function canStartAgentRun(status: unknown): boolean {
  if (!isCanonicalAgentStatus(status)) return false;
  return status !== "paused";
}

export function mapRunStatusToAgentStatus(status: unknown): CanonicalAgentStatus {
  const runStatus = String(status ?? "").trim().toLowerCase();
  switch (runStatus) {
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "error";
    case "cancelled":
    case "canceled":
      return "idle";
    default:
      return "idle";
  }
}
