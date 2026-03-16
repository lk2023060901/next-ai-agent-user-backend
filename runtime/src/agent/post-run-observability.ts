import { v4 as uuidv4 } from "uuid";
import type { ObservabilityStore } from "../db/observability-types.js";

interface RecordPostRunFailureParams {
  observabilityStore?: ObservabilityStore;
  runId: string;
  workspaceId: string;
  agentId: string;
  stage:
    | "post_run:episodic_ingest"
    | "post_run:semantic_extraction"
    | "post_run:entity_extraction"
    | "post_run:reflection"
    | "post_run:consolidation"
    | "post_run:decay_update"
    | "post_run:history_compaction";
  startedAt: number;
}

export async function recordPostRunFailure(
  params: RecordPostRunFailureParams,
): Promise<void> {
  if (!params.observabilityStore) return;

  await params.observabilityStore.recordToolMetric({
    id: uuidv4(),
    runId: params.runId,
    workspaceId: params.workspaceId,
    agentId: params.agentId,
    toolName: params.stage,
    status: "error",
    durationMs: Math.max(0, Date.now() - params.startedAt),
    createdAt: Date.now(),
  });
}
