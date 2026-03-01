import { grpcClient } from "../grpc/client.js";
import { buildSandboxFromAgentConfig } from "../policy/sandbox.js";
import { runCoordinator } from "./coordinator.js";
export async function runChannelRequest(input) {
    const { runId } = await grpcClient.createRun({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        userRequest: input.message,
        coordinatorAgentId: input.agentId,
    });
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
        await runCoordinator({
            runId,
            workspaceId: input.workspaceId,
            coordinatorAgentId: input.agentId,
            userMessage: input.message,
            sandbox,
            emit,
            grpc: grpcClient,
        });
        await grpcClient.updateRunStatus(runId, "completed");
    }
    catch (err) {
        try {
            await grpcClient.updateRunStatus(runId, "failed");
        }
        catch {
            // best effort
        }
        throw err;
    }
    return { runId, replyText: replyText.trim() };
}
