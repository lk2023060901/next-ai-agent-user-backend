import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { v4 as uuidv4 } from "uuid";
import { config } from "../config.js";
import { makeDelegateTool } from "../tools/delegate.js";
import { isToolAllowed } from "../policy/tool-policy.js";
export async function runCoordinator(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.coordinatorAgentId);
    params.emit({ type: "message-start", agentId: params.coordinatorAgentId });
    const llm = createOpenAI({
        baseURL: `${config.bifrostAddr}/v1`,
        apiKey: "runtime",
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
    const result = streamText({
        model: llm(agentCfg.model),
        system: agentCfg.systemPrompt || undefined,
        messages: [{ role: "user", content: params.userMessage }],
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxSteps: params.sandbox.maxTurns,
    });
    for await (const chunk of result.fullStream) {
        const c = chunk;
        if (c.type === "text-delta" && c.textDelta !== undefined) {
            params.emit({ type: "text-delta", text: c.textDelta });
        }
        else if (c.type === "tool-call") {
            params.emit({ type: "tool-call", toolName: c.toolName, args: c.args });
        }
        else if (c.type === "tool-result") {
            params.emit({ type: "tool-result", toolName: c.toolName, result: c.result });
        }
    }
    params.emit({ type: "message-end", runId: params.runId });
}
