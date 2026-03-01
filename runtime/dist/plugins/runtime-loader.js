import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const MANIFEST_FILE = "openclaw.plugin.json";
const loadedPlugins = new Map();
const pluginOperationChains = new Map();
function normalizeSyncAction(raw) {
    const action = (raw ?? "").trim().toLowerCase();
    if (action === "reload")
        return "reload";
    if (action === "unload")
        return "unload";
    if (action === "bootstrap")
        return "bootstrap";
    return "load";
}
function readManifestString(input, key) {
    const raw = input[key];
    if (typeof raw !== "string")
        return undefined;
    const value = raw.trim();
    return value.length > 0 ? value : undefined;
}
function readManifestObject(input, key) {
    const raw = input[key];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    return raw;
}
function requireManifestString(input, fieldName) {
    const value = readManifestString(input, fieldName);
    if (!value) {
        throw new Error(`${MANIFEST_FILE} ${fieldName} is required`);
    }
    return value;
}
function normalizeManifestPath(rawPath, fieldName) {
    const normalized = rawPath.trim().replaceAll("\\", "/");
    if (!normalized) {
        throw new Error(`${MANIFEST_FILE} ${fieldName} is required`);
    }
    if (normalized.startsWith("/") || normalized.startsWith("./") || normalized.startsWith("../")) {
        throw new Error(`${MANIFEST_FILE} ${fieldName} must be a safe relative path`);
    }
    const segments = normalized.split("/").filter((part) => part.length > 0);
    if (segments.length === 0 || segments.some((part) => part === "." || part === "..")) {
        throw new Error(`${MANIFEST_FILE} ${fieldName} contains invalid path segments`);
    }
    if (!/\.(m?js|cjs)$/i.test(normalized)) {
        throw new Error(`${MANIFEST_FILE} ${fieldName} must target a .js/.mjs/.cjs file`);
    }
    return segments.join("/");
}
function normalizeManifestExportName(rawName, fieldName) {
    const value = rawName.trim();
    if (!value) {
        throw new Error(`${MANIFEST_FILE} ${fieldName} is required`);
    }
    if (value === "default")
        return value;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
        throw new Error(`${MANIFEST_FILE} ${fieldName} must be a valid JS export identifier`);
    }
    return value;
}
function isPathInside(rootDir, candidatePath) {
    const root = path.resolve(rootDir);
    const candidate = path.resolve(candidatePath);
    if (root === candidate)
        return true;
    const rel = path.relative(root, candidate);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function parseConfigJson(raw) {
    if (!raw || raw.trim().length === 0)
        return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
    }
    return parsed;
}
function asRecord(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return null;
    return input;
}
function asString(input) {
    if (typeof input !== "string")
        return undefined;
    const value = input.trim();
    return value.length > 0 ? value : undefined;
}
function normalizeToolName(rawName, pluginId) {
    const fallback = `plugin_${pluginId}`;
    const base = (rawName && rawName.trim().length > 0 ? rawName.trim() : fallback).replace(/[^A-Za-z0-9_-]/g, "_");
    if (!base)
        return fallback;
    if (!/^[A-Za-z_]/.test(base))
        return `plugin_${base}`;
    return base;
}
function normalizeToolParameters(raw) {
    const record = asRecord(raw);
    if (!record) {
        return {
            type: "object",
            properties: {},
            additionalProperties: true,
        };
    }
    const hasJsonSchemaShape = "type" in record || "properties" in record || "required" in record || "$schema" in record || "oneOf" in record;
    if (!hasJsonSchemaShape) {
        return {
            type: "object",
            properties: {},
            additionalProperties: true,
        };
    }
    return record;
}
function normalizeExecuteMode(raw) {
    const value = String(raw ?? "").trim().toLowerCase();
    if (value === "ai-sdk" || value === "aisdk")
        return "ai-sdk";
    if (value === "args-only" || value === "argsonly")
        return "args-only";
    return "openclaw";
}
function resolveRuntimeModuleExport(moduleRecord, exportName) {
    if (exportName === "default") {
        return moduleRecord.default;
    }
    if (exportName in moduleRecord) {
        return moduleRecord[exportName];
    }
    const defaultExport = moduleRecord.default;
    const defaultRecord = asRecord(defaultExport);
    if (defaultRecord && exportName in defaultRecord) {
        return defaultRecord[exportName];
    }
    return undefined;
}
async function resolvePluginToolDefinition(params) {
    const moduleUrl = `${pathToFileURL(params.runtimeToolEntryPath).href}?v=${Date.now()}`;
    const imported = (await import(moduleUrl));
    const exported = resolveRuntimeModuleExport(imported, params.runtimeToolExportName);
    if (exported === undefined) {
        throw new Error(`runtime tool export "${params.runtimeToolExportName}" not found in ${params.runtimeToolEntryPath}`);
    }
    let toolCandidate = exported;
    if (typeof exported === "function") {
        toolCandidate = await exported({
            pluginId: params.pluginId,
            workspaceId: params.workspaceId,
            installedPluginId: params.installedPluginId,
            installPath: params.installPath,
            config: params.pluginConfig,
            pluginName: params.pluginName,
            pluginVersion: params.pluginVersion,
        });
    }
    const toolRecord = asRecord(toolCandidate);
    if (!toolRecord) {
        throw new Error(`runtime tool export "${params.runtimeToolExportName}" must return a tool object`);
    }
    const execute = toolRecord.execute;
    if (typeof execute !== "function") {
        throw new Error(`runtime tool "${params.pluginId}" must provide execute function`);
    }
    return {
        name: normalizeToolName(asString(toolRecord.name) ?? asString(toolRecord.label), params.pluginId),
        description: asString(toolRecord.description) ?? `Plugin tool from ${params.pluginId}`,
        parametersJsonSchema: normalizeToolParameters(toolRecord.parameters),
        executeMode: normalizeExecuteMode(toolRecord.executeMode),
        execute: (...args) => execute(...args),
    };
}
function parsePluginManifest(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error(`${MANIFEST_FILE} must be valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${MANIFEST_FILE} must be a JSON object`);
    }
    const record = parsed;
    const id = readManifestString(record, "id");
    if (!id) {
        throw new Error(`${MANIFEST_FILE} requires non-empty id`);
    }
    const kind = readManifestString(record, "kind");
    const normalizedKind = (kind ?? "tool").trim().toLowerCase();
    const runtimeObject = readManifestObject(record, "runtime");
    const runtimeToolObject = runtimeObject ? readManifestObject(runtimeObject, "tool") : undefined;
    let runtimeTool;
    if (runtimeToolObject) {
        runtimeTool = {
            entry: normalizeManifestPath(requireManifestString(runtimeToolObject, "entry"), "runtime.tool.entry"),
            exportName: normalizeManifestExportName(requireManifestString(runtimeToolObject, "exportName"), "runtime.tool.exportName"),
        };
    }
    if (normalizedKind === "tool" && !runtimeTool) {
        throw new Error(`${MANIFEST_FILE} runtime.tool.entry/exportName is required for kind=tool`);
    }
    return {
        id,
        kind,
        name: readManifestString(record, "name"),
        version: readManifestString(record, "version"),
        runtime: runtimeTool ? { tool: runtimeTool } : undefined,
    };
}
async function validateAndLoadPlugin(candidate) {
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
        throw new Error(`manifest plugin id mismatch: installed=${candidate.pluginId}, manifest=${manifest.id}`);
    }
    const kind = (manifest.kind ?? "tool").trim().toLowerCase();
    if (kind !== "tool") {
        throw new Error(`unsupported plugin kind for runtime loader: ${kind}`);
    }
    const runtimeTool = manifest.runtime?.tool;
    if (!runtimeTool) {
        throw new Error(`missing runtime tool entry in ${MANIFEST_FILE}`);
    }
    const runtimeToolEntryPath = path.resolve(installPath, runtimeTool.entry);
    if (!isPathInside(installPath, runtimeToolEntryPath)) {
        throw new Error(`runtime tool entry escapes install path: ${runtimeTool.entry}`);
    }
    const entryStat = await fs.stat(runtimeToolEntryPath).catch(() => null);
    if (!entryStat || !entryStat.isFile()) {
        throw new Error(`runtime tool entry file not found: ${runtimeTool.entry}`);
    }
    const pluginConfig = parseConfigJson(candidate.configJson);
    const tool = await resolvePluginToolDefinition({
        pluginId: candidate.pluginId,
        installPath,
        runtimeToolEntryPath,
        runtimeToolExportName: runtimeTool.exportName,
        pluginConfig,
        workspaceId: candidate.workspaceId,
        installedPluginId: candidate.installedPluginId,
        pluginName: candidate.pluginName,
        pluginVersion: candidate.pluginVersion,
    });
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
        runtimeToolEntry: runtimeTool.entry,
        runtimeToolExportName: runtimeTool.exportName,
        runtimeToolEntryPath,
        pluginConfig,
        tool,
    };
}
async function runSerializedForPlugin(installedPluginId, operation) {
    const previous = pluginOperationChains.get(installedPluginId) ?? Promise.resolve();
    let release = () => undefined;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    const chain = previous.then(() => gate);
    pluginOperationChains.set(installedPluginId, chain);
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (pluginOperationChains.get(installedPluginId) === chain) {
            pluginOperationChains.delete(installedPluginId);
        }
    }
}
function isSamePluginPath(a, b) {
    if (!a)
        return false;
    const nextPath = path.resolve((b.installPath ?? "").trim());
    return a.installPath === nextPath;
}
async function applyRuntimePluginAction(candidate, action) {
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
export function listLoadedRuntimePlugins() {
    return Array.from(loadedPlugins.values());
}
export function listWorkspaceRuntimePlugins(workspaceId) {
    return listLoadedRuntimePlugins().filter((item) => item.workspaceId === workspaceId);
}
async function reportLoadStatusBestEffort(params) {
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
    }
    catch (err) {
        params.logger.error({
            err,
            pluginId: params.pluginId,
            workspaceId: params.workspaceId,
            status: params.status,
            operation: params.operation,
        }, "Runtime plugin load status report failed");
    }
}
export async function syncRuntimePlugin(params) {
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
        }
        catch (err) {
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
export async function initializeRuntimePlugins(params) {
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
            params.logger.info({ pluginId: candidate.pluginId, workspaceId: candidate.workspaceId, installPath: candidate.installPath, action: result.action }, "Runtime plugin loaded");
        }
        else {
            failed += 1;
            params.logger.error({ pluginId: candidate.pluginId, workspaceId: candidate.workspaceId, installPath: candidate.installPath, action: result.action, message: result.message }, "Runtime plugin load failed");
        }
    }
    return {
        total: (plugins ?? []).length,
        loaded,
        failed,
    };
}
