import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config";
import { startGrpcServer } from "./grpc/server";

const app = Fastify({ logger: true });

async function main() {
  await app.register(cors, { origin: true });

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Start gRPC server
  startGrpcServer(config.grpcPort);

  // Start Fastify (for future REST endpoints if needed)
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`Fastify listening on :${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
