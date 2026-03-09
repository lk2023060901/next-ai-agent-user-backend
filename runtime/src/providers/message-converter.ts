/**
 * Converts between unified Message format and pi-ai's Context format.
 *
 * This module is the only place that knows about pi-ai's internal types.
 * When native adapters replace pi-ai, this file is deleted.
 */

import type { Context } from "@mariozechner/pi-ai";
import type { Message, MessageContent, ProviderToolDefinition } from "./adapter.js";

// ─── Message[] → pi-ai Context ──────────────────────────────────────────────

export function messagesToPiAiContext(
  messages: Message[],
  tools?: ProviderToolDefinition[],
): Context {
  let systemPrompt: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const piMessages: any[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system": {
        const texts = textParts(msg.content);
        if (texts.length > 0) {
          systemPrompt = (systemPrompt ? systemPrompt + "\n" : "") + texts.join("\n");
        }
        break;
      }

      case "user":
        piMessages.push({
          role: "user",
          content: msg.content
            .filter(isTextContent)
            .map((c) => ({ type: "text" as const, text: c.text })),
          timestamp: Date.now(),
        });
        break;

      case "assistant":
        piMessages.push(assistantToPiAi(msg));
        break;

      case "tool":
        if (msg.toolCallId && msg.toolName) {
          piMessages.push({
            role: "toolResult",
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            content: msg.content
              .filter(isTextContent)
              .map((c) => ({ type: "text" as const, text: c.text })),
            isError: msg.isError ?? false,
            timestamp: Date.now(),
          });
        }
        break;
    }
  }

  return {
    systemPrompt,
    messages: piMessages,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })) as any[],
  };
}

// ─── pi-ai assistant event → Message ────────────────────────────────────────

/**
 * Convert a pi-ai "done" event's message into our unified Message.
 * Used by the adapter to build the assistant Message after streaming.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function piAiAssistantToMessage(piMsg: any): Message {
  const content: MessageContent[] = [];

  if (Array.isArray(piMsg.content)) {
    for (const block of piMsg.content) {
      switch (block.type) {
        case "text":
          if (typeof block.text === "string" && block.text.length > 0) {
            content.push({ type: "text", text: block.text });
          }
          break;
        case "toolCall":
          content.push({
            type: "tool-call",
            toolCallId: block.id ?? "",
            toolName: block.name ?? "",
            args: typeof block.arguments === "string"
              ? block.arguments
              : JSON.stringify(block.arguments ?? {}),
          });
          break;
        case "thinking":
          if (typeof block.thinking === "string" && block.thinking.length > 0) {
            content.push({ type: "thinking", text: block.thinking });
          }
          break;
      }
    }
  }

  return { role: "assistant", content };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isTextContent(c: MessageContent): c is Extract<MessageContent, { type: "text" }> {
  return c.type === "text";
}

function textParts(content: MessageContent[]): string[] {
  return content.filter(isTextContent).map((c) => c.text);
}

/**
 * Reconstruct a pi-ai compatible assistant message from our Message.
 *
 * pi-ai expects { role: "assistant", content: ContentBlock[], usage }.
 * We supply stub usage since we don't track per-message usage in our format.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assistantToPiAi(msg: Message): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [];

  for (const c of msg.content) {
    switch (c.type) {
      case "text":
        content.push({ type: "text", text: c.text });
        break;
      case "tool-call":
        content.push({
          type: "toolCall",
          id: c.toolCallId,
          name: c.toolName,
          arguments: safeJsonParse(c.args),
        });
        break;
      case "thinking":
        content.push({ type: "thinking", thinking: c.text });
        break;
    }
  }

  return {
    role: "assistant",
    content,
    usage: { input: 0, output: 0, totalTokens: 0 },
  };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
