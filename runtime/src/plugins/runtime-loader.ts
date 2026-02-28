import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { type RuntimePluginLoadCandidate, grpcClient } from "../grpc/client.js";

const MANIFEST_FILE = "openclaw.plugin.json";

type RuntimePluginSyncAction = "load" | "reload" | "unload" | "bootstrap";

interface RuntimePluginManifest {
  id: string;
  kind?: string;
  name?: string;
  version?: string;
}

export interface LoadedRuntimePlugin {
  installedPluginId: string;
  workspaceId: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  pluginType: string;
  installPath: string;
  sourceType: string;
  sourceSpec: string;
  manifest: RuntimePluginManifest;
}

export interface RuntimePluginLoadSummary {
  total: number;
  loaded: number;
  failed: number;
}

export interface RuntimePluginSyncRequest extends RuntimePluginLoadCandidate {
  action: string;
  actorUserId?: string;
}

export interface RuntimePluginSyncResult {
  ok: boolean;
  action: RuntimePluginSyncAction;
  pluginId: string;
  installedPluginId: string;
  message: string;
}

const loadedPlugins = new Map<string, LoadedRuntimePlugin>();
const pluginOperationChains = new Map<string, Promise<void>>();

function normalizeSyncAction(raw: string): RuntimePluginSyncAction {
  const action = (raw ?? "").trim().toLowerCase();
  if (action === "reload") return "reload";
  if (action === "unload") return "unload";
  if (action === "bootstrap") return "bootstrap";
  return "load";
}

function readManifestString(input: Record<string, unknown>, key: string): string | undefined {
  const raw = input[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

function parsePluginManifest(raw: string): RuntimePluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MANIFEST_FILE} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${MANIFEST_FILE} must be a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const id = readManifestString(record, "id");
  if (!id) {
    throw new Error(`${MANIFEST_FILE} requires non-empty id`);
  }
  return {
    id,
    kind: readManifestString(record, "kind"),
    name: readManifestString(record, "name"),
    version: readManifestString(record, "version"),
  };
}

async function validateAndLoadPlugin(candidate: RuntimePluginLoadCandidate): Promise<LoadedRuntimePlugin> {
  const installPath = path.resolve((candidate.installPath ?? "").trim());
  if (!installPath) {
    throw new Error("installPath is empty");
  }

  const stat = await fs.stat(installPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`installPath not found or not a directory: ${installPath}`);
  }

  const manifestPath = path.join(installPath, MANIFEST_FILE);
  const manifestRaw = await fs.readFile(manifestPath, "utf-8").catch(() => {
    throw new Error(`missing ${MANIFEST_FILE} at ${installPath}`);
  });
  const manifest = parsePluginManifest(manifestRaw);
  if (manifest.id !== candidate.pluginId) {
    throw new Error(
      `manifest plugin id mismatch: installed=${candidate.pluginId}, manifest=${manifest.id}`,
    );
  }

  const kind = (manifest.kind ?? "tool").trim().toLowerCase();
  if (kind !== "tool") {
    throw new Error(`unsupported plugin kind for runtime loader: ${kind}`);
  }

  return {
    installedPluginId: candidate.installedPluginId,
    workspaceId: candidate.workspaceId,
    pluginId: candidate.pluginId,
    pluginName: candidate.pluginName,
    pluginVersion: candidate.pluginVersion,
    pluginType: candidate.pluginType,
    installPath,
    sourceType: candidate.sourceType,
    sourceSpec: candidate.sourceSpec,
    manifest,
  };
}

async function runSerializedForPlugin<T>(installedPluginId: string, operation: () => Promise<T>): Promise<T> {
  const previous = pluginOperationChains.get(installedPluginId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(() => gate);
  pluginOperationChains.set(installedPluginId, chain);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pluginOperationChains.get(installedPluginId) === chain) {
      pluginOperationChains.delete(installedPluginId);
    }
  }
}

function isSamePluginPath(a: LoadedRuntimePlugin | undefined, b: RuntimePluginLoadCandidate): boolean {
  if (!a) return false;
  const nextPath = path.resolve((b.installPath ?? "").trim());
  return a.installPath === nextPath;
}

async function applyRuntimePluginAction(
  candidate: RuntimePluginLoadCandidate,
  action: RuntimePluginSyncAction,
): Promise<string> {
  if (action === "unload") {
    const hadPlugin = loadedPlugins.delete(candidate.installedPluginId);
    return hadPlugin ? "runtime plugin unloaded" : "runtime plugin was not loaded";
  }

  if (action === "load") {
    const existing = loadedPlugins.get(candidate.installedPluginId);
    if (isSamePluginPath(existing, candidate)) {
      return "runtime plugin already loaded";
    }
  }

  const plugin = await validateAndLoadPlugin(candidate);
  loadedPlugins.set(plugin.installedPluginId, plugin);
  return action === "reload" ? "runtime plugin reloaded" : "runtime plugin loaded";
}

export function listLoadedRuntimePlugins(): LoadedRuntimePlugin[] {
  return Array.from(loadedPlugins.values());
}

async function reportLoadStatusBestEffort(params: {
  grpc: typeof grpcClient;
  logger: FastifyBaseLogger;
  installedPluginId: string;
  workspaceId: string;
  pluginId: string;
  status: "success" | "failure";
  operation: RuntimePluginSyncAction;
  message: string;
  actorUserId?: string;
}): Promise<void> {
  try {
    await params.grpc.reportRuntimePluginLoad({
      installedPluginId: params.installedPluginId,
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      status: params.status,
      operation: params.operation,
      message: params.message,
      actorUserId: params.actorUserId ?? "runtime",
    });
  } catch (err) {
    params.logger.error(
      {
        err,
        pluginId: params.pluginId,
        workspaceId: params.workspaceId,
        status: params.status,
        operation: params.operation,
      },
      "Runtime plugin load status report failed",
    );
  }
}

export async function syncRuntimePlugin(params: {
  grpc: typeof grpcClient;
  logger: FastifyBaseLogger;
  request: RuntimePluginSyncRequest;
}): Promise<RuntimePluginSyncResult> {
  const action = normalizeSyncAction(params.request.action);
  const actorUserId = params.request.actorUserId?.trim() || "runtime";

  return runSerializedForPlugin(params.request.installedPluginId, async () => {
    try {
      const message = await applyRuntimePluginAction(params.request, action);
      await reportLoadStatusBestEffort({
        grpc: params.grpc,
        logger: params.logger,
        installedPluginId: params.request.installedPluginId,
        workspaceId: params.request.workspaceId,
        pluginId: params.request.pluginId,
        status: "success",
        operation: action,
        message,
        actorUserId,
      });
      return {
        ok: true,
        action,
        pluginId: params.request.pluginId,
        installedPluginId: params.request.installedPluginId,
        message,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await reportLoadStatusBestEffort({
        grpc: params.grpc,
        logger: params.logger,
        installedPluginId: params.request.installedPluginId,
        workspaceId: params.request.workspaceId,
        pluginId: params.request.pluginId,
        status: "failure",
        operation: action,
        message,
        actorUserId,
      });
      return {
        ok: false,
        action,
        pluginId: params.request.pluginId,
        installedPluginId: params.request.installedPluginId,
        message,
      };
    }
  });
}

export async function initializeRuntimePlugins(params: {
  grpc: typeof grpcClient;
  logger: FastifyBaseLogger;
}): Promise<RuntimePluginLoadSummary> {
  loadedPlugins.clear();

  const { plugins } = await params.grpc.listRuntimePlugins();
  let loaded = 0;
  let failed = 0;

  for (const candidate of plugins ?? []) {
    const result = await syncRuntimePlugin({
      grpc: params.grpc,
      logger: params.logger,
      request: {
        ...candidate,
        action: "bootstrap",
        actorUserId: "runtime",
      },
    });

    if (result.ok) {
      loaded += 1;
      params.logger.info(
        { pluginId: candidate.pluginId, workspaceId: candidate.workspaceId, installPath: candidate.installPath, action: result.action },
        "Runtime plugin loaded",
      );
    } else {
      failed += 1;
      params.logger.error(
        { pluginId: candidate.pluginId, workspaceId: candidate.workspaceId, installPath: candidate.installPath, action: result.action, message: result.message },
        "Runtime plugin load failed",
      );
    }
  }

  return {
    total: (plugins ?? []).length,
    loaded,
    failed,
  };
}
