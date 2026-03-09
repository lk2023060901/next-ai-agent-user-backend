import type { Api, Model } from "@mariozechner/pi-ai";

function isOpenAiCompletionsModel(model: Model<Api>): model is Model<"openai-completions"> {
  return model.api === "openai-completions";
}

/**
 * Returns true only for endpoints confirmed to be native OpenAI infrastructure.
 * Azure OpenAI, proxies, Qwen, GLM, DeepSeek, etc. do NOT accept `developer` role.
 * All non-native openai-completions backends must have compat flags forced off.
 */
function isOpenAINativeEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com";
  } catch {
    return false;
  }
}

function isAnthropicMessagesModel(model: Model<Api>): model is Model<"anthropic-messages"> {
  return model.api === "anthropic-messages";
}

/**
 * pi-ai constructs the Anthropic API endpoint as `${baseUrl}/v1/messages`.
 * If baseUrl contains a trailing `/v1`, the result becomes `…/v1/v1/messages`
 * which Anthropic rejects with a 404. Strip the trailing `/v1` here.
 */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}

export function normalizeModelCompat(model: Model<Api>): Model<Api> {
  const baseUrl = model.baseUrl ?? "";

  if (isAnthropicMessagesModel(model) && baseUrl) {
    const normalised = normalizeAnthropicBaseUrl(baseUrl);
    if (normalised !== baseUrl) {
      return { ...model, baseUrl: normalised } as Model<"anthropic-messages">;
    }
  }

  if (!isOpenAiCompletionsModel(model)) {
    return model;
  }

  const compat = model.compat ?? undefined;
  // When baseUrl is empty, pi-ai defaults to api.openai.com — leave compat unchanged.
  const needsForce = baseUrl ? !isOpenAINativeEndpoint(baseUrl) : false;
  if (!needsForce) {
    return model;
  }
  if (compat?.supportsDeveloperRole === false && compat?.supportsUsageInStreaming === false) {
    return model;
  }

  // Return a new object — do not mutate the caller's model reference.
  return {
    ...model,
    compat: compat
      ? { ...compat, supportsDeveloperRole: false, supportsUsageInStreaming: false }
      : { supportsDeveloperRole: false, supportsUsageInStreaming: false },
  } as typeof model;
}
