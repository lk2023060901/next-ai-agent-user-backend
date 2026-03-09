import { stream, type Model, type Api, type Context, type Tool, type AssistantMessageEvent } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";
import type { RuntimeTool } from "../tools/types.js";
import type { SseEmitter } from "../sse/emitter.js";

export type ToolMap = Record<string, RuntimeTool>;

export interface StreamLoopParams {
  model: Model<Api>;
  systemPrompt: string;
  userMessage: string;
  tools: ToolMap;
  maxSteps: number;
  apiKey: string;
  emit: SseEmitter;
  runId: string;
  messageId: string;
}

export interface StreamLoopResult {
  fullText: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

function toPiTools(tools: ToolMap): Tool<TSchema>[] {
  return Object.values(tools).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

export async function runStreamLoop(params: StreamLoopParams): Promise<StreamLoopResult> {
  const context: Context = {
    systemPrompt: params.systemPrompt || undefined,
    messages: [
      { role: "user", content: [{ type: "text", text: params.userMessage }], timestamp: Date.now() },
    ],
    tools: toPiTools(params.tools),
  };

  let fullText = "";
  const totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  for (let step = 0; step < params.maxSteps; step++) {
    const pendingToolCalls: Array<{ id: string; name: string; args: Record<string, any> }> = [];

    const eventStream = stream(params.model, context, {
      apiKey: params.apiKey,
      signal: AbortSignal.timeout(120_000),
    });

    for await (const event of eventStream as AsyncIterable<AssistantMessageEvent>) {
      switch (event.type) {
        case "text_delta":
          fullText += event.delta;
          params.emit({
            type: "text-delta",
            runId: params.runId,
            messageId: params.messageId,
            text: event.delta,
            delta: event.delta,
          });
          break;

        case "thinking_delta":
          params.emit({
            type: "reasoning-delta",
            runId: params.runId,
            messageId: params.messageId,
            text: event.delta,
            delta: event.delta,
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

        case "toolcall_end":
          pendingToolCalls.push({
            id: event.toolCall.id,
            name: event.toolCall.name,
            args: event.toolCall.arguments,
          });
          params.emit({
            type: "tool-call",
            runId: params.runId,
            messageId: params.messageId,
            toolCallId: event.toolCall.id,
            toolName: event.toolCall.name,
            args: event.toolCall.arguments,
          });
          break;

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
    if (pendingToolCalls.length === 0) break;

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
      } catch (err) {
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

  return { fullText, usage: totalUsage };
}
