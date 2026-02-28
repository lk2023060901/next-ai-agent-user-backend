export type SseEnvelope = {
  seq?: number;
  emittedAt?: string;
};

// SSE event types — extends the frontend use-streaming-chat.ts event types
export type SseEvent = SseEnvelope &
  (
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
  | {
      type: "usage";
      runId?: string;
      messageId?: string;
      taskId?: string;
      agentId?: string;
      scope: "coordinator" | "sub_agent";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
    | { type: "message-end"; runId: string; messageId?: string }
    | { type: "done"; runId: string }
    | { type: "error"; runId: string; message: string }
  );

export type SseEmitter = (event: SseEvent) => void;

export function formatSseData(event: SseEvent): string {
  const idLine = typeof event.seq === "number" && Number.isFinite(event.seq) ? `id: ${event.seq}\n` : "";
  return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}
