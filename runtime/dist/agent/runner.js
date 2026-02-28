import { grpcClient } from "../grpc/client.js";
import { buildSandboxFromAgentConfig } from "../policy/sandbox.js";
import { getChannel } from "../sse/emitter.js";
import { runCoordinator } from "./coordinator.js";
/**
 * Entry point — called after runId has been created via gRPC and the SSE channel is registered.
 * Runs the coordinator loop in the background; the SSE stream delivers events in real time.
 */
export async function startRun(req) {
    const emit = getChannel(req.runId);
    if (!emit) {
        throw new Error(`No SSE channel registered for runId: ${req.runId}`);
    }
    try {
        await grpcClient.updateRunStatus(req.runId, "running");
        const agentCfg = await grpcClient.getAgentConfig(req.coordinatorAgentId);
        const sandbox = buildSandboxFromAgentConfig(agentCfg);
        await runCoordinator({
            runId: req.runId,
            coordinatorAgentId: req.coordinatorAgentId,
            userMessage: req.userRequest,
            sandbox,
            emit,
            grpc: grpcClient,
        });
        await grpcClient.updateRunStatus(req.runId, "completed");
        emit({ type: "done", runId: req.runId });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            await grpcClient.updateRunStatus(req.runId, "failed");
        }
        catch {
            // best effort
        }
        emit({ type: "error", runId: req.runId, message: msg });
        emit({ type: "done", runId: req.runId });
        throw err;
    }
}
