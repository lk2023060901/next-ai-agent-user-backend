import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { config } from "../config.js";

function loadProto(file: string) {
  return protoLoader.loadSync(path.join(config.protoDir, file), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [config.protoDir],
  });
}

function createClient(pkg: any, ServiceClass: any): any {
  return new ServiceClass(config.grpcAddr, grpc.credentials.createInsecure());
}

function promisify<T>(client: any, method: string, request: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    client[method](request, (err: grpc.ServiceError | null, response: T) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

// ─── AgentRunService client ───────────────────────────────────────────────────

const agentRunPkg = grpc.loadPackageDefinition(loadProto("agent_run.proto")) as any;
const agentRunClient = createClient(agentRunPkg, agentRunPkg.agent_run.AgentRunService);

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  toolIds: string[];
  toolAllowJson: string;
  toolDenyJson: string;
  fsAllowedPathsJson: string;
  execAllowedCommandsJson: string;
  maxTurns: number;
  maxSpawnDepth: number;
  timeoutMs: number;
  llmProviderType: string;
  llmBaseUrl: string;
  llmApiKey: string;
}

export const grpcClient = {
  getAgentConfig(agentId: string): Promise<AgentConfig> {
    return promisify<AgentConfig>(agentRunClient, "getAgentConfig", { agentId });
  },

  createRun(params: {
    sessionId: string;
    workspaceId: string;
    userRequest: string;
    coordinatorAgentId?: string;
  }): Promise<{ runId: string }> {
    return promisify(agentRunClient, "createRun", params);
  },

  appendMessage(params: {
    runId: string;
    role: string;
    content: string;
    agentId?: string;
    parentId?: string;
  }): Promise<{ messageId: string }> {
    return promisify(agentRunClient, "appendMessage", params);
  },

  updateRunStatus(runId: string, status: string): Promise<void> {
    return promisify(agentRunClient, "updateRunStatus", { runId, status });
  },

  createTask(params: {
    runId: string;
    agentId: string;
    instruction: string;
    depth: number;
    parentTaskId?: string;
  }): Promise<{ taskId: string }> {
    return promisify(agentRunClient, "createTask", params);
  },

  updateTask(params: {
    taskId: string;
    status: string;
    progress: number;
    result?: string;
  }): Promise<void> {
    return promisify(agentRunClient, "updateTask", params);
  },
};
