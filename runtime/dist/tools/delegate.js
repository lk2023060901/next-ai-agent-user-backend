import { Type } from "@sinclair/typebox";
import { narrowForSubagent } from "../policy/tool-policy.js";
const DelegateToolParams = Type.Object({
    agentId: Type.String({ description: "Target agent ID to delegate to" }),
    instruction: Type.String({ description: "Detailed task instruction for the sub-agent" }),
    contextSlice: Type.Optional(Type.Object({
        summary: Type.Optional(Type.String({ description: "A concise summary of relevant prior context the sub-agent should know" })),
        relevantFacts: Type.Optional(Type.Array(Type.String(), { description: "Key facts or data points relevant to the sub-task" })),
        constraints: Type.Optional(Type.String({ description: "Specific constraints or requirements for this sub-task" })),
    }, { description: "Optional context slice to provide the sub-agent with focused, relevant context from the current conversation" })),
});
export function makeDelegateTool(params) {
    return {
        name: "delegate_to_agent",
        description: "Delegate a subtask to a specialized sub-agent and return its result",
        parameters: DelegateToolParams,
        category: "agent",
        riskLevel: "medium",
        execute: async ({ agentId, instruction, contextSlice }) => {
            if (params.depth >= params.sandbox.maxSpawnDepth) {
                return {
                    error: `Max spawn depth (${params.sandbox.maxSpawnDepth}) reached — cannot delegate further`,
                };
            }
            params.emit({ type: "agent-switch", runId: params.runId, agentId });
            const { taskId } = await params.grpc.createTask({
                runId: params.runId,
                agentId,
                instruction,
                depth: params.depth + 1,
                parentTaskId: params.taskId,
            });
            params.emit({ type: "agent-switch", runId: params.runId, agentId, taskId });
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
                workspaceId: params.workspaceId,
                depth: params.depth + 1,
                sandbox: narrowedSandbox,
                emit: params.emit,
                grpc: params.grpc,
                contextSlice: contextSlice ?? undefined,
            });
            return result;
        },
    };
}
