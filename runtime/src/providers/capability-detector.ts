import type { ProviderCapabilities } from "./adapter.js";

/**
 * Detect provider capabilities from provider name and model ID.
 *
 * These are static profiles — they don't probe the API. When a model
 * isn't recognized, conservative defaults are returned.
 */
export function detectCapabilities(
  provider: string,
  modelId: string,
): ProviderCapabilities {
  const p = provider.toLowerCase();
  const m = modelId.toLowerCase();

  if (p === "anthropic") return anthropicCaps(m);
  if (p === "openai") return openaiCaps(m);
  if (p === "google" || p === "google-gemini-cli" || p === "google-vertex") return googleCaps(m);
  if (p === "ollama") return ollamaCaps();

  // OpenAI-compatible fallback (qwen, zhipu, mistral, xai, groq, etc.)
  return openaiCompatCaps(m);
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

function anthropicCaps(model: string): ProviderCapabilities {
  const isOpus = model.includes("opus");
  const isSonnet = model.includes("sonnet");
  const isHaiku = model.includes("haiku");

  // Extended thinking available on Sonnet 3.5+ and Opus 3+
  const reasoning = isSonnet || isOpus;

  // Context window: Claude 3+ models default to 200k
  const maxContextWindow = 200_000;
  const maxOutputTokens = isHaiku ? 4096 : 8192;

  return {
    streaming: true,
    toolUse: true,
    reasoning,
    vision: true,
    caching: true,
    maxContextWindow,
    maxOutputTokens,
  };
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────

function openaiCaps(model: string): ProviderCapabilities {
  const isO = model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4");
  const isGpt4 = model.includes("gpt-4");
  const isGpt5 = model.includes("gpt-5");

  return {
    streaming: true,
    toolUse: true,
    reasoning: isO,
    vision: isGpt4 || isGpt5 || isO,
    caching: false,
    maxContextWindow: isO ? 200_000 : 128_000,
    maxOutputTokens: isO ? 100_000 : 16_384,
  };
}

// ─── Google ──────────────────────────────────────────────────────────────────

function googleCaps(model: string): ProviderCapabilities {
  const isFlash = model.includes("flash");
  const isPro = model.includes("pro");
  const is2 = model.includes("2.0") || model.includes("2.5");

  return {
    streaming: true,
    toolUse: true,
    reasoning: is2 && !isFlash,
    vision: true,
    caching: false,
    maxContextWindow: isPro || is2 ? 2_000_000 : 1_000_000,
    maxOutputTokens: isFlash ? 8_192 : 8_192,
  };
}

// ─── Ollama (local) ──────────────────────────────────────────────────────────

function ollamaCaps(): ProviderCapabilities {
  return {
    streaming: true,
    toolUse: false,
    reasoning: false,
    vision: false,
    caching: false,
    maxContextWindow: 32_768,
    maxOutputTokens: 4_096,
  };
}

// ─── OpenAI-compatible fallback ──────────────────────────────────────────────

function openaiCompatCaps(model: string): ProviderCapabilities {
  // DeepSeek reasoning models
  const isDeepSeekReasoning = model.includes("deepseek-r") || model.includes("deepseek-reasoner");

  return {
    streaming: true,
    toolUse: true,
    reasoning: isDeepSeekReasoning,
    vision: false,
    caching: false,
    maxContextWindow: 128_000,
    maxOutputTokens: 8_192,
  };
}
