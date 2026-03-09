// ─── Message Types ───────────────────────────────────────────────────────────
//
// Unified internal message format. Provider-specific conversion happens in
// message-converter.ts. The agent loop works exclusively with these types.

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mediaType: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | { type: "thinking"; text: string };

export interface Message {
  role: MessageRole;
  content: MessageContent[];
  /** Tool result messages: the tool call this result responds to. */
  toolCallId?: string;
  /** Tool result messages: the tool that produced this result. */
  toolName?: string;
  /** Tool result messages: whether execution produced an error. */
  isError?: boolean;
}

// ─── Provider Tool Definition ────────────────────────────────────────────────
//
// Subset of ToolDefinition sent to the LLM.
// Full ToolDefinition (category, riskLevel, etc.) lives in tools/ module.

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ─── Stream Types ────────────────────────────────────────────────────────────

export interface StreamParams {
  messages: Message[];
  tools?: ProviderToolDefinition[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  reasoning?: "off" | "low" | "high";
  abortSignal?: AbortSignal;
}

export type StreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "stop"; reason: StopReason }
  | { type: "error"; error: ProviderError };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

// ─── Complete Types ──────────────────────────────────────────────────────────
//
// Non-streaming calls for internal use (memory extraction, reflection, etc.)

export interface CompleteParams {
  messages: Message[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export interface CompleteResult {
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  stopReason: StopReason;
}

// ─── Provider Capabilities ───────────────────────────────────────────────────

export interface ProviderCapabilities {
  streaming: boolean;
  toolUse: boolean;
  reasoning: boolean;
  vision: boolean;
  caching: boolean;
  maxContextWindow: number;
  maxOutputTokens: number;
}

// ─── ProviderAdapter Interface ───────────────────────────────────────────────

export interface ProviderAdapter {
  readonly providerName: string;

  /** Streaming LLM call — one turn per invocation. */
  stream(params: StreamParams): AsyncGenerator<StreamChunk>;

  /** Non-streaming LLM call — returns the full response. */
  complete(params: CompleteParams): Promise<CompleteResult>;

  /** Generate embeddings (optional — throw if unsupported). */
  embed(texts: string[], model?: string): Promise<Float32Array[]>;

  /** Query this adapter's capabilities. */
  capabilities(): ProviderCapabilities;
}

// ─── ProviderError ───────────────────────────────────────────────────────────

export type ProviderErrorCode =
  | "RATE_LIMIT"
  | "AUTH_FAILED"
  | "BILLING"
  | "SERVICE_UNAVAILABLE"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "CONTENT_FILTER"
  | "INVALID_REQUEST"
  | "CONTEXT_LENGTH_EXCEEDED"
  | "SERVER_ERROR";

export class ProviderError extends Error {
  override readonly name = "ProviderError";

  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly provider: string,
    public readonly retryable: boolean = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
