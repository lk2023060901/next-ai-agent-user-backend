import { parsePolicyFromAgent } from "./tool-policy.js";
import { parseFsPolicyFromAgent } from "./fs-policy.js";
export function buildSandboxFromAgentConfig(cfg) {
    return {
        toolPolicy: parsePolicyFromAgent(cfg.toolAllowJson, cfg.toolDenyJson),
        fsPolicy: parseFsPolicyFromAgent(cfg.fsAllowedPathsJson),
        execAllowedCommands: parseJsonArray(cfg.execAllowedCommandsJson),
        maxTurns: cfg.maxTurns || 20,
        maxSpawnDepth: cfg.maxSpawnDepth || 3,
        timeoutMs: cfg.timeoutMs || 300000,
    };
}
function parseJsonArray(json) {
    try {
        return JSON.parse(json);
    }
    catch {
        return [];
    }
}
