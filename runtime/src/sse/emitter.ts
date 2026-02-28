// SSE event types — extends the frontend use-streaming-chat.ts event types
export type SseEvent =
  | { type: "message-start"; runId?: string; messageId?: string; agentId: string }
  | { type: "text-delta"; runId?: string; messageId?: string; text: string; delta?: string }
  | { type: "reasoning-delta"; runId?: string; messageId?: string; text: string; delta?: string }
  | { type: "reasoning"; runId?: string; messageId?: string; text: string }
  | {
      type: "tool-call";
      runId?: string;
      messageId?: string;
      toolCallId?: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool-result";
      runId?: string;
      messageId?: string;
      toolCallId?: string;
      toolName: string;
      result: unknown;
      status?: "success" | "error";
    }
  | { type: "agent-switch"; runId?: string; agentId: string; taskId?: string }
  | { type: "task-progress"; runId?: string; messageId?: string; taskId: string; progress: number }
  | { type: "task-complete"; runId?: string; messageId?: string; taskId: string; result: string }
  | { type: "task-failed"; runId?: string; messageId?: string; taskId: string; error: string }
  | { type: "approval-request"; runId?: string; messageId?: string; message: string; taskId: string }
  | { type: "message-end"; runId: string; messageId?: string }
  | { type: "done"; runId: string }
  | { type: "error"; runId: string; message: string };

export type SseEmitter = (event: SseEvent) => void;

// One emitter per active runId — registered by Fastify SSE handler, consumed by agent runner
const channels = new Map<string, SseEmitter>();

export function registerChannel(runId: string, emit: SseEmitter): void {
  channels.set(runId, emit);
}

export function getChannel(runId: string): SseEmitter | undefined {
  return channels.get(runId);
}

export function removeChannel(runId: string): void {
  channels.delete(runId);
}

export function formatSseData(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
