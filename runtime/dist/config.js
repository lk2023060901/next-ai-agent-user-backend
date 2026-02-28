function getEnv(key, fallback) {
    return process.env[key] ?? fallback;
}
function getIntEnv(key, fallback) {
    const raw = process.env[key];
    if (!raw)
        return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}
export const config = {
    port: getIntEnv("RUNTIME_PORT", 8082),
    grpcAddr: getEnv("GRPC_ADDR", "localhost:50051"),
    bifrostAddr: getEnv("BIFROST_ADDR", "http://localhost:8081"),
    gatewayAddr: getEnv("GATEWAY_ADDR", "http://localhost:8080"),
    runtimeSecret: getEnv("RUNTIME_SECRET", "dev-runtime-secret"),
    channelSendTimeoutMs: getIntEnv("CHANNEL_SEND_TIMEOUT_MS", 15000),
    runEventBufferSize: getIntEnv("RUN_EVENT_BUFFER_SIZE", 1200),
    runRetentionMs: getIntEnv("RUN_RETENTION_MS", 30 * 60_000),
    runStoreCleanupIntervalMs: getIntEnv("RUN_STORE_CLEANUP_INTERVAL_MS", 30_000),
    runIdempotencyTtlMs: getIntEnv("RUN_IDEMPOTENCY_TTL_MS", 10 * 60_000),
    protoDir: getEnv("PROTO_DIR", `${import.meta.dirname}/../../proto`),
    // LLM direct access (bypasses Bifrost). Set both to skip Bifrost.
    // For BigModel: LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
    llmBaseUrl: getEnv("LLM_BASE_URL", ""),
    llmApiKey: getEnv("LLM_API_KEY", ""),
};
