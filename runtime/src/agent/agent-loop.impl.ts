import { v4 as uuidv4 } from "uuid";
import type { EventBus } from "../events/event-types.js";
import type {
  Message,
  ProviderAdapter,
  ProviderToolDefinition,
} from "../providers/adapter.js";
import type {
  AgentTool,
  ToolContext,
  ToolResult,
  ToolRuntime,
} from "../tools/tool-types.js";
import type {
  AgentConfig,
  AgentLoop,
  AgentLoopParams,
  MessageHistory,
  RunResult,
  RunUsage,
} from "./agent-types.js";

// ─── Options ─────────────────────────────────────────────────────────────────

export interface DefaultAgentLoopOptions {
  /** Default max turns when agent config doesn't specify one. */
  defaultMaxTurns?: number;
}

// ─── Implementation ──────────────────────────────────────────────────────────

/**
 * Core execution loop.
 *
 * Each "turn" is: assemble messages → stream LLM → process chunks → execute
 * tools → loop. Terminates when the LLM produces no tool calls, maxTurns is
 * reached, or the abort signal fires.
 *
 * Events are emitted via EventBus so SSE subscribers get real-time updates.
 * Tool execution is delegated to ToolRuntime (if provided) for timeout,
 * validation, and approval gating — otherwise tools are called directly.
 */
export class DefaultAgentLoop implements AgentLoop {
  private readonly defaultMaxTurns: number;

  constructor(options?: DefaultAgentLoopOptions) {
    this.defaultMaxTurns = options?.defaultMaxTurns ?? 25;
  }

  async execute(params: AgentLoopParams): Promise<RunResult> {
    const {
      run,
      agent,
      tools,
      providerAdapter,
      toolRuntime,
      messageHistory,
      eventBus,
      abortSignal,
    } = params;

    const maxTurns = agent.maxTurns || this.defaultMaxTurns;
    const messageId = uuidv4();
    let fullText = "";
    const usage: RunUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    // Emit message-start
    eventBus.emit(run.id, {
      type: "message-start",
      data: { messageId },
      agentId: agent.id,
    });

    // Build provider tool definitions from AgentTool[]
    const providerTools = toolsToProviderFormat(tools);

    // Add user request to history if this is a fresh run
    if (shouldAppendUserRequest(messageHistory, run.userRequest)) {
      messageHistory.append({
        role: "user",
        content: [{ type: "text", text: run.userRequest }],
      });
    }

    let turn = 0;

    try {
      while (turn < maxTurns) {
        if (abortSignal.aborted) {
          return buildResult(run.id, "cancelled", fullText, usage, turn, "Run cancelled");
        }

        // 1. Assemble messages for this turn
        const messages = assembleMessages(agent.systemPrompt, messageHistory.getAll());

        // 2. Stream LLM response
        const turnResult = await this.executeTurn({
          messages,
          providerTools: providerTools.length > 0 ? providerTools : undefined,
          agent,
          providerAdapter,
          eventBus,
          runId: run.id,
          messageId,
          abortSignal,
        });

        // 3. Accumulate usage
        usage.inputTokens += turnResult.usage.inputTokens;
        usage.outputTokens += turnResult.usage.outputTokens;
        usage.totalTokens += turnResult.usage.inputTokens + turnResult.usage.outputTokens;

        // 4. Accumulate text
        fullText += turnResult.text;

        // 5. Add assistant message to history
        const assistantContent: Message["content"] = [];
        if (turnResult.text) {
          assistantContent.push({ type: "text", text: turnResult.text });
        }
        for (const tc of turnResult.toolCalls) {
          assistantContent.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            args: tc.args,
          });
        }
        if (assistantContent.length > 0) {
          messageHistory.append({ role: "assistant", content: assistantContent });
        }

        // 6. No tool calls → natural stop
        if (turnResult.toolCalls.length === 0) {
          break;
        }

        // 7. Execute tool calls and add results to history
        for (const tc of turnResult.toolCalls) {
          if (abortSignal.aborted) {
            return buildResult(
              run.id, "cancelled", fullText, usage, turn,
              "Run cancelled during tool execution",
            );
          }

          const result = await this.executeTool(
            tc, tools, toolRuntime, run, agent, eventBus, messageId, abortSignal,
          );

          const resultText = result.status === "error"
            ? result.error ?? "Tool execution failed"
            : typeof result.data === "string"
              ? result.data
              : JSON.stringify(result.data);

          messageHistory.append({
            role: "tool",
            content: [{ type: "text", text: resultText }],
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            isError: result.status === "error",
          });
        }

        turn++;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      eventBus.emit(run.id, {
        type: "error",
        data: { message: errorMessage },
        agentId: agent.id,
      });

      // Still emit usage and message-end on failure
      emitUsageAndEnd(eventBus, run.id, agent.id, messageId, usage);

      return buildResult(run.id, "failed", fullText, usage, turn, errorMessage);
    }

    emitUsageAndEnd(eventBus, run.id, agent.id, messageId, usage);

    return buildResult(run.id, "completed", fullText, usage, turn);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private async executeTurn(params: {
    messages: Message[];
    providerTools?: ProviderToolDefinition[];
    agent: AgentConfig;
    providerAdapter: ProviderAdapter;
    eventBus: EventBus;
    runId: string;
    messageId: string;
    abortSignal: AbortSignal;
  }): Promise<TurnResult> {
    const toolCalls: ToolCallInfo[] = [];
    let text = "";
    let reasoningText = "";
    const turnUsage = { inputTokens: 0, outputTokens: 0 };

    const stream = params.providerAdapter.stream({
      messages: params.messages,
      tools: params.providerTools,
      model: params.agent.model,
      temperature: params.agent.temperature,
      maxTokens: params.agent.maxTokens,
      reasoning: params.agent.reasoning,
      abortSignal: params.abortSignal,
    });

    for await (const chunk of stream) {
      switch (chunk.type) {
        case "text-delta":
          text += chunk.text;
          params.eventBus.emit(params.runId, {
            type: "text-delta",
            data: { delta: chunk.text },
            agentId: params.agent.id,
            messageId: params.messageId,
          });
          break;

        case "reasoning":
          reasoningText += chunk.text;
          params.eventBus.emit(params.runId, {
            type: "reasoning-delta",
            data: { delta: chunk.text },
            agentId: params.agent.id,
            messageId: params.messageId,
          });
          break;

        case "tool-call":
          toolCalls.push({
            toolCallId: chunk.toolCallId,
            toolName: chunk.toolName,
            args: chunk.args,
          });
          params.eventBus.emit(params.runId, {
            type: "tool-call",
            data: {
              toolCallId: chunk.toolCallId,
              toolName: chunk.toolName,
              args: safeParseJson(chunk.args),
            },
            agentId: params.agent.id,
            messageId: params.messageId,
          });
          break;

        case "usage":
          turnUsage.inputTokens = chunk.inputTokens;
          turnUsage.outputTokens = chunk.outputTokens;
          break;

        case "stop":
          break;

        case "error":
          throw chunk.error;
      }
    }

    return { text, reasoningText, toolCalls, usage: turnUsage };
  }

  private async executeTool(
    tc: ToolCallInfo,
    tools: AgentTool[],
    toolRuntime: ToolRuntime | undefined,
    run: AgentLoopParams["run"],
    agent: AgentConfig,
    eventBus: EventBus,
    messageId: string,
    abortSignal: AbortSignal,
  ): Promise<ToolResult> {
    const tool = tools.find((t) => t.definition.name === tc.toolName);

    if (!tool) {
      const errorResult: ToolResult = {
        status: "error",
        data: null,
        error: `Tool "${tc.toolName}" not found`,
      };
      emitToolResult(eventBus, run.id, agent.id, messageId, tc, errorResult);
      return errorResult;
    }

    const toolContext: ToolContext = {
      toolCallId: tc.toolCallId,
      runId: run.id,
      sessionId: run.sessionId,
      agentId: agent.id,
      workspaceId: run.workspaceId,
      abortSignal,
      eventBus,
    };

    const parsedParams = safeParseJson(tc.args);
    let result: ToolResult;

    if (toolRuntime) {
      result = await toolRuntime.execute(tool, parsedParams, toolContext);
    } else {
      try {
        result = await tool.execute(parsedParams, toolContext);
      } catch (err) {
        result = {
          status: "error",
          data: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    emitToolResult(eventBus, run.id, agent.id, messageId, tc, result);
    return result;
  }
}

// ─── Internal Types ──────────────────────────────────────────────────────────

interface TurnResult {
  text: string;
  reasoningText: string;
  toolCalls: ToolCallInfo[];
  usage: { inputTokens: number; outputTokens: number };
}

interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  args: string; // Raw JSON string from the LLM
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assembleMessages(systemPrompt: string, history: Message[]): Message[] {
  const messages: Message[] = [];
  if (systemPrompt) {
    messages.push({
      role: "system",
      content: [{ type: "text", text: systemPrompt }],
    });
  }
  messages.push(...history);
  return messages;
}

function toolsToProviderFormat(tools: AgentTool[]): ProviderToolDefinition[] {
  return tools.map((t) => ({
    name: t.definition.name,
    description: t.definition.description,
    parameters: t.definition.parameters,
  }));
}

function safeParseJson(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Check if the user request should be appended (avoids duplication). */
function shouldAppendUserRequest(history: MessageHistory, userRequest: string): boolean {
  const all = history.getAll();
  if (all.length === 0) return true;
  const last = all[all.length - 1];
  if (!last || last.role !== "user") return true;
  const lastText = last.content.find((c) => c.type === "text");
  return !lastText || ("text" in lastText && lastText.text !== userRequest);
}

function emitToolResult(
  eventBus: EventBus,
  runId: string,
  agentId: string,
  messageId: string,
  tc: ToolCallInfo,
  result: ToolResult,
): void {
  eventBus.emit(runId, {
    type: "tool-result",
    data: {
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      result: result.status === "error" ? result.error : result.data,
      status: result.status,
    },
    agentId,
    messageId,
  });
}

function emitUsageAndEnd(
  eventBus: EventBus,
  runId: string,
  agentId: string,
  messageId: string,
  usage: RunUsage,
): void {
  eventBus.emit(runId, {
    type: "usage",
    data: {
      scope: "coordinator",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
    },
    agentId,
  });

  eventBus.emit(runId, {
    type: "message-end",
    data: { messageId },
    agentId,
  });
}

function buildResult(
  runId: string,
  status: RunResult["status"],
  fullText: string,
  usage: RunUsage,
  turnsUsed: number,
  error?: string,
): RunResult {
  return { runId, status, fullText, usage, turnsUsed, error };
}
