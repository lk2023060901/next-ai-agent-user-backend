import { stream } from "@mariozechner/pi-ai";
import { approvalGate } from "../tools/approval-gate.js";
function toPiTools(tools) {
    return Object.values(tools).map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    }));
}
export async function runStreamLoop(params) {
    const historyMessages = params.priorHistory ?? [];
    const userMsg = {
        role: "user",
        content: [{ type: "text", text: params.userMessage }],
        timestamp: Date.now(),
    };
    const context = {
        systemPrompt: params.systemPrompt || undefined,
        messages: [...historyMessages, userMsg],
        tools: toPiTools(params.tools),
    };
    // Track where new messages start (after history + user)
    const newMessagesStart = context.messages.length;
    let fullText = "";
    const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (let step = 0; step < params.maxSteps; step++) {
        const pendingToolCalls = [];
        const stepTimeout = AbortSignal.timeout(120_000);
        const signal = params.abortSignal
            ? AbortSignal.any([stepTimeout, params.abortSignal])
            : stepTimeout;
        const eventStream = stream(params.model, context, {
            apiKey: params.apiKey,
            signal,
        });
        for await (const event of eventStream) {
            switch (event.type) {
                case "text_delta":
                    fullText += event.delta;
                    params.emit({
                        type: "text-delta",
                        runId: params.runId,
                        messageId: params.messageId,
                        text: event.delta,
                    });
                    break;
                case "thinking_delta":
                    params.emit({
                        type: "reasoning-delta",
                        runId: params.runId,
                        messageId: params.messageId,
                        text: event.delta,
                    });
                    break;
                case "thinking_end":
                    params.emit({
                        type: "reasoning",
                        runId: params.runId,
                        messageId: params.messageId,
                        text: event.content,
                    });
                    break;
                case "toolcall_end": {
                    pendingToolCalls.push({
                        id: event.toolCall.id,
                        name: event.toolCall.name,
                        args: event.toolCall.arguments,
                    });
                    const calledTool = params.tools[event.toolCall.name];
                    params.emit({
                        type: "tool-call",
                        runId: params.runId,
                        messageId: params.messageId,
                        toolCallId: event.toolCall.id,
                        toolName: event.toolCall.name,
                        args: event.toolCall.arguments,
                        category: calledTool?.category ?? "system",
                        riskLevel: calledTool?.riskLevel ?? "low",
                    });
                    break;
                }
                case "done": {
                    const usage = event.message.usage;
                    totalUsage.inputTokens += usage.input;
                    totalUsage.outputTokens += usage.output;
                    totalUsage.totalTokens += usage.totalTokens;
                    // Push the assistant message into context for multi-turn
                    context.messages.push(event.message);
                    break;
                }
                case "error":
                    throw new Error(event.error.errorMessage ?? "stream error");
            }
        }
        // No tool calls → done
        if (pendingToolCalls.length === 0)
            break;
        // Execute tools and push results to context
        for (const tc of pendingToolCalls) {
            const tool = params.tools[tc.name];
            if (!tool) {
                context.messages.push({
                    role: "toolResult",
                    toolCallId: tc.id,
                    toolName: tc.name,
                    content: [{ type: "text", text: `Tool "${tc.name}" not found` }],
                    isError: true,
                    timestamp: Date.now(),
                });
                continue;
            }
            try {
                // Approval gating — if the tool requires approval, wait for user decision
                if (tool.requiresApproval) {
                    const decision = await approvalGate.requestApproval({
                        runId: params.runId,
                        messageId: params.messageId,
                        toolCallId: tc.id,
                        toolName: tc.name,
                        args: tc.args,
                        emit: params.emit,
                        abortSignal: params.abortSignal,
                    });
                    if (decision !== "approved") {
                        const rejectMsg = decision === "rejected"
                            ? `Tool "${tc.name}" execution rejected by user`
                            : `Tool "${tc.name}" approval request expired`;
                        params.emit({
                            type: "tool-result",
                            runId: params.runId,
                            messageId: params.messageId,
                            toolCallId: tc.id,
                            toolName: tc.name,
                            result: { error: rejectMsg },
                            status: "error",
                        });
                        context.messages.push({
                            role: "toolResult",
                            toolCallId: tc.id,
                            toolName: tc.name,
                            content: [{ type: "text", text: rejectMsg }],
                            isError: true,
                            timestamp: Date.now(),
                        });
                        continue;
                    }
                }
                const result = await tool.execute(tc.args, { toolCallId: tc.id });
                const resultText = typeof result === "string" ? result : JSON.stringify(result);
                params.emit({
                    type: "tool-result",
                    runId: params.runId,
                    messageId: params.messageId,
                    toolCallId: tc.id,
                    toolName: tc.name,
                    result,
                    status: "success",
                });
                context.messages.push({
                    role: "toolResult",
                    toolCallId: tc.id,
                    toolName: tc.name,
                    content: [{ type: "text", text: resultText }],
                    isError: false,
                    timestamp: Date.now(),
                });
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                params.emit({
                    type: "tool-result",
                    runId: params.runId,
                    messageId: params.messageId,
                    toolCallId: tc.id,
                    toolName: tc.name,
                    result: { error: msg },
                    status: "error",
                });
                context.messages.push({
                    role: "toolResult",
                    toolCallId: tc.id,
                    toolName: tc.name,
                    content: [{ type: "text", text: msg }],
                    isError: true,
                    timestamp: Date.now(),
                });
            }
        }
    }
    // Collect new messages: user message + everything the loop added
    const newMessages = [
        userMsg,
        ...context.messages.slice(newMessagesStart),
    ];
    return { fullText, usage: totalUsage, newMessages };
}
