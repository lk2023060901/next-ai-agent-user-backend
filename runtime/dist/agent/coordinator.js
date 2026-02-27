import { streamText } from "ai";
import { v4 as uuidv4 } from "uuid";
import { makeDelegateTool } from "../tools/delegate.js";
import { isToolAllowed } from "../policy/tool-policy.js";
import { buildModelForAgent } from "../llm/model-factory.js";
export async function runCoordinator(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.coordinatorAgentId);
    let fullText = "";
    params.emit({ type: "message-start", agentId: params.coordinatorAgentId });
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
                params.emit({ type: "text-delta", text: c.textDelta });
            }
            else if (c.type === "reasoning-delta") {
                const text = c.textDelta ?? c.text ?? c.reasoning ?? "";
                if (text)
                    params.emit({ type: "reasoning-delta", text });
            }
            else if (c.type === "reasoning") {
                const text = c.text ?? c.reasoning ?? "";
                if (text)
                    params.emit({ type: "reasoning", text });
            }
            else if (c.type === "tool-call") {
                params.emit({ type: "tool-call", toolName: c.toolName, args: c.args });
            }
            else if (c.type === "tool-result") {
                params.emit({ type: "tool-result", toolName: c.toolName, result: c.result });
            }
            else if (c.type === "error") {
                throw new Error(String(c.error));
            }
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        params.emit({ type: "task-failed", taskId: params.runId, error: msg });
        params.emit({ type: "message-end", runId: params.runId });
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
    params.emit({ type: "message-end", runId: params.runId });
}
