import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { grpcClient } from "./grpc/client.js";
import { formatSseData, type SseEvent } from "./sse/emitter.js";
import { IdempotencyConflictError, RunStore } from "./sse/run-store.js";
import { startRun } from "./agent/runner.js";
import { runChannelRequest } from "./agent/channel-runner.js";
import { runScheduledTask } from "./agent/scheduled-runner.js";
import { initializeRuntimePlugins, syncRuntimePlugin } from "./plugins/runtime-loader.js";
import { getRuntimeServices, closeRuntimeServices } from "./bootstrap.js";
import { approvalGate } from "./tools/approval-gate.js";
import { DefaultOrchestrator } from "./orchestrator/orchestrator.impl.js";
import { DefaultEventBus } from "./events/event-bus.js";
import type { RunResult } from "./agent/agent-types.js";
import {
  buildContinueRequest,
  decideApprovalResponse,
  decideCancelFinalizeResponse,
  decideCancelResponse,
  decideChannelReplyRetry,
  decideCreateRunSuccessResponse,
  decideEnqueueFailureResponse,
  extractRunIdFromLocalMessageId,
  firstHeaderValue,
} from "./http/runtime-route-helpers.js";
import {
  syncKbDocument,
  deleteKbDocument,
  deleteKbEntireKnowledgeBase,
} from "./kb/kb-sync.js";
import {
  loadPostRunFailureDetails,
  loadPostRunFailureSummary,
} from "./observability/post-run-query.js";

// Reject insecure default secrets in production
if (process.env.NODE_ENV === "production" && config.runtimeSecret === "dev-runtime-secret") {
  console.error("FATAL: RUNTIME_SECRET must be set in production. Cannot start with default secret.");
  process.exit(1);
}

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

// ─── Runtime secret auth middleware ───────────────────────────────────────────
// Used as a preHandler on all gateway→runtime internal endpoints.
// Uses timingSafeEqual to prevent timing-based secret extraction.

function runtimeSecretAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  done: () => void,
): void {
  const header = request.headers["x-runtime-secret"];
  const provided = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  const expected = config.runtimeSecret;
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    reply.status(401).send({ error: "invalid runtime secret" });
    return;
  }
  done();
}

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

interface CreateRuntimeRunBody {
  sessionId: string;
  userRequest: string;
  coordinatorAgentId: string;
  idempotencyKey?: string;
  startCandidateOffset?: number;
  resumeFromMessageId?: string;
  resumeFromRunId?: string;
  resumeMode?: "continue" | "regenerate";
  modelId?: string;
}

interface RuntimePluginSyncBody {
  action: string;
  installedPluginId: string;
  workspaceId: string;
  pluginId: string;
  pluginName?: string;
  pluginVersion?: string;
  pluginType?: string;
  status?: string;
  configJson?: string;
  installPath: string;
  sourceType?: string;
  sourceSpec?: string;
  actorUserId?: string;
}

// ─── Health ───────────────────────────────────────────────────────────────────

// L3: Track shutdown state so the health endpoint can report 503
let isShuttingDown = false;

app.get("/health", async (_request, reply) => {
  if (isShuttingDown) {
    return reply.status(503).send({ status: "shutting_down" });
  }
  return reply.send({ status: "ok" });
});

const runStore = new RunStore({
  maxEventsPerRun: config.runEventBufferSize,
  runRetentionMs: config.runRetentionMs,
  idempotencyTtlMs: config.runIdempotencyTtlMs,
  cleanupIntervalMs: config.runStoreCleanupIntervalMs,
});

// ─── Orchestrator (lane-based concurrency + session locking + retry) ──────
const eventBus = new DefaultEventBus();
const orchestrator = new DefaultOrchestrator({
  runHandler: async (request, context) => {
    if (request.lane === "channel") {
      // Channel lane — run directly without RunStore/SSE.
      // Collect text via a lightweight emit, return fullText in RunResult.
      let fullText = "";
      const collectEmit = (event: SseEvent) => {
        if (event.type === "text-delta") {
          fullText += event.text;
        }
      };

      await startRun(
        {
          runId: request.runId,
          sessionId: request.sessionKey,
          workspaceId: request.workspaceId,
          userRequest: request.userRequest,
          coordinatorAgentId: request.coordinatorAgentId,
          modelIdOverride: request.modelOverride,
          abortSignal: context.abortSignal,
        },
        collectEmit,
      );

      return {
        runId: request.runId,
        status: "completed",
        fullText,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnsUsed: 0,
      } satisfies RunResult;
    }

    // Scheduled lane — run without RunStore/SSE, collect text for result.
    if (request.lane === "scheduled") {
      let fullText = "";
      const collectEmit = (event: SseEvent) => {
        if (event.type === "text-delta") {
          fullText += event.text;
        }
      };

      await startRun(
        {
          runId: request.runId,
          sessionId: request.sessionKey,
          workspaceId: request.workspaceId,
          userRequest: request.userRequest,
          coordinatorAgentId: request.coordinatorAgentId,
          modelIdOverride: request.modelOverride,
          abortSignal: context.abortSignal,
        },
        collectEmit,
      );

      return {
        runId: request.runId,
        status: "completed",
        fullText,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        turnsUsed: 0,
      } satisfies RunResult;
    }

    // Interactive/other lanes — bridge through RunStore for SSE streaming.
    // Intercept usage + text-delta events so RunResult carries real telemetry.
    let interactiveFullText = "";
    const interactiveUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    await runStore.startRun(request.runId, async ({ runId, params, emit }) => {
      const instrumentedEmit = (event: SseEvent) => {
        if (event.type === "text-delta") {
          interactiveFullText += event.text;
        } else if (event.type === "usage") {
          interactiveUsage.inputTokens += event.inputTokens;
          interactiveUsage.outputTokens += event.outputTokens;
          interactiveUsage.totalTokens += event.totalTokens;
        }
        emit(event);
      };
      await startRun({ runId, ...params, abortSignal: context.abortSignal }, instrumentedEmit);
    });
    return {
      runId: request.runId,
      status: "completed",
      fullText: interactiveFullText,
      usage: interactiveUsage,
      turnsUsed: 0,
    } satisfies RunResult;
  },
  eventBus,
});

// ─── Channel run (async, no SSE) ──────────────────────────────────────────────
// POST /channel-run
// Body: { sessionId, channelId, agentId, workspaceId, message, chatId, threadId? }
// Returns immediately (202); actual agent run continues in background and pushes
// the final reply back to Gateway /channels/:channelId/send.

app.post<{ Body: ChannelRunBody }>(
  "/channel-run",
  { preHandler: runtimeSecretAuth },
  async (request, reply) => {
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

// ─── Scheduled run (cron task dispatch) ───────────────────────────────────────
// POST /runtime/scheduled-run
// Body: { workspaceId, sessionId, agentId, instruction, executionId }
// Authenticated via X-Runtime-Secret. Blocks until agent run completes.

interface ScheduledRunBody {
  workspaceId: string;
  sessionId: string;
  agentId: string;
  instruction: string;
  executionId: string;
}

app.post<{ Body: ScheduledRunBody }>(
  "/runtime/scheduled-run",
  { preHandler: runtimeSecretAuth },
  async (request, reply) => {
  const body = request.body;
  if (!body?.workspaceId || !body?.sessionId || !body?.agentId || !body?.instruction || !body?.executionId) {
    return reply.status(400).send({
      error: "workspaceId, sessionId, agentId, instruction, executionId required",
    });
  }

  try {
    const result = await runScheduledTask(
      {
        workspaceId: body.workspaceId,
        sessionId: body.sessionId,
        agentId: body.agentId,
        instruction: body.instruction,
        executionId: body.executionId,
      },
      { orchestrator, eventBus },
    );

    return reply.send({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    app.log.error({ err, executionId: body.executionId }, "Scheduled run failed");
    return reply.status(500).send({ error: message });
  }
});

// ─── Runtime plugin sync (hot load/reload/unload) ────────────────────────────
app.post<{ Body: RuntimePluginSyncBody }>(
  "/runtime/plugins/sync",
  { preHandler: runtimeSecretAuth },
  async (request, reply) => {
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

// ─── KB sync (R3: service → runtime knowledge base synchronization) ──────────
// POST /runtime/ws/:wsId/kb/sync
// Body: { action, knowledgeBaseId, documentId?, documentName?, chunks?, documentIds? }
// Authenticated via X-Runtime-Secret. Called by the service after KB document
// processing completes, or after document/KB deletion.

interface KbSyncBody {
  action: "sync-document" | "delete-document" | "delete-kb";
  knowledgeBaseId: string;
  documentId?: string;
  documentName?: string;
  chunks?: Array<{
    chunkIndex: number;
    content: string;
    embedding: number[];
  }>;
  documentIds?: string[];
}

app.post<{ Params: { wsId: string }; Body: KbSyncBody }>(
  "/runtime/ws/:wsId/kb/sync",
  { preHandler: runtimeSecretAuth },
  async (request, reply) => {
    const { wsId } = request.params;
    const body = request.body;

    if (!body?.action || !body?.knowledgeBaseId) {
      return reply.status(400).send({ error: "action and knowledgeBaseId required" });
    }

    try {
      switch (body.action) {
        case "sync-document": {
          if (!body.documentId || !body.chunks || body.chunks.length === 0) {
            return reply.status(400).send({ error: "documentId and non-empty chunks required for sync-document" });
          }
          const result = await syncKbDocument({
            workspaceId: wsId,
            knowledgeBaseId: body.knowledgeBaseId,
            documentId: body.documentId,
            documentName: body.documentName ?? "",
            chunks: body.chunks,
          });
          return reply.send({ data: result });
        }

        case "delete-document": {
          if (!body.documentId) {
            return reply.status(400).send({ error: "documentId required for delete-document" });
          }
          const result = await deleteKbDocument({ documentId: body.documentId });
          return reply.send({ data: result });
        }

        case "delete-kb": {
          if (!body.documentIds || body.documentIds.length === 0) {
            return reply.status(400).send({ error: "documentIds required for delete-kb" });
          }
          const result = await deleteKbEntireKnowledgeBase({
            knowledgeBaseId: body.knowledgeBaseId,
            documentIds: body.documentIds,
          });
          return reply.send({ data: result });
        }

        default:
          return reply.status(400).send({ error: `Unknown action: ${body.action}` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      app.log.error({ err, wsId, action: body.action }, "KB sync failed");
      return reply.status(500).send({ error: message });
    }
  },
);

// ─── Memory query (L1: memory visualization) ────────────────────────────────
// GET /runtime/ws/:wsId/agents/:agentId/memory?type=episodic&limit=50
// Returns: { data: MemoryEntry[] }

app.get<{
  Params: { wsId: string; agentId: string };
  Querystring: { type?: string; limit?: string; query?: string };
}>("/runtime/ws/:wsId/agents/:agentId/memory", async (request, reply) => {
  const { wsId, agentId } = request.params;
  const services = getRuntimeServices();

  if (!services.memoryManager) {
    return reply.status(503).send({ error: "Memory system not available" });
  }

  const typeParam = (request.query.type ?? "").trim();
  const validTypes = ["episodic", "semantic", "reflection", "meta_reflection", "knowledge"];
  const types = typeParam
    ? typeParam.split(",").filter((t) => validTypes.includes(t))
    : undefined;

  const limit = Math.min(
    Math.max(1, Number.parseInt(request.query.limit ?? "50", 10) || 50),
    200,
  );

  const queryText = (request.query.query ?? "").trim();

  if (queryText) {
    const results = await services.memoryManager.search({
      query: queryText,
      agentId,
      workspaceId: wsId,
      types: types as any,
      limit,
    });
    return reply.send({
      data: results.map((r) => ({
        ...r.entry,
        embedding: undefined,
        score: r.score,
        breakdown: r.breakdown,
        source: r.source,
      })),
    });
  }

  // Without query — list recent memories by type
  const results = await services.memoryManager.search({
    query: "",
    agentId,
    workspaceId: wsId,
    types: types as any,
    limit,
    includeDecayed: true,
  });
  return reply.send({
    data: results.map((r) => ({
      ...r.entry,
      embedding: undefined,
      score: r.score,
      breakdown: r.breakdown,
      source: r.source,
    })),
  });
});

// ─── Runtime status (L3: agent status panel real data) ─────────────────────
// GET /runtime/status
// Returns: { lanes, activeRuns, queueDepth }

app.get("/runtime/status", async (_request, reply) => {
  const status = orchestrator.getStatus?.() ?? {
    lanes: {},
    activeRuns: 0,
    queueDepth: 0,
  };
  return reply.send({ data: status });
});

// GET /runtime/ws/:wsId/observability/post-run?days=7
// Returns recent post-run failure metrics from runtime observability storage.
app.get<{ Params: { wsId: string }; Querystring: { days?: string } }>(
  "/runtime/ws/:wsId/observability/post-run",
  async (request, reply) => {
    const rawDays = Number(request.query.days ?? "7");
    const days = Number.isFinite(rawDays)
      ? Math.max(1, Math.min(90, Math.floor(rawDays || 7)))
      : 7;

    return reply.send(
      await loadPostRunFailureSummary({
        services: getRuntimeServices(),
        workspaceId: request.params.wsId,
        days,
      }),
    );
  },
);

// GET /runtime/ws/:wsId/observability/post-run/failures?stage=reflection&days=7&limit=20
// Returns recent failure records for one post-run stage.
app.get<{
  Params: { wsId: string };
  Querystring: { stage?: string; days?: string; limit?: string };
}>("/runtime/ws/:wsId/observability/post-run/failures", async (request, reply) => {
  const stage = (request.query.stage ?? "").trim();
  if (!stage) {
    return reply.status(400).send({ error: "stage query required" });
  }

  const rawDays = Number(request.query.days ?? "7");
  const days = Number.isFinite(rawDays)
    ? Math.max(1, Math.min(90, Math.floor(rawDays || 7)))
    : 7;
  const rawLimit = Number(request.query.limit ?? "20");
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(100, Math.floor(rawLimit || 20)))
    : 20;

  return reply.send({
    data: await loadPostRunFailureDetails({
      services: getRuntimeServices(),
      workspaceId: request.params.wsId,
      stage,
      days,
      limit,
    }),
  });
});

// ─── Create run (async) ───────────────────────────────────────────────────────
// POST /runtime/ws/:wsId/runs
// Body: { sessionId, userRequest, coordinatorAgentId }
// Returns: { runId }
// The run starts asynchronously; subscribe to /runtime/runs/:runId/stream for events.

app.post<{
  Params: { wsId: string };
  Body: CreateRuntimeRunBody;
}>("/runtime/ws/:wsId/runs", async (request, reply) => {
  const { wsId } = request.params;
  const { sessionId, userRequest, coordinatorAgentId } = request.body;
  const modelIdOverride = (request.body.modelId ?? "").trim() || undefined;
  const resumeFromMessageId = (request.body.resumeFromMessageId ?? "").trim();
  const explicitResumeFromRunId = (request.body.resumeFromRunId ?? "").trim();
  const resumeFromRunId =
    explicitResumeFromRunId || extractRunIdFromLocalMessageId(resumeFromMessageId || "") || "";
  const resumeMode = request.body.resumeMode === "regenerate" ? "regenerate" : "continue";
  let effectiveSessionId = (sessionId ?? "").trim();
  let effectiveUserRequest = (userRequest ?? "").trim();
  let effectiveCoordinatorAgentId = (coordinatorAgentId ?? "").trim();

  if (resumeFromMessageId || resumeFromRunId) {
    let context: Awaited<ReturnType<typeof grpcClient.getContinueContextByMessage>> | null = null;
    let messageLookupErrorCode: number | undefined;

    if (resumeFromMessageId) {
      try {
        context = await grpcClient.getContinueContextByMessage(resumeFromMessageId);
      } catch (error) {
        const code = (error as { code?: number } | null)?.code;
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
      } catch (error) {
        const code = (error as { code?: number } | null)?.code;
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

  const startCandidateOffset =
    typeof request.body.startCandidateOffset === "number" && Number.isFinite(request.body.startCandidateOffset)
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
        modelIdOverride,
      },
      idempotencyKey,
      fingerprint,
      createRun: () =>
        grpcClient.createRun({
          sessionId: effectiveSessionId,
          workspaceId: wsId,
          userRequest: effectiveUserRequest,
          coordinatorAgentId: effectiveCoordinatorAgentId,
        }),
    });

    // Register run in EventBus for orchestrator lifecycle events
    eventBus.registerRun(createResult.runId, {
      sessionId: effectiveSessionId,
      coordinatorAgentId: effectiveCoordinatorAgentId,
      workspaceId: wsId,
    });

    let enqueueResult;
    try {
      enqueueResult = await orchestrator.enqueue({
        runId: createResult.runId,
        sessionKey: effectiveSessionId,
        workspaceId: wsId,
        coordinatorAgentId: effectiveCoordinatorAgentId,
        userRequest: effectiveUserRequest,
        lane: "interactive",
        modelOverride: modelIdOverride,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      app.log.error({ err, runId: createResult.runId }, "Agent run enqueue failed");
      runStore.emitError(createResult.runId, `Enqueue failed: ${errorMsg}`);
      try {
        await grpcClient.updateRunStatus(createResult.runId, "failed");
      } catch (statusErr) {
        app.log.error(
          { err: statusErr, runId: createResult.runId },
          "Failed to persist enqueue failure status",
        );
      }
      const decision = decideEnqueueFailureResponse({
        runId: createResult.runId,
        reason: "error",
        detail: errorMsg,
      });
      return reply.status(decision.status).send(decision.body);
    }

    if (enqueueResult.status === "rejected") {
      const errorMsg = "Run rejected by orchestrator (lane full or shutting down)";
      app.log.error({ runId: createResult.runId }, errorMsg);
      runStore.emitError(createResult.runId, errorMsg);
      try {
        await grpcClient.updateRunStatus(createResult.runId, "failed");
      } catch (err) {
        app.log.error({ err, runId: createResult.runId }, "Failed to persist rejected run status");
      }
      const decision = decideEnqueueFailureResponse({
        runId: createResult.runId,
        reason: "rejected",
      });
      return reply.status(decision.status).send(decision.body);
    }

    const decision = decideCreateRunSuccessResponse({
      runId: createResult.runId,
      deduplicated: createResult.deduplicated,
    });
    return reply.status(decision.status).send(decision.body);
  } catch (err) {
    if (err instanceof IdempotencyConflictError) {
      return reply.status(409).send({ error: err.message, code: err.code });
    }
    if (typeof effectiveSessionId === "string" && effectiveSessionId.length > 0) {
      app.log.error({ err, workspaceId: wsId, sessionId: effectiveSessionId }, "Runtime run creation failed");
    }
    throw err;
  }
});

// ─── SSE stream ───────────────────────────────────────────────────────────────
// GET /runtime/runs/:runId/stream
// Returns: text/event-stream

app.get<{ Params: { runId: string }; Querystring: { cursor?: string } }>(
  "/runtime/runs/:runId/stream",
  async (request, reply) => {
    const { runId } = request.params;
    const snapshot = runStore.getSnapshot(runId);
    if (!snapshot) {
      return reply.status(404).send({ error: "run not found or expired" });
    }

    const cursorRaw = request.query.cursor;
    const cursor =
      typeof cursorRaw === "number"
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

    let subscription: ReturnType<typeof runStore.subscribe> | null = null;

    const closeStream = () => {
      subscription?.unsubscribe();
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

    try {
      subscription = runStore.subscribe(runId, emit, safeCursor);
    } catch {
      return reply.status(404).send({ error: "run not found or expired" });
    }

    // Clean up channel when client disconnects
    request.raw.on("close", closeStream);
    request.raw.on("finish", closeStream);

    if (subscription.snapshot.terminal) {
      setImmediate(closeStream);
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
  const decision = decideCancelResponse(runStore.getSnapshot(runId));
  if (decision.kind === "error") {
    return reply.status(decision.status).send({ error: decision.error });
  }

  await orchestrator.cancel(runId);
  const cancelled = runStore.cancel(runId, "Run cancelled by user");
  const finalizeDecision = decideCancelFinalizeResponse(cancelled);
  if (finalizeDecision.status !== 200) {
    return reply.status(finalizeDecision.status).send(finalizeDecision.body);
  }
  await grpcClient.updateRunStatus(runId, "cancelled");
  return reply.status(finalizeDecision.status).send(finalizeDecision.body);
});

// ─── Tool approval ──────────────────────────────────────────────────────────
// POST /runtime/approvals/:approvalId/approve
// POST /runtime/approvals/:approvalId/reject

app.post<{ Params: { approvalId: string } }>(
  "/runtime/approvals/:approvalId/approve",
  async (request, reply) => {
    const decision = decideApprovalResponse(approvalGate.approve(request.params.approvalId));
    return reply.status(decision.status).send(decision.body);
  },
);

app.post<{ Params: { approvalId: string } }>(
  "/runtime/approvals/:approvalId/reject",
  async (request, reply) => {
    const decision = decideApprovalResponse(approvalGate.reject(request.params.approvalId));
    return reply.status(decision.status).send(decision.body);
  },
);

async function processChannelRun(body: ChannelRunBody): Promise<void> {
  const { runId, replyText } = await runChannelRequest(
    {
      sessionId: body.sessionId,
      workspaceId: body.workspaceId,
      agentId: body.agentId,
      message: body.message,
    },
    { orchestrator, eventBus },
  );

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

  const url = `${config.gatewayAddr}/channels/${encodeURIComponent(params.channelId)}/send`;
  const maxRetries = config.channelReplyMaxRetries;

  // M5: Retry with exponential backoff (base 500ms, max 3 attempts)
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Runtime-Secret": config.runtimeSecret,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.channelSendTimeoutMs),
      });

      if (response.ok) return;

      let detail = "";
      try {
        detail = (await response.text()).trim();
      } catch {
        // ignore body parse failures
      }

      const decision = decideChannelReplyRetry({
        attempt,
        maxRetries,
        responseStatus: response.status,
      });
      if (decision.kind === "throw") {
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Gateway send failed (${response.status}): ${detail || response.statusText}`);
        }
        throw new Error(`Gateway send failed after ${maxRetries} attempts (${response.status}): ${detail || response.statusText}`);
      }
      await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
      continue;
    } catch (err) {
      const decision = decideChannelReplyRetry({
        attempt,
        maxRetries,
        error: err,
      });
      if (decision.kind === "throw") throw err;
      await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
      continue;
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  // Bootstrap memory system (no-op if DB_PATH is not set)
  try {
    const services = getRuntimeServices();
    if (services.db) {
      app.log.info(
        { dbPath: config.dbPath, embedding: !!services.embedding },
        "Memory system bootstrapped",
      );
    } else {
      app.log.info("Memory system disabled (DB_PATH not set)");
    }
  } catch (err) {
    app.log.error({ err }, "Memory system bootstrap failed — continuing without memory");
  }

  try {
    const summary = await initializeRuntimePlugins({
      grpc: grpcClient,
      logger: app.log,
    });
    app.log.info(summary, "Runtime plugin bootstrap completed");
  } catch (err) {
    app.log.error({ err }, "Runtime plugin bootstrap failed");
  }

  const host = process.env.RUNTIME_HOST ?? "127.0.0.1";
  await app.listen({ port: config.port, host });
  app.log.info(`Runtime listening on ${host}:${config.port}`);

  // M4: Graceful shutdown on SIGTERM/SIGINT — wait for in-flight runs, then flush DB
  const SHUTDOWN_TIMEOUT_MS = 30_000;
  const gracefulShutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    isShuttingDown = true;
    try {
      await Promise.race([
        orchestrator.shutdown(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            app.log.warn(`Orchestrator shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
            resolve();
          }, SHUTDOWN_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      await closeRuntimeServices();
      runStore.close();
      await app.close();
    } catch (err) {
      app.log.error({ err }, "Error during graceful shutdown");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });
  process.on("SIGINT", () => { gracefulShutdown("SIGINT"); });
} catch (err) {
  await orchestrator.shutdown();
  await closeRuntimeServices();
  runStore.close();
  app.log.error(err);
  process.exit(1);
}
