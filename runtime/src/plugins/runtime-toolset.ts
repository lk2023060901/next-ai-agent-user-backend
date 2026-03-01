import { jsonSchema, tool, type CoreTool } from "ai";
import { listWorkspaceRuntimePlugins, type LoadedRuntimePlugin, type RuntimePluginExecutionContext } from "./runtime-loader.js";

export interface RuntimePluginToolsetParams {
  workspaceId: string;
  runId: string;
  taskId: string;
  agentId: string;
  depth: number;
  reservedNames?: string[];
}

interface RuntimeToolExecutionOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
  messages: unknown[];
}

function uniqueToolName(base: string, occupied: Set<string>): string {
  if (!occupied.has(base)) {
    occupied.add(base);
    return base;
  }

  let index = 2;
  while (occupied.has(`${base}_${index}`)) {
    index += 1;
  }
  const next = `${base}_${index}`;
  occupied.add(next);
  return next;
}

function buildExecutionContext(params: {
  plugin: LoadedRuntimePlugin;
  runId: string;
  taskId: string;
  agentId: string;
  depth: number;
}): RuntimePluginExecutionContext {
  return {
    runId: params.runId,
    taskId: params.taskId,
    agentId: params.agentId,
    depth: params.depth,
    workspaceId: params.plugin.workspaceId,
    pluginId: params.plugin.pluginId,
    installedPluginId: params.plugin.installedPluginId,
    pluginName: params.plugin.pluginName,
    pluginVersion: params.plugin.pluginVersion,
    pluginConfig: params.plugin.pluginConfig,
  };
}

async function executePluginTool(params: {
  plugin: LoadedRuntimePlugin;
  args: unknown;
  options: RuntimeToolExecutionOptions;
  context: RuntimePluginExecutionContext;
}): Promise<unknown> {
  const execute = params.plugin.tool.execute;
  const mode = params.plugin.tool.executeMode;

  if (mode === "ai-sdk") {
    return await execute(params.args, params.options, params.context);
  }
  if (mode === "args-only") {
    return await execute(params.args, params.context);
  }
  return await execute(params.options.toolCallId, params.args, params.context);
}

export function buildRuntimePluginToolset(params: RuntimePluginToolsetParams): Record<string, CoreTool> {
  const out: Record<string, CoreTool> = {};
  const occupied = new Set(params.reservedNames ?? []);
  const plugins = listWorkspaceRuntimePlugins(params.workspaceId);

  for (const plugin of plugins) {
    const toolName = uniqueToolName(plugin.tool.name, occupied);
    const executionContext = buildExecutionContext({
      plugin,
      runId: params.runId,
      taskId: params.taskId,
      agentId: params.agentId,
      depth: params.depth,
    });

    out[toolName] = tool({
      description: plugin.tool.description,
      parameters: jsonSchema(plugin.tool.parametersJsonSchema as any),
      execute: async (args, options) => {
        try {
          return await executePluginTool({
            plugin,
            args,
            options,
            context: executionContext,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            error: message,
            pluginId: plugin.pluginId,
            toolName,
          };
        }
      },
    });
  }

  return out;
}
