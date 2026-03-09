import fs from "fs";
import path from "path";
import { Type } from "@sinclair/typebox";
import { isFsPathAllowed } from "../policy/fs-policy.js";
const CodeWriteParams = Type.Object({
    path: Type.String({ description: "Absolute file path to write" }),
    content: Type.String({ description: "Content to write to the file" }),
});
export function makeCodeWriteTool(fsPolicy) {
    return {
        name: "code_write",
        description: "Write content to a file at the given path",
        parameters: CodeWriteParams,
        execute: async ({ path: filePath, content }) => {
            if (!isFsPathAllowed(filePath, fsPolicy)) {
                return { error: `Access denied: ${filePath} is outside allowed paths` };
            }
            try {
                fs.mkdirSync(path.dirname(filePath), { recursive: true });
                fs.writeFileSync(filePath, content, "utf-8");
                return { success: true, path: filePath };
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return { error: `Failed to write file: ${msg}` };
            }
        },
    };
}
