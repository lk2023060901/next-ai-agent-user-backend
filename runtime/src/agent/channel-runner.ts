import { grpcClient } from "../grpc/client.js";
import { buildSandboxFromAgentConfig } from "../policy/sandbox.js";
import type { SseEvent } from "../sse/emitter.js";
import { runCoordinator } from "./coordinator.js";

export interface ChannelRunInput {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  message: string;
}

export interface ChannelRunResult {
  runId: string;
  replyText: string;
}

export async function runChannelRequest(input: ChannelRunInput): Promise<ChannelRunResult> {
  const { runId } = await grpcClient.createRun({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    userRequest: input.message,
    coordinatorAgentId: input.agentId,
  });

  let replyText = "";
  const emit = (event: SseEvent) => {
    if (event.type === "text-delta") {
      replyText += event.text;
    }
  };

  await grpcClient.updateRunStatus(runId, "running");

  try {
    const agentCfg = await grpcClient.getAgentConfig(input.agentId);
    const sandbox = buildSandboxFromAgentConfig(agentCfg);

    await runCoordinator({
      runId,
      coordinatorAgentId: input.agentId,
      userMessage: input.message,
      sandbox,
      emit,
      grpc: grpcClient,
    });

    await grpcClient.updateRunStatus(runId, "completed");
  } catch (err) {
    try {
      await grpcClient.updateRunStatus(runId, "failed");
    } catch {
      // best effort
    }
    throw err;
  }

  return { runId, replyText: replyText.trim() };
}
