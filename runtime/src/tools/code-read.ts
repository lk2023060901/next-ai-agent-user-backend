import fs from "fs";
import { Type } from "@sinclair/typebox";
import type { RuntimeTool } from "./types.js";
import type { FsPolicy } from "../policy/fs-policy.js";
import { isFsPathAllowed } from "../policy/fs-policy.js";
import { config } from "../config.js";

const CodeReadParams = Type.Object({
  path: Type.String({ description: "Absolute file path to read" }),
});

export function makeCodeReadTool(fsPolicy: FsPolicy): RuntimeTool<typeof CodeReadParams> {
  return {
    name: "code_read",
    description: "Read the contents of a file at the given path",
    parameters: CodeReadParams,
    category: "file",
    riskLevel: "low",
    execute: async ({ path: filePath }) => {
      if (!isFsPathAllowed(filePath, fsPolicy)) {
        return { error: `Access denied: ${filePath} is outside allowed paths` };
      }
      try {
        // M9: Enforce file size limit before reading
        const stat = fs.statSync(filePath);
        if (stat.size > config.codeReadMaxFileSizeBytes) {
          const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
          const limitMB = (config.codeReadMaxFileSizeBytes / (1024 * 1024)).toFixed(0);
          return { error: `File too large (${sizeMB}MB). Maximum allowed: ${limitMB}MB` };
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${msg}` };
      }
    },
  };
}
