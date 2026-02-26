import fs from "fs";
import path from "path";
import { tool } from "ai";
import { z } from "zod";
import type { FsPolicy } from "../policy/fs-policy.js";
import { isFsPathAllowed } from "../policy/fs-policy.js";

export function makeCodeWriteTool(fsPolicy: FsPolicy) {
  return tool({
    description: "Write content to a file at the given path",
    parameters: z.object({
      path: z.string().describe("Absolute file path to write"),
      content: z.string().describe("Content to write to the file"),
    }),
    execute: async ({ path: filePath, content }) => {
      if (!isFsPathAllowed(filePath, fsPolicy)) {
        return { error: `Access denied: ${filePath} is outside allowed paths` };
      }
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf-8");
        return { success: true, path: filePath };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { error: `Failed to write file: ${msg}` };
      }
    },
  });
}
