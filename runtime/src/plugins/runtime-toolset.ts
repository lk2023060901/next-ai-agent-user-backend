import { Type } from "@sinclair/typebox";
import type { RuntimeTool, ToolContext } from "../tools/types.js";
import { listWorkspaceRuntimePlugins, type LoadedRuntimePlugin, type RuntimePluginExecutionContext } from "./runtime-loader.js";
import { grpcClient } from "../grpc/client.js";
import { reportPluginToolUsageEvent } from "./plugin-usage-reporter.js";
import { isPluginExecutionGuardError, runtimePluginExecutionGuard } from "./plugin-execution-guard.js";

export interface RuntimePluginToolsetParams {
  workspaceId: string;
  runId: string;
  taskId: string;
  agentId: string;
  agentModel: string;
  depth: number;
  reservedNames?: string[];
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
  agentModel: string;
  depth: number;
}): RuntimePluginExecutionContext {
  return {
    runId: params.runId,
    taskId: params.taskId,
    agentId: params.agentId,
    agentModel: params.agentModel,
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
  toolContext: ToolContext;
  context: RuntimePluginExecutionContext;
}): Promise<unknown> {
  const execute = params.plugin.tool.execute;
  const mode = params.plugin.tool.executeMode;

  if (mode === "ai-sdk") {
    // ai-sdk mode: (args, options, context) — map ToolContext to the expected shape
    const options = {
      toolCallId: params.toolContext.toolCallId,
      abortSignal: params.toolContext.signal,
      messages: [],
    };
    return await execute(params.args, options, params.context);
  }
  if (mode === "args-only") {
    return await execute(params.args, params.context);
  }
  // legacy mode: (toolCallId, args, context)
  return await execute(params.toolContext.toolCallId, params.args, params.context);
}

export function buildRuntimePluginToolset(params: RuntimePluginToolsetParams): Record<string, RuntimeTool> {
  const out: Record<string, RuntimeTool> = {};
  const occupied = new Set(params.reservedNames ?? []);
  const plugins = listWorkspaceRuntimePlugins(params.workspaceId);

  for (const plugin of plugins) {
    const toolName = uniqueToolName(plugin.tool.name, occupied);
    const executionContext = buildExecutionContext({
      plugin,
      runId: params.runId,
      taskId: params.taskId,
      agentId: params.agentId,
      agentModel: params.agentModel,
      depth: params.depth,
    });

    // Use Type.Unsafe to wrap the plugin's raw JSON Schema as a TypeBox schema
    const parameters = Type.Unsafe(plugin.tool.parametersJsonSchema as any);

    out[toolName] = {
      name: toolName,
      description: plugin.tool.description,
      parameters,
      execute: async (args: unknown, toolContext: ToolContext) => {
        const startedAtMs = Date.now();
        try {
          const guarded = await runtimePluginExecutionGuard.run({
            pluginKey: plugin.installedPluginId,
            execute: () =>
              executePluginTool({
                plugin,
                args,
                toolContext,
                context: executionContext,
              }),
          });
          const result = guarded.result;
          void reportPluginToolUsageEvent({
            grpc: grpcClient,
            plugin,
            context: executionContext,
            toolName,
            toolCallId: toolContext.toolCallId,
            startedAtMs,
            endedAtMs: Date.now(),
            result,
            guardAudit: guarded.guardMeta,
          }).catch(() => undefined);
          return result;
        } catch (err) {
          const guardError = isPluginExecutionGuardError(err) ? err : null;
          const message = guardError?.message ?? (err instanceof Error ? err.message : String(err));
          const errorCode = guardError?.code ?? "plugin_execution_error";
          void reportPluginToolUsageEvent({
            grpc: grpcClient,
            plugin,
            context: executionContext,
            toolName,
            toolCallId: toolContext.toolCallId,
            startedAtMs,
            endedAtMs: Date.now(),
            errorMessage: message,
            errorCode,
            guardAudit: guardError?.meta,
          }).catch(() => undefined);
          return {
            error: message,
            errorCode,
            pluginId: plugin.pluginId,
            toolName,
          };
        }
      },
    };
  }

  return out;
}
