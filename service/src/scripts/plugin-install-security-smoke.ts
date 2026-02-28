import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

type ArtifactHashes = {
  sha256: string;
  sha512: string;
};

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function walkFiles(dirPath: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [dirPath];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
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
    const content = await fs.readFile(filePath);
    hasher256.update(content);
    hasher512.update(content);
  }
  return {
    sha256: hasher256.digest("hex"),
    sha512: hasher512.digest("hex"),
  };
}

async function writePluginFixture(params: {
  dirPath: string;
  pluginId: string;
  pluginName: string;
  pluginDescription: string;
}): Promise<void> {
  await fs.mkdir(params.dirPath, { recursive: true });
  const manifest = {
    id: params.pluginId,
    kind: "tool",
    name: params.pluginName,
    description: params.pluginDescription,
    version: "1.0.0",
    configSchema: {
      type: "object",
      properties: {
        token: {
          type: "string",
          title: "Token",
          description: "API token for smoke validation",
        },
      },
      required: ["token"],
    },
    uiHints: {
      token: {
        label: "Token",
        sensitive: true,
      },
    },
  };
  const pkg = {
    name: params.pluginId,
    version: "1.0.0",
    description: params.pluginDescription,
  };
  await fs.writeFile(path.join(params.dirPath, "openclaw.plugin.json"), JSON.stringify(manifest, null, 2), "utf-8");
  await fs.writeFile(path.join(params.dirPath, "package.json"), JSON.stringify(pkg, null, 2), "utf-8");
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "nextai-plugin-security-"));
  const dbPath = path.join(tempRoot, "app.db");
  process.env.DB_PATH = dbPath;

  const migrationsFolder = path.resolve(process.cwd(), "drizzle");
  assertTrue(fsSync.existsSync(migrationsFolder), `migrations folder not found: ${migrationsFolder}`);

  const { db } = await import("../db/index");
  const schema = await import("../db/schema");
  const pluginService = await import("../modules/plugins/plugin.service");

  migrate(db, { migrationsFolder });

  const orgId = `org-${uuidv4()}`;
  const wsSuccess = `ws-success-${uuidv4()}`;
  const wsIntegrityFail = `ws-integrity-fail-${uuidv4()}`;
  const wsRollback = `ws-rollback-${uuidv4()}`;

  db.insert(schema.organizations).values({
    id: orgId,
    slug: `org-${Date.now()}`,
    name: "Plugin Security Smoke Org",
  }).run();

  for (const wsId of [wsSuccess, wsIntegrityFail, wsRollback]) {
    db.insert(schema.workspaces).values({
      id: wsId,
      slug: wsId,
      name: wsId,
      orgId,
    }).run();
  }

  const pluginOkDir = path.join(tempRoot, "fixtures", "plugin-ok");
  const pluginRollbackDir = path.join(tempRoot, "fixtures", "plugin-rollback");
  await writePluginFixture({
    dirPath: pluginOkDir,
    pluginId: "smoke-plugin-ok",
    pluginName: "Smoke Plugin OK",
    pluginDescription: "happy path plugin for security smoke test",
  });
  await writePluginFixture({
    dirPath: pluginRollbackDir,
    pluginId: "smoke-plugin-rollback",
    pluginName: "Smoke Plugin Rollback",
    pluginDescription: "rollback plugin for security smoke test",
  });

  const okHash = await hashDirectory(pluginOkDir);
  const okInstall = await pluginService.installWorkspacePlugin({
    workspaceId: wsSuccess,
    sourceType: "path",
    sourceSpec: pluginOkDir,
    sourceIntegrity: `sha256:${okHash.sha256}`,
    installedBy: "smoke-test",
  });
  assertTrue(okInstall.pluginId === "smoke-plugin-ok", "happy path install returned unexpected pluginId");

  const okInstalledRow = db.select().from(schema.installedPlugins)
    .where(and(eq(schema.installedPlugins.workspaceId, wsSuccess), eq(schema.installedPlugins.pluginId, "smoke-plugin-ok")))
    .get();
  assertTrue(okInstalledRow, "happy path install row missing");

  const okRecord = db.select().from(schema.pluginInstallRecords)
    .where(eq(schema.pluginInstallRecords.installedPluginId, okInstalledRow.id))
    .get();
  assertTrue(okRecord, "plugin install record missing on happy path");
  assertTrue(Boolean(okRecord.artifactSha256), "artifactSha256 missing on happy path");
  assertTrue(Boolean(okRecord.artifactSha512), "artifactSha512 missing on happy path");
  assertTrue(Boolean(okRecord.expectedIntegrity), "expected integrity missing on happy path");

  let integrityFailed = false;
  try {
    await pluginService.installWorkspacePlugin({
      workspaceId: wsIntegrityFail,
      sourceType: "path",
      sourceSpec: pluginOkDir,
      sourceIntegrity: "sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      installedBy: "smoke-test",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    integrityFailed = message.toLowerCase().includes("integrity mismatch");
  }
  assertTrue(integrityFailed, "integrity mismatch should reject install");

  const failedInstallRows = db.select().from(schema.installedPlugins)
    .where(eq(schema.installedPlugins.workspaceId, wsIntegrityFail))
    .all();
  assertTrue(failedInstallRows.length === 0, "integrity mismatch should not create install row");

  let rollbackFailedAsExpected = false;
  try {
    await pluginService.installWorkspacePlugin({
      workspaceId: wsRollback,
      pluginId: "intentional-mismatch-plugin-id",
      sourceType: "path",
      sourceSpec: pluginRollbackDir,
      installedBy: "smoke-test",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rollbackFailedAsExpected = message.toLowerCase().includes("pluginid mismatch");
  }
  assertTrue(rollbackFailedAsExpected, "pluginId mismatch scenario should fail");

  const pluginRootDir = path.join(path.dirname(dbPath), "plugins", "extensions");
  const rollbackInstallPath = path.join(pluginRootDir, "smoke-plugin-rollback");
  assertTrue(!fsSync.existsSync(rollbackInstallPath), "rollback install path was not cleaned up");

  const successAudits = db.select().from(schema.pluginInstallAudits)
    .where(and(eq(schema.pluginInstallAudits.workspaceId, wsSuccess), eq(schema.pluginInstallAudits.action, "install")))
    .all();
  assertTrue(successAudits.some((row) => row.status === "success"), "missing success audit for happy path");

  const integrityAudits = db.select().from(schema.pluginInstallAudits)
    .where(and(eq(schema.pluginInstallAudits.workspaceId, wsIntegrityFail), eq(schema.pluginInstallAudits.action, "install")))
    .all();
  assertTrue(integrityAudits.some((row) => row.status === "failure"), "missing failure audit for integrity mismatch");

  const rollbackAudits = db.select().from(schema.pluginInstallAudits)
    .where(and(eq(schema.pluginInstallAudits.workspaceId, wsRollback), eq(schema.pluginInstallAudits.action, "install")))
    .all();
  assertTrue(rollbackAudits.some((row) => row.status === "failure"), "missing failure audit for rollback scenario");
  assertTrue(rollbackAudits.some((row) => row.status === "rollback"), "missing rollback audit for rollback scenario");

  console.log(`[PASS] happy path install with integrity check (${okInstall.pluginId})`);
  console.log("[PASS] integrity mismatch is rejected and no installed row created");
  console.log("[PASS] rollback cleans install path on source install failure");
  console.log("[PASS] audit trail written for success/failure/rollback");
  console.log(`Smoke DB: ${dbPath}`);
}

main().catch((err) => {
  console.error("[FAIL] plugin install security smoke test failed");
  console.error(err);
  process.exit(1);
});
