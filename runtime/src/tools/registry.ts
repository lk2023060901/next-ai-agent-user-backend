import type { CoreTool } from "ai";
import type { SandboxPolicy } from "../policy/sandbox.js";
import type { SseEmitter } from "../sse/emitter.js";
import type { grpcClient } from "../grpc/client.js";
import { isToolAllowed } from "../policy/tool-policy.js";
import { makeCodeReadTool } from "./code-read.js";
import { makeCodeWriteTool } from "./code-write.js";
import { makeSearchKnowledgeTool } from "./search-knowledge.js";
import { makeWebSearchTool } from "./web-search.js";
import { makeDelegateTool } from "./delegate.js";
import { buildRuntimePluginToolset } from "../plugins/runtime-toolset.js";

export interface ToolRegistryParams {
  runId: string;
  taskId: string;
  workspaceId: string;
  agentId: string;
  depth: number;
  sandbox: SandboxPolicy;
  emit: SseEmitter;
  grpc: typeof grpcClient;
  agentConfigModel: string;
}

export function buildToolset(params: ToolRegistryParams): Record<string, CoreTool> {
  const allTools: Record<string, CoreTool> = {
    code_read: makeCodeReadTool(params.sandbox.fsPolicy),
    code_write: makeCodeWriteTool(params.sandbox.fsPolicy),
    search_knowledge: makeSearchKnowledgeTool(),
    web_search: makeWebSearchTool(),
    delegate_to_agent: makeDelegateTool(params),
  };

  const pluginTools = buildRuntimePluginToolset({
    workspaceId: params.workspaceId,
    runId: params.runId,
    taskId: params.taskId,
    agentId: params.agentId,
    agentModel: params.agentConfigModel,
    depth: params.depth,
    reservedNames: Object.keys(allTools),
  });
  Object.assign(allTools, pluginTools);

  // Filter by tool policy — deny wins over allow
  const filtered: Record<string, CoreTool> = {};
  for (const [name, tool] of Object.entries(allTools)) {
    if (isToolAllowed(name, params.sandbox.toolPolicy)) {
      filtered[name] = tool;
    }
  }
  return filtered;
}
