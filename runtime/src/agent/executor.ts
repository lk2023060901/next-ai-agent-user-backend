import { streamText } from "ai";
import { v4 as uuidv4 } from "uuid";
import type { SandboxPolicy } from "../policy/sandbox.js";
import type { SseEmitter } from "../sse/emitter.js";
import type { grpcClient as GrpcClientType } from "../grpc/client.js";
import { buildToolset } from "../tools/registry.js";
import { buildModelForAgent } from "../llm/model-factory.js";

export interface ExecutorParams {
  agentId: string;
  instruction: string;
  taskId: string;
  runId: string;
  depth: number;
  sandbox: SandboxPolicy;
  emit: SseEmitter;
  grpc: typeof GrpcClientType;
}

export async function runExecutor(params: ExecutorParams): Promise<{ result: string }> {
  const agentCfg = await params.grpc.getAgentConfig(params.agentId);
  const messageId = uuidv4();
  const pendingToolCalls = new Map<string, string[]>();

  await params.grpc.updateTask({
    taskId: params.taskId,
    status: "running",
    progress: 0,
  });

  params.emit({
    type: "message-start",
    runId: params.runId,
    messageId,
    agentId: params.agentId,
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
      model: buildModelForAgent(agentCfg),
      system: agentCfg.systemPrompt || undefined,
      messages: [{ role: "user", content: params.instruction }],
      tools: Object.keys(tools).length > 0 ? tools : undefined,
      maxSteps: params.sandbox.maxTurns,
    });

    for await (const chunk of result.fullStream) {
      const c = chunk as {
        type: string;
        textDelta?: string;
        text?: string;
        reasoning?: string;
        toolCallId?: string;
        toolName?: string;
        args?: unknown;
        result?: unknown;
      };
      if (c.type === "text-delta" && c.textDelta !== undefined) {
        fullText += c.textDelta;
        params.emit({
          type: "text-delta",
          runId: params.runId,
          messageId,
          text: c.textDelta,
          delta: c.textDelta,
        });
      } else if (c.type === "reasoning-delta") {
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
      } else if (c.type === "reasoning") {
        const text = c.text ?? c.reasoning ?? "";
        if (text) params.emit({ type: "reasoning", runId: params.runId, messageId, text });
      } else if (c.type === "tool-call") {
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
      } else if (c.type === "tool-result") {
        const toolName = c.toolName ?? "unknown_tool";
        const queue = pendingToolCalls.get(toolName);
        const queuedToolCallId = queue && queue.length > 0 ? queue.shift() : undefined;
        if (queue && queue.length === 0) pendingToolCalls.delete(toolName);
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
    }

    await params.grpc.updateTask({
      taskId: params.taskId,
      status: "completed",
      progress: 100,
      result: fullText,
    });

    if (fullText.trim().length > 0) {
      await params.grpc.appendMessage({
        runId: params.runId,
        role: "assistant",
        content: fullText,
        agentId: params.agentId,
      });
    }

    params.emit({
      type: "task-complete",
      runId: params.runId,
      messageId,
      taskId: params.taskId,
      result: fullText,
    });

    return { result: fullText };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await params.grpc.updateTask({
      taskId: params.taskId,
      status: "failed",
      progress: 0,
      result: msg,
    });
    params.emit({
      type: "task-failed",
      runId: params.runId,
      messageId,
      taskId: params.taskId,
      error: msg,
    });
    return { result: `Error: ${msg}` };
  }
}
