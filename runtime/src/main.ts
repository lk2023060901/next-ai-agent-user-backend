import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { grpcClient } from "./grpc/client.js";
import { registerChannel, removeChannel, formatSseData, type SseEvent } from "./sse/emitter.js";
import { startRun } from "./agent/runner.js";
import { runChannelRequest } from "./agent/channel-runner.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

interface ChannelRunBody {
  sessionId: string;
  channelId: string;
  agentId: string;
  workspaceId: string;
  message: string;
  sender?: string;
  chatId: string;
  threadId?: string;
  messageId?: string;
}

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", async () => ({ status: "ok" }));

// ─── Channel run (async, no SSE) ──────────────────────────────────────────────
// POST /channel-run
// Body: { sessionId, channelId, agentId, workspaceId, message, chatId, threadId? }
// Returns immediately (202); actual agent run continues in background and pushes
// the final reply back to Gateway /channels/:channelId/send.

app.post<{ Body: ChannelRunBody }>("/channel-run", async (request, reply) => {
  const runtimeSecretHeader = request.headers["x-runtime-secret"];
  const providedSecret = Array.isArray(runtimeSecretHeader)
    ? (runtimeSecretHeader[0] ?? "")
    : (runtimeSecretHeader ?? "");
  if (providedSecret !== config.runtimeSecret) {
    return reply.status(401).send({ error: "invalid runtime secret" });
  }

  const body = request.body;

  if (
    !body?.sessionId ||
    !body?.channelId ||
    !body?.agentId ||
    !body?.workspaceId ||
    !body?.message ||
    !body?.chatId
  ) {
    return reply.status(400).send({
      error: "sessionId, channelId, agentId, workspaceId, message, chatId required",
    });
  }

  setImmediate(() => {
    processChannelRun(body).catch((err) => {
      app.log.error(
        {
          err,
          sessionId: body.sessionId,
          channelId: body.channelId,
          agentId: body.agentId,
        },
        "Channel run failed"
      );
    });
  });

  return reply.status(202).send({ accepted: true });
});

// ─── Create run (async) ───────────────────────────────────────────────────────
// POST /runtime/ws/:wsId/runs
// Body: { sessionId, userRequest, coordinatorAgentId }
// Returns: { runId }
// The run starts asynchronously; subscribe to /runtime/runs/:runId/stream for events.

// Pending runs: created but not yet started (waiting for SSE client to connect)
const pendingRuns = new Map<string, { sessionId: string; workspaceId: string; userRequest: string; coordinatorAgentId: string }>();

app.post<{
  Params: { wsId: string };
  Body: { sessionId: string; userRequest: string; coordinatorAgentId: string };
}>("/runtime/ws/:wsId/runs", async (request, reply) => {
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

  // Save run params — actual execution starts when the SSE client connects
  pendingRuns.set(runId, { sessionId, workspaceId: wsId, userRequest, coordinatorAgentId });

  return reply.send({ runId });
});

// ─── SSE stream ───────────────────────────────────────────────────────────────
// GET /runtime/runs/:runId/stream
// Returns: text/event-stream

app.get<{ Params: { runId: string } }>(
  "/runtime/runs/:runId/stream",
  async (request, reply) => {
    const { runId } = request.params;

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();

    const closeStream = () => {
      removeChannel(runId);
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    const emit = (event: SseEvent) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(formatSseData(event));
      if (event.type === "done" || event.type === "error") {
        // Ensure frontend read loop can terminate naturally.
        setImmediate(closeStream);
      }
    };

    registerChannel(runId, emit);

    // Clean up channel when client disconnects
    request.raw.on("close", closeStream);

    // Start the run now that the SSE channel is registered
    const pending = pendingRuns.get(runId);
    if (pending) {
      pendingRuns.delete(runId);
      setImmediate(() => {
        startRun({ runId, ...pending }).catch((err) => {
          app.log.error({ err, runId }, "Agent run failed");
        });
      });
    }

    // Keep connection alive — the coordinator will close it via message-end
    await new Promise<void>((resolve) => {
      reply.raw.on("close", resolve);
      reply.raw.on("finish", resolve);
    });
  }
);

// ─── Cancel run ──────────────────────────────────────────────────────────────
// POST /runtime/runs/:runId/cancel

app.post<{ Params: { runId: string } }>("/runtime/runs/:runId/cancel", async (request, reply) => {
  const { runId } = request.params;
  await grpcClient.updateRunStatus(runId, "cancelled");
  removeChannel(runId);
  return reply.send({ ok: true });
});

async function processChannelRun(body: ChannelRunBody): Promise<void> {
  const { runId, replyText } = await runChannelRequest({
    sessionId: body.sessionId,
    workspaceId: body.workspaceId,
    agentId: body.agentId,
    message: body.message,
  });

  if (!replyText) {
    app.log.warn(
      { runId, channelId: body.channelId, agentId: body.agentId },
      "Channel run produced empty reply; skip send"
    );
    return;
  }

  await sendReplyToChannel({
    channelId: body.channelId,
    chatId: body.chatId,
    text: replyText,
    threadId: body.threadId,
  });

  app.log.info({ runId, channelId: body.channelId }, "Channel reply sent");
}

async function sendReplyToChannel(params: {
  channelId: string;
  chatId: string;
  text: string;
  threadId?: string;
}): Promise<void> {
  const payload: { chatId: string; text: string; threadId?: string } = {
    chatId: params.chatId,
    text: params.text,
  };
  if (params.threadId) {
    payload.threadId = params.threadId;
  }

  const response = await fetch(
    `${config.gatewayAddr}/channels/${encodeURIComponent(params.channelId)}/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runtime-Secret": config.runtimeSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.channelSendTimeoutMs),
    }
  );

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).trim();
    } catch {
      // ignore body parse failures
    }
    throw new Error(`Gateway send failed (${response.status}): ${detail || response.statusText}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`Runtime listening on :${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
