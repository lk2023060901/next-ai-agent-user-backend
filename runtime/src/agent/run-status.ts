export type TerminalRunStatus = "failed" | "cancelled";

export function resolveTerminalRunStatus(
  err: unknown,
  options?: { abortSignal?: AbortSignal },
): TerminalRunStatus {
  if (options?.abortSignal?.aborted) {
    return "cancelled";
  }
  if (err instanceof Error && err.name === "AbortError") {
    return "cancelled";
  }
  return "failed";
}
