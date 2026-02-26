// SSE event types — extends the frontend use-streaming-chat.ts event types
export type SseEvent =
  | { type: "message-start"; agentId: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; toolName: string; args: unknown }
  | { type: "tool-result"; toolName: string; result: unknown }
  | { type: "agent-switch"; agentId: string; taskId?: string }
  | { type: "task-progress"; taskId: string; progress: number }
  | { type: "task-complete"; taskId: string; result: string }
  | { type: "task-failed"; taskId: string; error: string }
  | { type: "approval-request"; message: string; taskId: string }
  | { type: "message-end"; runId: string };

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
