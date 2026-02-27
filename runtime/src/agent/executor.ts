import { streamText } from "ai";
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

  await params.grpc.updateTask({
    taskId: params.taskId,
    status: "running",
    progress: 0,
  });

  params.emit({ type: "message-start", agentId: params.agentId });

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
        toolName?: string;
        args?: unknown;
        result?: unknown;
      };
      if (c.type === "text-delta" && c.textDelta !== undefined) {
        fullText += c.textDelta;
        params.emit({ type: "text-delta", text: c.textDelta });
      } else if (c.type === "reasoning-delta") {
        const text = c.textDelta ?? c.text ?? c.reasoning ?? "";
        if (text) params.emit({ type: "reasoning-delta", text });
      } else if (c.type === "reasoning") {
        const text = c.text ?? c.reasoning ?? "";
        if (text) params.emit({ type: "reasoning", text });
      } else if (c.type === "tool-call") {
        params.emit({ type: "tool-call", toolName: c.toolName!, args: c.args });
      } else if (c.type === "tool-result") {
        params.emit({ type: "tool-result", toolName: c.toolName!, result: c.result });
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

    params.emit({ type: "task-complete", taskId: params.taskId, result: fullText });

    return { result: fullText };
  } catch (err) {
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
