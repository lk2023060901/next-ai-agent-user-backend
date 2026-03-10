import type { Message as InternalMessage, MessageContent } from "../providers/adapter.js";
import type {
  Message as PiAiMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ImageContent,
  Usage,
} from "@mariozechner/pi-ai";

// ─── Internal → Pi-ai ─────────────────────────────────────────────────────
//
// Converts stored history messages to pi-ai format for the stream-loop
// context. Metadata fields on AssistantMessage (api, provider, model, usage,
// stopReason) are filled with stubs — pi-ai only uses role + content when
// replaying history to the LLM provider.

const STUB_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function internalToPiAi(msg: InternalMessage): PiAiMessage | null {
  switch (msg.role) {
    case "user":
      return {
        role: "user",
        content: msg.content.map(toUserContent),
        timestamp: 0,
      } satisfies UserMessage;

    case "assistant":
      return {
        role: "assistant",
        content: msg.content.map(toAssistantContent),
        api: "anthropic-messages",
        provider: "anthropic",
        model: "",
        usage: STUB_USAGE,
        stopReason: "stop",
        timestamp: 0,
      } satisfies AssistantMessage;

    case "tool":
      return {
        role: "toolResult",
        toolCallId: msg.toolCallId ?? "",
        toolName: msg.toolName ?? "",
        content: msg.content.map(toToolContent),
        isError: msg.isError ?? false,
        timestamp: 0,
      } satisfies ToolResultMessage;

    case "system":
      // System messages go into Context.systemPrompt, not messages[]
      return null;
  }
}

// ─── Pi-ai → Internal ─────────────────────────────────────────────────────
//
// Converts pi-ai messages (from stream-loop context) back to our internal
// format for persistent storage. Strips pi-ai metadata.

export function piAiToInternal(msg: PiAiMessage): InternalMessage {
  switch (msg.role) {
    case "user":
      return {
        role: "user",
        content: fromUserContent(msg.content),
      };

    case "assistant":
      return {
        role: "assistant",
        content: msg.content.map(fromAssistantContent),
      };

    case "toolResult":
      return {
        role: "tool",
        content: fromToolContent(msg.content),
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        isError: msg.isError,
      };
  }
}

// ─── Content Converters ────────────────────────────────────────────────────

function toUserContent(c: MessageContent): TextContent | ImageContent {
  switch (c.type) {
    case "text":
      return { type: "text", text: c.text };
    case "image":
      return { type: "image", data: c.data, mimeType: c.mediaType };
    default:
      return { type: "text", text: "" };
  }
}

function toAssistantContent(c: MessageContent): TextContent | ThinkingContent | ToolCall {
  switch (c.type) {
    case "text":
      return { type: "text", text: c.text };
    case "thinking":
      return { type: "thinking", thinking: c.text };
    case "tool-call":
      return {
        type: "toolCall",
        id: c.toolCallId,
        name: c.toolName,
        arguments: safeParseArgs(c.args),
      };
    default:
      return { type: "text", text: "" };
  }
}

function toToolContent(c: MessageContent): TextContent | ImageContent {
  switch (c.type) {
    case "text":
      return { type: "text", text: c.text };
    case "image":
      return { type: "image", data: c.data, mimeType: c.mediaType };
    default:
      return { type: "text", text: "" };
  }
}

function fromUserContent(
  content: string | (TextContent | ImageContent)[],
): MessageContent[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((c): MessageContent => {
    if (c.type === "text") return { type: "text", text: c.text };
    return { type: "image", data: c.data, mediaType: c.mimeType };
  });
}

function fromAssistantContent(
  c: TextContent | ThinkingContent | ToolCall,
): MessageContent {
  switch (c.type) {
    case "text":
      return { type: "text", text: c.text };
    case "thinking":
      return { type: "thinking", text: c.thinking };
    case "toolCall":
      return {
        type: "tool-call",
        toolCallId: c.id,
        toolName: c.name,
        args: JSON.stringify(c.arguments),
      };
  }
}

function fromToolContent(
  content: (TextContent | ImageContent)[],
): MessageContent[] {
  return content.map((c): MessageContent => {
    if (c.type === "text") return { type: "text", text: c.text };
    return { type: "image", data: c.data, mediaType: c.mimeType };
  });
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return { raw: args };
  }
}
