import { getModel, type Api, type Model } from "@mariozechner/pi-ai";
import { normalizeModelCompat } from "./model-compat.js";

/**
 * Forward-compat layer for model IDs not yet present in the current pi-ai registry.
 *
 * Pattern (mirrors openclaw/src/agents/model-forward-compat.ts):
 *   1. Try to load each template model ID from the pi-ai registry via getModel().
 *   2. Clone the first successful template, overriding id/name with the requested ID.
 *   3. Apply normalizeModelCompat() to the cloned model.
 *   4. Fall back to a hardcoded stub only if no template was found.
 *
 * We use getModel() instead of ModelRegistry.find() because we don't depend on
 * @mariozechner/pi-coding-agent. The semantics are identical: try each template ID,
 * skip on failure, use the first that resolves.
 */

// ─── Anthropic ────────────────────────────────────────────────────────────────

const ANTHROPIC_SONNET_46_ID = "claude-sonnet-4-6";
const ANTHROPIC_SONNET_46_DOT_ID = "claude-sonnet-4.6";
const ANTHROPIC_SONNET_TEMPLATE_IDS = ["claude-sonnet-4-5", "claude-sonnet-4.5"] as const;

const ANTHROPIC_OPUS_46_ID = "claude-opus-4-6";
const ANTHROPIC_OPUS_46_DOT_ID = "claude-opus-4.6";
const ANTHROPIC_OPUS_TEMPLATE_IDS = ["claude-opus-4-5", "claude-opus-4.5"] as const;

// ─── OpenAI ───────────────────────────────────────────────────────────────────

const OPENAI_GPT_53_ID = "gpt-5.3";
const OPENAI_GPT_53_TEMPLATE_IDS = ["gpt-5.2"] as const;

const OPENAI_GPT_54_ID = "gpt-5.4";
const OPENAI_GPT_54_TEMPLATE_IDS = ["gpt-5.2"] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cloneFirstTemplateModel(params: {
  provider: string;
  modelId: string;
  templateIds: readonly string[];
  patch?: Partial<Model<Api>>;
}): Model<Api> | undefined {
  for (const templateId of [...new Set(params.templateIds)].filter(Boolean)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const template = getModel(params.provider as any, templateId as any) as Model<Api>;
      if (!template) continue;
      return normalizeModelCompat({
        ...template,
        id: params.modelId,
        name: params.modelId,
        ...params.patch,
      } as Model<Api>);
    } catch {
      continue;
    }
  }
  return undefined;
}

// ─── Per-provider resolvers ───────────────────────────────────────────────────

function resolveAnthropicForwardCompat(
  modelId: string,
  dashId: string,
  dotId: string,
  templateIds: readonly string[],
): Model<Api> | undefined {
  const lower = modelId.toLowerCase();
  if (
    lower !== dashId &&
    lower !== dotId &&
    !lower.startsWith(`${dashId}-`) &&
    !lower.startsWith(`${dotId}-`)
  ) {
    return undefined;
  }

  // Build ordered template list: try suffix-mapped IDs first, then generic fallbacks
  const ordered: string[] = [];
  if (lower.startsWith(dashId)) {
    ordered.push(lower.replace(dashId, templateIds[0]!));
  }
  if (lower.startsWith(dotId)) {
    ordered.push(lower.replace(dotId, templateIds[1] ?? templateIds[0]!));
  }
  ordered.push(...templateIds);

  return cloneFirstTemplateModel({ provider: "anthropic", modelId, templateIds: ordered });
}

function resolveOpenAIForwardCompat(
  modelId: string,
  targetId: string,
  templateIds: readonly string[],
): Model<Api> | undefined {
  if (modelId.toLowerCase() !== targetId) {
    return undefined;
  }
  return cloneFirstTemplateModel({ provider: "openai", modelId, templateIds });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve forward-compat for model IDs not yet registered in the current
 * pi-ai version. Returns undefined if the modelId/provider combination is
 * not a known forward-compat case.
 *
 * Call this AFTER the primary registry lookup (getModel) fails and BEFORE
 * falling back to a generic hardcoded stub.
 */
export function resolveForwardCompatModel(
  provider: string,
  modelId: string,
): Model<Api> | undefined {
  const normalizedProvider = provider.trim().toLowerCase();
  const trimmedModelId = modelId.trim();

  if (normalizedProvider === "anthropic") {
    return (
      resolveAnthropicForwardCompat(
        trimmedModelId,
        ANTHROPIC_SONNET_46_ID,
        ANTHROPIC_SONNET_46_DOT_ID,
        ANTHROPIC_SONNET_TEMPLATE_IDS,
      ) ??
      resolveAnthropicForwardCompat(
        trimmedModelId,
        ANTHROPIC_OPUS_46_ID,
        ANTHROPIC_OPUS_46_DOT_ID,
        ANTHROPIC_OPUS_TEMPLATE_IDS,
      )
    );
  }

  if (normalizedProvider === "openai") {
    return (
      resolveOpenAIForwardCompat(trimmedModelId, OPENAI_GPT_53_ID, OPENAI_GPT_53_TEMPLATE_IDS) ??
      resolveOpenAIForwardCompat(trimmedModelId, OPENAI_GPT_54_ID, OPENAI_GPT_54_TEMPLATE_IDS)
    );
  }

  return undefined;
}
