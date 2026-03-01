import { generateObject, streamText } from "ai";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { makeDelegateTool } from "../tools/delegate.js";
import { makeWebSearchTool } from "../tools/web-search.js";
import { isToolAllowed } from "../policy/tool-policy.js";
import { buildModelForAgent } from "../llm/model-factory.js";
import { buildRuntimePluginToolset } from "../plugins/runtime-toolset.js";
const WEB_SEARCH_PLAN_SCHEMA = z.object({
    needWebSearch: z.boolean(),
    query: z.string().min(1).max(180),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(240),
});
async function decideWebSearch(model, userMessage, systemPrompt) {
    try {
        const { object } = await generateObject({
            model,
            schema: WEB_SEARCH_PLAN_SCHEMA,
            temperature: 0,
            prompt: [
                "You are a routing planner for an AI coordinator.",
                "Decide whether the request requires fresh public web information before answering.",
                "Use reasoning, not keyword matching.",
                "Set needWebSearch=true when the answer likely depends on recent/real-time facts, news, prices, schedules, or external verification.",
                "Set needWebSearch=false for stable knowledge, coding, writing, translation, summarization, or opinion.",
                "Return a concise search query in the same language as the user question.",
                `Coordinator system prompt (may be empty): ${systemPrompt || "(empty)"}`,
                `User request: ${userMessage}`,
            ].join("\n"),
        });
        return object;
    }
    catch {
        return null;
    }
}
function formatWebSearchContext(result) {
    if (!result || typeof result !== "object")
        return "";
    const r = result;
    const query = typeof r.query === "string" ? r.query.trim() : "";
    const note = typeof r.note === "string" ? r.note.trim() : "";
    const results = Array.isArray(r.results) ? r.results : [];
    const lines = results
        .slice(0, 5)
        .map((item, index) => {
        if (!item || typeof item !== "object")
            return null;
        const row = item;
        const title = typeof row.title === "string" ? row.title.trim() : "";
        const snippet = typeof row.snippet === "string" ? row.snippet.trim() : "";
        const url = typeof row.url === "string" ? row.url.trim() : "";
        if (!title && !snippet && !url)
            return null;
        return `${index + 1}. ${title || "(untitled)"}\n   ${snippet || "(no snippet)"}\n   ${url || "(no url)"}`;
    })
        .filter((line) => Boolean(line));
    const sections = [];
    sections.push(`Query: ${query || "(empty)"}`);
    if (note)
        sections.push(`Note: ${note}`);
    if (lines.length > 0) {
        sections.push("Results:");
        sections.push(lines.join("\n"));
    }
    else {
        sections.push("Results: (none)");
    }
    return sections.join("\n");
}
export async function runCoordinator(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.coordinatorAgentId);
    const model = buildModelForAgent(agentCfg);
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
            workspaceId: params.workspaceId,
            depth: 0,
            sandbox: params.sandbox,
            emit: params.emit,
            grpc: params.grpc,
            agentConfigModel: agentCfg.model,
        });
    }
    const webSearchAllowed = isToolAllowed("web_search", params.sandbox.toolPolicy);
    let webSearchContext = "";
    const searchPlan = webSearchAllowed
        ? await decideWebSearch(model, params.userMessage, agentCfg.systemPrompt || "")
        : null;
    const shouldForceWebSearch = Boolean(searchPlan?.needWebSearch) &&
        Boolean(searchPlan?.query?.trim()) &&
        (searchPlan?.confidence ?? 0) >= 0.6;
    if (shouldForceWebSearch) {
        const toolCallId = uuidv4();
        const query = searchPlan.query.trim();
        const args = { query, count: 5, provider: "auto" };
        params.emit({
            type: "tool-call",
            runId: params.runId,
            messageId,
            toolCallId,
            toolName: "web_search",
            args,
        });
        try {
            const preflightResult = await makeWebSearchTool().execute(args);
            params.emit({
                type: "tool-result",
                runId: params.runId,
                messageId,
                toolCallId,
                toolName: "web_search",
                result: preflightResult,
                status: "success",
            });
            webSearchContext = formatWebSearchContext(preflightResult);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            params.emit({
                type: "tool-result",
                runId: params.runId,
                messageId,
                toolCallId,
                toolName: "web_search",
                result: { error: msg },
                status: "error",
            });
        }
    }
    if (webSearchAllowed && !shouldForceWebSearch) {
        tools["web_search"] = makeWebSearchTool();
    }
    const pluginTools = buildRuntimePluginToolset({
        workspaceId: params.workspaceId,
        runId: params.runId,
        taskId: rootTaskId,
        agentId: params.coordinatorAgentId,
        depth: 0,
        reservedNames: Object.keys(tools),
    });
    for (const [toolName, pluginTool] of Object.entries(pluginTools)) {
        if (isToolAllowed(toolName, params.sandbox.toolPolicy)) {
            tools[toolName] = pluginTool;
        }
    }
    const systemPrompt = [
        agentCfg.systemPrompt || "",
        webSearchContext
            ? [
                "Web search context is already available for this answer.",
                "Use it as the primary evidence for time-sensitive claims.",
                "If sources conflict, mention uncertainty briefly.",
                `\n[WEB_SEARCH_CONTEXT]\n${webSearchContext}`,
            ].join("\n")
            : "",
    ]
        .filter((part) => part.trim().length > 0)
        .join("\n\n");
    const userMessage = params.userMessage;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const result = streamText({
        model,
        system: systemPrompt || undefined,
        messages: [{ role: "user", content: userMessage }],
        tools: Object.keys(tools).length > 0 ? tools : undefined,
        maxSteps: params.sandbox.maxTurns,
    });
    const resolveUsage = async () => {
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
        const usage = await resolveUsage();
        params.emit({
            type: "usage",
            runId: params.runId,
            messageId,
            agentId: params.coordinatorAgentId,
            scope: "coordinator",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
        });
        try {
            await params.grpc.recordRunUsage({
                runId: params.runId,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                totalTokens: usage.totalTokens,
            });
        }
        catch {
            // best effort
        }
        const msg = err instanceof Error ? err.message : String(err);
        params.emit({ type: "task-failed", runId: params.runId, messageId, taskId: params.runId, error: msg });
        params.emit({ type: "message-end", runId: params.runId, messageId });
        throw err;
    }
    const usage = await resolveUsage();
    params.emit({
        type: "usage",
        runId: params.runId,
        messageId,
        agentId: params.coordinatorAgentId,
        scope: "coordinator",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
    });
    try {
        await params.grpc.recordRunUsage({
            runId: params.runId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
        });
    }
    catch {
        // best effort
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
