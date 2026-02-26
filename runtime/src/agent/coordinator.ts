import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ToolSet } from "ai";
import { v4 as uuidv4 } from "uuid";
import type { SandboxPolicy } from "../policy/sandbox.js";
import type { SseEmitter } from "../sse/emitter.js";
import type { grpcClient as GrpcClientType } from "../grpc/client.js";
import { config } from "../config.js";
import { makeDelegateTool } from "../tools/delegate.js";
import { isToolAllowed } from "../policy/tool-policy.js";

export interface CoordinatorParams {
  runId: string;
  coordinatorAgentId: string;
  userMessage: string;
  sandbox: SandboxPolicy;
  emit: SseEmitter;
  grpc: typeof GrpcClientType;
}

export async function runCoordinator(params: CoordinatorParams): Promise<void> {
  const agentCfg = await params.grpc.getAgentConfig(params.coordinatorAgentId);

  params.emit({ type: "message-start", agentId: params.coordinatorAgentId });

  // If LLM_BASE_URL + LLM_API_KEY are set, call the provider directly (e.g. BigModel).
  // Otherwise route through Bifrost sidecar.
  const llm = createOpenAI({
    baseURL: config.llmBaseUrl || `${config.bifrostAddr}/v1`,
    apiKey: config.llmApiKey || "runtime",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const rootTaskId = uuidv4();

  const tools: ToolSet = {};
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

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const result = streamText({
    model: llm(agentCfg.model) as any,
    system: agentCfg.systemPrompt || undefined,
    messages: [{ role: "user", content: params.userMessage }],
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    maxSteps: params.sandbox.maxTurns,
  });

  try {
    for await (const chunk of result.fullStream) {
      const c = chunk as { type: string; textDelta?: string; toolName?: string; args?: unknown; result?: unknown; error?: unknown };
      if (c.type === "text-delta" && c.textDelta !== undefined) {
        params.emit({ type: "text-delta", text: c.textDelta });
      } else if (c.type === "tool-call") {
        params.emit({ type: "tool-call", toolName: c.toolName!, args: c.args });
      } else if (c.type === "tool-result") {
        params.emit({ type: "tool-result", toolName: c.toolName!, result: c.result });
      } else if (c.type === "error") {
        throw new Error(String(c.error));
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.emit({ type: "task-failed", taskId: params.runId, error: msg });
    params.emit({ type: "message-end", runId: params.runId });
    throw err;
  }

  params.emit({ type: "message-end", runId: params.runId });
}
