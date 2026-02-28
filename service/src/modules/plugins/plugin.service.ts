import { and, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { db } from "../../db";
import {
  installedPlugins,
  pluginInstallAudits,
  pluginInstallRecords,
  plugins,
  workspaces,
} from "../../db/schema";

const MANIFEST_FILE = "openclaw.plugin.json";
const ALLOWED_PLUGIN_TYPES = new Set([
  "tool",
  "channel",
  "memory",
  "hook",
  "skill",
  "agent-template",
  "observability",
]);
const ALLOWED_PRICING_MODELS = new Set(["free", "one_time", "subscription", "usage_based"]);
const ALLOWED_CONFIG_FIELD_TYPES = new Set(["text", "password", "number", "boolean", "select"]);
const ALLOWED_INSTALL_SOURCE_TYPES = new Set(["npm", "path", "archive"]);

export type PluginConfigFieldOption = {
  value: string;
  label: string;
};

export type PluginConfigField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean" | "select";
  required: boolean;
  placeholder?: string;
  description?: string;
  options: PluginConfigFieldOption[];
  defaultValueJson?: string;
};

export type PluginMarketplaceItem = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  longDescription: string;
  author: string;
  authorAvatar: string;
  icon: string;
  type: string;
  version: string;
  pricingModel: string;
  price: number;
  monthlyPrice: number;
  trialDays: number;
  rating: number;
  reviewCount: number;
  installCount: number;
  tags: string[];
  permissions: string[];
  configSchema: PluginConfigField[];
  screenshots: string[];
  publishedAt: string;
  updatedAt: string;
  sourceType?: string;
  sourceSpec?: string;
};

export type InstalledPluginItem = {
  id: string;
  workspaceId: string;
  pluginId: string;
  plugin: PluginMarketplaceItem;
  status: "enabled" | "disabled" | "error" | "updating";
  config: Record<string, string | number | boolean>;
  installedAt: string;
  installedBy: string;
};

export type PluginReviewItem = {
  id: string;
  pluginId: string;
  authorName: string;
  rating: number;
  content: string;
  createdAt: string;
};

export type ListMarketplacePluginsParams = {
  type?: string;
  pricingModel?: string;
  search?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
};

export type InstallWorkspacePluginParams = {
  workspaceId: string;
  pluginId?: string;
  configJson?: string;
  sourceType?: string;
  sourceSpec?: string;
  sourceIntegrity?: string;
  sourcePin?: boolean;
  installedBy?: string;
};

type OpenClawManifest = {
  id: string;
  configSchema: Record<string, unknown>;
  kind?: string;
  name?: string;
  description?: string;
  version?: string;
  uiHints?: Record<string, unknown>;
};

type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  author?: string | { name?: string };
  dependencies?: Record<string, string>;
};

type PluginMetadataFile = {
  displayName?: string;
  longDescription?: string;
  configSchema?: PluginConfigField[];
  tags?: string[];
  permissions?: string[];
  screenshots?: string[];
  publishedAt?: string;
  updatedAt?: string;
  sourceType?: string;
  sourceSpec?: string;
  installPath?: string;
};

type InstalledSourcePackage = {
  pluginId: string;
  manifest: OpenClawManifest;
  packageManifest: PackageManifest;
  installPath: string;
  installPathCreated: boolean;
  sourceType: "npm" | "path" | "archive";
  sourceSpec: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  expectedIntegrity?: string;
  resolvedIntegrity?: string;
  shasum?: string;
  artifactSha256: string;
  artifactSha512: string;
};

type ArtifactHashes = {
  sha256: string;
  sha512: string;
};

type IntegrityValidation = {
  expectedIntegrity?: string;
  resolvedIntegrity?: string;
};

type NpmPackMetadata = {
  filename: string;
  id?: string;
  name?: string;
  version?: string;
  integrity?: string;
  shasum?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function resolveDataDir(): string {
  if (process.env.DB_PATH && process.env.DB_PATH.trim().length > 0) {
    return path.dirname(path.resolve(process.env.DB_PATH));
  }
  return path.resolve(__dirname, "../../../../data");
}

function resolvePluginExtensionsDir(): string {
  const configured = process.env.PLUGINS_EXTENSIONS_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(resolveDataDir(), "plugins", "extensions");
}

function resolvePluginMetadataDir(): string {
  const configured = process.env.PLUGINS_METADATA_DIR?.trim();
  if (configured) return path.resolve(configured);
  return path.join(resolveDataDir(), "plugins", "metadata");
}

function normalizeInstalledStatus(raw: string | null | undefined): "enabled" | "disabled" | "error" | "updating" {
  const status = (raw ?? "").trim().toLowerCase();
  if (status === "enabled" || status === "disabled" || status === "error" || status === "updating") {
    return status;
  }
  if (status === "active") return "enabled";
  if (status === "inactive") return "disabled";
  return "enabled";
}

function normalizePluginType(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().toLowerCase();
  return ALLOWED_PLUGIN_TYPES.has(value) ? value : "tool";
}

function normalizePricingModel(raw: string | null | undefined): string {
  const value = (raw ?? "").trim().toLowerCase();
  return ALLOWED_PRICING_MODELS.has(value) ? value : "free";
}

function normalizeInstallSourceType(raw: string | null | undefined): "npm" | "path" | "archive" | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!ALLOWED_INSTALL_SOURCE_TYPES.has(value)) return null;
  if (value === "npm" || value === "path" || value === "archive") return value;
  return null;
}

function splitEnvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function getAllowedSourceTypeSet(): Set<string> {
  const configured = splitEnvList(process.env.PLUGIN_INSTALL_ALLOWED_SOURCE_TYPES);
  if (configured.length === 0) {
    return new Set(["npm", "path", "archive"]);
  }
  return new Set(configured.map((item) => item.toLowerCase()));
}

function getAllowedPathRoots(): string[] {
  const configured = splitEnvList(process.env.PLUGIN_INSTALL_ALLOWED_PATH_ROOTS);
  if (configured.length > 0) {
    return configured.map((item) => path.resolve(item));
  }
  return [resolveDataDir(), path.resolve(process.cwd()), path.resolve(os.tmpdir())];
}

function isPathInside(rootDir: string, candidatePath: string): boolean {
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidatePath);
  if (root === candidate) return true;
  const rel = path.relative(root, candidate);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function enforceSourceTypeWhitelist(sourceType: "npm" | "path" | "archive"): void {
  const allowSet = getAllowedSourceTypeSet();
  if (!allowSet.has(sourceType)) {
    throw Object.assign(new Error(`source type "${sourceType}" is not allowed by policy`), {
      code: "PERMISSION_DENIED",
    });
  }
}

function matchNpmWhitelistPattern(pattern: string, spec: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return spec.startsWith(prefix);
  }
  return spec === pattern;
}

function enforceNpmSpecWhitelist(spec: string): void {
  const allowPatterns = splitEnvList(process.env.PLUGIN_INSTALL_ALLOWED_NPM_SPECS);
  if (allowPatterns.length === 0) return;
  const matched = allowPatterns.some((pattern) => matchNpmWhitelistPattern(pattern, spec));
  if (!matched) {
    throw Object.assign(new Error(`npm spec "${spec}" is not allowed by policy`), {
      code: "PERMISSION_DENIED",
    });
  }
}

function enforceLocalPathWhitelist(resolvedPath: string): void {
  const allowedRoots = getAllowedPathRoots();
  const allowed = allowedRoots.some((root) => isPathInside(root, resolvedPath));
  if (!allowed) {
    throw Object.assign(new Error(`path "${resolvedPath}" is outside allowed roots`), {
      code: "PERMISSION_DENIED",
    });
  }
}

function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^0x/, "");
}

function decodeBase64ToHex(value: string): string | null {
  try {
    const normalized = value.trim();
    if (!normalized) return null;
    return Buffer.from(normalized, "base64").toString("hex");
  } catch {
    return null;
  }
}

function parseExpectedIntegrity(raw: string | undefined): { algo: "sha256" | "sha512"; value: string } | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  const lower = value.toLowerCase();
  if (lower.startsWith("sha256:") || lower.startsWith("sha256-")) {
    const payload = value.slice(7).trim();
    const decoded = decodeBase64ToHex(payload);
    if (decoded) return { algo: "sha256", value: decoded };
    return { algo: "sha256", value: normalizeHex(payload) };
  }
  if (lower.startsWith("sha512:") || lower.startsWith("sha512-")) {
    const payload = value.slice(7).trim();
    const decoded = decodeBase64ToHex(payload);
    if (decoded) return { algo: "sha512", value: decoded };
    return { algo: "sha512", value: normalizeHex(payload) };
  }
  if (/^[a-f0-9]{64}$/i.test(value)) {
    return { algo: "sha256", value: normalizeHex(value) };
  }
  if (/^[a-f0-9]{128}$/i.test(value)) {
    return { algo: "sha512", value: normalizeHex(value) };
  }
  return null;
}

function parseResolvedIntegrity(raw: string | undefined): { algo: "sha256" | "sha512"; value: string } | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith("sha256-")) {
    const decoded = decodeBase64ToHex(value.slice(7));
    if (decoded) return { algo: "sha256", value: decoded };
    return null;
  }
  if (lower.startsWith("sha512-")) {
    const decoded = decodeBase64ToHex(value.slice(7));
    if (decoded) return { algo: "sha512", value: decoded };
    return null;
  }
  return parseExpectedIntegrity(value);
}

function assertIntegrityMatch(params: {
  expectedIntegrity?: string;
  resolvedIntegrity?: string;
  artifact: ArtifactHashes;
}): IntegrityValidation {
  const parsedExpected = parseExpectedIntegrity(params.expectedIntegrity);
  const parsedResolved = parseResolvedIntegrity(params.resolvedIntegrity);
  const expected = parsedExpected ?? parsedResolved;
  if (!expected) {
    return {
      expectedIntegrity: params.expectedIntegrity,
      resolvedIntegrity: params.resolvedIntegrity,
    };
  }

  const actual = expected.algo === "sha256" ? params.artifact.sha256 : params.artifact.sha512;
  if (normalizeHex(actual) !== normalizeHex(expected.value)) {
    throw Object.assign(new Error(`integrity mismatch for ${expected.algo}`), {
      code: "INVALID_ARGUMENT",
    });
  }

  return {
    expectedIntegrity: parsedExpected ? `${expected.algo}:${parsedExpected.value}` : params.expectedIntegrity,
    resolvedIntegrity: parsedResolved ? `${parsedResolved.algo}:${parsedResolved.value}` : params.resolvedIntegrity,
  };
}

function parseJSONRecord(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function normalizeConfigJSON(raw: string | null | undefined): string {
  const parsed = parseJSONRecord(raw ?? "{}");
  return JSON.stringify(parsed);
}

function toConfigObject(raw: string | null | undefined): Record<string, string | number | boolean> {
  const parsed = parseJSONRecord(raw);
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

function validatePluginId(pluginId: string): string {
  const normalized = pluginId.trim();
  if (!normalized) {
    throw Object.assign(new Error("pluginId is required"), { code: "INVALID_ARGUMENT" });
  }
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw Object.assign(new Error("pluginId cannot contain path separators"), {
      code: "INVALID_ARGUMENT",
    });
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw Object.assign(new Error("pluginId contains unsupported characters"), {
      code: "INVALID_ARGUMENT",
    });
  }
  return normalized;
}

function validateRegistryNpmSpec(spec: string): void {
  const value = spec.trim();
  if (!value) {
    throw Object.assign(new Error("npm spec is required"), { code: "INVALID_ARGUMENT" });
  }
  if (
    value.startsWith("file:") ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("git+") ||
    value.startsWith("github:") ||
    value.startsWith("gitlab:") ||
    value.startsWith("bitbucket:") ||
    value.startsWith(".") ||
    value.startsWith("/") ||
    value.startsWith("~")
  ) {
    throw Object.assign(new Error("npm spec must be a registry package spec (name[@version])"), {
      code: "INVALID_ARGUMENT",
    });
  }
  const npmSpecPattern = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(@[^@\s]+)?$/i;
  if (!npmSpecPattern.test(value)) {
    throw Object.assign(new Error("invalid npm package spec"), { code: "INVALID_ARGUMENT" });
  }
}

function isArchivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".zip") ||
    lower.endsWith(".tgz") ||
    lower.endsWith(".tar") ||
    lower.endsWith(".tar.gz")
  );
}

async function runCommand(params: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${params.command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${params.command} ${params.args.join(" ")} failed: ${stderr || stdout}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function hashFile(filePath: string): Promise<ArtifactHashes> {
  const hasher256 = createHash("sha256");
  const hasher512 = createHash("sha512");
  const stream = fsSync.createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => {
      hasher256.update(chunk);
      hasher512.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return {
    sha256: hasher256.digest("hex"),
    sha512: hasher512.digest("hex"),
  };
}

async function walkFiles(dirPath: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [dirPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile()) {
        out.push(fullPath);
      }
    }
  }
  out.sort();
  return out;
}

async function hashDirectory(dirPath: string): Promise<ArtifactHashes> {
  const hasher256 = createHash("sha256");
  const hasher512 = createHash("sha512");
  const files = await walkFiles(dirPath);
  for (const filePath of files) {
    const relPath = path.relative(dirPath, filePath).replaceAll(path.sep, "/");
    hasher256.update(relPath);
    hasher512.update(relPath);
    const stream = fsSync.createReadStream(filePath);
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk) => {
        hasher256.update(chunk);
        hasher512.update(chunk);
      });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
  }
  return {
    sha256: hasher256.digest("hex"),
    sha512: hasher512.digest("hex"),
  };
}

async function ensureDir(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
}

async function readOptionalPackageManifest(rootDir: string): Promise<PackageManifest> {
  const filePath = path.join(rootDir, "package.json");
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as PackageManifest;
  } catch {
    return {};
  }
}

function readStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function extractString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseOpenClawManifest(rootDir: string): OpenClawManifest {
  const manifestPath = path.join(rootDir, MANIFEST_FILE);
  if (!fsSync.existsSync(manifestPath)) {
    throw Object.assign(new Error(`missing ${MANIFEST_FILE}`), { code: "INVALID_ARGUMENT" });
  }
  const raw = fsSync.readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error(`${MANIFEST_FILE} must be a JSON object`), {
      code: "INVALID_ARGUMENT",
    });
  }

  const id = extractString(parsed.id);
  if (!id) {
    throw Object.assign(new Error(`${MANIFEST_FILE} requires id`), { code: "INVALID_ARGUMENT" });
  }

  const configSchemaRaw = parsed.configSchema;
  if (!configSchemaRaw || typeof configSchemaRaw !== "object" || Array.isArray(configSchemaRaw)) {
    throw Object.assign(new Error(`${MANIFEST_FILE} requires configSchema object`), {
      code: "INVALID_ARGUMENT",
    });
  }

  const manifest: OpenClawManifest = {
    id,
    configSchema: configSchemaRaw as Record<string, unknown>,
    kind: extractString(parsed.kind),
    name: extractString(parsed.name),
    description: extractString(parsed.description),
    version: extractString(parsed.version),
    uiHints:
      parsed.uiHints && typeof parsed.uiHints === "object" && !Array.isArray(parsed.uiHints)
        ? (parsed.uiHints as Record<string, unknown>)
        : undefined,
  };

  return manifest;
}

async function locatePluginRoot(rootDir: string): Promise<string> {
  const directManifest = path.join(rootDir, MANIFEST_FILE);
  if (fsSync.existsSync(directManifest)) return rootDir;

  const npmPackRoot = path.join(rootDir, "package");
  if (fsSync.existsSync(path.join(npmPackRoot, MANIFEST_FILE))) {
    return npmPackRoot;
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootDir, entry.name))
    .filter((dir) => fsSync.existsSync(path.join(dir, MANIFEST_FILE)));

  if (candidates.length == 1) {
    return candidates[0]!;
  }

  throw Object.assign(new Error(`cannot locate ${MANIFEST_FILE} in extracted package`), {
    code: "INVALID_ARGUMENT",
  });
}

async function extractArchiveTo(archivePath: string, destDir: string): Promise<void> {
  if (archivePath.toLowerCase().endsWith(".zip")) {
    await runCommand({
      command: "unzip",
      args: ["-qq", archivePath, "-d", destDir],
      timeoutMs: 120_000,
    });
    return;
  }

  await runCommand({
    command: "tar",
    args: ["-xf", archivePath, "-C", destDir],
    timeoutMs: 120_000,
  });
}

function resolveAuthor(pkg: PackageManifest): string {
  if (typeof pkg.author === "string" && pkg.author.trim().length > 0) {
    return pkg.author.trim();
  }
  if (pkg.author && typeof pkg.author === "object") {
    const name = extractString(pkg.author.name);
    if (name) return name;
  }
  return "Unknown";
}

function resolvePluginTypeFromManifest(manifest: OpenClawManifest): string {
  const kind = (manifest.kind ?? "").trim().toLowerCase();
  if (kind === "memory") return "memory";
  if (kind === "channel") return "channel";
  if (kind === "skill") return "skill";
  if (kind === "hook") return "hook";
  if (kind === "observability") return "observability";
  if (kind === "agent-template") return "agent-template";
  return "tool";
}

function readObjectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const raw = record[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function mapSchemaType(property: Record<string, unknown>): "text" | "password" | "number" | "boolean" | "select" {
  const enumValues = property.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return "select";
  }
  const type = String(property.type ?? "").toLowerCase();
  if (type === "boolean") return "boolean";
  if (type === "number" || type === "integer") return "number";
  return "text";
}

function toDefaultValueJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return undefined;
  }
  return JSON.stringify(value);
}

function toSelectOptions(property: Record<string, unknown>): PluginConfigFieldOption[] {
  const enumValues = property.enum;
  if (!Array.isArray(enumValues)) return [];

  return enumValues
    .map((value) => {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return null;
      }
      const normalized = String(value);
      return { value: normalized, label: normalized };
    })
    .filter((item): item is PluginConfigFieldOption => Boolean(item));
}

function parseConfigFields(manifest: OpenClawManifest): PluginConfigField[] {
  const schema = manifest.configSchema;
  const properties = readObjectField(schema, "properties");
  if (!properties) return [];

  const requiredRaw = schema.required;
  const required = new Set(
    Array.isArray(requiredRaw)
      ? requiredRaw.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
      : [],
  );

  const uiHints = manifest.uiHints && typeof manifest.uiHints === "object" ? manifest.uiHints : {};

  const fields: PluginConfigField[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const property = value as Record<string, unknown>;

    const hint = readObjectField(uiHints as Record<string, unknown>, key) ?? {};
    const fieldType = mapSchemaType(property);

    const sensitiveRaw = hint.sensitive;
    const sensitive =
      fieldType === "text" &&
      ((typeof sensitiveRaw === "boolean" && sensitiveRaw) ||
        String(property.format ?? "").toLowerCase() === "password");

    const finalType: PluginConfigField["type"] = sensitive ? "password" : fieldType;
    if (!ALLOWED_CONFIG_FIELD_TYPES.has(finalType)) continue;

    const label =
      extractString((hint as Record<string, unknown>).label) ??
      extractString(property.title) ??
      key;

    fields.push({
      key,
      label,
      type: finalType,
      required: required.has(key),
      placeholder: extractString((hint as Record<string, unknown>).placeholder),
      description: extractString((hint as Record<string, unknown>).description) ?? extractString(property.description),
      options: finalType === "select" ? toSelectOptions(property) : [],
      defaultValueJson: toDefaultValueJson(property.default),
    });
  }

  return fields;
}

function normalizeMetadata(raw: PluginMetadataFile | null | undefined): PluginMetadataFile {
  if (!raw) return {};
  const configSchema = Array.isArray(raw.configSchema)
    ? raw.configSchema.filter(
        (item) =>
          Boolean(item) &&
          typeof item.key === "string" &&
          typeof item.label === "string" &&
          typeof item.type === "string",
      )
    : [];

  return {
    displayName: extractString(raw.displayName),
    longDescription: extractString(raw.longDescription),
    configSchema,
    tags: readStringArray(raw.tags),
    permissions: readStringArray(raw.permissions),
    screenshots: readStringArray(raw.screenshots),
    publishedAt: extractString(raw.publishedAt),
    updatedAt: extractString(raw.updatedAt),
    sourceType: extractString(raw.sourceType),
    sourceSpec: extractString(raw.sourceSpec),
    installPath: extractString(raw.installPath),
  };
}

async function loadPluginMetadata(pluginId: string): Promise<PluginMetadataFile> {
  const filePath = path.join(resolvePluginMetadataDir(), `${pluginId}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return normalizeMetadata(parsed as PluginMetadataFile);
  } catch {
    return {};
  }
}

async function writePluginMetadata(pluginId: string, metadata: PluginMetadataFile): Promise<void> {
  await ensureDir(resolvePluginMetadataDir());
  const filePath = path.join(resolvePluginMetadataDir(), `${pluginId}.json`);
  await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), "utf-8");
}

function buildPluginItemFromRow(params: {
  row: typeof plugins.$inferSelect;
  metadata: PluginMetadataFile;
}): PluginMarketplaceItem {
  const { row, metadata } = params;
  const publishedAt = metadata.publishedAt ?? nowIso();
  const updatedAt = metadata.updatedAt ?? publishedAt;

  return {
    id: row.id,
    name: row.name,
    displayName: metadata.displayName ?? row.name,
    description: row.description ?? "",
    longDescription: metadata.longDescription ?? row.description ?? "",
    author: row.author ?? "Unknown",
    authorAvatar: "",
    icon: row.iconUrl ?? "🧩",
    type: normalizePluginType(row.type),
    version: row.version ?? "0.0.0",
    pricingModel: normalizePricingModel(row.pricingModel),
    price: row.price != null ? Number(row.price) : 0,
    monthlyPrice: 0,
    trialDays: 0,
    rating: row.rating != null ? Number(row.rating) : 0,
    reviewCount: 0,
    installCount: row.installCount != null ? Number(row.installCount) : 0,
    tags: metadata.tags ?? [],
    permissions: metadata.permissions ?? [],
    configSchema: metadata.configSchema ?? [],
    screenshots: metadata.screenshots ?? [],
    publishedAt,
    updatedAt,
    sourceType: metadata.sourceType,
    sourceSpec: metadata.sourceSpec,
  };
}

async function ensureWorkspaceExists(workspaceId: string): Promise<void> {
  const ws = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).get();
  if (!ws) {
    throw Object.assign(new Error("Workspace not found"), { code: "NOT_FOUND" });
  }
}

async function installDependenciesIfNeeded(targetDir: string): Promise<void> {
  const packageManifest = await readOptionalPackageManifest(targetDir);
  const dependencies = packageManifest.dependencies ?? {};
  if (Object.keys(dependencies).length === 0) return;

  const nodeModulesDir = path.join(targetDir, "node_modules");
  if (fsSync.existsSync(nodeModulesDir)) return;

  await runCommand({
    command: "npm",
    args: ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: targetDir,
    timeoutMs: 180_000,
  });
}

async function prepareInstalledPackage(params: {
  pluginRootDir: string;
  packageRootDir: string;
  sourceType: "npm" | "path" | "archive";
  sourceSpec: string;
  artifact: ArtifactHashes;
  resolvedSpec?: string;
  resolvedVersion?: string;
  expectedIntegrity?: string;
  resolvedIntegrity?: string;
  shasum?: string;
}): Promise<InstalledSourcePackage> {
  const manifest = parseOpenClawManifest(params.packageRootDir);
  const pluginId = validatePluginId(manifest.id);

  const installPath = path.join(params.pluginRootDir, pluginId);
  await ensureDir(params.pluginRootDir);
  let installPathCreated = false;
  if (fsSync.existsSync(installPath)) {
    await installDependenciesIfNeeded(installPath);
  } else {
    const tempInstallPath = `${installPath}.tmp-${uuidv4()}`;
    try {
      await fs.cp(params.packageRootDir, tempInstallPath, { recursive: true });
      await installDependenciesIfNeeded(tempInstallPath);
      await fs.rename(tempInstallPath, installPath);
      installPathCreated = true;
    } catch (err) {
      await fs.rm(tempInstallPath, { recursive: true, force: true });
      throw err;
    }
  }

  const packageManifest = await readOptionalPackageManifest(installPath);

  return {
    pluginId,
    manifest,
    packageManifest,
    installPath,
    installPathCreated,
    sourceType: params.sourceType,
    sourceSpec: params.sourceSpec,
    resolvedSpec: params.resolvedSpec,
    resolvedVersion: params.resolvedVersion,
    expectedIntegrity: params.expectedIntegrity,
    resolvedIntegrity: params.resolvedIntegrity,
    shasum: params.shasum,
    artifactSha256: params.artifact.sha256,
    artifactSha512: params.artifact.sha512,
  };
}

async function installFromArchivePath(params: {
  archivePath: string;
  sourceType: "npm" | "path" | "archive";
  sourceSpec: string;
  pluginRootDir: string;
  expectedIntegrity?: string;
  resolvedIntegrity?: string;
  resolvedSpec?: string;
  resolvedVersion?: string;
  shasum?: string;
}): Promise<InstalledSourcePackage> {
  const artifact = await hashFile(params.archivePath);
  const integrity = assertIntegrityMatch({
    expectedIntegrity: params.expectedIntegrity,
    resolvedIntegrity: params.resolvedIntegrity,
    artifact,
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nextai-plugin-archive-"));
  try {
    const extractDir = path.join(tempDir, "extract");
    await ensureDir(extractDir);
    await extractArchiveTo(params.archivePath, extractDir);
    const packageRoot = await locatePluginRoot(extractDir);
    return await prepareInstalledPackage({
      pluginRootDir: params.pluginRootDir,
      packageRootDir: packageRoot,
      sourceType: params.sourceType,
      sourceSpec: params.sourceSpec,
      artifact,
      resolvedSpec: params.resolvedSpec,
      resolvedVersion: params.resolvedVersion,
      expectedIntegrity: integrity.expectedIntegrity,
      resolvedIntegrity: integrity.resolvedIntegrity,
      shasum: params.shasum,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function installFromPathSpec(
  sourceSpec: string,
  pluginRootDir: string,
  expectedIntegrity?: string,
): Promise<InstalledSourcePackage> {
  const resolved = path.resolve(sourceSpec);
  enforceLocalPathWhitelist(resolved);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw Object.assign(new Error(`path not found: ${resolved}`), { code: "NOT_FOUND" });
  }

  if (stat.isDirectory()) {
    const packageRoot = await locatePluginRoot(resolved);
    const artifact = await hashDirectory(packageRoot);
    const integrity = assertIntegrityMatch({
      expectedIntegrity,
      artifact,
    });
    return await prepareInstalledPackage({
      pluginRootDir,
      packageRootDir: packageRoot,
      sourceType: "path",
      sourceSpec: resolved,
      artifact,
      expectedIntegrity: integrity.expectedIntegrity,
      resolvedIntegrity: integrity.resolvedIntegrity,
    });
  }

  if (!isArchivePath(resolved)) {
    throw Object.assign(new Error("path source must be a plugin directory or archive"), {
      code: "INVALID_ARGUMENT",
    });
  }

  return await installFromArchivePath({
    archivePath: resolved,
    sourceType: "path",
    sourceSpec: resolved,
    pluginRootDir,
    expectedIntegrity,
  });
}

async function installFromNpmSpec(
  sourceSpec: string,
  pluginRootDir: string,
  expectedIntegrity?: string,
): Promise<InstalledSourcePackage> {
  validateRegistryNpmSpec(sourceSpec);
  enforceNpmSpecWhitelist(sourceSpec);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "nextai-plugin-npm-"));
  try {
    const { stdout } = await runCommand({
      command: "npm",
      args: ["pack", sourceSpec, "--json", "--silent", "--ignore-scripts"],
      cwd: tempDir,
      timeoutMs: 180_000,
    });

    let archiveName = "";
    let packMeta: NpmPackMetadata | null = null;
    try {
      const parsed = JSON.parse(stdout);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const rawMeta = (parsed[0] as Record<string, unknown>) ?? {};
        packMeta = {
          filename: extractString(rawMeta.filename) ?? "",
          id: extractString(rawMeta.id),
          name: extractString(rawMeta.name),
          version: extractString(rawMeta.version),
          integrity: extractString(rawMeta.integrity),
          shasum: extractString(rawMeta.shasum),
        };
        archiveName = packMeta.filename;
      }
    } catch {
      archiveName = "";
    }

    if (!archiveName) {
      const files = await fs.readdir(tempDir);
      const tgz = files.find((file) => file.toLowerCase().endsWith(".tgz"));
      if (tgz) archiveName = tgz;
    }

    if (!archiveName) {
      throw Object.assign(new Error("npm pack did not produce an archive"), {
        code: "INTERNAL",
      });
    }

    const archivePath = path.join(tempDir, archiveName);
    const resolvedSpec = packMeta?.name && packMeta?.version
      ? `${packMeta.name}@${packMeta.version}`
      : sourceSpec.trim();

    return await installFromArchivePath({
      archivePath,
      sourceType: "npm",
      sourceSpec: sourceSpec.trim(),
      pluginRootDir,
      expectedIntegrity,
      resolvedIntegrity: packMeta?.integrity,
      resolvedSpec,
      resolvedVersion: packMeta?.version,
      shasum: packMeta?.shasum,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function installFromSource(params: {
  sourceType: "npm" | "path" | "archive";
  sourceSpec: string;
  pluginRootDir: string;
  expectedIntegrity?: string;
}): Promise<InstalledSourcePackage> {
  enforceSourceTypeWhitelist(params.sourceType);

  if (params.sourceType === "npm") {
    return await installFromNpmSpec(params.sourceSpec, params.pluginRootDir, params.expectedIntegrity);
  }

  if (params.sourceType === "archive") {
    const resolved = path.resolve(params.sourceSpec);
    enforceLocalPathWhitelist(resolved);
    if (!isArchivePath(resolved)) {
      throw Object.assign(new Error("archive source must be .zip/.tgz/.tar.gz/.tar"), {
        code: "INVALID_ARGUMENT",
      });
    }
    try {
      await fs.access(resolved);
    } catch {
      throw Object.assign(new Error(`archive not found: ${resolved}`), { code: "NOT_FOUND" });
    }
    return await installFromArchivePath({
      archivePath: resolved,
      sourceType: "archive",
      sourceSpec: resolved,
      pluginRootDir: params.pluginRootDir,
      expectedIntegrity: params.expectedIntegrity,
    });
  }

  return await installFromPathSpec(params.sourceSpec, params.pluginRootDir, params.expectedIntegrity);
}

function toPluginMetadataFile(installed: InstalledSourcePackage): PluginMetadataFile {
  const configSchema = parseConfigFields(installed.manifest);
  const publishedAt = nowIso();

  return {
    displayName: installed.manifest.name ?? installed.packageManifest.name ?? installed.pluginId,
    longDescription: installed.manifest.description ?? installed.packageManifest.description ?? "",
    configSchema,
    tags: [],
    permissions: [],
    screenshots: [],
    publishedAt,
    updatedAt: publishedAt,
    sourceType: installed.sourceType,
    sourceSpec: installed.sourceSpec,
    installPath: installed.installPath,
  };
}

async function upsertMarketplacePluginFromInstalledPackage(installed: InstalledSourcePackage): Promise<void> {
  const existing = db.select().from(plugins).where(eq(plugins.id, installed.pluginId)).get();

  const name = installed.manifest.name ?? installed.packageManifest.name ?? installed.pluginId;
  const type = resolvePluginTypeFromManifest(installed.manifest);
  const description = installed.manifest.description ?? installed.packageManifest.description ?? "";
  const author = resolveAuthor(installed.packageManifest);
  const version = installed.manifest.version ?? installed.packageManifest.version ?? "0.0.0";

  if (existing) {
    db.update(plugins)
      .set({
        name,
        type,
        description,
        author,
        version,
      })
      .where(eq(plugins.id, installed.pluginId))
      .run();
  } else {
    db.insert(plugins)
      .values({
        id: installed.pluginId,
        name,
        type,
        description,
        author,
        version,
        pricingModel: "free",
        price: 0,
        rating: 0,
        installCount: 0,
        iconUrl: "🧩",
      })
      .run();
  }

  await writePluginMetadata(installed.pluginId, toPluginMetadataFile(installed));
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function writePluginInstallAudit(params: {
  workspaceId: string;
  pluginId: string;
  installedPluginId?: string;
  actorUserId?: string;
  action: string;
  status: "success" | "failure" | "rollback";
  sourceType?: string;
  sourceSpec?: string;
  expectedIntegrity?: string;
  resolvedIntegrity?: string;
  artifactSha256?: string;
  artifactSha512?: string;
  message?: string;
  detail?: Record<string, unknown>;
}): void {
  try {
    db.insert(pluginInstallAudits)
      .values({
        id: uuidv4(),
        workspaceId: params.workspaceId,
        pluginId: params.pluginId,
        installedPluginId: params.installedPluginId ?? null,
        actorUserId: params.actorUserId ?? null,
        action: params.action,
        status: params.status,
        sourceType: params.sourceType ?? null,
        sourceSpec: params.sourceSpec ?? null,
        expectedIntegrity: params.expectedIntegrity ?? null,
        resolvedIntegrity: params.resolvedIntegrity ?? null,
        artifactSha256: params.artifactSha256 ?? null,
        artifactSha512: params.artifactSha512 ?? null,
        message: params.message ?? null,
        detailJson: safeJSONStringify(params.detail ?? {}),
      })
      .run();
  } catch {
    // best-effort audit write
  }
}

function findInstallRecordByInstalledPluginId(installedPluginId: string) {
  return db
    .select()
    .from(pluginInstallRecords)
    .where(eq(pluginInstallRecords.installedPluginId, installedPluginId))
    .get();
}

function resolveInstallAuditSourceFields(params: {
  installedSource: InstalledSourcePackage | null;
  sourceType: "npm" | "path" | "archive" | null;
  sourceSpec: string;
  sourceIntegrity: string;
}): {
  sourceType?: string;
  sourceSpec?: string;
  expectedIntegrity?: string;
  resolvedIntegrity?: string;
  artifactSha256?: string;
  artifactSha512?: string;
} {
  const sourceType = params.installedSource?.sourceType ?? params.sourceType ?? undefined;
  const sourceSpec = params.installedSource?.sourceSpec || params.sourceSpec || undefined;
  const expectedIntegrity = params.installedSource?.expectedIntegrity || params.sourceIntegrity || undefined;
  return {
    sourceType,
    sourceSpec,
    expectedIntegrity,
    resolvedIntegrity: params.installedSource?.resolvedIntegrity,
    artifactSha256: params.installedSource?.artifactSha256,
    artifactSha512: params.installedSource?.artifactSha512,
  };
}

async function cleanupInstalledPath(installedSource: InstalledSourcePackage | null): Promise<boolean> {
  if (!installedSource?.installPathCreated) return false;
  try {
    await fs.rm(installedSource.installPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function findInstalledRow(workspaceId: string, pluginKey: string) {
  const byId = db
    .select()
    .from(installedPlugins)
    .where(and(eq(installedPlugins.workspaceId, workspaceId), eq(installedPlugins.id, pluginKey)))
    .get();
  if (byId) return byId;

  return db
    .select()
    .from(installedPlugins)
    .where(and(eq(installedPlugins.workspaceId, workspaceId), eq(installedPlugins.pluginId, pluginKey)))
    .get();
}

async function buildInstalledPluginItem(row: typeof installedPlugins.$inferSelect): Promise<InstalledPluginItem> {
  const pluginRow = db.select().from(plugins).where(eq(plugins.id, row.pluginId)).get();
  if (!pluginRow) {
    throw Object.assign(new Error("Plugin not found"), { code: "NOT_FOUND" });
  }

  const metadata = await loadPluginMetadata(pluginRow.id);
  const plugin = buildPluginItemFromRow({ row: pluginRow, metadata });

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    pluginId: row.pluginId,
    plugin,
    status: normalizeInstalledStatus(row.status),
    config: toConfigObject(row.configJson),
    installedAt: row.installedAt,
    installedBy: "system",
  };
}

export async function listMarketplacePlugins(params: ListMarketplacePluginsParams) {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, Math.min(100, params.pageSize ?? 24));

  const rows = db.select().from(plugins).all();
  const enriched: PluginMarketplaceItem[] = [];
  for (const row of rows) {
    const metadata = await loadPluginMetadata(row.id);
    enriched.push(buildPluginItemFromRow({ row, metadata }));
  }

  const type = (params.type ?? "").trim().toLowerCase();
  const pricingModel = (params.pricingModel ?? "").trim().toLowerCase();
  const search = (params.search ?? "").trim().toLowerCase();
  const sort = (params.sort ?? "").trim().toLowerCase();

  let filtered = enriched;
  if (type) {
    filtered = filtered.filter((plugin) => plugin.type === type);
  }
  if (pricingModel) {
    filtered = filtered.filter((plugin) => plugin.pricingModel === pricingModel);
  }
  if (search) {
    filtered = filtered.filter((plugin) => {
      const haystack = [plugin.name, plugin.displayName, plugin.description, plugin.author]
        .join(" ")
        .toLowerCase();
      return haystack.includes(search);
    });
  }

  if (sort === "rating") {
    filtered = [...filtered].sort((a, b) => b.rating - a.rating);
  } else if (sort === "newest") {
    filtered = [...filtered].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  } else {
    filtered = [...filtered].sort((a, b) => b.installCount - a.installCount);
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const data = filtered.slice(start, start + pageSize);

  return {
    data,
    total,
    page,
    pageSize,
    totalPages,
  };
}

export async function getMarketplacePlugin(pluginId: string): Promise<PluginMarketplaceItem> {
  const normalizedId = validatePluginId(pluginId);
  const row = db.select().from(plugins).where(eq(plugins.id, normalizedId)).get();
  if (!row) {
    throw Object.assign(new Error("Plugin not found"), { code: "NOT_FOUND" });
  }

  const metadata = await loadPluginMetadata(normalizedId);
  return buildPluginItemFromRow({ row, metadata });
}

export function listPluginReviews(pluginId: string): PluginReviewItem[] {
  const normalizedId = pluginId.trim();
  if (!normalizedId) return [];
  return [];
}

export async function listWorkspaceInstalledPlugins(workspaceId: string): Promise<InstalledPluginItem[]> {
  await ensureWorkspaceExists(workspaceId);
  const rows = db
    .select()
    .from(installedPlugins)
    .where(eq(installedPlugins.workspaceId, workspaceId))
    .all()
    .sort((a, b) => b.installedAt.localeCompare(a.installedAt));

  const out: InstalledPluginItem[] = [];
  for (const row of rows) {
    out.push(await buildInstalledPluginItem(row));
  }
  return out;
}

export async function installWorkspacePlugin(params: InstallWorkspacePluginParams): Promise<InstalledPluginItem> {
  const workspaceId = params.workspaceId.trim();
  if (!workspaceId) {
    throw Object.assign(new Error("workspaceId is required"), { code: "INVALID_ARGUMENT" });
  }

  await ensureWorkspaceExists(workspaceId);

  const rawSourceType = (params.sourceType ?? "").trim();
  const sourceType = normalizeInstallSourceType(rawSourceType);
  if (rawSourceType && !sourceType) {
    throw Object.assign(new Error("sourceType must be one of: npm, path, archive"), {
      code: "INVALID_ARGUMENT",
    });
  }
  const sourceSpec = (params.sourceSpec ?? "").trim();
  const sourceIntegrity = (params.sourceIntegrity ?? "").trim();
  const pluginRootDir = resolvePluginExtensionsDir();
  const installedBy = params.installedBy?.trim() || "system";

  let pluginId = (params.pluginId ?? "").trim();
  let installedSource: InstalledSourcePackage | null = null;

  if (sourceType) {
    await ensureDir(pluginRootDir);
    if (!sourceSpec) {
      throw Object.assign(new Error("sourceSpec is required when sourceType is provided"), {
        code: "INVALID_ARGUMENT",
      });
    }

    try {
      installedSource = await installFromSource({
        sourceType,
        sourceSpec,
        pluginRootDir,
        expectedIntegrity: sourceIntegrity || undefined,
      });

      if (pluginId && pluginId !== installedSource.pluginId) {
        throw Object.assign(
          new Error(`pluginId mismatch: request=${pluginId}, manifest=${installedSource.pluginId}`),
          { code: "INVALID_ARGUMENT" },
        );
      }

      pluginId = installedSource.pluginId;
      await upsertMarketplacePluginFromInstalledPackage(installedSource);
    } catch (err) {
      const rollbackRemoved = await cleanupInstalledPath(installedSource);
      const fallbackPluginId = pluginId || "unknown";
      const sourceAudit = resolveInstallAuditSourceFields({
        installedSource,
        sourceType,
        sourceSpec,
        sourceIntegrity,
      });
      writePluginInstallAudit({
        workspaceId,
        pluginId: fallbackPluginId,
        actorUserId: installedBy,
        action: "install",
        status: "failure",
        ...sourceAudit,
        message: err instanceof Error ? err.message : "plugin source install failed",
        detail: {
          stage: "source_prepare",
          rollbackRemovedInstallPath: rollbackRemoved,
        },
      });
      if (rollbackRemoved) {
        writePluginInstallAudit({
          workspaceId,
          pluginId: fallbackPluginId,
          actorUserId: installedBy,
          action: "install",
          status: "rollback",
          sourceType: sourceAudit.sourceType,
          sourceSpec: sourceAudit.sourceSpec,
          message: "install rollback removed plugin install path",
        });
      }
      throw err;
    }
  }

  let pluginRow: typeof plugins.$inferSelect | undefined;
  let normalizedConfig = "{}";
  try {
    pluginId = validatePluginId(pluginId);
    pluginRow = db.select().from(plugins).where(eq(plugins.id, pluginId)).get();
    if (!pluginRow) {
      throw Object.assign(new Error("Plugin not found"), { code: "NOT_FOUND" });
    }

    const exists = db
      .select({ id: installedPlugins.id })
      .from(installedPlugins)
      .where(and(eq(installedPlugins.workspaceId, workspaceId), eq(installedPlugins.pluginId, pluginId)))
      .get();
    if (exists) {
      throw Object.assign(new Error("Plugin already installed"), { code: "ALREADY_EXISTS" });
    }
    normalizedConfig = normalizeConfigJSON(params.configJson ?? "{}");
  } catch (err) {
    const rollbackRemoved = await cleanupInstalledPath(installedSource);
    const sourceAudit = resolveInstallAuditSourceFields({
      installedSource,
      sourceType,
      sourceSpec,
      sourceIntegrity,
    });
    writePluginInstallAudit({
      workspaceId,
      pluginId: pluginId || "unknown",
      actorUserId: installedBy,
      action: "install",
      status: "failure",
      ...sourceAudit,
      message: err instanceof Error ? err.message : "install precheck failed",
      detail: {
        stage: "precheck",
        rollbackRemovedInstallPath: rollbackRemoved,
      },
    });
    if (rollbackRemoved) {
      writePluginInstallAudit({
        workspaceId,
        pluginId: pluginId || "unknown",
        actorUserId: installedBy,
        action: "install",
        status: "rollback",
        sourceType: sourceAudit.sourceType,
        sourceSpec: sourceAudit.sourceSpec,
        message: "install rollback removed plugin install path",
      });
    }
    throw err;
  }

  if (!pluginRow) {
    throw Object.assign(new Error("Plugin not found"), { code: "NOT_FOUND" });
  }

  const sourceAudit = resolveInstallAuditSourceFields({
    installedSource,
    sourceType,
    sourceSpec,
    sourceIntegrity,
  });
  const installedAt = nowIso();

  const installedPluginId = uuidv4();
  try {
    db.transaction((tx) => {
      tx.insert(installedPlugins)
        .values({
          id: installedPluginId,
          workspaceId,
          pluginId,
          status: "enabled",
          configJson: normalizedConfig,
          installedAt,
        })
        .run();

      const nextInstallCount = Math.max(0, Number(pluginRow.installCount ?? 0) + 1);
      tx.update(plugins)
        .set({ installCount: nextInstallCount })
        .where(eq(plugins.id, pluginId))
        .run();

      if (installedSource) {
        tx.insert(pluginInstallRecords)
          .values({
            id: uuidv4(),
            installedPluginId,
            workspaceId,
            pluginId,
            sourceType: installedSource.sourceType,
            sourceSpec: installedSource.sourceSpec,
            resolvedSpec: installedSource.resolvedSpec ?? null,
            resolvedVersion: installedSource.resolvedVersion ?? null,
            expectedIntegrity: installedSource.expectedIntegrity ?? null,
            resolvedIntegrity: installedSource.resolvedIntegrity ?? null,
            shasum: installedSource.shasum ?? null,
            artifactSha256: installedSource.artifactSha256,
            artifactSha512: installedSource.artifactSha512,
            installPath: installedSource.installPath ?? null,
            createdAt: installedAt,
            updatedAt: installedAt,
          })
          .run();
      }
    });
  } catch (err) {
    const rollbackRemoved = await cleanupInstalledPath(installedSource);

    writePluginInstallAudit({
      workspaceId,
      pluginId,
      installedPluginId,
      actorUserId: installedBy,
      action: "install",
      status: "failure",
      ...sourceAudit,
      message: err instanceof Error ? err.message : "install transaction failed",
      detail: {
        stage: "db_commit",
        rollbackRemovedInstallPath: rollbackRemoved,
      },
    });
    if (rollbackRemoved) {
      writePluginInstallAudit({
        workspaceId,
        pluginId,
        installedPluginId,
        actorUserId: installedBy,
        action: "install",
        status: "rollback",
        sourceType: sourceAudit.sourceType,
        sourceSpec: sourceAudit.sourceSpec,
        message: "install rollback removed plugin install path",
      });
    }
    throw err;
  }

  const row = db.select().from(installedPlugins).where(eq(installedPlugins.id, installedPluginId)).get();
  if (!row) {
    throw Object.assign(new Error("Installed plugin not found"), { code: "INTERNAL" });
  }

  const item = await buildInstalledPluginItem(row);
  item.installedBy = installedBy;

  writePluginInstallAudit({
    workspaceId,
    pluginId,
    installedPluginId,
    actorUserId: installedBy,
    action: "install",
    status: "success",
    ...sourceAudit,
    message: "plugin installed successfully",
    detail: {
      installPath: installedSource?.installPath,
      installPathCreated: installedSource?.installPathCreated ?? false,
      resolvedSpec: installedSource?.resolvedSpec,
      resolvedVersion: installedSource?.resolvedVersion,
      shasum: installedSource?.shasum,
    },
  });

  return item;
}

export async function uninstallWorkspacePlugin(
  workspaceId: string,
  pluginKey: string,
  actorUserId?: string,
): Promise<void> {
  await ensureWorkspaceExists(workspaceId);
  const actor = actorUserId?.trim() || "system";

  const row = await findInstalledRow(workspaceId, pluginKey.trim());
  if (!row) {
    throw Object.assign(new Error("Installed plugin not found"), { code: "NOT_FOUND" });
  }

  const installRecord = findInstallRecordByInstalledPluginId(row.id);
  const sourceType = installRecord?.sourceType ?? undefined;
  const sourceSpec = installRecord?.sourceSpec ?? undefined;
  const expectedIntegrity = installRecord?.expectedIntegrity ?? undefined;
  const resolvedIntegrity = installRecord?.resolvedIntegrity ?? undefined;
  const artifactSha256 = installRecord?.artifactSha256 ?? undefined;
  const artifactSha512 = installRecord?.artifactSha512 ?? undefined;

  try {
    db.transaction((tx) => {
      tx.delete(installedPlugins).where(eq(installedPlugins.id, row.id)).run();

      const pluginRow = tx.select().from(plugins).where(eq(plugins.id, row.pluginId)).get();
      if (pluginRow) {
        const nextInstallCount = Math.max(0, Number(pluginRow.installCount ?? 0) - 1);
        tx.update(plugins)
          .set({ installCount: nextInstallCount })
          .where(eq(plugins.id, pluginRow.id))
          .run();
      }
    });
  } catch (err) {
    writePluginInstallAudit({
      workspaceId,
      pluginId: row.pluginId,
      installedPluginId: row.id,
      actorUserId: actor,
      action: "uninstall",
      status: "failure",
      sourceType,
      sourceSpec,
      expectedIntegrity,
      resolvedIntegrity,
      artifactSha256,
      artifactSha512,
      message: err instanceof Error ? err.message : "uninstall failed",
    });
    throw err;
  }

  writePluginInstallAudit({
    workspaceId,
    pluginId: row.pluginId,
    installedPluginId: row.id,
    actorUserId: actor,
    action: "uninstall",
    status: "success",
    sourceType,
    sourceSpec,
    expectedIntegrity,
    resolvedIntegrity,
    artifactSha256,
    artifactSha512,
    message: "plugin uninstalled successfully",
  });
}

export async function updateWorkspacePluginStatus(params: {
  workspaceId: string;
  pluginKey: string;
  status: string;
  actorUserId?: string;
}): Promise<InstalledPluginItem> {
  const workspaceId = params.workspaceId.trim();
  await ensureWorkspaceExists(workspaceId);
  const actor = params.actorUserId?.trim() || "system";

  const status = normalizeInstalledStatus(params.status);
  const row = await findInstalledRow(workspaceId, params.pluginKey.trim());
  if (!row) {
    throw Object.assign(new Error("Installed plugin not found"), { code: "NOT_FOUND" });
  }
  const installRecord = findInstallRecordByInstalledPluginId(row.id);

  let updated: typeof installedPlugins.$inferSelect | undefined;
  try {
    db.update(installedPlugins)
      .set({ status })
      .where(eq(installedPlugins.id, row.id))
      .run();

    updated = db.select().from(installedPlugins).where(eq(installedPlugins.id, row.id)).get();
    if (!updated) {
      throw Object.assign(new Error("Installed plugin not found"), { code: "NOT_FOUND" });
    }
  } catch (err) {
    writePluginInstallAudit({
      workspaceId,
      pluginId: row.pluginId,
      installedPluginId: row.id,
      actorUserId: actor,
      action: "update_status",
      status: "failure",
      sourceType: installRecord?.sourceType ?? undefined,
      sourceSpec: installRecord?.sourceSpec ?? undefined,
      message: err instanceof Error ? err.message : "update status failed",
      detail: {
        targetStatus: status,
      },
    });
    throw err;
  }

  writePluginInstallAudit({
    workspaceId,
    pluginId: row.pluginId,
    installedPluginId: row.id,
    actorUserId: actor,
    action: "update_status",
    status: "success",
    sourceType: installRecord?.sourceType ?? undefined,
    sourceSpec: installRecord?.sourceSpec ?? undefined,
    message: "plugin status updated successfully",
    detail: {
      targetStatus: status,
    },
  });

  if (!updated) {
    throw Object.assign(new Error("Installed plugin not found"), { code: "NOT_FOUND" });
  }
  return await buildInstalledPluginItem(updated);
}

export async function updateWorkspacePluginConfig(params: {
  workspaceId: string;
  pluginKey: string;
  configJson: string;
  actorUserId?: string;
}): Promise<InstalledPluginItem> {
  const workspaceId = params.workspaceId.trim();
  await ensureWorkspaceExists(workspaceId);
  const actor = params.actorUserId?.trim() || "system";

  const row = await findInstalledRow(workspaceId, params.pluginKey.trim());
  if (!row) {
    throw Object.assign(new Error("Installed plugin not found"), { code: "NOT_FOUND" });
  }
  const installRecord = findInstallRecordByInstalledPluginId(row.id);

  let configJson = "{}";
  let updated: typeof installedPlugins.$inferSelect | undefined;
  try {
    configJson = normalizeConfigJSON(params.configJson);

    db.update(installedPlugins)
      .set({ configJson })
      .where(eq(installedPlugins.id, row.id))
      .run();

    updated = db.select().from(installedPlugins).where(eq(installedPlugins.id, row.id)).get();
    if (!updated) {
      throw Object.assign(new Error("Installed plugin not found"), { code: "NOT_FOUND" });
    }
  } catch (err) {
    writePluginInstallAudit({
      workspaceId,
      pluginId: row.pluginId,
      installedPluginId: row.id,
      actorUserId: actor,
      action: "update_config",
      status: "failure",
      sourceType: installRecord?.sourceType ?? undefined,
      sourceSpec: installRecord?.sourceSpec ?? undefined,
      message: err instanceof Error ? err.message : "update config failed",
    });
    throw err;
  }

  writePluginInstallAudit({
    workspaceId,
    pluginId: row.pluginId,
    installedPluginId: row.id,
    actorUserId: actor,
    action: "update_config",
    status: "success",
    sourceType: installRecord?.sourceType ?? undefined,
    sourceSpec: installRecord?.sourceSpec ?? undefined,
    message: "plugin config updated successfully",
    detail: {
      configSize: configJson.length,
    },
  });

  if (!updated) {
    throw Object.assign(new Error("Installed plugin not found"), { code: "NOT_FOUND" });
  }
  return await buildInstalledPluginItem(updated);
}
