import { streamText } from "ai";
import { v4 as uuidv4 } from "uuid";
import { buildToolset } from "../tools/registry.js";
import { buildModelForAgent, getLlmCandidates } from "../llm/model-factory.js";
export async function runExecutor(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.agentId);
    const messageId = uuidv4();
    const pendingToolCalls = new Map();
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
    let result = null;
    const llmCandidates = getLlmCandidates(agentCfg);
    const resolveUsage = async () => {
        if (!result)
            return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        try {
            const usage = await result.usage;
            const inputTokens = Math.max(0, usage.promptTokens ?? 0);
            const outputTokens = Math.max(0, usage.completionTokens ?? 0);
            const totalTokens = Math.max(0, usage.totalTokens ?? (inputTokens + outputTokens));
            return { inputTokens, outputTokens, totalTokens };
        }
        catch {
            return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
        }
    };
    try {
        const candidates = llmCandidates.length > 0 ? llmCandidates : [undefined];
        let streamError = null;
        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            let emittedStreamData = false;
            fullText = "";
            pendingToolCalls.clear();
            try {
                result = streamText({
                    model: buildModelForAgent(agentCfg, candidate),
                    system: agentCfg.systemPrompt || undefined,
                    messages: [{ role: "user", content: params.instruction }],
                    tools: Object.keys(tools).length > 0 ? tools : undefined,
                    maxSteps: params.sandbox.maxTurns,
                });
                for await (const chunk of result.fullStream) {
                    const c = chunk;
                    if (c.type === "text-delta" && c.textDelta !== undefined) {
                        emittedStreamData = true;
                        fullText += c.textDelta;
                        params.emit({
                            type: "text-delta",
                            runId: params.runId,
                            messageId,
                            text: c.textDelta,
                            delta: c.textDelta,
                        });
                    }
                    else if (c.type === "reasoning-delta") {
                        const text = c.textDelta ?? c.text ?? c.reasoning ?? "";
                        if (text) {
                            emittedStreamData = true;
                            params.emit({
                                type: "reasoning-delta",
                                runId: params.runId,
                                messageId,
                                text,
                                delta: text,
                            });
                        }
                    }
                    else if (c.type === "reasoning") {
                        const text = c.text ?? c.reasoning ?? "";
                        if (text) {
                            emittedStreamData = true;
                            params.emit({ type: "reasoning", runId: params.runId, messageId, text });
                        }
                    }
                    else if (c.type === "tool-call") {
                        emittedStreamData = true;
                        const toolName = c.toolName ?? "unknown_tool";
                        const toolCallId = c.toolCallId ?? uuidv4();
                        const queue = pendingToolCalls.get(toolName) ?? [];
                        queue.push(toolCallId);
                        pendingToolCalls.set(toolName, queue);
                        params.emit({
                            type: "tool-call",
                            runId: params.runId,
                            messageId,
                            toolCallId,
                            toolName,
                            args: c.args ?? {},
                        });
                    }
                    else if (c.type === "tool-result") {
                        emittedStreamData = true;
                        const toolName = c.toolName ?? "unknown_tool";
                        const queue = pendingToolCalls.get(toolName);
                        const queuedToolCallId = queue && queue.length > 0 ? queue.shift() : undefined;
                        if (queue && queue.length === 0)
                            pendingToolCalls.delete(toolName);
                        params.emit({
                            type: "tool-result",
                            runId: params.runId,
                            messageId,
                            toolCallId: c.toolCallId ?? queuedToolCallId,
                            toolName,
                            result: c.result ?? "",
                            status: "success",
                        });
                    }
                }
                streamError = null;
                break;
            }
            catch (err) {
                streamError = err;
                const errorMessage = err instanceof Error ? err.message : String(err);
                const hasNextCandidate = index + 1 < candidates.length;
                if (hasNextCandidate && !emittedStreamData && fullText.trim().length === 0) {
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
        const usage = await resolveUsage();
        params.emit({
            type: "usage",
            runId: params.runId,
            messageId,
            taskId: params.taskId,
            agentId: params.agentId,
            scope: "sub_agent",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
        });
        try {
            await params.grpc.recordTaskUsage({
                taskId: params.taskId,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
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
            await params.grpc.appendMessage({
                runId: params.runId,
                role: "assistant",
                content: fullText,
                agentId: params.agentId,
            });
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
        const usage = await resolveUsage();
        params.emit({
            type: "usage",
            runId: params.runId,
            messageId,
            taskId: params.taskId,
            agentId: params.agentId,
            scope: "sub_agent",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
        });
        try {
            await params.grpc.recordTaskUsage({
                taskId: params.taskId,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
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
