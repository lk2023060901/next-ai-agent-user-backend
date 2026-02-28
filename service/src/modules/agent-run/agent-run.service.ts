import { eq, inArray } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { db } from "../../db";
import {
  agents,
  agentTools,
  agentRuns,
  agentTasks,
  messages,
  chatSessions,
  aiModels,
  aiProviders,
} from "../../db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentConfigResult {
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

export interface CreateRunParams {
  sessionId: string;
  workspaceId: string;
  userRequest: string;
  coordinatorAgentId?: string;
}

export interface AppendMessageParams {
  runId: string;
  role: string;
  content: string;
  agentId?: string;
  parentId?: string;
}

export interface CreateTaskParams {
  runId: string;
  agentId: string;
  instruction: string;
  depth: number;
  parentTaskId?: string;
}

export interface UpdateTaskParams {
  taskId: string;
  status: string;
  progress: number;
  result?: string;
}

export interface TokenUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RecordRunUsageParams extends TokenUsageMetrics {
  runId: string;
}

export interface RecordTaskUsageParams extends TokenUsageMetrics {
  taskId: string;
}

export interface RuntimeMetricsDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  successfulRuns: number;
  failedRuns: number;
  successfulTasks: number;
  failedTasks: number;
}

export interface RuntimeAgentMetrics {
  agentId: string;
  name: string;
  role: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  successfulRuns: number;
  failedRuns: number;
  successfulTasks: number;
  failedTasks: number;
}

export interface WorkspaceRuntimeMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  coordinatorInputTokens: number;
  coordinatorOutputTokens: number;
  coordinatorTotalTokens: number;
  subAgentInputTokens: number;
  subAgentOutputTokens: number;
  subAgentTotalTokens: number;
  successfulRuns: number;
  failedRuns: number;
  successfulTasks: number;
  failedTasks: number;
  daily: RuntimeMetricsDay[];
  agents: RuntimeAgentMetrics[];
}

interface ResolvedLlmConfig {
  model: string;
  llmProviderType: string;
  llmBaseUrl: string;
  llmApiKey: string;
}

function decryptKey(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeUsage(inputTokens: number, outputTokens: number, totalTokens?: number): TokenUsageMetrics {
  const input = toNonNegativeInt(inputTokens);
  const output = toNonNegativeInt(outputTokens);
  const providedTotal = totalTokens !== undefined ? toNonNegativeInt(totalTokens) : undefined;
  const total = providedTotal !== undefined && providedTotal > 0 ? providedTotal : input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function dateKeyFromTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length < 10) return null;
  return trimmed.slice(0, 10);
}

function buildRecentDateKeys(days: number): string[] {
  const safeDays = Math.max(1, Math.min(90, days));
  const out: string[] = [];
  const now = new Date();
  for (let i = safeDays - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function resolveLlmConfigForAgent(workspaceId: string, modelId: string | null): ResolvedLlmConfig {
  if (!modelId) {
    throw Object.assign(new Error("Agent modelId is required"), { code: "INVALID_ARGUMENT" });
  }

  const selectedModel = db.select().from(aiModels).where(eq(aiModels.id, modelId)).get();
  if (!selectedModel) {
    throw Object.assign(new Error("Agent model not found"), { code: "NOT_FOUND" });
  }

  const provider = db.select().from(aiProviders).where(eq(aiProviders.id, selectedModel.providerId)).get();
  if (!provider || provider.workspaceId !== workspaceId) {
    throw Object.assign(
      new Error(`Model "${selectedModel.name}" does not belong to workspace`),
      { code: "INVALID_ARGUMENT" }
    );
  }
  if ((provider.status ?? "active") !== "active") {
    throw Object.assign(
      new Error(`Model provider "${provider.name}" is not active`),
      { code: "INVALID_ARGUMENT" }
    );
  }
  if (!provider.apiKeyEncrypted) {
    throw Object.assign(
      new Error(`Model provider "${provider.name}" has no API key configured`),
      { code: "INVALID_ARGUMENT" }
    );
  }

  return {
    model: selectedModel.name,
    llmProviderType: provider.type.toLowerCase(),
    llmBaseUrl: provider.baseUrl ?? "",
    llmApiKey: decryptKey(provider.apiKeyEncrypted),
  };
}

// ─── Functions ────────────────────────────────────────────────────────────────

export function getAgentConfig(agentId: string): AgentConfigResult {
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!agent) {
    throw Object.assign(new Error("Agent not found"), { code: "NOT_FOUND" });
  }

  const tools = db.select().from(agentTools).where(eq(agentTools.agentId, agentId)).all();
  const toolIds = tools.map((t) => t.toolId);
  const llm = resolveLlmConfigForAgent(agent.workspaceId, agent.modelId ?? null);

  return {
    id: agent.id,
    name: agent.name,
    role: agent.role ?? "",
    model: llm.model,
    systemPrompt: agent.systemPrompt ?? "",
    temperature: agent.temperature ?? 0.7,
    maxTokens: agent.maxTokens ?? 4096,
    toolIds,
    toolAllowJson: "[]",
    toolDenyJson: "[]",
    fsAllowedPathsJson: "[]",
    execAllowedCommandsJson: "[]",
    maxTurns: 20,
    maxSpawnDepth: 3,
    timeoutMs: 300000,
    llmProviderType: llm.llmProviderType,
    llmBaseUrl: llm.llmBaseUrl,
    llmApiKey: llm.llmApiKey,
  };
}

export function createRun(params: CreateRunParams): { runId: string } {
  const session = db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.id, params.sessionId))
    .get();
  if (!session) {
    throw Object.assign(new Error("Chat session not found"), { code: "NOT_FOUND" });
  }

  const runId = uuidv4();
  db.insert(agentRuns)
    .values({
      id: runId,
      sessionId: params.sessionId,
      workspaceId: params.workspaceId,
      coordinatorAgentId: params.coordinatorAgentId ?? null,
      userRequest: params.userRequest,
      status: "pending",
    })
    .run();

  return { runId };
}

export function appendMessage(params: AppendMessageParams): { messageId: string } {
  // Look up the run to find which sessionId it belongs to
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, params.runId)).get();
  if (!run) {
    throw Object.assign(new Error("Agent run not found"), { code: "NOT_FOUND" });
  }

  const session = db.select().from(chatSessions).where(eq(chatSessions.id, run.sessionId)).get();
  if (!session) {
    throw Object.assign(new Error("Chat session not found"), { code: "NOT_FOUND" });
  }

  const messageId = uuidv4();
  db.insert(messages)
    .values({
      id: messageId,
      sessionId: run.sessionId,
      role: params.role,
      content: params.content,
      agentId: params.agentId ?? null,
      parentId: params.parentId ?? null,
      status: "done",
      createdAt: new Date().toISOString(),
    })
    .run();

  db.update(chatSessions)
    .set({
      messageCount: (session.messageCount ?? 0) + 1,
      lastMessageAt: new Date().toISOString(),
    })
    .where(eq(chatSessions.id, run.sessionId))
    .run();

  return { messageId };
}

export function updateRunStatus(runId: string, status: string): void {
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
  if (!run) {
    throw Object.assign(new Error("Agent run not found"), { code: "NOT_FOUND" });
  }

  const now = new Date().toISOString();
  const patch: Partial<typeof agentRuns.$inferInsert> = {
    status,
    startedAt: status === "running" ? now : run.startedAt,
    endedAt: ["completed", "failed", "cancelled"].includes(status) ? now : run.endedAt,
    updatedAt: now,
  };

  if (["completed", "failed", "cancelled"].includes(status)) {
    const tasks = db.select().from(agentTasks).where(eq(agentTasks.runId, runId)).all();

    const subAgentInputTokens = tasks.reduce((sum, task) => sum + (task.inputTokens ?? 0), 0);
    const subAgentOutputTokens = tasks.reduce((sum, task) => sum + (task.outputTokens ?? 0), 0);
    const subAgentTotalTokens = tasks.reduce((sum, task) => sum + (task.totalTokens ?? 0), 0);
    const taskSuccessCount = tasks.filter((task) => task.status === "completed").length;
    const taskFailureCount = tasks.filter((task) => task.status === "failed").length;

    const coordinatorInputTokens = run.coordinatorInputTokens ?? 0;
    const coordinatorOutputTokens = run.coordinatorOutputTokens ?? 0;
    const coordinatorTotalTokens = run.coordinatorTotalTokens ?? 0;

    patch.subAgentInputTokens = subAgentInputTokens;
    patch.subAgentOutputTokens = subAgentOutputTokens;
    patch.subAgentTotalTokens = subAgentTotalTokens;
    patch.taskSuccessCount = taskSuccessCount;
    patch.taskFailureCount = taskFailureCount;
    patch.totalInputTokens = coordinatorInputTokens + subAgentInputTokens;
    patch.totalOutputTokens = coordinatorOutputTokens + subAgentOutputTokens;
    patch.totalTokens = coordinatorTotalTokens + subAgentTotalTokens;
  }

  db.update(agentRuns)
    .set(patch)
    .where(eq(agentRuns.id, runId))
    .run();
}

export function recordRunUsage(params: RecordRunUsageParams): void {
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, params.runId)).get();
  if (!run) {
    throw Object.assign(new Error("Agent run not found"), { code: "NOT_FOUND" });
  }

  const usage = normalizeUsage(params.inputTokens, params.outputTokens, params.totalTokens);
  const subAgentInputTokens = run.subAgentInputTokens ?? 0;
  const subAgentOutputTokens = run.subAgentOutputTokens ?? 0;
  const subAgentTotalTokens = run.subAgentTotalTokens ?? 0;

  db.update(agentRuns)
    .set({
      coordinatorInputTokens: usage.inputTokens,
      coordinatorOutputTokens: usage.outputTokens,
      coordinatorTotalTokens: usage.totalTokens,
      totalInputTokens: usage.inputTokens + subAgentInputTokens,
      totalOutputTokens: usage.outputTokens + subAgentOutputTokens,
      totalTokens: usage.totalTokens + subAgentTotalTokens,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentRuns.id, params.runId))
    .run();
}

export function recordTaskUsage(params: RecordTaskUsageParams): void {
  const task = db.select().from(agentTasks).where(eq(agentTasks.id, params.taskId)).get();
  if (!task) {
    throw Object.assign(new Error("Agent task not found"), { code: "NOT_FOUND" });
  }

  const usage = normalizeUsage(params.inputTokens, params.outputTokens, params.totalTokens);
  db.update(agentTasks)
    .set({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentTasks.id, params.taskId))
    .run();
}

export function createAgentTask(params: CreateTaskParams): { taskId: string } {
  const taskId = uuidv4();
  db.insert(agentTasks)
    .values({
      id: taskId,
      runId: params.runId,
      agentId: params.agentId,
      instruction: params.instruction,
      status: "pending",
      progress: 0,
      depth: params.depth,
      parentTaskId: params.parentTaskId ?? null,
    })
    .run();

  return { taskId };
}

export function updateAgentTask(params: UpdateTaskParams): void {
  const task = db.select().from(agentTasks).where(eq(agentTasks.id, params.taskId)).get();
  if (!task) {
    throw Object.assign(new Error("Agent task not found"), { code: "NOT_FOUND" });
  }

  const now = new Date().toISOString();
  db.update(agentTasks)
    .set({
      status: params.status,
      progress: params.progress,
      result: params.result ?? task.result,
      startedAt: params.status === "running" ? now : task.startedAt,
      endedAt: ["completed", "failed", "blocked"].includes(params.status) ? now : task.endedAt,
      updatedAt: now,
    })
    .where(eq(agentTasks.id, params.taskId))
    .run();
}

export function getWorkspaceRuntimeMetrics(workspaceId: string, days = 7): WorkspaceRuntimeMetrics {
  const safeDays = Math.max(1, Math.min(90, Math.floor(days || 7)));
  const dateKeys = buildRecentDateKeys(safeDays);
  const dateSet = new Set(dateKeys);
  const dayToIndex = new Map(dateKeys.map((date, index) => [date, index]));

  const runs = db.select().from(agentRuns).where(eq(agentRuns.workspaceId, workspaceId)).all();
  const runIds = runs.map((run) => run.id);
  const tasks = runIds.length > 0
    ? db.select().from(agentTasks).where(inArray(agentTasks.runId, runIds)).all()
    : [];
  const agentRows = db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
    })
    .from(agents)
    .where(eq(agents.workspaceId, workspaceId))
    .all();

  const tasksByRun = new Map<string, Array<typeof agentTasks.$inferSelect>>();
  for (const task of tasks) {
    const list = tasksByRun.get(task.runId) ?? [];
    list.push(task);
    tasksByRun.set(task.runId, list);
  }

  const daily: RuntimeMetricsDay[] = dateKeys.map((date) => ({
    date,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    successfulRuns: 0,
    failedRuns: 0,
    successfulTasks: 0,
    failedTasks: 0,
  }));

  const agentMap = new Map<string, RuntimeAgentMetrics>();
  const ensureAgentMetric = (agentId: string, name: string, role: string) => {
    const existing = agentMap.get(agentId);
    if (existing) return existing;
    const created: RuntimeAgentMetrics = {
      agentId,
      name,
      role,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      successfulRuns: 0,
      failedRuns: 0,
      successfulTasks: 0,
      failedTasks: 0,
    };
    agentMap.set(agentId, created);
    return created;
  };

  for (const agent of agentRows) {
    ensureAgentMetric(agent.id, agent.name, agent.role ?? "");
  }

  const totals: Omit<WorkspaceRuntimeMetrics, "daily" | "agents"> = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    coordinatorInputTokens: 0,
    coordinatorOutputTokens: 0,
    coordinatorTotalTokens: 0,
    subAgentInputTokens: 0,
    subAgentOutputTokens: 0,
    subAgentTotalTokens: 0,
    successfulRuns: 0,
    failedRuns: 0,
    successfulTasks: 0,
    failedTasks: 0,
  };
  const includedRunIds = new Set<string>();

  for (const run of runs) {
    const runTasks = tasksByRun.get(run.id) ?? [];
    const fallbackSubInput = runTasks.reduce((sum, task) => sum + (task.inputTokens ?? 0), 0);
    const fallbackSubOutput = runTasks.reduce((sum, task) => sum + (task.outputTokens ?? 0), 0);
    const fallbackSubTotal = runTasks.reduce((sum, task) => sum + (task.totalTokens ?? 0), 0);
    const fallbackTaskSuccess = runTasks.filter((task) => task.status === "completed").length;
    const fallbackTaskFailed = runTasks.filter((task) => task.status === "failed").length;

    const coordinatorInputTokens = run.coordinatorInputTokens ?? 0;
    const coordinatorOutputTokens = run.coordinatorOutputTokens ?? 0;
    const coordinatorTotalTokens = run.coordinatorTotalTokens ?? 0;

    const hasStoredSubUsage =
      (run.subAgentInputTokens ?? 0) > 0 ||
      (run.subAgentOutputTokens ?? 0) > 0 ||
      (run.subAgentTotalTokens ?? 0) > 0 ||
      (run.taskSuccessCount ?? 0) > 0 ||
      (run.taskFailureCount ?? 0) > 0;

    const subAgentInputTokens = hasStoredSubUsage ? (run.subAgentInputTokens ?? 0) : fallbackSubInput;
    const subAgentOutputTokens = hasStoredSubUsage ? (run.subAgentOutputTokens ?? 0) : fallbackSubOutput;
    const subAgentTotalTokens = hasStoredSubUsage ? (run.subAgentTotalTokens ?? 0) : fallbackSubTotal;

    const totalInputTokens = coordinatorInputTokens + subAgentInputTokens;
    const totalOutputTokens = coordinatorOutputTokens + subAgentOutputTokens;
    const totalTokens = coordinatorTotalTokens + subAgentTotalTokens;

    const successfulTasks = hasStoredSubUsage ? (run.taskSuccessCount ?? 0) : fallbackTaskSuccess;
    const failedTasks = hasStoredSubUsage ? (run.taskFailureCount ?? 0) : fallbackTaskFailed;
    const successfulRuns = run.status === "completed" ? 1 : 0;
    const failedRuns = run.status === "failed" ? 1 : 0;

    const dayKey = dateKeyFromTimestamp(run.endedAt ?? run.updatedAt ?? run.createdAt);
    if (!dayKey || !dateSet.has(dayKey)) {
      continue;
    }
    includedRunIds.add(run.id);

    totals.totalInputTokens += totalInputTokens;
    totals.totalOutputTokens += totalOutputTokens;
    totals.totalTokens += totalTokens;
    totals.coordinatorInputTokens += coordinatorInputTokens;
    totals.coordinatorOutputTokens += coordinatorOutputTokens;
    totals.coordinatorTotalTokens += coordinatorTotalTokens;
    totals.subAgentInputTokens += subAgentInputTokens;
    totals.subAgentOutputTokens += subAgentOutputTokens;
    totals.subAgentTotalTokens += subAgentTotalTokens;
    totals.successfulRuns += successfulRuns;
    totals.failedRuns += failedRuns;
    totals.successfulTasks += successfulTasks;
    totals.failedTasks += failedTasks;

    const index = dayToIndex.get(dayKey);
    if (index !== undefined) {
      daily[index]!.inputTokens += totalInputTokens;
      daily[index]!.outputTokens += totalOutputTokens;
      daily[index]!.totalTokens += totalTokens;
      daily[index]!.successfulRuns += successfulRuns;
      daily[index]!.failedRuns += failedRuns;
      daily[index]!.successfulTasks += successfulTasks;
      daily[index]!.failedTasks += failedTasks;
    }

    if (run.coordinatorAgentId) {
      const agent = ensureAgentMetric(run.coordinatorAgentId, run.coordinatorAgentId, "");
      agent.inputTokens += coordinatorInputTokens;
      agent.outputTokens += coordinatorOutputTokens;
      agent.totalTokens += coordinatorTotalTokens;
      agent.successfulRuns += successfulRuns;
      agent.failedRuns += failedRuns;
    }
  }

  for (const task of tasks) {
    if (!includedRunIds.has(task.runId)) continue;
    const metric = ensureAgentMetric(task.agentId, task.agentId, "");
    metric.inputTokens += task.inputTokens ?? 0;
    metric.outputTokens += task.outputTokens ?? 0;
    metric.totalTokens += task.totalTokens ?? 0;
    if (task.status === "completed") metric.successfulTasks += 1;
    if (task.status === "failed") metric.failedTasks += 1;
  }

  const agentsSorted = [...agentMap.values()]
    .filter(
      (item) =>
        item.totalTokens > 0 ||
        item.successfulRuns > 0 ||
        item.failedRuns > 0 ||
        item.successfulTasks > 0 ||
        item.failedTasks > 0,
    )
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    ...totals,
    daily,
    agents: agentsSorted,
  };
}
