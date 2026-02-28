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
function createClient(pkg, ServiceClass) {
    return new ServiceClass(config.grpcAddr, grpc.credentials.createInsecure());
}
function promisify(client, method, request) {
    return new Promise((resolve, reject) => {
        client[method](request, (err, response) => {
            if (err)
                reject(err);
            else
                resolve(response);
        });
    });
}
// ─── AgentRunService client ───────────────────────────────────────────────────
const agentRunPkg = grpc.loadPackageDefinition(loadProto("agent_run.proto"));
const agentRunClient = createClient(agentRunPkg, agentRunPkg.agent_run.AgentRunService);
export const grpcClient = {
    getAgentConfig(agentId) {
        return promisify(agentRunClient, "getAgentConfig", { agentId });
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
};
