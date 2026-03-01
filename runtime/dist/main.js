import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config.js";
import { grpcClient } from "./grpc/client.js";
import { formatSseData } from "./sse/emitter.js";
import { IdempotencyConflictError, RunStore } from "./sse/run-store.js";
import { startRun } from "./agent/runner.js";
import { runChannelRequest } from "./agent/channel-runner.js";
import { initializeRuntimePlugins, syncRuntimePlugin } from "./plugins/runtime-loader.js";
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", async () => ({ status: "ok" }));
const runStore = new RunStore({
    maxEventsPerRun: config.runEventBufferSize,
    runRetentionMs: config.runRetentionMs,
    idempotencyTtlMs: config.runIdempotencyTtlMs,
    cleanupIntervalMs: config.runStoreCleanupIntervalMs,
});
// ─── Channel run (async, no SSE) ──────────────────────────────────────────────
// POST /channel-run
// Body: { sessionId, channelId, agentId, workspaceId, message, chatId, threadId? }
// Returns immediately (202); actual agent run continues in background and pushes
// the final reply back to Gateway /channels/:channelId/send.
app.post("/channel-run", async (request, reply) => {
    const runtimeSecretHeader = request.headers["x-runtime-secret"];
    const providedSecret = Array.isArray(runtimeSecretHeader)
        ? (runtimeSecretHeader[0] ?? "")
        : (runtimeSecretHeader ?? "");
    if (providedSecret !== config.runtimeSecret) {
        return reply.status(401).send({ error: "invalid runtime secret" });
    }
    const body = request.body;
    if (!body?.sessionId ||
        !body?.channelId ||
        !body?.agentId ||
        !body?.workspaceId ||
        !body?.message ||
        !body?.chatId) {
        return reply.status(400).send({
            error: "sessionId, channelId, agentId, workspaceId, message, chatId required",
        });
    }
    setImmediate(() => {
        processChannelRun(body).catch((err) => {
            app.log.error({
                err,
                sessionId: body.sessionId,
                channelId: body.channelId,
                agentId: body.agentId,
            }, "Channel run failed");
        });
    });
    return reply.status(202).send({ accepted: true });
});
// ─── Runtime plugin sync (hot load/reload/unload) ────────────────────────────
app.post("/runtime/plugins/sync", async (request, reply) => {
    const runtimeSecretHeader = request.headers["x-runtime-secret"];
    const providedSecret = Array.isArray(runtimeSecretHeader)
        ? (runtimeSecretHeader[0] ?? "")
        : (runtimeSecretHeader ?? "");
    if (providedSecret !== config.runtimeSecret) {
        return reply.status(401).send({ error: "invalid runtime secret" });
    }
    const body = request.body;
    if (!body?.installedPluginId || !body?.workspaceId || !body?.pluginId || !body?.installPath) {
        return reply
            .status(400)
            .send({ error: "installedPluginId, workspaceId, pluginId, installPath required" });
    }
    const result = await syncRuntimePlugin({
        grpc: grpcClient,
        logger: app.log,
        request: {
            action: body.action,
            installedPluginId: body.installedPluginId,
            workspaceId: body.workspaceId,
            pluginId: body.pluginId,
            pluginName: body.pluginName ?? body.pluginId,
            pluginVersion: body.pluginVersion ?? "0.0.0",
            pluginType: body.pluginType ?? "tool",
            status: body.status ?? "enabled",
            configJson: body.configJson ?? "{}",
            installPath: body.installPath,
            sourceType: body.sourceType ?? "",
            sourceSpec: body.sourceSpec ?? "",
            actorUserId: body.actorUserId ?? "runtime",
        },
    });
    if (!result.ok) {
        return reply.status(500).send(result);
    }
    return reply.send(result);
});
// ─── Create run (async) ───────────────────────────────────────────────────────
// POST /runtime/ws/:wsId/runs
// Body: { sessionId, userRequest, coordinatorAgentId }
// Returns: { runId }
// The run starts asynchronously; subscribe to /runtime/runs/:runId/stream for events.
function firstHeaderValue(value) {
    if (Array.isArray(value))
        return value[0] ?? "";
    return value ?? "";
}
function buildContinueRequest(userRequest, assistantContent) {
    return [
        "请继续你上一条中断的回答。",
        "要求：不要重复已经输出的内容，直接从中断处续写并完成回答。",
        `用户原始问题：${userRequest}`,
        "你已经输出的部分（用于对齐上下文）：",
        assistantContent.trim().length > 0 ? assistantContent : "(空)",
    ].join("\n\n");
}
function extractRunIdFromLocalMessageId(messageId) {
    const normalized = messageId.trim();
    const matched = /^run-([0-9a-fA-F-]{36})-\d+$/.exec(normalized);
    return matched?.[1] ?? null;
}
app.post("/runtime/ws/:wsId/runs", async (request, reply) => {
    const { wsId } = request.params;
    const { sessionId, userRequest, coordinatorAgentId } = request.body;
    const resumeFromMessageId = (request.body.resumeFromMessageId ?? "").trim();
    const explicitResumeFromRunId = (request.body.resumeFromRunId ?? "").trim();
    const resumeFromRunId = explicitResumeFromRunId || extractRunIdFromLocalMessageId(resumeFromMessageId || "") || "";
    const resumeMode = request.body.resumeMode === "regenerate" ? "regenerate" : "continue";
    let effectiveSessionId = (sessionId ?? "").trim();
    let effectiveUserRequest = (userRequest ?? "").trim();
    let effectiveCoordinatorAgentId = (coordinatorAgentId ?? "").trim();
    if (resumeFromMessageId || resumeFromRunId) {
        let context = null;
        let messageLookupErrorCode;
        if (resumeFromMessageId) {
            try {
                context = await grpcClient.getContinueContextByMessage(resumeFromMessageId);
            }
            catch (error) {
                const code = error?.code;
                messageLookupErrorCode = code;
                if (code === 3) {
                    return reply.status(400).send({ error: "invalid assistant message id" });
                }
                if (code !== 5 || !resumeFromRunId) {
                    if (code === 5) {
                        return reply.status(404).send({ error: "assistant message not found" });
                    }
                    throw error;
                }
            }
        }
        if (!context && resumeFromRunId) {
            try {
                context = await grpcClient.getContinueContextByRun(resumeFromRunId);
            }
            catch (error) {
                const code = error?.code;
                if (code === 3) {
                    return reply.status(400).send({ error: "invalid run id" });
                }
                if (code === 5) {
                    if (messageLookupErrorCode === 5 && resumeFromMessageId) {
                        return reply.status(404).send({ error: "assistant message and run context not found" });
                    }
                    return reply.status(404).send({ error: "run context not found" });
                }
                throw error;
            }
        }
        if (!context) {
            return reply.status(404).send({ error: "resume context not found" });
        }
        if ((context.workspaceId ?? "").trim() !== wsId) {
            return reply.status(400).send({ error: "resume context does not belong to workspace" });
        }
        effectiveSessionId = (context.sessionId ?? "").trim();
        effectiveCoordinatorAgentId = (context.coordinatorAgentId ?? "").trim();
        effectiveUserRequest =
            resumeMode === "regenerate"
                ? (context.userRequest ?? "").trim()
                : buildContinueRequest(context.userRequest ?? "", context.assistantContent ?? "");
    }
    const startCandidateOffset = typeof request.body.startCandidateOffset === "number" && Number.isFinite(request.body.startCandidateOffset)
        ? Math.max(0, Math.floor(request.body.startCandidateOffset))
        : (resumeFromMessageId || resumeFromRunId) && resumeMode === "continue"
            ? 1
            : undefined;
    if (!effectiveSessionId || !effectiveUserRequest || !effectiveCoordinatorAgentId) {
        return reply.status(400).send({ error: "sessionId, userRequest, coordinatorAgentId required" });
    }
    const idempotencyHeader = firstHeaderValue(request.headers["idempotency-key"]);
    const idempotencyKey = (request.body.idempotencyKey ?? idempotencyHeader).trim() || undefined;
    const fingerprint = JSON.stringify({
        sessionId: effectiveSessionId,
        workspaceId: wsId,
        userRequest: effectiveUserRequest,
        coordinatorAgentId: effectiveCoordinatorAgentId,
        startCandidateOffset: startCandidateOffset ?? 0,
        resumeFromMessageId: resumeFromMessageId || "",
        resumeFromRunId: resumeFromRunId || "",
        resumeMode,
    });
    try {
        const createResult = await runStore.createRuntimeRun({
            params: {
                sessionId: effectiveSessionId,
                workspaceId: wsId,
                userRequest: effectiveUserRequest,
                coordinatorAgentId: effectiveCoordinatorAgentId,
                startCandidateOffset,
            },
            idempotencyKey,
            fingerprint,
            createRun: () => grpcClient.createRun({
                sessionId: effectiveSessionId,
                workspaceId: wsId,
                userRequest: effectiveUserRequest,
                coordinatorAgentId: effectiveCoordinatorAgentId,
            }),
        });
        setImmediate(() => {
            runStore
                .startRun(createResult.runId, async ({ runId, params, emit }) => {
                await startRun({ runId, ...params }, emit);
            })
                .catch((err) => {
                app.log.error({ err, runId: createResult.runId }, "Agent run failed");
            });
        });
        return reply.send({
            runId: createResult.runId,
            deduplicated: createResult.deduplicated,
        });
    }
    catch (err) {
        if (err instanceof IdempotencyConflictError) {
            return reply.status(409).send({ error: err.message, code: err.code });
        }
        throw err;
    }
});
// ─── SSE stream ───────────────────────────────────────────────────────────────
// GET /runtime/runs/:runId/stream
// Returns: text/event-stream
app.get("/runtime/runs/:runId/stream", async (request, reply) => {
    const { runId } = request.params;
    const snapshot = runStore.getSnapshot(runId);
    if (!snapshot) {
        return reply.status(404).send({ error: "run not found or expired" });
    }
    const cursorRaw = request.query.cursor;
    const cursor = typeof cursorRaw === "number"
        ? cursorRaw
        : typeof cursorRaw === "string"
            ? Number.parseInt(cursorRaw, 10)
            : 0;
    const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.flushHeaders();
    let subscription = null;
    const closeStream = () => {
        subscription?.unsubscribe();
        if (!reply.raw.writableEnded) {
            reply.raw.end();
        }
    };
    const emit = (event) => {
        if (reply.raw.destroyed || reply.raw.writableEnded)
            return;
        reply.raw.write(formatSseData(event));
        if (event.type === "done" || event.type === "error") {
            // Ensure frontend read loop can terminate naturally.
            setImmediate(closeStream);
        }
    };
    try {
        subscription = runStore.subscribe(runId, emit, safeCursor);
    }
    catch {
        return reply.status(404).send({ error: "run not found or expired" });
    }
    // Clean up channel when client disconnects
    request.raw.on("close", closeStream);
    request.raw.on("finish", closeStream);
    if (subscription.snapshot.terminal) {
        setImmediate(closeStream);
    }
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
    runStore.cancel(runId, "Run cancelled by user");
    return reply.send({ ok: true });
});
async function processChannelRun(body) {
    const { runId, replyText } = await runChannelRequest({
        sessionId: body.sessionId,
        workspaceId: body.workspaceId,
        agentId: body.agentId,
        message: body.message,
    });
    if (!replyText) {
        app.log.warn({ runId, channelId: body.channelId, agentId: body.agentId }, "Channel run produced empty reply; skip send");
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
async function sendReplyToChannel(params) {
    const payload = {
        chatId: params.chatId,
        text: params.text,
    };
    if (params.threadId) {
        payload.threadId = params.threadId;
    }
    const response = await fetch(`${config.gatewayAddr}/channels/${encodeURIComponent(params.channelId)}/send`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Runtime-Secret": config.runtimeSecret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.channelSendTimeoutMs),
    });
    if (!response.ok) {
        let detail = "";
        try {
            detail = (await response.text()).trim();
        }
        catch {
            // ignore body parse failures
        }
        throw new Error(`Gateway send failed (${response.status}): ${detail || response.statusText}`);
    }
}
// ─── Start ────────────────────────────────────────────────────────────────────
try {
    try {
        const summary = await initializeRuntimePlugins({
            grpc: grpcClient,
            logger: app.log,
        });
        app.log.info(summary, "Runtime plugin bootstrap completed");
    }
    catch (err) {
        app.log.error({ err }, "Runtime plugin bootstrap failed");
    }
    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`Runtime listening on :${config.port}`);
}
catch (err) {
    runStore.close();
    app.log.error(err);
    process.exit(1);
}
