function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  port: parseInt(getEnv("RUNTIME_PORT", "8082"), 10),
  grpcAddr: getEnv("GRPC_ADDR", "localhost:50051"),
  bifrostAddr: getEnv("BIFROST_ADDR", "http://localhost:8081"),
  protoDir: getEnv("PROTO_DIR", `${import.meta.dirname}/../../proto`),
  // LLM direct access (bypasses Bifrost). Set both to skip Bifrost.
  // For BigModel: LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4
  llmBaseUrl: getEnv("LLM_BASE_URL", ""),
  llmApiKey: getEnv("LLM_API_KEY", ""),
};
