import { getModel } from "@mariozechner/pi-ai";
import { config } from "../config.js";
import { normalizeModelCompat } from "./model-compat.js";
import { resolveForwardCompatModel } from "./model-forward-compat.js";
function hasWorkspaceLlmConfig(candidate) {
    return Boolean(candidate.llmApiKey);
}
function defaultBaseUrlForProvider(providerType) {
    switch (providerType) {
        case "qwen":
            return "https://dashscope.aliyuncs.com/compatible-mode/v1";
        case "zhipu":
            return "https://open.bigmodel.cn/api/paas/v4/";
        case "mistral":
            return "https://api.mistral.ai/v1";
        default:
            return undefined;
    }
}
const BUILTIN_PROVIDERS = new Set([
    "anthropic", "openai", "google", "google-gemini-cli", "google-vertex",
    "mistral", "xai", "groq", "cerebras", "openrouter", "amazon-bedrock",
]);
function isBuiltinProvider(providerType) {
    return BUILTIN_PROVIDERS.has(providerType);
}
function normalizeCandidate(cfg, candidate) {
    const model = (candidate?.model ?? cfg.model ?? "").trim();
    if (!model)
        return null;
    return {
        model,
        llmProviderType: (candidate?.llmProviderType ?? cfg.llmProviderType ?? "").trim().toLowerCase(),
        llmBaseUrl: (candidate?.llmBaseUrl ?? cfg.llmBaseUrl ?? "").trim(),
        llmApiKey: (candidate?.llmApiKey ?? cfg.llmApiKey ?? "").trim(),
    };
}
export function getLlmCandidates(cfg) {
    const out = [];
    const seen = new Set();
    const pushCandidate = (candidate) => {
        if (!candidate)
            return;
        const key = `${candidate.llmProviderType}|${candidate.llmBaseUrl}|${candidate.model}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push(candidate);
    };
    pushCandidate(normalizeCandidate(cfg));
    if (Array.isArray(cfg.llmCandidates)) {
        for (const candidate of cfg.llmCandidates) {
            pushCandidate(normalizeCandidate(cfg, candidate));
        }
    }
    return out;
}
function buildOpenAICompatModel(modelId, providerType, baseUrl) {
    return normalizeModelCompat({
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: providerType,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
    });
}
function tryGetModel(provider, modelId) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return getModel(provider, modelId);
    }
    catch {
        return undefined;
    }
}
/**
 * Resolve a model for a workspace-configured provider that uses pi-ai's native
 * registry. Resolution order mirrors openclaw:
 *   1. Direct registry lookup via getModel()
 *   2. Forward-compat (new model IDs cloned from nearest template)
 *   3. Hardcoded stub with normalizeModelCompat() applied
 */
function resolveRegisteredProviderModel(provider, modelId, fallbackApi, fallbackBaseUrl) {
    // 1. Direct registry lookup
    const direct = tryGetModel(provider, modelId);
    if (direct) {
        return normalizeModelCompat(direct);
    }
    // 2. Forward-compat: clone nearest template from registry
    const forwardCompat = resolveForwardCompatModel(provider, modelId);
    if (forwardCompat) {
        return forwardCompat;
    }
    // 3. Hardcoded stub — normalizeModelCompat handles compat flags and baseUrl normalization
    return normalizeModelCompat({
        id: modelId,
        name: modelId,
        api: fallbackApi,
        provider,
        baseUrl: fallbackBaseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
    });
}
export function buildModelForAgent(cfg, candidateOverride) {
    const candidate = normalizeCandidate(cfg, candidateOverride) ?? normalizeCandidate(cfg);
    if (!candidate) {
        throw new Error("Missing model configuration");
    }
    const providerType = candidate.llmProviderType;
    const useWorkspaceConfig = hasWorkspaceLlmConfig(candidate);
    // Workspace-configured anthropic without custom baseUrl → use native anthropic-messages protocol.
    // Fallback chain: registry → forward-compat → hardcoded anthropic-messages stub.
    if (useWorkspaceConfig && providerType === "anthropic" && !candidate.llmBaseUrl) {
        return resolveRegisteredProviderModel("anthropic", candidate.model, "anthropic-messages", "https://api.anthropic.com");
    }
    // Google native — no forward-compat, hard error if not in registry.
    if (useWorkspaceConfig && providerType === "google" && !candidate.llmBaseUrl) {
        const model = tryGetModel("google", candidate.model);
        if (model) {
            return normalizeModelCompat(model);
        }
        throw new Error("Google model not found in pi-ai registry. Configure an OpenAI-compatible baseUrl or use OpenAI/Anthropic.");
    }
    if (useWorkspaceConfig) {
        const baseUrl = candidate.llmBaseUrl || defaultBaseUrlForProvider(providerType);
        // Custom baseUrl or non-built-in provider → OpenAI-compatible with compat normalization.
        if (baseUrl || !isBuiltinProvider(providerType)) {
            return buildOpenAICompatModel(candidate.model, providerType, baseUrl || "https://api.openai.com/v1");
        }
        // Built-in provider without custom base URL → registry → forward-compat → openai-compat stub.
        if (providerType === "openai") {
            return resolveRegisteredProviderModel("openai", candidate.model, "openai-completions", "https://api.openai.com/v1");
        }
        // Other built-in providers (mistral, groq, xai, etc.)
        const model = tryGetModel(providerType, candidate.model);
        if (model) {
            return normalizeModelCompat(model);
        }
        return buildOpenAICompatModel(candidate.model, providerType, "https://api.openai.com/v1");
    }
    // No workspace config → use runtime's default LLM endpoint (Bifrost or LLM_BASE_URL).
    return buildOpenAICompatModel(candidate.model, providerType || "openai", config.llmBaseUrl || `${config.bifrostAddr}/v1`);
}
/**
 * Resolve the apiKey to pass to pi-ai stream() options.
 * Uses candidate's key, falls back to runtime config, then empty string.
 */
export function resolveApiKey(cfg, candidate) {
    const key = candidate?.llmApiKey ?? cfg.llmApiKey ?? "";
    if (key)
        return key;
    return config.llmApiKey || "runtime";
}
