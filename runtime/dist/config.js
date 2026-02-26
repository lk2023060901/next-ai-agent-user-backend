function getEnv(key, fallback) {
    return process.env[key] ?? fallback;
}
export const config = {
    port: parseInt(getEnv("RUNTIME_PORT", "8082"), 10),
    grpcAddr: getEnv("GRPC_ADDR", "localhost:50051"),
    bifrostAddr: getEnv("BIFROST_ADDR", "http://localhost:8081"),
    protoDir: getEnv("PROTO_DIR", `${__dirname}/../../proto`),
};
