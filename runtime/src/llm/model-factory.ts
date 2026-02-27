import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { AgentConfig } from "../grpc/client.js";
import { config } from "../config.js";

function hasWorkspaceLlmConfig(cfg: AgentConfig): boolean {
  return Boolean(cfg.llmApiKey);
}

function defaultBaseUrlForProvider(providerType: string): string | undefined {
  switch (providerType) {
    case "mistral":
      return "https://api.mistral.ai/v1";
    default:
      return undefined;
  }
}

export function buildModelForAgent(cfg: AgentConfig): any {
  const providerType = (cfg.llmProviderType || "").toLowerCase();
  const useWorkspaceConfig = hasWorkspaceLlmConfig(cfg);

  if (useWorkspaceConfig && providerType === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: cfg.llmApiKey,
      ...(cfg.llmBaseUrl ? { baseURL: cfg.llmBaseUrl } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return anthropic(cfg.model);
  }

  if (useWorkspaceConfig && providerType === "google" && !cfg.llmBaseUrl) {
    throw new Error(
      "Google provider is not wired in runtime yet. Configure an OpenAI-compatible baseUrl or use OpenAI/Anthropic."
    );
  }

  const openai = createOpenAI({
    apiKey: useWorkspaceConfig ? cfg.llmApiKey : (config.llmApiKey || "runtime"),
    ...(useWorkspaceConfig
      ? ((cfg.llmBaseUrl || defaultBaseUrlForProvider(providerType))
          ? { baseURL: cfg.llmBaseUrl || defaultBaseUrlForProvider(providerType) }
          : {})
      : { baseURL: config.llmBaseUrl || `${config.bifrostAddr}/v1` }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return openai(cfg.model);
}
