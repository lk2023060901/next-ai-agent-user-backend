import type { AgentEvent } from "./event-types.js";
import type { SseEvent } from "../sse/emitter.js";
import { formatSseData } from "../sse/emitter.js";

/**
 * Convert a structured AgentEvent to the flat SseEvent wire format
 * expected by the frontend.
 *
 * Returns null for internal-only events (memory, compaction, lifecycle
 * internals) that have no SseEvent counterpart.
 */
export function agentEventToSse(event: AgentEvent): SseEvent | null {
  const base = {
    seq: event.seq,
    emittedAt: new Date(event.ts).toISOString(),
  };

  switch (event.type) {
    case "message-start":
      return {
        ...base,
        type: "message-start",
        runId: event.runId,
        messageId: event.messageId ?? event.data.messageId,
        agentId: event.agentId ?? "",
      };

    case "text-delta":
      return {
        ...base,
        type: "text-delta",
        runId: event.runId,
        messageId: event.messageId,
        text: event.data.delta,
      };

    case "reasoning-delta":
      return {
        ...base,
        type: "reasoning-delta",
        runId: event.runId,
        messageId: event.messageId,
        text: event.data.delta,
      };

    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        runId: event.runId,
        messageId: event.messageId,
        text: event.data.text,
      };

    case "tool-call":
      return {
        ...base,
        type: "tool-call",
        runId: event.runId,
        messageId: event.messageId,
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        args: event.data.args,
        category: event.data.category,
        riskLevel: event.data.riskLevel,
      };

    case "tool-result":
      return {
        ...base,
        type: "tool-result",
        runId: event.runId,
        messageId: event.messageId,
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        result: event.data.result,
        status: event.data.status,
      };

    case "agent-switch":
      return {
        ...base,
        type: "agent-switch",
        runId: event.runId,
        agentId: event.data.targetAgentId,
        taskId: event.data.taskId,
      };

    case "task-progress":
      return {
        ...base,
        type: "task-progress",
        runId: event.runId,
        messageId: event.messageId,
        taskId: event.data.taskId,
        progress: event.data.progress,
      };

    case "task-complete":
      return {
        ...base,
        type: "task-complete",
        runId: event.runId,
        messageId: event.messageId,
        taskId: event.data.taskId,
        result: event.data.result,
      };

    case "task-failed":
      return {
        ...base,
        type: "task-failed",
        runId: event.runId,
        messageId: event.messageId,
        taskId: event.data.taskId,
        error: event.data.error,
      };

    case "approval-request":
      return {
        ...base,
        type: "approval-request",
        runId: event.runId,
        messageId: event.messageId,
        approvalId: event.data.approvalId,
        toolCallId: event.data.toolCallId,
        toolName: event.data.toolName,
        args: event.data.params,
        message: event.data.reason,
        expiresAt: event.data.expiresAt,
      };

    case "usage":
      return {
        ...base,
        type: "usage",
        runId: event.runId,
        messageId: event.messageId,
        agentId: event.agentId,
        taskId: event.data.taskId,
        scope: event.data.scope,
        inputTokens: event.data.inputTokens,
        outputTokens: event.data.outputTokens,
        totalTokens: event.data.totalTokens,
      };

    case "message-end":
      return {
        ...base,
        type: "message-end",
        runId: event.runId,
        messageId: event.messageId ?? event.data.messageId,
      };

    case "done":
      return { ...base, type: "done", runId: event.runId };

    case "error":
      return { ...base, type: "error", runId: event.runId, message: event.data.message };

    case "memory-injection":
      return {
        ...base,
        type: "memory-injection",
        runId: event.runId,
        messageId: event.messageId,
        memories: event.data.memories.map((m) => ({
          memoryId: m.memoryId,
          source: m.source,
          score: m.score,
          contentPreview: m.contentPreview ?? "",
        })),
        count: event.data.memories.length,
      };

    // Internal-only events — no SSE representation
    case "run-start":
    case "run-end":
    case "agent-start":
    case "agent-end":
    case "compaction-start":
    case "compaction-end":
    case "approval-response":
    case "memory-extracted":
    case "reflection-triggered":
    case "entity-discovered":
      return null;
  }
}

/**
 * Convert an AgentEvent to an SSE wire-format string.
 * Returns null for events that should not be sent to the frontend.
 */
export function formatAgentEventSse(event: AgentEvent): string | null {
  const sseEvent = agentEventToSse(event);
  if (!sseEvent) return null;
  return formatSseData(sseEvent);
}
