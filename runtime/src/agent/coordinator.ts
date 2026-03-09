import { completeSimple, type Model, type Api } from "@mariozechner/pi-ai";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import type { RuntimeTool } from "../tools/types.js";
import type { SandboxPolicy } from "../policy/sandbox.js";
import type { SseEmitter } from "../sse/emitter.js";
import type { grpcClient as GrpcClientType } from "../grpc/client.js";
import { makeDelegateTool } from "../tools/delegate.js";
import { makeWebSearchTool } from "../tools/web-search.js";
import { isToolAllowed } from "../policy/tool-policy.js";
import { buildModelForAgent, getLlmCandidates, resolveApiKey } from "../llm/model-factory.js";
import { buildRuntimePluginToolset } from "../plugins/runtime-toolset.js";
import { runStreamLoop, type ToolMap } from "./stream-loop.js";

export interface CoordinatorParams {
  runId: string;
  workspaceId: string;
  coordinatorAgentId: string;
  userMessage: string;
  startCandidateOffset?: number;
  modelIdOverride?: string;
  sandbox: SandboxPolicy;
  emit: SseEmitter;
  grpc: typeof GrpcClientType;
}

const WEB_SEARCH_PLAN_SCHEMA = z.object({
  needWebSearch: z.boolean(),
  query: z.string().min(1).max(180),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(240),
});

type WebSearchPlan = z.infer<typeof WEB_SEARCH_PLAN_SCHEMA>;

async function decideWebSearch(
  model: Model<Api>,
  apiKey: string,
  userMessage: string,
  systemPrompt: string
): Promise<WebSearchPlan | null> {
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
  } catch {
    return null;
  }
}

function formatWebSearchContext(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const query = typeof r.query === "string" ? r.query.trim() : "";
  const note = typeof r.note === "string" ? r.note.trim() : "";
  const results = Array.isArray(r.results) ? r.results : [];
  const lines = results
    .slice(0, 5)
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const title = typeof row.title === "string" ? row.title.trim() : "";
      const snippet = typeof row.snippet === "string" ? row.snippet.trim() : "";
      const url = typeof row.url === "string" ? row.url.trim() : "";
      if (!title && !snippet && !url) return null;
      return `${index + 1}. ${title || "(untitled)"}\n   ${snippet || "(no snippet)"}\n   ${url || "(no url)"}`;
    })
    .filter((line): line is string => Boolean(line));

  const sections: string[] = [];
  sections.push(`Query: ${query || "(empty)"}`);
  if (note) sections.push(`Note: ${note}`);
  if (lines.length > 0) {
    sections.push("Results:");
    sections.push(lines.join("\n"));
  } else {
    sections.push("Results: (none)");
  }
  return sections.join("\n");
}

export async function runCoordinator(params: CoordinatorParams): Promise<void> {
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

  const tools: ToolMap = {};
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

  // Pre-flight web search decision
  let webSearchContext = "";
  const planningApiKey = resolveApiKey(agentCfg, llmCandidates[0]);
  let planningModel: Model<Api>;
  try {
    planningModel = buildModelForAgent(agentCfg, llmCandidates[0]);
  } catch {
    planningModel = buildModelForAgent(agentCfg);
  }

  const searchPlan = webSearchAllowed
    ? await decideWebSearch(planningModel, planningApiKey, params.userMessage, agentCfg.systemPrompt || "")
    : null;
  const shouldForceWebSearch =
    Boolean(searchPlan?.needWebSearch) &&
    Boolean(searchPlan?.query?.trim()) &&
    (searchPlan?.confidence ?? 0) >= 0.6;

  if (shouldForceWebSearch) {
    const toolCallId = uuidv4();
    const query = searchPlan!.query.trim();
    const searchArgs = { query, count: 5, provider: "auto" as const };
    params.emit({
      type: "tool-call",
      runId: params.runId,
      messageId,
      toolCallId,
      toolName: "web_search",
      args: searchArgs,
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
    } catch (err) {
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

  let fullText = "";
  let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  try {
    const orderedCandidates = llmCandidates.length > 0 ? llmCandidates : [undefined];
    const rawStartOffset = params.startCandidateOffset ?? 0;
    const safeStartOffset = Math.max(
      0,
      Math.min(Math.floor(rawStartOffset), Math.max(orderedCandidates.length - 1, 0)),
    );
    const candidates = orderedCandidates.slice(safeStartOffset);
    let streamError: unknown = null;

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
        });

        fullText = result.fullText;
        totalUsage = result.usage;
        streamError = null;
        break;
      } catch (err) {
        streamError = err;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const hasNextCandidate = index + 1 < candidates.length;
        if (hasNextCandidate && fullText.trim().length === 0) {
          console.warn(
            `[coordinator] primary model failed before streaming, retrying fallback (${index + 1}/${candidates.length})`,
            {
              runId: params.runId,
              agentId: params.coordinatorAgentId,
              provider: candidate?.llmProviderType ?? agentCfg.llmProviderType,
              model: candidate?.model ?? agentCfg.model,
              error: errorMessage,
            }
          );
          continue;
        }
        break;
      }
    }

    if (streamError) {
      throw streamError;
    }
  } catch (err) {
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
    } catch {
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
      } catch {
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
  } catch {
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
    } catch {
      // best effort — message-end must always fire
    }
  }

  params.emit({ type: "message-end", runId: params.runId, messageId });
}
