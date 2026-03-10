import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import type { RuntimeTool } from "./types.js";
import type { FsPolicy } from "../policy/fs-policy.js";
import { isFsPathAllowed } from "../policy/fs-policy.js";

const CodeWriteParams = Type.Object({
  path: Type.String({ description: "Absolute file path to write" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export function makeCodeWriteTool(fsPolicy: FsPolicy): RuntimeTool<typeof CodeWriteParams> {
  return {
    name: "code_write",
    description: "Write content to a file at the given path",
    parameters: CodeWriteParams,
    category: "file",
    riskLevel: "medium",
    execute: async ({ path: filePath, content }) => {
      if (!isFsPathAllowed(filePath, fsPolicy)) {
        return { error: `Access denied: ${filePath} is outside allowed paths` };
      }
      try {
        // M10: Resolve symlinks in the parent directory to prevent sandbox escape.
        // The target file may not exist yet, so resolve the nearest existing ancestor.
        const dir = path.dirname(filePath);
        let resolvedDir: string;
        try {
          resolvedDir = fs.realpathSync(dir);
        } catch {
          // Directory doesn't exist yet — resolve its parent
          fs.mkdirSync(dir, { recursive: true });
          resolvedDir = fs.realpathSync(dir);
        }
        const resolvedPath = path.join(resolvedDir, path.basename(filePath));

        if (!isFsPathAllowed(resolvedPath, fsPolicy)) {
          return { error: `Access denied: resolved path ${resolvedPath} is outside allowed paths` };
        }

        fs.writeFileSync(resolvedPath, content, "utf-8");
        return { success: true, path: resolvedPath };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to write file: ${msg}` };
      }
    },
  };
}
