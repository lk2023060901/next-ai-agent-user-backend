import { v4 as uuidv4 } from "uuid";
import type { EventBus } from "../events/event-types.js";
import type { AgentTool, ToolRuntime } from "../tools/tool-types.js";
import type {
  AgentConfig,
  AgentLoop,
  RunContext,
  SubAgentResult,
  SubAgentSpawnParams,
} from "./agent-types.js";
import { DefaultMessageHistory } from "./message-history.js";

/**
 * Spawns child AgentLoop executions for sub-agent delegation.
 *
 * When a coordinator calls the `delegate_to_agent` tool, this spawner
 * creates an isolated execution context and runs the child agent's loop.
 * The child shares the same EventBus (events are tagged with agentId)
 * but has its own message history.
 *
 * Depth tracking is handled at the tool policy level
 * (SubAgentDepthLayer in policy-pipeline.ts).
 */
export class SubAgentSpawner {
  private readonly agentLoop: AgentLoop;

  constructor(agentLoop: AgentLoop) {
    this.agentLoop = agentLoop;
  }

  async spawn(params: SubAgentSpawnParams): Promise<SubAgentResult> {
    const {
      parentRunId,
      parentSessionId,
      targetAgentId,
      instruction,
      taskId,
      agent,
      tools,
      providerAdapter,
      toolRuntime,
      eventBus,
      abortSignal,
    } = params;

    // Emit agent-switch event
    eventBus.emit(parentRunId, {
      type: "agent-switch",
      data: { targetAgentId, taskId },
      agentId: targetAgentId,
    });

    // Emit agent-start for the child
    eventBus.emit(parentRunId, {
      type: "agent-start",
      data: { instruction },
      agentId: targetAgentId,
    });

    // Create isolated run context for the child
    const childRunContext: RunContext = {
      id: parentRunId, // Same run — sub-agent is part of the parent run
      sessionId: parentSessionId,
      workspaceId: agent.id, // Will be overridden; placeholder
      coordinatorAgentId: targetAgentId,
      userRequest: instruction,
      status: "running",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      startedAt: Date.now(),
      timeoutMs: 120_000,
      abortController: new AbortController(),
    };

    // Link parent abort signal
    const onParentAbort = () => childRunContext.abortController.abort();
    abortSignal.addEventListener("abort", onParentAbort, { once: true });

    // Child gets its own message history (doesn't pollute parent)
    const childHistory = new DefaultMessageHistory();

    try {
      const result = await this.agentLoop.execute({
        run: childRunContext,
        agent,
        tools,
        providerAdapter,
        toolRuntime,
        messageHistory: childHistory,
        eventBus,
        abortSignal: childRunContext.abortController.signal,
      });

      // Emit task-complete
      eventBus.emit(parentRunId, {
        type: "task-complete",
        data: { taskId, result: result.fullText },
        agentId: targetAgentId,
      });

      // Emit agent-end
      eventBus.emit(parentRunId, {
        type: "agent-end",
        data: { status: result.status === "completed" ? "completed" : "failed" },
        agentId: targetAgentId,
      });

      // Emit sub-agent usage
      eventBus.emit(parentRunId, {
        type: "usage",
        data: {
          scope: "sub_agent",
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          taskId,
        },
        agentId: targetAgentId,
      });

      return {
        taskId,
        agentId: targetAgentId,
        status: result.status === "completed" ? "completed" : "failed",
        result: result.fullText,
        usage: result.usage,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      eventBus.emit(parentRunId, {
        type: "task-failed",
        data: { taskId, error: errorMessage },
        agentId: targetAgentId,
      });

      eventBus.emit(parentRunId, {
        type: "agent-end",
        data: { status: "failed" },
        agentId: targetAgentId,
      });

      return {
        taskId,
        agentId: targetAgentId,
        status: "failed",
        result: errorMessage,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    } finally {
      abortSignal.removeEventListener("abort", onParentAbort);
    }
  }
}
