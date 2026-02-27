import { eq } from "drizzle-orm";
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

interface ResolvedLlmConfig {
  model: string;
  llmProviderType: string;
  llmBaseUrl: string;
  llmApiKey: string;
}

function decryptKey(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
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
  db.update(agentRuns)
    .set({
      status,
      startedAt: status === "running" ? now : run.startedAt,
      endedAt: ["completed", "failed", "cancelled"].includes(status) ? now : run.endedAt,
      updatedAt: now,
    })
    .where(eq(agentRuns.id, runId))
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
