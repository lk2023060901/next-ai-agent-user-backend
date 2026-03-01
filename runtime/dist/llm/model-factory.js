import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config.js";
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
export function buildModelForAgent(cfg, candidateOverride) {
    const candidate = normalizeCandidate(cfg, candidateOverride) ?? normalizeCandidate(cfg);
    if (!candidate) {
        throw new Error("Missing model configuration");
    }
    const providerType = candidate.llmProviderType;
    const useWorkspaceConfig = hasWorkspaceLlmConfig(candidate);
    if (useWorkspaceConfig && providerType === "anthropic") {
        const anthropic = createAnthropic({
            apiKey: candidate.llmApiKey,
            ...(candidate.llmBaseUrl ? { baseURL: candidate.llmBaseUrl } : {}),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        });
        return anthropic(candidate.model);
    }
    if (useWorkspaceConfig && providerType === "google" && !candidate.llmBaseUrl) {
        throw new Error("Google provider is not wired in runtime yet. Configure an OpenAI-compatible baseUrl or use OpenAI/Anthropic.");
    }
    const openai = createOpenAI({
        apiKey: useWorkspaceConfig ? candidate.llmApiKey : (config.llmApiKey || "runtime"),
        ...(useWorkspaceConfig
            ? ((candidate.llmBaseUrl || defaultBaseUrlForProvider(providerType))
                ? { baseURL: candidate.llmBaseUrl || defaultBaseUrlForProvider(providerType) }
                : {})
            : { baseURL: config.llmBaseUrl || `${config.bifrostAddr}/v1` }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    });
    return openai(candidate.model);
}
