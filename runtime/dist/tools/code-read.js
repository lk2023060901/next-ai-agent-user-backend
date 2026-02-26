import fs from "fs";
import { tool } from "ai";
import { z } from "zod";
import { isFsPathAllowed } from "../policy/fs-policy.js";
export function makeCodeReadTool(fsPolicy) {
    return tool({
        description: "Read the contents of a file at the given path",
        parameters: z.object({
            path: z.string().describe("Absolute file path to read"),
        }),
        execute: async ({ path: filePath }) => {
            if (!isFsPathAllowed(filePath, fsPolicy)) {
                return { error: `Access denied: ${filePath} is outside allowed paths` };
            }
            try {
                const content = fs.readFileSync(filePath, "utf-8");
                return { content };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { error: `Failed to read file: ${msg}` };
            }
        },
    });
}
