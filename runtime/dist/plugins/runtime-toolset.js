import { jsonSchema, tool } from "ai";
import { listWorkspaceRuntimePlugins } from "./runtime-loader.js";
import { grpcClient } from "../grpc/client.js";
import { reportPluginToolUsageEvent } from "./plugin-usage-reporter.js";
import { isPluginExecutionGuardError, runtimePluginExecutionGuard } from "./plugin-execution-guard.js";
function uniqueToolName(base, occupied) {
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
function buildExecutionContext(params) {
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
async function executePluginTool(params) {
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
export function buildRuntimePluginToolset(params) {
    const out = {};
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
        out[toolName] = tool({
            description: plugin.tool.description,
            parameters: jsonSchema(plugin.tool.parametersJsonSchema),
            execute: async (args, options) => {
                const startedAtMs = Date.now();
                try {
                    const guarded = await runtimePluginExecutionGuard.run({
                        pluginKey: plugin.installedPluginId,
                        execute: () => executePluginTool({
                            plugin,
                            args,
                            options,
                            context: executionContext,
                        }),
                    });
                    const result = guarded.result;
                    void reportPluginToolUsageEvent({
                        grpc: grpcClient,
                        plugin,
                        context: executionContext,
                        toolName,
                        toolCallId: options.toolCallId,
                        startedAtMs,
                        endedAtMs: Date.now(),
                        result,
                        guardAudit: guarded.guardMeta,
                    }).catch(() => undefined);
                    return result;
                }
                catch (err) {
                    const guardError = isPluginExecutionGuardError(err) ? err : null;
                    const message = guardError?.message ?? (err instanceof Error ? err.message : String(err));
                    const errorCode = guardError?.code ?? "plugin_execution_error";
                    void reportPluginToolUsageEvent({
                        grpc: grpcClient,
                        plugin,
                        context: executionContext,
                        toolName,
                        toolCallId: options.toolCallId,
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
        });
    }
    return out;
}
