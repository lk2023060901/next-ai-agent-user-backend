import { grpcClient } from "../grpc/client.js";
import { buildSandboxFromAgentConfig } from "../policy/sandbox.js";
import { getRuntimeServices } from "../bootstrap.js";
import { runCoordinator } from "./coordinator.js";
import { resolveTerminalRunStatus } from "./run-status.js";
/**
 * Execute a channel run through the orchestrator with "channel" lane.
 * Falls back to direct execution if orchestrator is not provided.
 */
export async function runChannelRequest(input, deps) {
    const { runId } = await grpcClient.createRun({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userRequest: input.message,
        coordinatorAgentId: input.agentId,
    });
    if (deps) {
        // Orchestrated path — uses "channel" lane for concurrency control
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
            userRequest: input.message,
            lane: "channel",
        });
        return { runId, replyText: result.fullText.trim() };
    }
    // Direct execution fallback (no orchestrator)
    let replyText = "";
    const emit = (event) => {
        if (event.type === "text-delta") {
            replyText += event.text;
        }
    };
    await grpcClient.updateRunStatus(runId, "running");
    try {
        const agentCfg = await grpcClient.getAgentConfig(input.agentId);
        const sandbox = buildSandboxFromAgentConfig(agentCfg);
        const services = getRuntimeServices();
        await runCoordinator({
            runId,
            workspaceId: input.workspaceId,
            coordinatorAgentId: input.agentId,
            userMessage: input.message,
            sandbox,
            emit,
            grpc: grpcClient,
            memoryManager: services.memoryManager ?? undefined,
            embeddingService: services.embedding ?? undefined,
            setMemoryProvider: services.setMemoryProvider,
            sessionId: input.sessionId,
            sessionStore: services.sessionStore ?? undefined,
            observabilityStore: services.db?.observabilityStore,
        });
        await grpcClient.updateRunStatus(runId, "completed");
    }
    catch (err) {
        const nextStatus = resolveTerminalRunStatus(err);
        try {
            await grpcClient.updateRunStatus(runId, nextStatus);
        }
        catch {
            // best effort
        }
        throw err;
    }
    return { runId, replyText: replyText.trim() };
}
