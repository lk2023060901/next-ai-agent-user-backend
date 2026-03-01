import { v4 as uuidv4 } from "uuid";
const PLUGIN_USAGE_SPEC_VERSION = "plugin-usage.v1";
const ALLOWED_PLUGIN_USAGE_STATUSES = new Set(["success", "failure", "partial"]);
function asRecord(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return null;
    return input;
}
function asString(input) {
    if (typeof input !== "string")
        return undefined;
    const value = input.trim();
    return value.length > 0 ? value : undefined;
}
function asNumber(input) {
    if (typeof input === "number" && Number.isFinite(input))
        return input;
    if (typeof input === "string" && input.trim().length > 0) {
        const parsed = Number(input);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return undefined;
}
function toNonNegativeInt(input) {
    const parsed = asNumber(input);
    if (parsed === undefined)
        return 0;
    return Math.max(0, Math.floor(parsed));
}
function normalizeStatus(status, fallback) {
    const normalized = String(status ?? "").trim().toLowerCase();
    if (ALLOWED_PLUGIN_USAGE_STATUSES.has(normalized)) {
        return normalized;
    }
    return fallback;
}
function safeJsonStringify(input) {
    try {
        return JSON.stringify(input ?? {});
    }
    catch {
        return "{}";
    }
}
function extractPluginUsageMeta(result) {
    const resultRecord = asRecord(result);
    if (!resultRecord)
        return {};
    const pluginUsage = asRecord(resultRecord.pluginUsage);
    const nestedMetrics = pluginUsage ? asRecord(pluginUsage.metrics) : null;
    const nestedPayload = pluginUsage ? asRecord(pluginUsage.payload) : null;
    const topLevelMetrics = asRecord(resultRecord.metrics);
    const statusRaw = pluginUsage?.status ?? resultRecord.status;
    const status = statusRaw ? normalizeStatus(statusRaw, "success") : undefined;
    const eventType = asString(pluginUsage?.eventType) ?? asString(resultRecord.eventType);
    return {
        eventType,
        status,
        metrics: nestedMetrics ?? topLevelMetrics ?? undefined,
        payload: nestedPayload ?? undefined,
    };
}
export async function reportPluginToolUsageEvent(params) {
    const durationMs = Math.max(0, params.endedAtMs - params.startedAtMs);
    const hasError = Boolean(params.errorMessage);
    const meta = extractPluginUsageMeta(params.result);
    const status = normalizeStatus(meta.status, hasError ? "failure" : "success");
    const metrics = {
        latencyMs: durationMs,
        durationMs,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        successCount: status === "success" ? 1 : 0,
        failureCount: status === "failure" ? 1 : 0,
    };
    if (meta.metrics) {
        for (const [key, value] of Object.entries(meta.metrics)) {
            metrics[key] = value;
        }
    }
    const inputTokens = toNonNegativeInt(metrics.inputTokens);
    const outputTokens = toNonNegativeInt(metrics.outputTokens);
    const totalTokensRaw = toNonNegativeInt(metrics.totalTokens);
    metrics.inputTokens = inputTokens;
    metrics.outputTokens = outputTokens;
    metrics.totalTokens = totalTokensRaw > 0 ? totalTokensRaw : inputTokens + outputTokens;
    metrics.successCount = toNonNegativeInt(metrics.successCount);
    metrics.failureCount = toNonNegativeInt(metrics.failureCount);
    metrics.latencyMs = toNonNegativeInt(metrics.latencyMs);
    metrics.durationMs = toNonNegativeInt(metrics.durationMs);
    const scope = params.context.depth > 0 ? "sub_agent" : "coordinator";
    const payload = {
        recordType: "plugin",
        scope,
        sessionId: "",
        taskId: params.context.taskId,
        agentId: params.context.agentId,
        agentName: "",
        agentRole: scope,
        pluginId: params.plugin.pluginId,
        installedPluginId: params.plugin.installedPluginId,
        toolName: params.toolName,
        model: params.context.agentModel,
        provider: "",
        errorMessage: params.errorMessage ?? "",
    };
    if (meta.payload) {
        for (const [key, value] of Object.entries(meta.payload)) {
            payload[key] = value;
        }
    }
    const toolCallId = asString(params.toolCallId) ?? uuidv4();
    const eventType = meta.eventType ?? `plugin.tool.${params.toolName}`;
    const eventId = `${params.plugin.installedPluginId}:${params.context.runId}:${toolCallId}`;
    const timestamp = new Date(params.startedAtMs).toISOString();
    await params.grpc.reportPluginUsageEvents({
        workspaceId: params.context.workspaceId,
        events: [
            {
                specVersion: PLUGIN_USAGE_SPEC_VERSION,
                pluginName: params.plugin.pluginName || params.plugin.pluginId,
                pluginVersion: params.plugin.pluginVersion || "0.0.0",
                eventId,
                eventType,
                timestamp,
                workspaceId: params.context.workspaceId,
                runId: params.context.runId,
                status,
                metricsJson: safeJsonStringify(metrics),
                payloadJson: safeJsonStringify(payload),
            },
        ],
    });
}
