import type { AgentConfig } from "../grpc/client.js";
import { parsePolicyFromAgent, type ToolPolicy } from "./tool-policy.js";
import { parseFsPolicyFromAgent, type FsPolicy } from "./fs-policy.js";

export interface SandboxPolicy {
  toolPolicy: ToolPolicy;
  fsPolicy: FsPolicy;
  execAllowedCommands: string[];
  maxTurns: number;
  maxSpawnDepth: number;
  timeoutMs: number;
}

export function buildSandboxFromAgentConfig(cfg: AgentConfig): SandboxPolicy {
  return {
    toolPolicy: parsePolicyFromAgent(cfg.toolAllowJson, cfg.toolDenyJson),
    fsPolicy: parseFsPolicyFromAgent(cfg.fsAllowedPathsJson),
    execAllowedCommands: parseJsonArray(cfg.execAllowedCommandsJson),
    maxTurns: cfg.maxTurns || 20,
    maxSpawnDepth: cfg.maxSpawnDepth || 3,
    timeoutMs: cfg.timeoutMs || 300000,
  };
}

function parseJsonArray(json: string): string[] {
  try {
    return JSON.parse(json) as string[];
  } catch {
    return [];
  }
}
