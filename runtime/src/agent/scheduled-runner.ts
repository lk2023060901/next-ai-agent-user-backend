import { grpcClient } from "../grpc/client.js";
import type { Orchestrator } from "../orchestrator/orchestrator-types.js";
import type { EventBus } from "../events/event-types.js";

export interface ScheduledRunInput {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  instruction: string;
  executionId: string;
}

export interface ScheduledRunResult {
  runId: string;
  status: string;
  resultSummary: string;
}

/**
 * Execute a scheduled task through the orchestrator with "scheduled" lane.
 * Similar to channel-runner but designed for cron/scheduled task executions.
 */
export async function runScheduledTask(
  input: ScheduledRunInput,
  deps: { orchestrator: Orchestrator; eventBus: EventBus },
): Promise<ScheduledRunResult> {
  const { runId } = await grpcClient.createRun({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    userRequest: input.instruction,
    coordinatorAgentId: input.agentId,
  });

  deps.eventBus.registerRun(runId, {
    sessionId: input.sessionId,
    coordinatorAgentId: input.agentId,
    workspaceId: input.workspaceId,
  });

  const result = await deps.orchestrator.executeAndAwait({
    runId,
    sessionKey: input.sessionId,
    workspaceId: input.workspaceId,
    coordinatorAgentId: input.agentId,
    userRequest: input.instruction,
    lane: "scheduled",
  });

  return {
    runId,
    status: result.status,
    resultSummary: result.fullText.trim().slice(0, 2000),
  };
}
