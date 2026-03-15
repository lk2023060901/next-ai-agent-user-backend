import { v4 as uuidv4 } from "uuid";
import { buildToolset } from "../tools/registry.js";
import { buildModelForAgent, getLlmCandidates, resolveApiKey } from "../llm/model-factory.js";
import { runStreamLoop } from "./stream-loop.js";
export async function runExecutor(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.agentId);
    const messageId = uuidv4();
    await params.grpc.updateTask({
        taskId: params.taskId,
        status: "running",
        progress: 0,
    });
    params.emit({
        type: "message-start",
        runId: params.runId,
        messageId,
        agentId: params.agentId,
    });
    const tools = buildToolset({
        runId: params.runId,
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        agentId: params.agentId,
        depth: params.depth,
        sandbox: params.sandbox,
        emit: params.emit,
        grpc: params.grpc,
        agentConfigModel: agentCfg.model,
    });
    let fullText = "";
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const llmCandidates = getLlmCandidates(agentCfg);
    try {
        const candidates = llmCandidates.length > 0 ? llmCandidates : [undefined];
        let streamError = null;
        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            fullText = "";
            try {
                const model = buildModelForAgent(agentCfg, candidate);
                const apiKey = resolveApiKey(agentCfg, candidate ?? undefined);
                // Build system prompt with optional context slice from parent
                let systemPrompt = agentCfg.systemPrompt || "";
                if (params.contextSlice) {
                    const sliceParts = [];
                    if (params.contextSlice.summary) {
                        sliceParts.push(`## Parent Context\n${params.contextSlice.summary}`);
                    }
                    if (params.contextSlice.relevantFacts?.length) {
                        sliceParts.push(`## Relevant Facts\n${params.contextSlice.relevantFacts.map((f) => `- ${f}`).join("\n")}`);
                    }
                    if (params.contextSlice.constraints) {
                        sliceParts.push(`## Constraints\n${params.contextSlice.constraints}`);
                    }
                    if (sliceParts.length > 0) {
                        systemPrompt = `${systemPrompt}\n\n${sliceParts.join("\n\n")}`;
                    }
                }
                const result = await runStreamLoop({
                    model,
                    systemPrompt,
                    userMessage: params.instruction,
                    tools,
                    maxSteps: params.sandbox.maxTurns,
                    apiKey,
                    emit: params.emit,
                    runId: params.runId,
                    messageId,
                });
                fullText = result.fullText;
                totalUsage = result.usage;
                streamError = null;
                break;
            }
            catch (err) {
                streamError = err;
                const errorMessage = err instanceof Error ? err.message : String(err);
                const hasNextCandidate = index + 1 < candidates.length;
                if (hasNextCandidate && fullText.trim().length === 0) {
                    console.warn(`[executor] model failed before streaming, retrying fallback (${index + 1}/${candidates.length})`, {
                        runId: params.runId,
                        taskId: params.taskId,
                        agentId: params.agentId,
                        provider: candidate?.llmProviderType ?? agentCfg.llmProviderType,
                        model: candidate?.model ?? agentCfg.model,
                        error: errorMessage,
                    });
                    continue;
                }
                break;
            }
        }
        if (streamError) {
            throw streamError;
        }
        params.emit({
            type: "usage",
            runId: params.runId,
            messageId,
            taskId: params.taskId,
            agentId: params.agentId,
            scope: "sub_agent",
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            totalTokens: totalUsage.totalTokens,
        });
        try {
            await params.grpc.recordTaskUsage({
                taskId: params.taskId,
                inputTokens: totalUsage.inputTokens,
                outputTokens: totalUsage.outputTokens,
                totalTokens: totalUsage.totalTokens,
            });
        }
        catch {
            // best effort
        }
        await params.grpc.updateTask({
            taskId: params.taskId,
            status: "completed",
            progress: 100,
            result: fullText,
        });
        if (fullText.trim().length > 0) {
            try {
                await params.grpc.appendMessage({
                    runId: params.runId,
                    role: "assistant",
                    content: fullText,
                    agentId: params.agentId,
                });
            }
            catch {
                // best effort — task-complete must always fire
            }
        }
        params.emit({
            type: "task-complete",
            runId: params.runId,
            messageId,
            taskId: params.taskId,
            result: fullText,
        });
        return { result: fullText };
    }
    catch (err) {
        params.emit({
            type: "usage",
            runId: params.runId,
            messageId,
            taskId: params.taskId,
            agentId: params.agentId,
            scope: "sub_agent",
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            totalTokens: totalUsage.totalTokens,
        });
        try {
            await params.grpc.recordTaskUsage({
                taskId: params.taskId,
                inputTokens: totalUsage.inputTokens,
                outputTokens: totalUsage.outputTokens,
                totalTokens: totalUsage.totalTokens,
            });
        }
        catch {
            // best effort
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (fullText.trim().length > 0) {
            try {
                await params.grpc.appendMessage({
                    runId: params.runId,
                    role: "assistant",
                    content: fullText,
                    agentId: params.agentId,
                });
            }
            catch {
                // best effort
            }
        }
        await params.grpc.updateTask({
            taskId: params.taskId,
            status: "failed",
            progress: 0,
            result: msg,
        });
        params.emit({
            type: "task-failed",
            runId: params.runId,
            messageId,
            taskId: params.taskId,
            error: msg,
        });
        return { result: `Error: ${msg}` };
    }
}
