import { getProviders, getModels as piGetModels, type KnownProvider } from "@mariozechner/pi-ai";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CatalogModel {
  id: string;
  displayName: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { inputPerMtok: number; outputPerMtok: number };
  contextWindow: number;
  maxTokens: number;
}

export interface CatalogProvider {
  name: string;         // unique key, e.g. "anthropic"
  displayName: string;
  baseUrl: string;      // provider-level API base URL (for DB seeding & connection test)
  defaultModel: string; // suggested default model id
  models: CatalogModel[];
}

export type ProviderCatalog = CatalogProvider[];

// ─── Display names ────────────────────────────────────────────────────────────

const PROVIDER_DISPLAY_NAMES: Partial<Record<string, string>> = {
  anthropic:                "Anthropic",
  openai:                   "OpenAI",
  google:                   "Google AI",
  mistral:                  "Mistral AI",
  groq:                     "Groq",
  xai:                      "xAI",
  cerebras:                 "Cerebras",
  zai:                      "Z-AI (Zhipu)",
  "amazon-bedrock":         "Amazon Bedrock",
  "azure-openai-responses": "Azure OpenAI",
  "google-vertex":          "Google Vertex AI",
  huggingface:              "HuggingFace",
  "kimi-coding":            "Kimi Coding",
  minimax:                  "MiniMax",
  "minimax-cn":             "MiniMax (中国)",
  openrouter:               "OpenRouter",
  "vercel-ai-gateway":      "Vercel AI Gateway",
};

// ─── Provider-level base URL and default model ────────────────────────────────
// These drive DB seeding (ensureWorkspaceDefaultProviders) and connection tests.

const PROVIDER_SEED: Record<string, { baseUrl: string; defaultModel: string }> = {
  anthropic:                { baseUrl: "https://api.anthropic.com",                               defaultModel: "claude-sonnet-4-6" },
  openai:                   { baseUrl: "https://api.openai.com/v1",                               defaultModel: "gpt-5.3" },
  google:                   { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-pro" },
  mistral:                  { baseUrl: "https://api.mistral.ai/v1",                               defaultModel: "mistral-large-latest" },
  groq:                     { baseUrl: "https://api.groq.com/openai/v1",                          defaultModel: "llama-3.3-70b-versatile" },
  xai:                      { baseUrl: "https://api.x.ai/v1",                                     defaultModel: "grok-3" },
  cerebras:                 { baseUrl: "https://api.cerebras.ai/v1",                              defaultModel: "llama-3.3-70b" },
  zhipu:                    { baseUrl: "https://open.bigmodel.cn/api/paas/v4/",                   defaultModel: "glm-5" },
  "amazon-bedrock":         { baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",         defaultModel: "amazon.nova-pro-v1:0" },
  "azure-openai-responses": { baseUrl: "",                                                         defaultModel: "gpt-4.1" },
  "google-vertex":          { baseUrl: "https://us-central1-aiplatform.googleapis.com",           defaultModel: "gemini-2.5-pro" },
  huggingface:              { baseUrl: "https://router.huggingface.co/v1",                        defaultModel: "Qwen/Qwen3-235B-A22B-Thinking-2507" },
  "kimi-coding":            { baseUrl: "https://api.kimi.com/coding",                             defaultModel: "k2p5" },
  minimax:                  { baseUrl: "https://api.minimax.io/anthropic",                        defaultModel: "MiniMax-M2.5" },
  "minimax-cn":             { baseUrl: "https://api.minimaxi.com/anthropic",                      defaultModel: "MiniMax-M2.5" },
  openrouter:               { baseUrl: "https://openrouter.ai/api/v1",                            defaultModel: "anthropic/claude-opus-4" },
  "vercel-ai-gateway":      { baseUrl: "https://ai-gateway.vercel.sh",                            defaultModel: "anthropic/claude-opus-4" },
  deepseek:                 { baseUrl: "https://api.deepseek.com/v1",                             defaultModel: "deepseek-chat" },
  qwen:                     { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",       defaultModel: "qwen3-235b-a22b" },
};

// ─── Series grouping (also used by model.service for listModelSeries) ─────────

export const SERIES_PATTERNS: Record<string, Array<[RegExp, string]>> = {
  anthropic: [
    [/claude-(?:opus|sonnet|haiku)-4/, "Claude 4"],
    [/3[-.]7/, "Claude 3.7"],
    [/3[-.]5/, "Claude 3.5"],
  ],
  openai: [
    [/gpt-5/, "GPT-5"],
    [/gpt-4\.1/, "GPT-4.1"],
    [/gpt-4o/, "GPT-4o"],
    [/gpt-4/, "GPT-4"],
    [/gpt-3/, "GPT-3.5"],
    [/codex/, "Codex"],
  ],
  google: [
    [/2\.5/, "Gemini 2.5"],
    [/2\.0/, "Gemini 2.0"],
    [/1\.5/, "Gemini 1.5"],
  ],
  "google-vertex": [
    [/2\.5/, "Gemini 2.5"],
    [/2\.0/, "Gemini 2.0"],
    [/1\.5/, "Gemini 1.5"],
  ],
  mistral: [
    [/magistral/, "Magistral"],
    [/codestral/, "Codestral"],
    [/devstral|labs-devstral/, "Devstral"],
    [/pixtral/, "Pixtral"],
    [/mixtral|^open-mix/, "Mixtral"],
    [/large/, "Mistral Large"],
    [/medium/, "Mistral Medium"],
    [/small|ministral|^open-mistral/, "Mistral Small"],
  ],
  groq: [
    [/llama-4|llama4/, "Llama 4"],
    [/llama-3\.3|llama3-/, "Llama 3"],
    [/llama/, "Llama"],
    [/gemma/, "Gemma"],
    [/deepseek/, "DeepSeek"],
    [/qwen/, "Qwen"],
    [/kimi/, "Kimi"],
    [/openai/, "OpenAI OSS"],
    [/mistral/, "Mistral"],
  ],
  xai: [
    [/grok-code/, "Grok Code"],
    [/grok-4/, "Grok 4"],
    [/grok-3/, "Grok 3"],
    [/grok-2/, "Grok 2"],
  ],
  cerebras: [
    [/llama-4|llama4/, "Llama 4"],
    [/llama/, "Llama"],
    [/qwen/, "Qwen"],
    [/glm|zai/, "GLM"],
  ],
  zhipu: [
    [/glm-(?:5|4\.5|4\.6|4\.7)/, "GLM Latest"],
    [/glm-z1/, "GLM-Z1"],
  ],
  deepseek: [
    [/reasoner|r1/, "DeepSeek R1"],
  ],
  qwen: [
    [/coder/, "Qwen Code"],
    [/qwen3/, "Qwen 3"],
    [/qwen2/, "Qwen 2.5"],
  ],
  "amazon-bedrock": [
    [/nova-2/, "Nova 2"],
    [/nova/, "Nova"],
    [/claude/, "Claude on Bedrock"],
    [/llama/, "Llama on Bedrock"],
    [/titan/, "Titan"],
  ],
  "azure-openai-responses": [
    [/gpt-5/, "GPT-5"],
    [/gpt-4\.1/, "GPT-4.1"],
    [/gpt-4o/, "GPT-4o"],
    [/gpt-4/, "GPT-4"],
    [/codex/, "Codex"],
    [/o[0-9]/, "o-series"],
  ],
  huggingface:         [[/qwen/, "Qwen"], [/llama/, "Llama"], [/minimax|m2/, "MiniMax"], [/deepseek/, "DeepSeek"], [/mimo/, "MiMo"]],
  "kimi-coding":       [[/k2/, "Kimi K2"]],
  minimax:             [[/m2/, "MiniMax M2"]],
  "minimax-cn":        [[/m2/, "MiniMax M2"]],
  openrouter:          [[/claude/, "Claude"], [/gpt/, "GPT"], [/gemini/, "Gemini"], [/llama/, "Llama"], [/qwen/, "Qwen"], [/deepseek/, "DeepSeek"]],
  "vercel-ai-gateway": [[/claude/, "Claude"], [/gpt/, "GPT"], [/gemini/, "Gemini"], [/llama/, "Llama"], [/qwen/, "Qwen"]],
};

function providerFallbackSeriesName(providerName: string): string {
  switch (providerName) {
    case "anthropic":               return "Claude 3";
    case "openai":                  return "o-series";
    case "google":
    case "google-vertex":           return "Gemini";
    case "mistral":                 return "Mistral";
    case "xai":                     return "Grok";
    case "groq":
    case "cerebras":                return "Other";
    case "zhipu":                   return "GLM";
    case "deepseek":                return "DeepSeek V3";
    case "qwen":                    return "Qwen";
    case "amazon-bedrock":          return "Other";
    case "azure-openai-responses":  return "Azure Models";
    case "huggingface":             return "Other";
    case "kimi-coding":             return "Kimi";
    case "minimax":
    case "minimax-cn":              return "MiniMax";
    case "openrouter":
    case "vercel-ai-gateway":       return "Other";
    default:                        return "Models";
  }
}

export function inferCatalogSeriesName(providerName: string, modelId: string): string {
  const patterns = SERIES_PATTERNS[providerName];
  if (!patterns) return "Models";
  const lower = modelId.toLowerCase();
  const match = patterns.find(([re]) => re.test(lower));
  return match ? match[1] : providerFallbackSeriesName(providerName);
}

export function piAiInputToCapabilities(input: readonly string[], reasoning: boolean): string[] {
  const caps: string[] = ["text", "tools"];
  if (input.includes("image")) caps.push("vision");
  if (reasoning) caps.push("reasoning");
  return caps;
}

// ─── pi-ai integration ────────────────────────────────────────────────────────

const HIDDEN_PI_AI_PROVIDERS = new Set<string>([
  "google-gemini-cli",
  "google-antigravity",
  "openai-codex",
  "github-copilot",
  "opencode",
  "opencode-go",
]);

/** pi-ai KnownProvider key → our internal provider name (differs only for zai → zhipu). */
const PI_AI_KEY_TO_NAME: Partial<Record<KnownProvider, string>> = {
  zai: "zhipu",
};

function tryGetPiAiModels(key: KnownProvider): ReturnType<typeof piGetModels> {
  try { return piGetModels(key); } catch { return []; }
}

function buildPiAiProvider(key: KnownProvider): CatalogProvider {
  const name = PI_AI_KEY_TO_NAME[key] ?? key;
  const seed = PROVIDER_SEED[name] ?? {};
  const models = tryGetPiAiModels(key);
  return {
    name,
    displayName: PROVIDER_DISPLAY_NAMES[key] ?? name,
    baseUrl: seed.baseUrl ?? models[0]?.baseUrl ?? "",
    defaultModel: seed.defaultModel ?? models[0]?.id ?? "",
    models: models.map((m) => ({
      id: m.id,
      displayName: m.name,
      api: m.api,
      baseUrl: m.baseUrl ?? "",
      reasoning: m.reasoning,
      input: m.input.filter((i): i is "text" | "image" => i === "text" || i === "image"),
      cost: { inputPerMtok: m.cost.input, outputPerMtok: m.cost.output },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  };
}

// ─── Custom providers (not in pi-ai registry) ─────────────────────────────────

const CUSTOM_PROVIDERS: CatalogProvider[] = [
  {
    name: "deepseek", displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-chat",
    models: [
      { id: "deepseek-chat",     displayName: "DeepSeek Chat (V3)",    api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", reasoning: false, input: ["text"], cost: { inputPerMtok: 0.27, outputPerMtok: 1.1  }, contextWindow: 64000,  maxTokens: 8192 },
      { id: "deepseek-reasoner", displayName: "DeepSeek Reasoner (R1)", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", reasoning: true,  input: ["text"], cost: { inputPerMtok: 0.55, outputPerMtok: 2.19 }, contextWindow: 64000,  maxTokens: 8192 },
    ],
  },
  {
    name: "qwen", displayName: "Qwen (通义千问)",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen3-235b-a22b",
    models: [
      { id: "qwen3-235b-a22b",             displayName: "Qwen 3 235B",        api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: true,  input: ["text"], cost: { inputPerMtok: 0.22, outputPerMtok: 0.88 }, contextWindow: 128000, maxTokens: 8192 },
      { id: "qwen3-30b-a3b",               displayName: "Qwen 3 30B",         api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: true,  input: ["text"], cost: { inputPerMtok: 0.1,  outputPerMtok: 0.4  }, contextWindow: 128000, maxTokens: 8192 },
      { id: "qwen3-8b",                    displayName: "Qwen 3 8B",          api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: false, input: ["text"], cost: { inputPerMtok: 0.05, outputPerMtok: 0.2  }, contextWindow: 128000, maxTokens: 8192 },
      { id: "qwen-max",                    displayName: "Qwen Max",           api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: false, input: ["text"], cost: { inputPerMtok: 0.4,  outputPerMtok: 1.2  }, contextWindow: 32000,  maxTokens: 8192 },
      { id: "qwen-turbo",                  displayName: "Qwen Turbo",         api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: false, input: ["text"], cost: { inputPerMtok: 0.05, outputPerMtok: 0.2  }, contextWindow: 128000, maxTokens: 8192 },
      { id: "qwen2.5-coder-32b-instruct",  displayName: "Qwen 2.5 Coder 32B", api: "openai-completions", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", reasoning: false, input: ["text"], cost: { inputPerMtok: 0.1,  outputPerMtok: 0.4  }, contextWindow: 128000, maxTokens: 8192 },
    ],
  },
];

// ─── Catalog singleton ────────────────────────────────────────────────────────

function buildProviderCatalog(): ProviderCatalog {
  const piAiProviders = getProviders()
    .filter((key) => !HIDDEN_PI_AI_PROVIDERS.has(key))
    .map((key) => buildPiAiProvider(key));
  return [...piAiProviders, ...CUSTOM_PROVIDERS];
}

/** Built once at startup — pi-ai registry data is static. */
export const PROVIDER_CATALOG: ProviderCatalog = buildProviderCatalog();

export function catalogRequiredModels(providerName: string): string[] {
  return PROVIDER_CATALOG.find((p) => p.name === providerName)?.models.map((m) => m.id) ?? [];
}
