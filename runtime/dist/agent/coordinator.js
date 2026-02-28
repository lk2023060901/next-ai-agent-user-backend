import { streamText } from "ai";
import { v4 as uuidv4 } from "uuid";
import { makeDelegateTool } from "../tools/delegate.js";
import { isToolAllowed } from "../policy/tool-policy.js";
import { buildModelForAgent } from "../llm/model-factory.js";
export async function runCoordinator(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.coordinatorAgentId);
    let fullText = "";
    const messageId = uuidv4();
    const pendingToolCalls = new Map();
    params.emit({
        type: "message-start",
        runId: params.runId,
        messageId,
        agentId: params.coordinatorAgentId,
    });
    const rootTaskId = uuidv4();
    const tools = {};
    if (isToolAllowed("delegate_to_agent", params.sandbox.toolPolicy)) {
        tools["delegate_to_agent"] = makeDelegateTool({
            runId: params.runId,
            taskId: rootTaskId,
            depth: 0,
            sandbox: params.sandbox,
            emit: params.emit,
            grpc: params.grpc,
            agentConfigModel: agentCfg.model,
        });
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = streamText({
        model: buildModelForAgent(agentCfg),
        system: agentCfg.systemPrompt || undefined,
        messages: [{ role: "user", content: params.userMessage }],
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxSteps: params.sandbox.maxTurns,
    });
    try {
        for await (const chunk of result.fullStream) {
            const c = chunk;
            if (c.type === "text-delta" && c.textDelta !== undefined) {
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
                if (text)
                    params.emit({ type: "reasoning", runId: params.runId, messageId, text });
            }
            else if (c.type === "tool-call") {
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
            else if (c.type === "error") {
                throw new Error(String(c.error));
            }
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        params.emit({ type: "task-failed", runId: params.runId, messageId, taskId: params.runId, error: msg });
        params.emit({ type: "message-end", runId: params.runId, messageId });
        throw err;
    }
    if (fullText.trim().length > 0) {
        await params.grpc.appendMessage({
            runId: params.runId,
            role: "assistant",
            content: fullText,
            agentId: params.coordinatorAgentId,
        });
    }
    params.emit({ type: "message-end", runId: params.runId, messageId });
}
