import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { login, signup, logout, refresh, getMe } from "../modules/auth/auth.service";
import { getOrg, updateOrg, listMembers, listWorkspaces, getDashboardStats } from "../modules/org/org.service";
import {
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "../modules/workspace/workspace.service";
import {
  listProviders, createProvider, updateProvider, deleteProvider,
  listModels, listAllModels, createModel, updateModel, deleteModel,
  listApiKeys, createApiKey, deleteApiKey,
} from "../modules/settings/settings.service";
import {
  listTools, listToolAuthorizations, upsertToolAuthorization,
} from "../modules/tools/tools.service";
import {
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  listRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule,
  handleWebhook, listChannelMessages,
} from "../modules/channel/channel.service";
import {
  listTasks, createTask, updateTask, deleteTask, runTask, listExecutions, bootstrapScheduler,
} from "../modules/scheduler/scheduler.service";

const PROTO_DIR = path.join(__dirname, "../../../proto");

function loadProto(file: string) {
  return protoLoader.loadSync(path.join(PROTO_DIR, file), {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
}

function grpcError(code: grpc.status, message: string): grpc.ServiceError {
  const err = new Error(message) as grpc.ServiceError;
  err.code = code;
  return err;
}

function mapErrorCode(code?: string): grpc.status {
  switch (code) {
    case "ALREADY_EXISTS": return grpc.status.ALREADY_EXISTS;
    case "UNAUTHENTICATED": return grpc.status.UNAUTHENTICATED;
    case "NOT_FOUND": return grpc.status.NOT_FOUND;
    default: return grpc.status.INTERNAL;
  }
}

function handleError(callback: grpc.sendUnaryData<any>, err: unknown) {
  const e = err as any;
  callback(grpcError(mapErrorCode(e.code), e.message ?? "internal error"));
}

export function startGrpcServer(port: number): grpc.Server {
  const server = new grpc.Server();

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authPkg = grpc.loadPackageDefinition(loadProto("auth.proto")) as any;
  server.addService(authPkg.auth.AuthService.service, {
    async login(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const { tokens, user } = await login(call.request.email, call.request.password);
        callback(null, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user });
      } catch (err) { handleError(callback, err); }
    },
    async signup(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const { tokens, user } = await signup(call.request.email, call.request.password, call.request.name);
        callback(null, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user });
      } catch (err) { handleError(callback, err); }
    },
    logout(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { logout(call.request.refreshToken); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
    async refreshToken(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const { tokens, user } = await refresh(call.request.refreshToken);
        callback(null, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user });
      } catch (err) { handleError(callback, err); }
    },
    getMe(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const userId = call.request.userContext?.userId;
        if (!userId) { callback(grpcError(grpc.status.UNAUTHENTICATED, "missing user context")); return; }
        callback(null, getMe(userId));
      } catch (err) { handleError(callback, err); }
    },
  });

  // ── Org ───────────────────────────────────────────────────────────────────
  const orgPkg = grpc.loadPackageDefinition(loadProto("org.proto")) as any;
  server.addService(orgPkg.org.OrgService.service, {
    getOrg(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, getOrg(call.request.slug)); }
      catch (err) { handleError(callback, err); }
    },
    updateOrg(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateOrg(call.request.slug, { name: call.request.name, avatarUrl: call.request.avatarUrl }));
      } catch (err) { handleError(callback, err); }
    },
    listMembers(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { members: listMembers(call.request.orgId) }); }
      catch (err) { handleError(callback, err); }
    },
    listWorkspaces(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { workspaces: listWorkspaces(call.request.orgId) }); }
      catch (err) { handleError(callback, err); }
    },
    getDashboardStats(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const stats = getDashboardStats(call.request.orgId);
        callback(null, {
          totalAgents: stats.totalAgents,
          totalSessions: stats.totalSessions,
          totalMessages: stats.totalMessages,
          activeChannels: stats.activeChannels,
        });
      } catch (err) { handleError(callback, err); }
    },
  });

  // ── Workspace ─────────────────────────────────────────────────────────────
  const wsPkg = grpc.loadPackageDefinition(loadProto("workspace.proto")) as any;
  server.addService(wsPkg.workspace.WorkspaceService.service, {
    getWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, getWorkspace(call.request.workspaceId)); }
      catch (err) { handleError(callback, err); }
    },
    createWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, createWorkspace({
          orgId: call.request.orgId,
          name: call.request.name,
          emoji: call.request.emoji,
          description: call.request.description,
        }));
      } catch (err) { handleError(callback, err); }
    },
    updateWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateWorkspace(call.request.workspaceId, {
          name: call.request.name,
          emoji: call.request.emoji,
          description: call.request.description,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteWorkspace(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteWorkspace(call.request.workspaceId); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  const settingsPkg = grpc.loadPackageDefinition(loadProto("settings.proto")) as any;
  server.addService(settingsPkg.settings.SettingsService.service, {
    listProviders(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { providers: listProviders(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    createProvider(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, createProvider({
          workspaceId: call.request.workspaceId, name: call.request.name,
          type: call.request.type, apiKey: call.request.apiKey, baseUrl: call.request.baseUrl,
        }));
      } catch (err) { handleError(callback, err); }
    },
    updateProvider(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateProvider(call.request.id, {
          name: call.request.name, apiKey: call.request.apiKey,
          baseUrl: call.request.baseUrl, status: call.request.status,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteProvider(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteProvider(call.request.id); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
    listModels(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { models: listModels(call.request.providerId) }); }
      catch (err) { handleError(callback, err); }
    },
    listAllModels(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { models: listAllModels(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    createModel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, createModel({
          providerId: call.request.providerId, name: call.request.name,
          contextWindow: call.request.contextWindow, costPer1kTokens: call.request.costPer1kTokens,
          isDefault: call.request.isDefault,
        }));
      } catch (err) { handleError(callback, err); }
    },
    updateModel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateModel(call.request.id, {
          name: call.request.name, contextWindow: call.request.contextWindow,
          costPer1kTokens: call.request.costPer1kTokens, isDefault: call.request.isDefault,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteModel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteModel(call.request.id); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
    listApiKeys(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { apiKeys: listApiKeys(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    createApiKey(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const { apiKey, rawKey } = createApiKey({
          workspaceId: call.request.workspaceId, name: call.request.name, expiresAt: call.request.expiresAt,
        });
        callback(null, { apiKey, rawKey });
      } catch (err) { handleError(callback, err); }
    },
    deleteApiKey(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteApiKey(call.request.id); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
  });

  // ── Tools ─────────────────────────────────────────────────────────────────
  const toolsPkg = grpc.loadPackageDefinition(loadProto("tools.proto")) as any;
  server.addService(toolsPkg.tools.ToolsService.service, {
    listTools(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { tools: listTools(call.request.category) }); }
      catch (err) { handleError(callback, err); }
    },
    listToolAuthorizations(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { authorizations: listToolAuthorizations(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    upsertToolAuthorization(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, upsertToolAuthorization({
          workspaceId: call.request.workspaceId,
          toolId: call.request.toolId,
          authorized: call.request.authorized,
        }));
      } catch (err) { handleError(callback, err); }
    },
  });

  // ── Channels ──────────────────────────────────────────────────────────────
  const channelsPkg = grpc.loadPackageDefinition(loadProto("channels.proto")) as any;
  server.addService(channelsPkg.channels.ChannelsService.service, {
    listChannels(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { channels: listChannels(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    getChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, getChannel(call.request.channelId)); }
      catch (err) { handleError(callback, err); }
    },
    createChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, createChannel({
          workspaceId: call.request.workspaceId, name: call.request.name,
          type: call.request.type, configJson: call.request.configJson,
        }));
      } catch (err) { handleError(callback, err); }
    },
    updateChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateChannel(call.request.channelId, {
          name: call.request.name, status: call.request.status, configJson: call.request.configJson,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteChannel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteChannel(call.request.channelId); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
    listRoutingRules(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { rules: listRoutingRules(call.request.channelId) }); }
      catch (err) { handleError(callback, err); }
    },
    createRoutingRule(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, createRoutingRule({
          channelId: call.request.channelId, field: call.request.field,
          operator: call.request.operator, value: call.request.value,
          targetAgentId: call.request.targetAgentId, priority: call.request.priority,
        }));
      } catch (err) { handleError(callback, err); }
    },
    updateRoutingRule(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateRoutingRule(call.request.ruleId, {
          field: call.request.field, operator: call.request.operator,
          value: call.request.value, targetAgentId: call.request.targetAgentId,
          priority: call.request.priority, enabled: call.request.enabled,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteRoutingRule(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteRoutingRule(call.request.ruleId); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
    handleWebhook(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = handleWebhook(call.request.channelId, call.request.body, call.request.headers ?? {});
        callback(null, result);
      } catch (err) { handleError(callback, err); }
    },
    listChannelMessages(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, { messages: listChannelMessages(call.request.channelId, call.request.limit || 50) });
      } catch (err) { handleError(callback, err); }
    },
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) throw err;
      console.log(`gRPC server listening on :${boundPort}`);
      bootstrapScheduler();
    }
  );

  // ── Scheduler ─────────────────────────────────────────────────────────────
  const schedulerPkg = grpc.loadPackageDefinition(loadProto("scheduler.proto")) as any;
  server.addService(schedulerPkg.scheduler.SchedulerService.service, {
    listTasks(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { tasks: listTasks(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    async createTask(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, createTask({
          workspaceId: call.request.workspaceId,
          name: call.request.name,
          instruction: call.request.instruction,
          scheduleType: call.request.scheduleType || "cron",
          cronExpression: call.request.cronExpression,
          runAt: call.request.runAt,
          maxRuns: call.request.maxRuns || undefined,
          targetAgentId: call.request.targetAgentId,
        }));
      } catch (err) { handleError(callback, err); }
    },
    updateTask(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateTask(call.request.taskId, {
          name: call.request.name,
          instruction: call.request.instruction,
          scheduleType: call.request.scheduleType,
          cronExpression: call.request.cronExpression,
          runAt: call.request.runAt,
          maxRuns: call.request.maxRuns || undefined,
          targetAgentId: call.request.targetAgentId,
          status: call.request.status,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteTask(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteTask(call.request.taskId); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
    async runTask(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, await runTask(call.request.taskId)); }
      catch (err) { handleError(callback, err); }
    },
    listExecutions(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { executions: listExecutions(call.request.taskId, call.request.limit || 20) }); }
      catch (err) { handleError(callback, err); }
    },
  });

  return server;
}
