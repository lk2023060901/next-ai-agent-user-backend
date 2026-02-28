import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { type RuntimePluginLoadCandidate, grpcClient } from "../grpc/client.js";

const MANIFEST_FILE = "openclaw.plugin.json";

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

const loadedPlugins = new Map<string, LoadedRuntimePlugin>();

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
  message: string;
}): Promise<void> {
  try {
    await params.grpc.reportRuntimePluginLoad({
      installedPluginId: params.installedPluginId,
      workspaceId: params.workspaceId,
      pluginId: params.pluginId,
      status: params.status,
      message: params.message,
    });
  } catch (err) {
    params.logger.error(
      { err, pluginId: params.pluginId, workspaceId: params.workspaceId, status: params.status },
      "Runtime plugin load status report failed",
    );
  }
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
    try {
      const plugin = await validateAndLoadPlugin(candidate);
      loadedPlugins.set(plugin.installedPluginId, plugin);
      loaded += 1;
      await reportLoadStatusBestEffort({
        grpc: params.grpc,
        logger: params.logger,
        installedPluginId: candidate.installedPluginId,
        workspaceId: candidate.workspaceId,
        pluginId: candidate.pluginId,
        status: "success",
        message: `runtime plugin loaded from ${plugin.installPath}`,
      });
      params.logger.info(
        { pluginId: candidate.pluginId, workspaceId: candidate.workspaceId, installPath: plugin.installPath },
        "Runtime plugin loaded",
      );
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      await reportLoadStatusBestEffort({
        grpc: params.grpc,
        logger: params.logger,
        installedPluginId: candidate.installedPluginId,
        workspaceId: candidate.workspaceId,
        pluginId: candidate.pluginId,
        status: "failure",
        message,
      });
      params.logger.error(
        { err, pluginId: candidate.pluginId, workspaceId: candidate.workspaceId, installPath: candidate.installPath },
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
