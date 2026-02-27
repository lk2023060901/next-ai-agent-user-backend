import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
};

// ─── Auth ────────────────────────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  avatarUrl: text("avatar_url"),
  ...timestamps,
});

export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Organizations ───────────────────────────────────────────────────────────

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  avatarUrl: text("avatar_url"),
  plan: text("plan").notNull().default("free"),
  ...timestamps,
});

export const orgMembers = sqliteTable("org_members", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // owner | admin | member
  joinedAt: text("joined_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Workspaces ──────────────────────────────────────────────────────────────

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  emoji: text("emoji"),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  description: text("description"),
  ...timestamps,
});

// ─── Agents ──────────────────────────────────────────────────────────────────

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role"),
  color: text("color"),
  status: text("status").notNull().default("active"),
  // Source of truth for agent model selection.
  modelId: text("model_id")
    .references(() => aiModels.id, { onDelete: "set null" }),
  // Legacy denormalized display value; kept for backward compatibility.
  model: text("model"),
  systemPrompt: text("system_prompt"),
  temperature: real("temperature").default(0.7),
  maxTokens: integer("max_tokens").default(4096),
  outputFormat: text("output_format").default("text"),
  description: text("description"),
  ...timestamps,
});

export const agentTools = sqliteTable("agent_tools", {
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  toolId: text("tool_id").notNull(),
});

export const agentKnowledgeBases = sqliteTable("agent_knowledge_bases", {
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  knowledgeBaseId: text("knowledge_base_id").notNull(),
});

// ─── Topology ────────────────────────────────────────────────────────────────

export const agentConnections = sqliteTable("agent_connections", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  sourceAgentId: text("source_agent_id").notNull(),
  targetAgentId: text("target_agent_id").notNull(),
  label: text("label"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const blueprints = sqliteTable("blueprints", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  dataJson: text("data_json").notNull().default("{}"),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Chat ────────────────────────────────────────────────────────────────────

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title"),
  isPinned: integer("is_pinned", { mode: "boolean" }).notNull().default(false),
  pinnedAt: text("pinned_at"),
  status: text("status").notNull().default("active"),
  messageCount: integer("message_count").notNull().default(0),
  lastMessageAt: text("last_message_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant | tool
  content: text("content"),
  agentId: text("agent_id"),
  status: text("status").notNull().default("done"),
  parentId: text("parent_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const toolCalls = sqliteTable("tool_calls", {
  id: text("id").primaryKey(),
  messageId: text("message_id")
    .notNull()
    .references(() => messages.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  params: text("params"),
  status: text("status").notNull().default("pending"),
  result: text("result"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
});

// ─── Agent Runs ──────────────────────────────────────────────────────────────

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  coordinatorAgentId: text("coordinator_agent_id"),
  userRequest: text("user_request").notNull(),
  status: text("status").notNull().default("pending"),
  // pending | running | completed | failed | cancelled
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  ...timestamps,
});

export const agentTasks = sqliteTable("agent_tasks", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  instruction: text("instruction").notNull(),
  status: text("status").notNull().default("pending"),
  // pending | running | completed | failed | blocked
  progress: integer("progress").notNull().default(0),
  result: text("result"),
  depth: integer("depth").notNull().default(1),
  parentTaskId: text("parent_task_id"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  ...timestamps,
});

// ─── Tools ───────────────────────────────────────────────────────────────────

export const tools = sqliteTable("tools", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category"),
  description: text("description"),
  riskLevel: text("risk_level").default("low"),
  platform: text("platform"),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).default(false),
});

export const toolAuthorizations = sqliteTable("tool_authorizations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  toolId: text("tool_id")
    .notNull()
    .references(() => tools.id, { onDelete: "cascade" }),
  authorized: integer("authorized", { mode: "boolean" }).default(false),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Knowledge Bases ─────────────────────────────────────────────────────────

export const knowledgeBases = sqliteTable("knowledge_bases", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  embeddingModel: text("embedding_model"),
  documentCount: integer("document_count").notNull().default(0),
  ...timestamps,
});

export const kbDocuments = sqliteTable("kb_documents", {
  id: text("id").primaryKey(),
  knowledgeBaseId: text("knowledge_base_id")
    .notNull()
    .references(() => knowledgeBases.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type"),
  size: integer("size"),
  status: text("status").notNull().default("processing"),
  filePath: text("file_path"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Channels ────────────────────────────────────────────────────────────────

export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("inactive"),
  configJson: text("config_json").default("{}"),
  ...timestamps,
});

export const channelMessages = sqliteTable("channel_messages", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(), // inbound | outbound
  sender: text("sender"),
  content: text("content"),
  status: text("status").notNull().default("received"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const routingRules = sqliteTable("routing_rules", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  operator: text("operator").notNull(),
  value: text("value"),
  targetAgentId: text("target_agent_id"),
  priority: integer("priority").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
});

export const channelSessions = sqliteTable("channel_sessions", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  senderId: text("sender_id").notNull(),    // 平台用户 ID（飞书 open_id）
  chatId: text("chat_id").notNull(),        // 平台会话 ID（用于回复）
  agentId: text("agent_id"),               // 由路由规则决定
  lastActiveAt: text("last_active_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  ...timestamps,
}, (t) => ({
  uniqSession: uniqueIndex("channel_sessions_channel_sender_chat_uniq")
    .on(t.channelId, t.senderId, t.chatId),
}));

// ─── Plugins ─────────────────────────────────────────────────────────────────

export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type"),
  description: text("description"),
  author: text("author"),
  version: text("version"),
  pricingModel: text("pricing_model").default("free"),
  price: real("price").default(0),
  rating: real("rating").default(0),
  installCount: integer("install_count").default(0),
  iconUrl: text("icon_url"),
});

export const installedPlugins = sqliteTable("installed_plugins", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  pluginId: text("plugin_id")
    .notNull()
    .references(() => plugins.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("active"),
  configJson: text("config_json").default("{}"),
  installedAt: text("installed_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Scheduler ───────────────────────────────────────────────────────────────

export const scheduledTasks = sqliteTable("scheduled_tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  instruction: text("instruction"),
  // schedule_type: "cron" | "once"
  scheduleType: text("schedule_type").notNull().default("cron"),
  cronExpression: text("cron_expression"),  // for "cron" type
  runAt: text("run_at"),                    // for "once" type (ISO datetime)
  maxRuns: integer("max_runs"),             // null = unlimited, N = stop after N runs
  runCount: integer("run_count").notNull().default(0),
  targetAgentId: text("target_agent_id"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const taskExecutions = sqliteTable("task_executions", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => scheduledTasks.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("running"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  result: text("result"),
});

// ─── Monitoring ──────────────────────────────────────────────────────────────

export const desktopClients = sqliteTable("desktop_clients", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hostname: text("hostname"),
  platform: text("platform"),
  status: text("status").notNull().default("offline"),
  appVersion: text("app_version"),
  lastSeenAt: text("last_seen_at"),
});

export const operationLogs = sqliteTable("operation_logs", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => desktopClients.id, { onDelete: "cascade" }),
  agentName: text("agent_name"),
  toolName: text("tool_name"),
  status: text("status"),
  riskLevel: text("risk_level"),
  approvalResult: text("approval_result"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
});

// ─── Settings ────────────────────────────────────────────────────────────────

export const aiProviders = sqliteTable("ai_providers", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  apiKeyEncrypted: text("api_key_encrypted"),
  baseUrl: text("base_url"),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const aiModels = sqliteTable("ai_models", {
  id: text("id").primaryKey(),
  providerId: text("provider_id")
    .notNull()
    .references(() => aiProviders.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contextWindow: integer("context_window"),
  costPer1kTokens: real("cost_per_1k_tokens"),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  expiresAt: text("expires_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

// ─── Billing ─────────────────────────────────────────────────────────────────

export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  status: text("status").notNull().default("active"),
  billingCycle: text("billing_cycle").default("monthly"),
  currentPeriodStart: text("current_period_start"),
  currentPeriodEnd: text("current_period_end"),
});

export const invoices = sqliteTable("invoices", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  amount: real("amount").notNull(),
  status: text("status").notNull().default("pending"),
  periodStart: text("period_start"),
  periodEnd: text("period_end"),
  paidAt: text("paid_at"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const paymentMethods = sqliteTable("payment_methods", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  brand: text("brand"),
  last4: text("last4"),
  expiryMonth: integer("expiry_month"),
  expiryYear: integer("expiry_year"),
  isDefault: integer("is_default", { mode: "boolean" }).default(false),
});

export const usageAlerts = sqliteTable("usage_alerts", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  metric: text("metric").notNull(),
  threshold: real("threshold").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).default(true),
  notifyEmail: text("notify_email"),
  notifyWebhook: text("notify_webhook"),
});
