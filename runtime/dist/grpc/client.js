import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { config } from "../config.js";
function loadProto(file) {
    return protoLoader.loadSync(path.join(config.protoDir, file), {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [config.protoDir],
    });
}
function createClient(pkg, serviceName) {
    const ServiceCtor = pkg[serviceName];
    return new ServiceCtor(config.grpcAddr, grpc.credentials.createInsecure());
}
function promisify(client, method, request) {
    return new Promise((resolve, reject) => {
        const deadline = new Date(Date.now() + config.grpcCallTimeoutMs);
        const fn = client[method];
        if (typeof fn !== "function") {
            return reject(new Error(`gRPC method "${method}" not found on client`));
        }
        fn.call(client, request, { deadline }, (err, response) => {
            if (err)
                reject(err);
            else
                resolve(response);
        });
    });
}
// ─── AgentRunService client ───────────────────────────────────────────────────
const agentRunPkg = grpc.loadPackageDefinition(loadProto("agent_run.proto"));
const agentRunNs = agentRunPkg["agent_run"];
const agentRunClient = createClient(agentRunNs, "AgentRunService");
// ─── ToolsService client ────────────────────────────────────────────────────
const toolsPkg = grpc.loadPackageDefinition(loadProto("tools.proto"));
const toolsNs = toolsPkg["tools"];
const toolsClient = createClient(toolsNs, "ToolsService");
export const grpcClient = {
    getAgentConfig(agentId, modelIdOverride) {
        return promisify(agentRunClient, "getAgentConfig", {
            agentId,
            ...(modelIdOverride ? { modelIdOverride } : {}),
        });
    },
    getContinueContextByMessage(assistantMessageId) {
        return promisify(agentRunClient, "getContinueContextByMessage", {
            assistantMessageId,
        });
    },
    getContinueContextByRun(runId) {
        return promisify(agentRunClient, "getContinueContextByRun", {
            runId,
        });
    },
    createRun(params) {
        return promisify(agentRunClient, "createRun", params);
    },
    appendMessage(params) {
        return promisify(agentRunClient, "appendMessage", params);
    },
    updateRunStatus(runId, status) {
        return promisify(agentRunClient, "updateRunStatus", { runId, status });
    },
    createTask(params) {
        return promisify(agentRunClient, "createTask", params);
    },
    updateTask(params) {
        return promisify(agentRunClient, "updateTask", params);
    },
    recordRunUsage(params) {
        return promisify(agentRunClient, "recordRunUsage", {
            runId: params.runId,
            coordinatorInputTokens: params.inputTokens,
            coordinatorOutputTokens: params.outputTokens,
            coordinatorTotalTokens: params.totalTokens,
        });
    },
    recordTaskUsage(params) {
        return promisify(agentRunClient, "recordTaskUsage", {
            taskId: params.taskId,
            inputTokens: params.inputTokens,
            outputTokens: params.outputTokens,
            totalTokens: params.totalTokens,
        });
    },
    reportPluginUsageEvents(params) {
        return promisify(agentRunClient, "reportPluginUsageEvents", {
            workspaceId: params.workspaceId,
            events: params.events,
        });
    },
    listRuntimePlugins() {
        return promisify(agentRunClient, "listRuntimePlugins", {});
    },
    reportRuntimePluginLoad(params) {
        return promisify(agentRunClient, "reportRuntimePluginLoad", {
            installedPluginId: params.installedPluginId,
            workspaceId: params.workspaceId,
            pluginId: params.pluginId,
            status: params.status,
            operation: params.operation ?? "load",
            message: params.message ?? "",
            actorUserId: params.actorUserId ?? "runtime",
        });
    },
    // ─── KB Search (ToolsService) ──────────────────────────────────────────
    searchKnowledgeBase(params) {
        return promisify(toolsClient, "searchKnowledgeBase", {
            knowledgeBaseId: params.knowledgeBaseId,
            query: params.query,
            topK: params.topK ?? 5,
            // Runtime calls don't need user context
            userContext: { userId: "runtime", role: "service" },
        });
    },
    listKnowledgeBases(workspaceId) {
        return promisify(toolsClient, "listKnowledgeBases", {
            workspaceId,
            userContext: { userId: "runtime", role: "service" },
        });
    },
};
