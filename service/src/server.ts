import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { startGrpcServer } from "./grpc/server.js";

const app = Fastify({ logger: true });

async function main() {
  await app.register(cors, { origin: true });

  // Reject insecure default secrets in production
  if (process.env.NODE_ENV === "production") {
    const insecure = [
      config.jwtSecret === "dev-secret-change-in-production" && "JWT_SECRET",
      config.runtimeSecret === "dev-runtime-secret" && "RUNTIME_SECRET",
      config.encryptionSecret === "dev-secret-change-in-production" && "ENCRYPTION_SECRET",
    ].filter(Boolean) as string[];
    if (insecure.length > 0) {
      console.error(`FATAL: Insecure default secrets detected for: ${insecure.join(", ")}. Cannot start in production.`);
      process.exit(1);
    }
  }

  // Warn if ENCRYPTION_SECRET is not set (falling back to JWT_SECRET or hardcoded default)
  if (!process.env.ENCRYPTION_SECRET) {
    if (process.env.JWT_SECRET) {
      console.warn(
        "[config] ENCRYPTION_SECRET not set — falling back to JWT_SECRET for API key encryption. " +
        "Set ENCRYPTION_SECRET to an independent secret in production.",
      );
    } else {
      console.warn(
        "[config] ENCRYPTION_SECRET and JWT_SECRET are not set — using hardcoded default. " +
        "This is insecure; set ENCRYPTION_SECRET in production.",
      );
    }
  }

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
