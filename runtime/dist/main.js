import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { grpcClient } from "./grpc/client.js";
import { registerChannel, removeChannel, formatSseData } from "./sse/emitter.js";
import { startRun } from "./agent/runner.js";
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", async () => ({ status: "ok" }));
// ─── Create run (async) ───────────────────────────────────────────────────────
// POST /runtime/ws/:wsId/runs
// Body: { sessionId, userRequest, coordinatorAgentId }
// Returns: { runId }
// The run starts asynchronously; subscribe to /runtime/runs/:runId/stream for events.
app.post("/runtime/ws/:wsId/runs", async (request, reply) => {
    const { wsId } = request.params;
    const { sessionId, userRequest, coordinatorAgentId } = request.body;
    if (!sessionId || !userRequest || !coordinatorAgentId) {
        return reply.status(400).send({ error: "sessionId, userRequest, coordinatorAgentId required" });
    }
    const { runId } = await grpcClient.createRun({
        sessionId,
        workspaceId: wsId,
        userRequest,
        coordinatorAgentId,
    });
    // Start the run in the background — SSE stream will deliver events
    setImmediate(() => {
        startRun({ runId, sessionId, workspaceId: wsId, userRequest, coordinatorAgentId }).catch((err) => {
            app.log.error({ err, runId }, "Agent run failed");
        });
    });
    return reply.send({ runId });
});
// ─── SSE stream ───────────────────────────────────────────────────────────────
// GET /runtime/runs/:runId/stream
// Returns: text/event-stream
app.get("/runtime/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params;
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    const emit = (event) => {
        reply.raw.write(formatSseData(event));
    };
    registerChannel(runId, emit);
    // Clean up channel when client disconnects
    request.raw.on("close", () => {
        removeChannel(runId);
    });
    // Keep connection alive — the coordinator will close it via message-end
    await new Promise((resolve) => {
        reply.raw.on("close", resolve);
        reply.raw.on("finish", resolve);
    });
});
// ─── Cancel run ──────────────────────────────────────────────────────────────
// POST /runtime/runs/:runId/cancel
app.post("/runtime/runs/:runId/cancel", async (request, reply) => {
    const { runId } = request.params;
    await grpcClient.updateRunStatus(runId, "cancelled");
    removeChannel(runId);
    return reply.send({ ok: true });
});
// ─── Start ────────────────────────────────────────────────────────────────────
try {
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`Runtime listening on :${config.port}`);
}
catch (err) {
    app.log.error(err);
    process.exit(1);
}
