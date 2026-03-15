import { grpcClient } from "../grpc/client.js";
import { buildSandboxFromAgentConfig } from "../policy/sandbox.js";
import type { SseEmitter } from "../sse/emitter.js";
import { runCoordinator } from "./coordinator.js";
import { getRuntimeServices } from "../bootstrap.js";
import { resolveTerminalRunStatus } from "./run-status.js";

export interface RunRequest {
  runId: string;
  sessionId: string;
  workspaceId: string;
  userRequest: string;
  coordinatorAgentId: string;
  startCandidateOffset?: number;
  modelIdOverride?: string;
  abortSignal?: AbortSignal;
}

/**
 * Entry point — called after runId has been created via gRPC.
 * Runs the coordinator loop in the background; runtime run-store is responsible
 * for dispatching and replaying stream events to connected clients.
 */
export async function startRun(req: RunRequest, emit: SseEmitter): Promise<void> {
  try {
    await grpcClient.updateRunStatus(req.runId, "running");

    const agentCfg = await grpcClient.getAgentConfig(req.coordinatorAgentId, req.modelIdOverride);
    const sandbox = buildSandboxFromAgentConfig(agentCfg);
    const services = getRuntimeServices();

    await runCoordinator({
      runId: req.runId,
      workspaceId: req.workspaceId,
      coordinatorAgentId: req.coordinatorAgentId,
      userMessage: req.userRequest,
      startCandidateOffset: req.startCandidateOffset,
      modelIdOverride: req.modelIdOverride,
      sandbox,
      emit,
      grpc: grpcClient,
      memoryManager: services.memoryManager ?? undefined,
      embeddingService: services.embedding ?? undefined,
      setMemoryProvider: services.setMemoryProvider,
      sessionId: req.sessionId,
      sessionStore: services.sessionStore ?? undefined,
      abortSignal: req.abortSignal,
    });

    await grpcClient.updateRunStatus(req.runId, "completed");
    emit({ type: "done", runId: req.runId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const nextStatus = resolveTerminalRunStatus(err, { abortSignal: req.abortSignal });
    try {
      await grpcClient.updateRunStatus(req.runId, nextStatus);
    } catch {
      // best effort
    }
    emit({ type: "error", runId: req.runId, message: msg });
    emit({ type: "done", runId: req.runId });
  }
}
