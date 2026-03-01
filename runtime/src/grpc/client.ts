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
  llmCandidates?: Array<{
    model: string;
    llmProviderType: string;
    llmBaseUrl: string;
    llmApiKey: string;
  }>;
}

export interface RuntimePluginLoadCandidate {
  installedPluginId: string;
  workspaceId: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  pluginType: string;
  status: string;
  configJson: string;
  installPath: string;
  sourceType: string;
  sourceSpec: string;
}

export interface ContinueContext {
  runId: string;
  sessionId: string;
  workspaceId: string;
  coordinatorAgentId: string;
  userRequest: string;
  assistantContent: string;
}

export interface PluginUsageEvent {
  specVersion: string;
  pluginName: string;
  pluginVersion: string;
  eventId: string;
  eventType: string;
  timestamp: string;
  workspaceId: string;
  runId: string;
  status: "success" | "failure" | "partial";
  metricsJson: string;
  payloadJson: string;
}

export const grpcClient = {
  getAgentConfig(agentId: string): Promise<AgentConfig> {
    return promisify<AgentConfig>(agentRunClient, "getAgentConfig", { agentId });
  },

  getContinueContextByMessage(assistantMessageId: string): Promise<ContinueContext> {
    return promisify<ContinueContext>(agentRunClient, "getContinueContextByMessage", {
      assistantMessageId,
    });
  },

  getContinueContextByRun(runId: string): Promise<ContinueContext> {
    return promisify<ContinueContext>(agentRunClient, "getContinueContextByRun", {
      runId,
    });
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

  recordRunUsage(params: {
    runId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): Promise<void> {
    return promisify(agentRunClient, "recordRunUsage", {
      runId: params.runId,
      coordinatorInputTokens: params.inputTokens,
      coordinatorOutputTokens: params.outputTokens,
      coordinatorTotalTokens: params.totalTokens,
    });
  },

  recordTaskUsage(params: {
    taskId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): Promise<void> {
    return promisify(agentRunClient, "recordTaskUsage", {
      taskId: params.taskId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      totalTokens: params.totalTokens,
    });
  },

  reportPluginUsageEvents(params: {
    workspaceId: string;
    events: PluginUsageEvent[];
  }): Promise<{ accepted: number }> {
    return promisify(agentRunClient, "reportPluginUsageEvents", {
      workspaceId: params.workspaceId,
      events: params.events,
    });
  },

  listRuntimePlugins(): Promise<{ plugins: RuntimePluginLoadCandidate[] }> {
    return promisify(agentRunClient, "listRuntimePlugins", {});
  },

  reportRuntimePluginLoad(params: {
    installedPluginId: string;
    workspaceId: string;
    pluginId: string;
    status: "success" | "failure";
    operation?: "load" | "reload" | "unload" | "bootstrap";
    message?: string;
    actorUserId?: string;
  }): Promise<{ updated: boolean }> {
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
};
