import { completeSimple } from "@mariozechner/pi-ai";
import { estimateTokens } from "../utils/token-estimator.js";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { makeDelegateTool } from "../tools/delegate.js";
import { makeWebSearchTool } from "../tools/web-search.js";
import { makeSearchKnowledgeTool } from "../tools/search-knowledge.js";
import { makeCodeReadTool } from "../tools/code-read.js";
import { makeCodeWriteTool } from "../tools/code-write.js";
import { isToolAllowed } from "../policy/tool-policy.js";
import { buildModelForAgent, getLlmCandidates, resolveApiKey } from "../llm/model-factory.js";
import { buildRuntimePluginToolset } from "../plugins/runtime-toolset.js";
import { runStreamLoop } from "./stream-loop.js";
import { PiAiAdapter } from "../providers/pi-ai-adapter.js";
import { MemoryExtractor } from "../memory/extraction/memory-extractor.js";
import { DefaultContextEngine } from "../context/context-engine.impl.js";
import { DefaultTokenBudgetAllocator } from "../context/token-budget.js";
import { PersistentMessageHistory } from "./persistent-message-history.js";
import { internalToPiAi, piAiToInternal } from "./message-converter.js";
import { recordPostRunFailure } from "./post-run-observability.js";
const WEB_SEARCH_PLAN_SCHEMA = z.object({
    needWebSearch: z.boolean(),
    query: z.string().min(1).max(180),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(240),
});
async function decideWebSearch(model, apiKey, userMessage, systemPrompt) {
    try {
        const result = await completeSimple(model, {
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: [
                                "You are a routing planner for an AI coordinator.",
                                "Decide whether the request requires fresh public web information before answering.",
                                "Use reasoning, not keyword matching.",
                                "Set needWebSearch=true when the answer likely depends on recent/real-time facts, news, prices, schedules, or external verification.",
                                "Set needWebSearch=false for stable knowledge, coding, writing, translation, summarization, or opinion.",
                                "Return ONLY a JSON object: { needWebSearch: boolean, query: string, confidence: number, reason: string }",
                                "No markdown, no explanation, just JSON.",
                                "Return a concise search query in the same language as the user question.",
                                `Coordinator system prompt (may be empty): ${systemPrompt || "(empty)"}`,
                                `User request: ${userMessage}`,
                            ].join("\n"),
                        },
                    ],
                    timestamp: Date.now(),
                },
            ],
        }, {
            apiKey,
            temperature: 0,
            maxTokens: 256,
            signal: AbortSignal.timeout(8000),
        });
        const text = result.content.find((c) => c.type === "text")?.text ?? "";
        const parsed = JSON.parse(text);
        return WEB_SEARCH_PLAN_SCHEMA.parse(parsed);
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
function resolveCoordinatorContextWindow(model, apiKey) {
    const caps = new PiAiAdapter({ model, apiKey }).capabilities();
    const maxContextWindow = caps.maxContextWindow > 0 ? caps.maxContextWindow : 200_000;
    const maxOutputTokens = caps.maxOutputTokens > 0 ? caps.maxOutputTokens : 8_192;
    const tokenBudget = Math.max(8_192, Math.min(maxContextWindow, maxContextWindow - Math.min(maxOutputTokens, Math.floor(maxContextWindow * 0.2))));
    return { maxContextWindow, tokenBudget, maxOutputTokens };
}
export async function runCoordinator(params) {
    const agentCfg = await params.grpc.getAgentConfig(params.coordinatorAgentId, params.modelIdOverride);
    const llmCandidates = getLlmCandidates(agentCfg);
    const messageId = uuidv4();
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
    if (isToolAllowed("code_read", params.sandbox.toolPolicy)) {
        tools["code_read"] = makeCodeReadTool(params.sandbox.fsPolicy);
    }
    if (isToolAllowed("code_write", params.sandbox.toolPolicy)) {
        tools["code_write"] = makeCodeWriteTool(params.sandbox.fsPolicy);
    }
    if (isToolAllowed("search_knowledge", params.sandbox.toolPolicy)) {
        tools["search_knowledge"] = makeSearchKnowledgeTool({
            workspaceId: params.workspaceId,
            reranker: params.reranker,
        });
    }
    const webSearchAllowed = isToolAllowed("web_search", params.sandbox.toolPolicy);
    // Pre-flight web search decision
    let webSearchContext = "";
    const planningApiKey = resolveApiKey(agentCfg, llmCandidates[0]);
    let planningModel;
    try {
        planningModel = buildModelForAgent(agentCfg, llmCandidates[0]);
    }
    catch {
        planningModel = buildModelForAgent(agentCfg);
    }
    const contextWindow = resolveCoordinatorContextWindow(planningModel, planningApiKey);
    const searchPlan = webSearchAllowed
        ? await decideWebSearch(planningModel, planningApiKey, params.userMessage, agentCfg.systemPrompt || "")
        : null;
    const shouldForceWebSearch = Boolean(searchPlan?.needWebSearch) &&
        Boolean(searchPlan?.query?.trim()) &&
        (searchPlan?.confidence ?? 0) >= 0.6;
    if (shouldForceWebSearch) {
        const toolCallId = uuidv4();
        const query = searchPlan.query.trim();
        const searchArgs = { query, count: 5, provider: "auto" };
        params.emit({
            type: "tool-call",
            runId: params.runId,
            messageId,
            toolCallId,
            toolName: "web_search",
            args: searchArgs,
            category: "api",
            riskLevel: "low",
        });
        try {
            const webSearchTool = makeWebSearchTool();
            const preflightResult = await webSearchTool.execute(searchArgs, { toolCallId });
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
        agentModel: agentCfg.model,
        depth: 0,
        reservedNames: Object.keys(tools),
    });
    for (const [toolName, pluginTool] of Object.entries(pluginTools)) {
        if (isToolAllowed(toolName, params.sandbox.toolPolicy)) {
            tools[toolName] = pluginTool;
        }
    }
    // ─── Session history (multi-turn) ────────────────────────────────────
    let messageHistory = null;
    if (params.sessionId && params.sessionStore) {
        try {
            // Ensure session record exists (FK constraint on session_messages)
            const existing = await params.sessionStore.getSession(params.sessionId);
            if (!existing) {
                await params.sessionStore.saveSession({
                    id: params.sessionId,
                    agentId: params.coordinatorAgentId,
                    workspaceId: params.workspaceId,
                    sessionKey: `agent:${params.coordinatorAgentId}:run`,
                    status: "running",
                    createdAt: Date.now(),
                    lastActiveAt: Date.now(),
                });
            }
            else {
                await params.sessionStore.updateSession(params.sessionId, {
                    lastActiveAt: Date.now(),
                });
            }
            messageHistory = new PersistentMessageHistory(params.sessionId, params.sessionStore);
            await messageHistory.load();
        }
        catch {
            // Non-fatal — history loading failure, proceed without history
        }
    }
    // ─── Memory retrieval (raw data — formatting handled by ContextEngine) ──
    let coreMemorySnapshot;
    let injectedMemories;
    if (params.memoryManager) {
        try {
            coreMemorySnapshot = await params.memoryManager.getCoreMemory(params.coordinatorAgentId, params.workspaceId);
        }
        catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn("[coordinator] Core memory retrieval failed:", errMsg);
        }
        try {
            const preAllocator = new DefaultTokenBudgetAllocator();
            const preAllocation = preAllocator.allocate(contextWindow.tokenBudget, {
                systemPromptTokens: 0,
                hasCoreMemory: !!coreMemorySnapshot,
                hasInjectedMemories: true,
                maxOutputTokens: contextWindow.maxOutputTokens,
            });
            const injectionBudget = preAllocation.injectedMemories;
            injectedMemories = await params.memoryManager.getRelevantInjections({
                currentMessage: params.userMessage,
                recentMessages: [],
                agentId: params.coordinatorAgentId,
                workspaceId: params.workspaceId,
                tokenBudget: injectionBudget,
            });
            // Emit memory-injection event for frontend transparency
            if (injectedMemories && injectedMemories.length > 0) {
                params.emit({
                    type: "memory-injection",
                    runId: params.runId,
                    memories: injectedMemories.map((m) => ({
                        memoryId: m.memoryId,
                        source: m.source,
                        score: m.score,
                        contentPreview: m.content.slice(0, 120),
                    })),
                    count: injectedMemories.length,
                });
            }
        }
        catch (err) {
            // H6: Non-fatal but emit warning so the user knows memory retrieval failed
            const errMsg = err instanceof Error ? err.message : String(err);
            console.warn("[coordinator] Memory injection retrieval failed:", errMsg);
        }
    }
    // ─── ContextEngine: system prompt + dynamic token budget + history trimming ──
    const agentSessionCfg = {
        id: agentCfg.id,
        name: agentCfg.name,
        systemPrompt: agentCfg.systemPrompt || "",
        model: agentCfg.model,
        maxTurns: agentCfg.maxTurns || 10,
        temperature: agentCfg.temperature || undefined,
        maxTokens: Math.min(agentCfg.maxTokens || contextWindow.maxOutputTokens, contextWindow.maxOutputTokens),
    };
    const contextEngine = new DefaultContextEngine({
        maxContextWindow: contextWindow.maxContextWindow,
    });
    // H2: Build web search additional context for inclusion in token budget
    const webSearchAdditionalContext = webSearchContext
        ? [
            "Web search context is already available for this answer.",
            "Use it as the primary evidence for time-sensitive claims.",
            "If sources conflict, mention uncertainty briefly.",
            `\n[WEB_SEARCH_CONTEXT]\n${webSearchContext}`,
        ].join("\n")
        : undefined;
    const allHistory = messageHistory ? messageHistory.getAll() : [];
    const assembled = await contextEngine.assemble({
        agent: agentSessionCfg,
        tools: [], // pi-ai handles tool definitions natively
        messageHistory: allHistory,
        tokenBudget: contextWindow.tokenBudget,
        coreMemorySnapshot,
        injectedMemories,
        additionalSystemContext: webSearchAdditionalContext,
    });
    // Extract system prompt and trimmed history from assembled context
    let systemPrompt = "";
    let trimmedInternalHistory = [];
    if (assembled.messages.length > 0 && assembled.messages[0].role === "system") {
        const textBlock = assembled.messages[0].content.find((c) => c.type === "text");
        systemPrompt = textBlock && "text" in textBlock ? textBlock.text : "";
        trimmedInternalHistory = assembled.messages.slice(1);
    }
    else {
        trimmedInternalHistory = assembled.messages;
    }
    // H2: Web search context is now included via additionalSystemContext
    // in ContextEngine.assemble(), counted in the token budget.
    // Convert trimmed history to pi-ai format for stream-loop
    const priorHistory = [];
    for (const msg of trimmedInternalHistory) {
        const converted = internalToPiAi(msg);
        if (converted)
            priorHistory.push(converted);
    }
    let fullText = "";
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let successModel = null;
    let successApiKey = "";
    let runNewMessages = [];
    try {
        const orderedCandidates = llmCandidates.length > 0 ? llmCandidates : [undefined];
        const rawStartOffset = params.startCandidateOffset ?? 0;
        const safeStartOffset = Math.max(0, Math.min(Math.floor(rawStartOffset), Math.max(orderedCandidates.length - 1, 0)));
        const candidates = orderedCandidates.slice(safeStartOffset);
        let streamError = null;
        for (let index = 0; index < candidates.length; index += 1) {
            const candidate = candidates[index];
            fullText = "";
            try {
                const model = buildModelForAgent(agentCfg, candidate);
                const apiKey = resolveApiKey(agentCfg, candidate ?? undefined);
                const result = await runStreamLoop({
                    model,
                    systemPrompt,
                    userMessage: params.userMessage,
                    tools,
                    maxSteps: params.sandbox.maxTurns,
                    apiKey,
                    emit: params.emit,
                    runId: params.runId,
                    messageId,
                    priorHistory,
                    abortSignal: params.abortSignal,
                });
                fullText = result.fullText;
                totalUsage = result.usage;
                runNewMessages = result.newMessages;
                successModel = model;
                successApiKey = apiKey;
                streamError = null;
                break;
            }
            catch (err) {
                streamError = err;
                const errorMessage = err instanceof Error ? err.message : String(err);
                const hasNextCandidate = index + 1 < candidates.length;
                if (hasNextCandidate && fullText.trim().length === 0) {
                    console.warn(`[coordinator] primary model failed before streaming, retrying fallback (${index + 1}/${candidates.length})`, {
                        runId: params.runId,
                        agentId: params.coordinatorAgentId,
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
    }
    catch (err) {
        params.emit({
            type: "usage",
            runId: params.runId,
            messageId,
            agentId: params.coordinatorAgentId,
            scope: "coordinator",
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            totalTokens: totalUsage.totalTokens,
        });
        try {
            await params.grpc.recordRunUsage({
                runId: params.runId,
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
                    agentId: params.coordinatorAgentId,
                });
            }
            catch {
                // best effort
            }
        }
        params.emit({ type: "task-failed", runId: params.runId, messageId, taskId: params.runId, error: msg });
        params.emit({ type: "message-end", runId: params.runId, messageId });
        throw err;
    }
    params.emit({
        type: "usage",
        runId: params.runId,
        messageId,
        agentId: params.coordinatorAgentId,
        scope: "coordinator",
        inputTokens: totalUsage.inputTokens,
        outputTokens: totalUsage.outputTokens,
        totalTokens: totalUsage.totalTokens,
    });
    try {
        await params.grpc.recordRunUsage({
            runId: params.runId,
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            totalTokens: totalUsage.totalTokens,
        });
    }
    catch {
        // best effort
    }
    if (fullText.trim().length > 0) {
        try {
            await params.grpc.appendMessage({
                runId: params.runId,
                role: "assistant",
                content: fullText,
                agentId: params.coordinatorAgentId,
            });
        }
        catch {
            // best effort — message-end must always fire
        }
    }
    // ─── Persist new messages to session history ──────────────────────────────
    // H7: Use appendAsync() to await persistence, preventing data loss on crash.
    if (messageHistory && runNewMessages.length > 0) {
        try {
            for (const piMsg of runNewMessages) {
                await messageHistory.appendAsync(piAiToInternal(piMsg));
            }
        }
        catch {
            // Non-fatal — history persistence failure
        }
    }
    // ─── Post-run: memory extraction ─────────────────────────────────────────
    // 1. Basic episodic memory (always, no LLM needed)
    // 2. LLM-based semantic extraction (needs ProviderAdapter via PiAiAdapter)
    // 3. Entity extraction (needs ProviderAdapter)
    // All non-fatal — failures are silently caught.
    if (params.memoryManager && fullText.trim().length > 0) {
        await postRunMemoryExtraction({
            memoryManager: params.memoryManager,
            embeddingService: params.embeddingService,
            agentId: params.coordinatorAgentId,
            workspaceId: params.workspaceId,
            userMessage: params.userMessage,
            assistantText: fullText,
            runId: params.runId,
            model: successModel,
            apiKey: successApiKey,
            setMemoryProvider: params.setMemoryProvider,
        });
    }
    // ─── Post-run: memory consolidation + decay update ────────────────────────
    // Consolidation merges near-duplicate memories; decay update applies the
    // Ebbinghaus forgetting curve to stale entries. Both are best-effort.
    if (params.memoryManager) {
        const consolidationStartedAt = Date.now();
        try {
            await params.memoryManager.consolidate(params.coordinatorAgentId, params.workspaceId);
        }
        catch (err) {
            console.warn("[coordinator] consolidation failed:", err);
            await recordPostRunFailure({
                observabilityStore: params.observabilityStore,
                runId: params.runId,
                workspaceId: params.workspaceId,
                agentId: params.coordinatorAgentId,
                stage: "post_run:consolidation",
                startedAt: consolidationStartedAt,
            });
        }
        const decayStartedAt = Date.now();
        try {
            await params.memoryManager.batchDecayUpdate();
        }
        catch (err) {
            console.warn("[coordinator] decay update failed:", err);
            await recordPostRunFailure({
                observabilityStore: params.observabilityStore,
                runId: params.runId,
                workspaceId: params.workspaceId,
                agentId: params.coordinatorAgentId,
                stage: "post_run:decay_update",
                startedAt: decayStartedAt,
            });
        }
    }
    // ─── Post-run: session history compaction ─────────────────────────────────
    // If history grew too large, compact old messages into a summary.
    // Requires a real LLM provider (successModel) for summarization.
    if (messageHistory && successModel && messageHistory.length > 0) {
        const compactionStartedAt = Date.now();
        try {
            const historyMessages = messageHistory.getAll();
            const historyTokens = estimateTokensForCompaction(historyMessages);
            const compactionBudget = assembled.breakdown.messageHistory;
            if (contextEngine.shouldCompact(historyTokens, compactionBudget)) {
                const adapter = new PiAiAdapter({
                    model: successModel,
                    apiKey: successApiKey,
                    completeTimeoutMs: 30_000,
                });
                const compactionEngine = new DefaultContextEngine({
                    providerAdapter: adapter,
                    maxContextWindow: contextWindow.maxContextWindow,
                });
                const { summary, result } = await compactionEngine.compactMessages(historyMessages);
                if (result.removedMessages > 0 && summary) {
                    // Build compacted history: summary message + recent messages
                    const recentCount = Math.min(8, historyMessages.length);
                    const recentMessages = historyMessages.slice(-recentCount);
                    const summaryMessage = {
                        role: "system",
                        content: [{ type: "text", text: `[Conversation Summary]\n${summary}` }],
                    };
                    // H7: Await persistence for crash safety
                    await messageHistory.replaceAllAsync([summaryMessage, ...recentMessages]);
                }
            }
        }
        catch {
            // Non-fatal — compaction failure doesn't affect the current run
            await recordPostRunFailure({
                observabilityStore: params.observabilityStore,
                runId: params.runId,
                workspaceId: params.workspaceId,
                agentId: params.coordinatorAgentId,
                stage: "post_run:history_compaction",
                startedAt: compactionStartedAt,
            });
        }
    }
    params.emit({ type: "message-end", runId: params.runId, messageId });
}
async function postRunMemoryExtraction(params) {
    const { memoryManager, embeddingService, agentId, workspaceId, userMessage, assistantText } = params;
    const conversationText = `User: ${userMessage}\n\nAssistant: ${assistantText.slice(0, 2000)}`;
    // 1. Basic episodic memory (no LLM needed)
    const episodicStartedAt = Date.now();
    try {
        let embedding;
        if (embeddingService) {
            try {
                embedding = await embeddingService.embedOne(conversationText.slice(0, 4000));
            }
            catch (err) {
                console.warn("[post-run] Embedding for episodic memory failed:", err instanceof Error ? err.message : err);
            }
        }
        await memoryManager.ingest({
            type: "episodic",
            agentId,
            workspaceId,
            content: conversationText,
            importance: 5,
            embedding,
        });
    }
    catch (err) {
        console.warn("[post-run] Episodic memory ingestion failed:", {
            runId: params.runId,
            agentId,
            error: err instanceof Error ? err.message : String(err),
        });
        await recordPostRunFailure({
            observabilityStore: params.observabilityStore,
            runId: params.runId,
            workspaceId,
            agentId,
            stage: "post_run:episodic_ingest",
            startedAt: episodicStartedAt,
        });
    }
    // 2. LLM-based semantic extraction (requires a successful model)
    if (!params.model)
        return;
    const adapter = new PiAiAdapter({
        model: params.model,
        apiKey: params.apiKey,
        completeTimeoutMs: 15_000,
    });
    // Set the lazy provider so MemoryManager's internal sub-components
    // (EntityExtractor, ReflectionEngine, etc.) can now use a real LLM.
    if (params.setMemoryProvider) {
        params.setMemoryProvider(adapter);
    }
    const semanticStartedAt = Date.now();
    try {
        const extractor = new MemoryExtractor(adapter);
        const conversationMessages = [
            {
                role: "user",
                content: [{ type: "text", text: userMessage }],
            },
            {
                role: "assistant",
                content: [{ type: "text", text: assistantText.slice(0, 4000) }],
            },
        ];
        const extracted = await extractor.extract(conversationMessages, agentId, workspaceId);
        for (const entry of extracted) {
            let embedding;
            if (embeddingService) {
                try {
                    embedding = await embeddingService.embedOne(entry.content);
                }
                catch (err) {
                    console.warn("[post-run] Embedding for extracted memory failed:", err instanceof Error ? err.message : err);
                }
            }
            await memoryManager.ingest({ ...entry, embedding });
        }
    }
    catch (err) {
        console.warn("[post-run] Semantic extraction failed:", {
            runId: params.runId,
            agentId,
            error: err instanceof Error ? err.message : String(err),
        });
        await recordPostRunFailure({
            observabilityStore: params.observabilityStore,
            runId: params.runId,
            workspaceId,
            agentId,
            stage: "post_run:semantic_extraction",
            startedAt: semanticStartedAt,
        });
    }
    // 3. Entity extraction (uses LazyProvider — now backed by the real adapter)
    const entityStartedAt = Date.now();
    try {
        await memoryManager.extractEntities(conversationText, {
            type: "conversation",
            runId: params.runId,
        });
    }
    catch (err) {
        console.warn("[post-run] Entity extraction failed:", {
            runId: params.runId,
            agentId,
            error: err instanceof Error ? err.message : String(err),
        });
        await recordPostRunFailure({
            observabilityStore: params.observabilityStore,
            runId: params.runId,
            workspaceId,
            agentId,
            stage: "post_run:entity_extraction",
            startedAt: entityStartedAt,
        });
    }
    // 4. Reflection trigger check — if enough new memories accumulated, run reflection
    const reflectionStartedAt = Date.now();
    try {
        const shouldReflect = await memoryManager.checkReflectionTrigger(agentId, workspaceId);
        if (shouldReflect) {
            await memoryManager.executeReflection(agentId, workspaceId);
        }
    }
    catch (err) {
        console.warn("[post-run] Reflection failed:", {
            runId: params.runId,
            agentId,
            error: err instanceof Error ? err.message : String(err),
        });
        await recordPostRunFailure({
            observabilityStore: params.observabilityStore,
            runId: params.runId,
            workspaceId,
            agentId,
            stage: "post_run:reflection",
            startedAt: reflectionStartedAt,
        });
    }
}
// ─── Token Estimation ────────────────────────────────────────────────────────
function estimateTokensForCompaction(messages) {
    let total = 0;
    for (const msg of messages) {
        for (const block of msg.content) {
            if ("text" in block) {
                total += estimateTokens(block.text);
            }
            else if (block.type === "tool-call") {
                total += estimateTokens(block.toolName) + estimateTokens(block.args);
            }
        }
    }
    return total;
}
