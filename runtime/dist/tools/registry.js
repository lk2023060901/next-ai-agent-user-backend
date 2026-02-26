import { isToolAllowed } from "../policy/tool-policy.js";
import { makeCodeReadTool } from "./code-read.js";
import { makeCodeWriteTool } from "./code-write.js";
import { makeSearchKnowledgeTool } from "./search-knowledge.js";
import { makeDelegateTool } from "./delegate.js";
export function buildToolset(params) {
    const allTools = {
        code_read: makeCodeReadTool(params.sandbox.fsPolicy),
        code_write: makeCodeWriteTool(params.sandbox.fsPolicy),
        search_knowledge: makeSearchKnowledgeTool(),
        delegate_to_agent: makeDelegateTool(params),
    };
    // Filter by tool policy — deny wins over allow
    const filtered = {};
    for (const [name, tool] of Object.entries(allTools)) {
        if (isToolAllowed(name, params.sandbox.toolPolicy)) {
            filtered[name] = tool;
        }
    }
    return filtered;
}
