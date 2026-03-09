/**
 * ProviderAdapter implementation backed by @mariozechner/pi-ai.
 *
 * Wraps pi-ai's stream() and completeSimple() behind the unified
 * ProviderAdapter interface. This is the bridge between the new agent
 * runtime and the existing LLM infrastructure.
 *
 * When native per-provider adapters are built, this file is replaced.
 */

import {
  stream as piAiStream,
  completeSimple,
  type Model,
  type Api,
  type AssistantMessageEvent,
} from "@mariozechner/pi-ai";
import type {
  CompleteParams,
  CompleteResult,
  ProviderAdapter,
  ProviderCapabilities,
  StreamChunk,
  StreamParams,
} from "./adapter.js";
import { ProviderError } from "./adapter.js";
import { messagesToPiAiContext, piAiAssistantToMessage } from "./message-converter.js";
import { detectCapabilities } from "./capability-detector.js";

export interface PiAiAdapterOptions {
  model: Model<Api>;
  apiKey: string;
  /** Provider name for error reporting. Defaults to model.provider. */
  providerName?: string;
  /** Default timeout per stream() call in ms. Defaults to 120s. */
  streamTimeoutMs?: number;
  /** Default timeout per complete() call in ms. Defaults to 30s. */
  completeTimeoutMs?: number;
}

export class PiAiAdapter implements ProviderAdapter {
  readonly providerName: string;

  private readonly model: Model<Api>;
  private readonly apiKey: string;
  private readonly streamTimeoutMs: number;
  private readonly completeTimeoutMs: number;
  private readonly caps: ProviderCapabilities;

  constructor(options: PiAiAdapterOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.providerName = options.providerName ?? (options.model.provider || "unknown");
    this.streamTimeoutMs = options.streamTimeoutMs ?? 120_000;
    this.completeTimeoutMs = options.completeTimeoutMs ?? 30_000;
    this.caps = detectCapabilities(this.providerName, this.model.id);
  }

  async *stream(params: StreamParams): AsyncGenerator<StreamChunk> {
    const context = messagesToPiAiContext(params.messages, params.tools);
    const signal = params.abortSignal ?? AbortSignal.timeout(this.streamTimeoutMs);

    let eventStream: AsyncIterable<AssistantMessageEvent>;
    try {
      eventStream = piAiStream(this.model, context, {
        apiKey: this.apiKey,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        signal,
      }) as AsyncIterable<AssistantMessageEvent>;
    } catch (err) {
      throw this.wrapError(err);
    }

    let hasToolCalls = false;

    try {
      for await (const event of eventStream) {
        switch (event.type) {
          case "text_delta":
            yield { type: "text-delta", text: event.delta };
            break;

          case "thinking_delta":
            yield { type: "reasoning", text: event.delta };
            break;

          // thinking_end carries the full thinking text — we already
          // streamed deltas above, so we skip it to avoid duplication.
          case "thinking_end":
            break;

          case "toolcall_end":
            hasToolCalls = true;
            yield {
              type: "tool-call",
              toolCallId: event.toolCall.id,
              toolName: event.toolCall.name,
              args: typeof event.toolCall.arguments === "string"
                ? event.toolCall.arguments
                : JSON.stringify(event.toolCall.arguments ?? {}),
            };
            break;

          case "done": {
            const usage = event.message.usage;
            yield {
              type: "usage",
              inputTokens: usage.input,
              outputTokens: usage.output,
            };
            yield {
              type: "stop",
              reason: hasToolCalls ? "tool_use" : "end_turn",
            };
            break;
          }

          case "error":
            yield {
              type: "error",
              error: this.wrapError(
                new Error(event.error.errorMessage ?? "stream error"),
              ),
            };
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: this.wrapError(err) };
    }
  }

  /**
   * Build the unified assistant Message from the last pi-ai "done" event.
   *
   * This is a convenience for callers that need to reconstruct the
   * assistant message after streaming (e.g., to append to message history).
   * Not part of the ProviderAdapter interface — pi-ai specific.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static assistantMessageFromDone(doneEvent: any) {
    return piAiAssistantToMessage(doneEvent.message ?? doneEvent);
  }

  async complete(params: CompleteParams): Promise<CompleteResult> {
    const context = messagesToPiAiContext(params.messages);
    const signal = params.abortSignal ?? AbortSignal.timeout(this.completeTimeoutMs);

    try {
      const result = await completeSimple(this.model, context, {
        apiKey: this.apiKey,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        signal,
      });

      const text = Array.isArray(result.content)
        ? result.content
            .filter((c) => c.type === "text")
            .map((c) => ("text" in c && typeof c.text === "string" ? c.text : ""))
            .join("")
        : "";

      const usage = result.usage ?? { input: 0, output: 0, totalTokens: 0 };

      return {
        content: text,
        usage: {
          inputTokens: usage.input ?? 0,
          outputTokens: usage.output ?? 0,
          totalTokens: usage.totalTokens ?? 0,
        },
        stopReason: "end_turn",
      };
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async embed(): Promise<Float32Array[]> {
    throw new ProviderError(
      "Embedding not supported via PiAiAdapter — use the embedding module",
      "INVALID_REQUEST",
      this.providerName,
    );
  }

  capabilities(): ProviderCapabilities {
    return this.caps;
  }

  // ─── Error categorization ──────────────────────────────────────────────────

  private wrapError(err: unknown): ProviderError {
    if (err instanceof ProviderError) return err;

    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many")) {
      return new ProviderError(msg, "RATE_LIMIT", this.providerName, true, 30_000);
    }
    if (lower.includes("401") || lower.includes("api key") || lower.includes("unauthorized")) {
      return new ProviderError(msg, "AUTH_FAILED", this.providerName, false);
    }
    if (lower.includes("402") || lower.includes("billing") || lower.includes("quota")) {
      return new ProviderError(msg, "BILLING", this.providerName, false);
    }
    if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("aborted")) {
      return new ProviderError(msg, "TIMEOUT", this.providerName, true);
    }
    if (lower.includes("context length") || lower.includes("too many tokens") || lower.includes("too long")) {
      return new ProviderError(msg, "CONTEXT_LENGTH_EXCEEDED", this.providerName, false);
    }
    if (lower.includes("content filter") || lower.includes("safety") || lower.includes("blocked")) {
      return new ProviderError(msg, "CONTENT_FILTER", this.providerName, false);
    }
    if (lower.includes("503") || lower.includes("service unavailable") || lower.includes("overloaded")) {
      return new ProviderError(msg, "SERVICE_UNAVAILABLE", this.providerName, true, 15_000);
    }
    if (lower.includes("network") || lower.includes("econnrefused") || lower.includes("fetch failed")) {
      return new ProviderError(msg, "NETWORK_ERROR", this.providerName, true);
    }

    return new ProviderError(msg, "SERVER_ERROR", this.providerName, true);
  }
}
