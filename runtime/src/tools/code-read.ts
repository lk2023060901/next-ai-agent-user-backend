import fs from "fs";
import { Type } from "@sinclair/typebox";
import type { RuntimeTool } from "./types.js";
import type { FsPolicy } from "../policy/fs-policy.js";
import { isFsPathAllowed } from "../policy/fs-policy.js";

const CodeReadParams = Type.Object({
  path: Type.String({ description: "Absolute file path to read" }),
});

export function makeCodeReadTool(fsPolicy: FsPolicy): RuntimeTool<typeof CodeReadParams> {
  return {
    name: "code_read",
    description: "Read the contents of a file at the given path",
    parameters: CodeReadParams,
    execute: async ({ path: filePath }) => {
      if (!isFsPathAllowed(filePath, fsPolicy)) {
        return { error: `Access denied: ${filePath} is outside allowed paths` };
      }
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        return { content };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${msg}` };
      }
    },
  };
}
