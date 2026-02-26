import { tool } from "ai";
import { z } from "zod";
import { narrowForSubagent } from "../policy/tool-policy.js";
export function makeDelegateTool(params) {
    return tool({
        description: "Delegate a subtask to a specialized sub-agent and return its result",
        parameters: z.object({
            agentId: z.string().describe("Target agent ID to delegate to"),
            instruction: z.string().describe("Detailed task instruction for the sub-agent"),
        }),
        execute: async ({ agentId, instruction }) => {
            if (params.depth >= params.sandbox.maxSpawnDepth) {
                return {
                    error: `Max spawn depth (${params.sandbox.maxSpawnDepth}) reached — cannot delegate further`,
                };
            }
            params.emit({ type: "agent-switch", agentId });
            const { taskId } = await params.grpc.createTask({
                runId: params.runId,
                agentId,
                instruction,
                depth: params.depth + 1,
                parentTaskId: params.taskId,
            });
            params.emit({ type: "agent-switch", agentId, taskId });
            // Lazy import to avoid circular dependency: delegate → executor → delegate
            const { runExecutor } = await import("../agent/executor.js");
            const narrowedSandbox = {
                ...params.sandbox,
                toolPolicy: narrowForSubagent(params.sandbox.toolPolicy, params.depth + 1, params.sandbox.maxSpawnDepth),
            };
            const result = await runExecutor({
                agentId,
                instruction,
                taskId,
                runId: params.runId,
                depth: params.depth + 1,
                sandbox: narrowedSandbox,
                emit: params.emit,
                grpc: params.grpc,
            });
            return result;
        },
    });
}
