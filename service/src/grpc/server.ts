import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "path";
import { login, signup, logout, refresh, getMe } from "../modules/auth/auth.service";
import { getOrg, updateOrg, listMembers, listWorkspaces, getDashboardStats, listOrgs } from "../modules/org/org.service";
import {
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from "../modules/workspace/workspace.service";
import {
  listProviders, createProvider, updateProvider, deleteProvider, testProvider,
  listModels, listAllModels, createModel, updateModel, deleteModel,
  listApiKeys, createApiKey, deleteApiKey,
} from "../modules/settings/settings.service";
import {
  listTools, listToolAuthorizations, upsertToolAuthorization,
} from "../modules/tools/tools.service";
import {
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  listRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule,
  handleWebhook, listChannelMessages, sendChannelMessage,
} from "../modules/channel/channel.service";
import { getPlugin } from "../modules/channel/plugins";
import {
  listTasks, createTask, updateTask, deleteTask, runTask, listExecutions, bootstrapScheduler,
} from "../modules/scheduler/scheduler.service";
import {
  getAgentConfig, createRun, appendMessage, updateRunStatus, createAgentTask, updateAgentTask,
  recordRunUsage, recordTaskUsage, reportPluginUsageEvents as reportPluginUsageEventsFromAgentRun,
} from "../modules/agent-run/agent-run.service";
import {
  listSessions, createSession, updateSession, deleteSession, listMessages, saveUserMessage, updateUserMessage,
  getRuntimeMetrics, listUsageRecords,
  reportWorkspacePluginUsageEvents,
  listAgents, createAgent, getAgent, updateAgent, deleteAgent,
} from "../modules/chat/chat.service";
import {
  getMarketplacePlugin,
  installWorkspacePlugin,
  listMarketplacePlugins,
  listPluginReviews,
  listWorkspaceInstalledPlugins,
  listRuntimePluginLoadCandidates,
  reportRuntimePluginLoad,
  uninstallWorkspacePlugin,
  updateWorkspacePluginConfig,
  updateWorkspacePluginStatus,
  type InstalledPluginItem,
  type PluginConfigField,
  type PluginMarketplaceItem,
  type PluginReviewItem,
  type RuntimePluginLoadCandidate,
} from "../modules/plugins/plugin.service";

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
    case "UNIMPLEMENTED": return grpc.status.UNIMPLEMENTED;
    case "INVALID_ARGUMENT": return grpc.status.INVALID_ARGUMENT;
    default: return grpc.status.INTERNAL;
  }
}

function handleError(callback: grpc.sendUnaryData<any>, err: unknown) {
  const e = err as any;
  callback(grpcError(mapErrorCode(e.code), e.message ?? "internal error"));
}

function readNumberField(input: Record<string, unknown>, keys: string[]): number | undefined {
  const parse = (raw: unknown): number | undefined => {
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  };

  for (const key of keys) {
    const parsed = parse(input[key]);
    if (parsed !== undefined) return parsed;
  }

  const normalizedTargets = new Set(keys.map((k) => k.toLowerCase().replaceAll("_", "")));
  for (const [key, raw] of Object.entries(input)) {
    const normalizedKey = key.toLowerCase().replaceAll("_", "");
    if (!normalizedTargets.has(normalizedKey)) continue;
    const parsed = parse(raw);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function pluginConfigFieldToProto(field: PluginConfigField): Record<string, unknown> {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    placeholder: field.placeholder ?? "",
    description: field.description ?? "",
    options: field.options.map((option) => ({
      value: option.value,
      label: option.label,
    })),
    defaultValueJson: field.defaultValueJson ?? "",
  };
}

function pluginItemToProto(item: PluginMarketplaceItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    longDescription: item.longDescription,
    author: item.author,
    authorAvatar: item.authorAvatar,
    icon: item.icon,
    type: item.type,
    version: item.version,
    pricingModel: item.pricingModel,
    price: item.price,
    monthlyPrice: item.monthlyPrice,
    trialDays: item.trialDays,
    rating: item.rating,
    reviewCount: item.reviewCount,
    installCount: item.installCount,
    tags: item.tags,
    permissions: item.permissions,
    configSchema: item.configSchema.map(pluginConfigFieldToProto),
    screenshots: item.screenshots,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    sourceType: item.sourceType ?? "",
    sourceSpec: item.sourceSpec ?? "",
  };
}

function installedPluginToProto(item: InstalledPluginItem): Record<string, unknown> {
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    pluginId: item.pluginId,
    plugin: pluginItemToProto(item.plugin),
    status: item.status,
    configJson: JSON.stringify(item.config ?? {}),
    installedAt: item.installedAt,
    installedBy: item.installedBy,
  };
}

function pluginReviewToProto(item: PluginReviewItem): Record<string, unknown> {
  return {
    id: item.id,
    pluginId: item.pluginId,
    authorName: item.authorName,
    rating: item.rating,
    content: item.content,
    createdAt: item.createdAt,
  };
}

function runtimePluginLoadCandidateToProto(item: RuntimePluginLoadCandidate): Record<string, unknown> {
  return {
    installedPluginId: item.installedPluginId,
    workspaceId: item.workspaceId,
    pluginId: item.pluginId,
    pluginName: item.pluginName,
    pluginVersion: item.pluginVersion,
    pluginType: item.pluginType,
    status: item.status,
    configJson: item.configJson,
    installPath: item.installPath,
    sourceType: item.sourceType,
    sourceSpec: item.sourceSpec,
  };
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
    listOrgs(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const userId = call.request.userContext?.userId;
        callback(null, { orgs: listOrgs(userId) });
      } catch (err) { handleError(callback, err); }
    },
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
          activeAgents:   { value: stats.activeAgents.value,   trend: stats.activeAgents.trend,   sparkline: stats.activeAgents.sparkline },
          todaySessions:  { value: stats.todaySessions.value,  trend: stats.todaySessions.trend,  sparkline: stats.todaySessions.sparkline },
          tokenUsage:     { value: stats.tokenUsage.value,     trend: stats.tokenUsage.trend,     sparkline: stats.tokenUsage.sparkline },
          completedTasks: { value: stats.completedTasks.value, trend: stats.completedTasks.trend, sparkline: stats.completedTasks.sparkline },
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
    async testProvider(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = await testProvider(call.request.id);
        callback(null, { success: result.success, message: result.message });
      } catch (err) { handleError(callback, err); }
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
        const costPer1kTokens = readNumberField(call.request as Record<string, unknown>, [
          "costPer1kTokens",
          "costPer1KTokens",
          "costPer_1KTokens",
          "cost_per_1k_tokens",
        ]);
        callback(null, createModel({
          providerId: call.request.providerId, name: call.request.name,
          contextWindow: call.request.contextWindow, costPer1kTokens,
          isDefault: call.request.isDefault,
        }));
      } catch (err) { handleError(callback, err); }
    },
    updateModel(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const costPer1kTokens = readNumberField(call.request as Record<string, unknown>, [
          "costPer1kTokens",
          "costPer1KTokens",
          "costPer_1KTokens",
          "cost_per_1k_tokens",
        ]);
        callback(null, updateModel(call.request.id, {
          name: call.request.name, contextWindow: call.request.contextWindow,
          costPer1kTokens, isDefault: call.request.isDefault,
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
    async testConnection(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const config = JSON.parse(call.request.configJson || '{}') as Record<string, string>;
        const result = await getPlugin(call.request.type).testConnection(config);
        callback(null, { success: result.success, botName: result.botName ?? '', error: result.error ?? '' });
      } catch (err) { handleError(callback, err); }
    },
    async sendChannelMessage(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        await sendChannelMessage({
          channelId: call.request.channelId,
          chatId: call.request.chatId,
          text: call.request.text,
          threadId: call.request.threadId || undefined,
        })
        callback(null, {})
      } catch (err) { handleError(callback, err) }
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

  // ── AgentRun ──────────────────────────────────────────────────────────────
  const agentRunPkg = grpc.loadPackageDefinition(loadProto("agent_run.proto")) as any;
  server.addService(agentRunPkg.agent_run.AgentRunService.service, {
    getAgentConfig(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = getAgentConfig(call.request.agentId);
        callback(null, {
          id: result.id,
          name: result.name,
          role: result.role,
          model: result.model,
          systemPrompt: result.systemPrompt,
          temperature: result.temperature,
          maxTokens: result.maxTokens,
          toolIds: result.toolIds,
          toolAllowJson: result.toolAllowJson,
          toolDenyJson: result.toolDenyJson,
          fsAllowedPathsJson: result.fsAllowedPathsJson,
          execAllowedCommandsJson: result.execAllowedCommandsJson,
          maxTurns: result.maxTurns,
          maxSpawnDepth: result.maxSpawnDepth,
          timeoutMs: result.timeoutMs,
          llmProviderType: result.llmProviderType,
          llmBaseUrl: result.llmBaseUrl,
          llmApiKey: result.llmApiKey,
        });
      } catch (err) { handleError(callback, err); }
    },
    createRun(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const { runId } = createRun({
          sessionId: call.request.sessionId,
          workspaceId: call.request.workspaceId,
          userRequest: call.request.userRequest,
          coordinatorAgentId: call.request.coordinatorAgentId,
        });
        callback(null, { runId });
      } catch (err) { handleError(callback, err); }
    },
    appendMessage(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const { messageId } = appendMessage({
          runId: call.request.runId,
          role: call.request.role,
          content: call.request.content,
          agentId: call.request.agentId,
          parentId: call.request.parentId,
        });
        callback(null, { messageId });
      } catch (err) { handleError(callback, err); }
    },
    updateRunStatus(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        updateRunStatus(call.request.runId, call.request.status);
        callback(null, {});
      } catch (err) { handleError(callback, err); }
    },
    createTask(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const { taskId } = createAgentTask({
          runId: call.request.runId,
          agentId: call.request.agentId,
          instruction: call.request.instruction,
          depth: call.request.depth,
          parentTaskId: call.request.parentTaskId,
        });
        callback(null, { taskId });
      } catch (err) { handleError(callback, err); }
    },
    updateTask(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        updateAgentTask({
          taskId: call.request.taskId,
          status: call.request.status,
          progress: call.request.progress,
          result: call.request.result,
        });
        callback(null, {});
      } catch (err) { handleError(callback, err); }
    },
    recordRunUsage(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        recordRunUsage({
          runId: call.request.runId,
          inputTokens: call.request.coordinatorInputTokens,
          outputTokens: call.request.coordinatorOutputTokens,
          totalTokens: call.request.coordinatorTotalTokens,
        });
        callback(null, {});
      } catch (err) { handleError(callback, err); }
    },
    recordTaskUsage(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        recordTaskUsage({
          taskId: call.request.taskId,
          inputTokens: call.request.inputTokens,
          outputTokens: call.request.outputTokens,
          totalTokens: call.request.totalTokens,
        });
        callback(null, {});
      } catch (err) { handleError(callback, err); }
    },
    reportPluginUsageEvents(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const workspaceId = String(call.request.workspaceId ?? "");
        const events = Array.isArray(call.request.events)
          ? call.request.events.map((item: Record<string, unknown>) => ({
              specVersion: String(item.specVersion ?? ""),
              pluginName: String(item.pluginName ?? ""),
              pluginVersion: String(item.pluginVersion ?? ""),
              eventId: String(item.eventId ?? ""),
              eventType: String(item.eventType ?? ""),
              timestamp: String(item.timestamp ?? ""),
              workspaceId: String(item.workspaceId ?? ""),
              runId: String(item.runId ?? ""),
              status: String(item.status ?? ""),
              metricsJson: String(item.metricsJson ?? ""),
              payloadJson: String(item.payloadJson ?? ""),
            }))
          : [];
        const result = reportPluginUsageEventsFromAgentRun(workspaceId, events);
        callback(null, { accepted: result.accepted });
      } catch (err) { handleError(callback, err); }
    },
    listRuntimePlugins(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const plugins = listRuntimePluginLoadCandidates();
        callback(null, {
          plugins: plugins.map(runtimePluginLoadCandidateToProto),
        });
      } catch (err) { handleError(callback, err); }
    },
    reportRuntimePluginLoad(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = reportRuntimePluginLoad({
          installedPluginId: String(call.request.installedPluginId ?? ""),
          workspaceId: String(call.request.workspaceId ?? ""),
          pluginId: String(call.request.pluginId ?? ""),
          status: String(call.request.status ?? ""),
          operation: String(call.request.operation ?? ""),
          message: String(call.request.message ?? ""),
          actorUserId: String(call.request.actorUserId ?? "runtime"),
        });
        callback(null, { updated: result.updated });
      } catch (err) { handleError(callback, err); }
    },
  });

  // ── Chat (Sessions / Messages / Agents) ───────────────────────────────────
  const chatPkg = grpc.loadPackageDefinition(loadProto("chat.proto")) as any;
  server.addService(chatPkg.chat.ChatService.service, {
    listSessions(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { sessions: listSessions(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    createSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, createSession(call.request.workspaceId, call.request.title)); }
      catch (err) { handleError(callback, err); }
    },
    updateSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateSession({
          sessionId: call.request.sessionId,
          title: call.request.title,
          isPinned: call.request.isPinned,
          updateTitle: call.request.updateTitle,
          updateIsPinned: call.request.updateIsPinned,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteSession(call.request.sessionId); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
    listMessages(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const page = listMessages(call.request.sessionId, {
          limit: call.request.limit,
          beforeMessageId: call.request.beforeMessageId,
        });
        callback(null, {
          messages: page.messages,
          hasMore: page.hasMore,
          nextBeforeMessageId: page.nextBeforeMessageId,
        });
      }
      catch (err) { handleError(callback, err); }
    },
    saveUserMessage(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, saveUserMessage(call.request.sessionId, call.request.content)); }
      catch (err) { handleError(callback, err); }
    },
    updateUserMessage(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = updateUserMessage(
          call.request.sessionId,
          call.request.messageId,
          call.request.content,
        );
        callback(null, {
          message: result.message,
          removedMessageIds: result.removedMessageIds,
        });
      }
      catch (err) { handleError(callback, err); }
    },
    getRuntimeMetrics(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = getRuntimeMetrics(call.request.workspaceId, call.request.days);
        callback(null, {
          totalInputTokens: result.totalInputTokens,
          totalOutputTokens: result.totalOutputTokens,
          totalTokens: result.totalTokens,
          coordinatorInputTokens: result.coordinatorInputTokens,
          coordinatorOutputTokens: result.coordinatorOutputTokens,
          coordinatorTotalTokens: result.coordinatorTotalTokens,
          subAgentInputTokens: result.subAgentInputTokens,
          subAgentOutputTokens: result.subAgentOutputTokens,
          subAgentTotalTokens: result.subAgentTotalTokens,
          successfulRuns: result.successfulRuns,
          failedRuns: result.failedRuns,
          successfulTasks: result.successfulTasks,
          failedTasks: result.failedTasks,
          daily: result.daily.map((item) => ({
            date: item.date,
            inputTokens: item.inputTokens,
            outputTokens: item.outputTokens,
            totalTokens: item.totalTokens,
            successfulRuns: item.successfulRuns,
            failedRuns: item.failedRuns,
            successfulTasks: item.successfulTasks,
            failedTasks: item.failedTasks,
          })),
          agents: result.agents.map((item) => ({
            agentId: item.agentId,
            name: item.name,
            role: item.role,
            inputTokens: item.inputTokens,
            outputTokens: item.outputTokens,
            totalTokens: item.totalTokens,
            successfulRuns: item.successfulRuns,
            failedRuns: item.failedRuns,
            successfulTasks: item.successfulTasks,
            failedTasks: item.failedTasks,
          })),
        });
      } catch (err) { handleError(callback, err); }
    },
    listUsageRecords(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = listUsageRecords(call.request.workspaceId, {
          limit: call.request.limit,
          offset: call.request.offset,
          startDate: call.request.startDate,
          endDate: call.request.endDate,
        });
        callback(null, {
          records: result.records.map((item) => ({
            id: item.id,
            workspaceId: item.workspaceId,
            orgId: item.orgId,
            sessionId: item.sessionId,
            runId: item.runId,
            taskId: item.taskId,
            recordType: item.recordType,
            scope: item.scope,
            status: item.status,
            agentId: item.agentId,
            agentName: item.agentName,
            agentRole: item.agentRole,
            providerId: item.providerId,
            providerName: item.providerName,
            modelId: item.modelId,
            modelName: item.modelName,
            inputTokens: item.inputTokens,
            outputTokens: item.outputTokens,
            totalTokens: item.totalTokens,
            successCount: item.successCount,
            failureCount: item.failureCount,
            startedAt: item.startedAt,
            endedAt: item.endedAt,
            recordedAt: item.recordedAt,
            metadataJson: item.metadataJson,
          })),
          total: result.total,
          sumInputTokens: result.sumInputTokens,
          sumOutputTokens: result.sumOutputTokens,
          sumTotalTokens: result.sumTotalTokens,
          sumSuccessCount: result.sumSuccessCount,
          sumFailureCount: result.sumFailureCount,
        });
      } catch (err) { handleError(callback, err); }
    },
    reportPluginUsageEvents(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const workspaceId = (call.request.workspaceId ?? "").trim();
        const events = Array.isArray(call.request.events)
          ? call.request.events.map((item: Record<string, unknown>) => ({
              specVersion: String(item.specVersion ?? ""),
              pluginName: String(item.pluginName ?? ""),
              pluginVersion: String(item.pluginVersion ?? ""),
              eventId: String(item.eventId ?? ""),
              eventType: String(item.eventType ?? ""),
              timestamp: String(item.timestamp ?? ""),
              workspaceId: String(item.workspaceId ?? ""),
              runId: String(item.runId ?? ""),
              status: String(item.status ?? ""),
              metricsJson: String(item.metricsJson ?? ""),
              payloadJson: String(item.payloadJson ?? ""),
            }))
          : [];
        const result = reportWorkspacePluginUsageEvents(workspaceId, events);
        callback(null, { accepted: result.accepted });
      } catch (err) { handleError(callback, err); }
    },
    async listMarketplacePlugins(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const result = await listMarketplacePlugins({
          type: call.request.type,
          pricingModel: call.request.pricingModel,
          search: call.request.search,
          sort: call.request.sort,
          page: call.request.page,
          pageSize: call.request.pageSize,
        });

        callback(null, {
          data: result.data.map(pluginItemToProto),
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
          totalPages: result.totalPages,
        });
      } catch (err) { handleError(callback, err); }
    },
    async getMarketplacePlugin(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const plugin = await getMarketplacePlugin(call.request.pluginId);
        callback(null, pluginItemToProto(plugin));
      } catch (err) { handleError(callback, err); }
    },
    listPluginReviews(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const reviews = listPluginReviews(call.request.pluginId);
        callback(null, { reviews: reviews.map(pluginReviewToProto) });
      } catch (err) { handleError(callback, err); }
    },
    async listWorkspacePlugins(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const items = await listWorkspaceInstalledPlugins(call.request.workspaceId);
        callback(null, { plugins: items.map(installedPluginToProto) });
      } catch (err) { handleError(callback, err); }
    },
    async installWorkspacePlugin(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const installed = await installWorkspacePlugin({
          workspaceId: String(call.request.workspaceId ?? ""),
          pluginId: String(call.request.pluginId ?? ""),
          configJson: String(call.request.configJson ?? ""),
          sourceType: String(call.request.sourceType ?? ""),
          sourceSpec: String(call.request.sourceSpec ?? ""),
          sourceIntegrity: String(call.request.sourceIntegrity ?? ""),
          sourcePin: Boolean(call.request.sourcePin),
          installedBy: String(call.request.userContext?.userId ?? "system"),
        });
        callback(null, installedPluginToProto(installed));
      } catch (err) { handleError(callback, err); }
    },
    async updateWorkspacePlugin(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const updated = await updateWorkspacePluginStatus({
          workspaceId: String(call.request.workspaceId ?? ""),
          pluginKey: String(call.request.pluginId ?? ""),
          status: String(call.request.status ?? ""),
          actorUserId: String(call.request.userContext?.userId ?? "system"),
        });
        callback(null, installedPluginToProto(updated));
      } catch (err) { handleError(callback, err); }
    },
    async updateWorkspacePluginConfig(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        const updated = await updateWorkspacePluginConfig({
          workspaceId: String(call.request.workspaceId ?? ""),
          pluginKey: String(call.request.pluginId ?? ""),
          configJson: String(call.request.configJson ?? ""),
          actorUserId: String(call.request.userContext?.userId ?? "system"),
        });
        callback(null, installedPluginToProto(updated));
      } catch (err) { handleError(callback, err); }
    },
    async uninstallWorkspacePlugin(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        await uninstallWorkspacePlugin(
          String(call.request.workspaceId ?? ""),
          String(call.request.pluginId ?? ""),
          String(call.request.userContext?.userId ?? "system"),
        );
        callback(null, {});
      } catch (err) { handleError(callback, err); }
    },
    listAgents(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, { agents: listAgents(call.request.workspaceId) }); }
      catch (err) { handleError(callback, err); }
    },
    createAgent(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, createAgent({
          workspaceId: call.request.workspaceId,
          name: call.request.name,
          role: call.request.role,
          modelId: call.request.modelId,
          color: call.request.color,
          description: call.request.description,
          systemPrompt: call.request.systemPrompt,
          temperature: call.request.temperature,
          outputFormat: call.request.outputFormat,
          tools: call.request.tools,
          knowledgeBases: call.request.knowledgeBases,
        }));
      } catch (err) { handleError(callback, err); }
    },
    getAgent(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { callback(null, getAgent(call.request.id)); }
      catch (err) { handleError(callback, err); }
    },
    updateAgent(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try {
        callback(null, updateAgent({
          id: call.request.id,
          name: call.request.name,
          role: call.request.role,
          modelId: call.request.modelId,
          color: call.request.color,
          description: call.request.description,
          systemPrompt: call.request.systemPrompt,
          temperature: call.request.temperature,
          outputFormat: call.request.outputFormat,
          tools: call.request.tools,
          knowledgeBases: call.request.knowledgeBases,
        }));
      } catch (err) { handleError(callback, err); }
    },
    deleteAgent(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      try { deleteAgent(call.request.id); callback(null, {}); }
      catch (err) { handleError(callback, err); }
    },
  });

  return server;
}
