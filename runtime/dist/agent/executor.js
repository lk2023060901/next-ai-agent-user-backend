import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { config } from "../config.js";
import { buildToolset } from "../tools/registry.js";
export async function runExecutor(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.agentId);
    await params.grpc.updateTask({
        taskId: params.taskId,
        status: "running",
        progress: 0,
    });
    params.emit({ type: "message-start", agentId: params.agentId });
    const llm = createOpenAI({
        baseURL: `${config.bifrostAddr}/v1`,
        apiKey: "runtime",
    });
    const tools = buildToolset({
        runId: params.runId,
        taskId: params.taskId,
        depth: params.depth,
        sandbox: params.sandbox,
        emit: params.emit,
        grpc: params.grpc,
        agentConfigModel: agentCfg.model,
    });
    let fullText = "";
    try {
        const result = streamText({
            model: llm(agentCfg.model),
            system: agentCfg.systemPrompt || undefined,
            messages: [{ role: "user", content: params.instruction }],
            tools: Object.keys(tools).length > 0 ? tools : undefined,
            maxSteps: params.sandbox.maxTurns,
        });
        for await (const chunk of result.fullStream) {
            const c = chunk;
            if (c.type === "text-delta" && c.textDelta !== undefined) {
                fullText += c.textDelta;
                params.emit({ type: "text-delta", text: c.textDelta });
            }
            else if (c.type === "tool-call") {
                params.emit({ type: "tool-call", toolName: c.toolName, args: c.args });
            }
            else if (c.type === "tool-result") {
                params.emit({ type: "tool-result", toolName: c.toolName, result: c.result });
            }
        }
        await params.grpc.updateTask({
            taskId: params.taskId,
            status: "completed",
            progress: 100,
            result: fullText,
        });
        params.emit({ type: "task-complete", taskId: params.taskId, result: fullText });
        return { result: fullText };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await params.grpc.updateTask({
            taskId: params.taskId,
            status: "failed",
            progress: 0,
            result: msg,
        });
        params.emit({ type: "task-failed", taskId: params.taskId, error: msg });
        return { result: `Error: ${msg}` };
    }
}
