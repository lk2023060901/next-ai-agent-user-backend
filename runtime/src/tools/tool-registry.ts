import type {
  AgentTool,
  ResolvedToolPolicy,
  ToolCategory,
  ToolContext,
  ToolRegistry,
  ToolResult,
} from "./tool-types.js";
import type { RuntimeTool } from "./types.js";

/**
 * In-memory tool registry.
 *
 * Tools are stored by name. Duplicate names overwrite — this allows
 * plugin tools to shadow builtins when explicitly configured.
 */
export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.definition.name, tool);
  }

  registerBatch(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  listByCategory(category: ToolCategory): AgentTool[] {
    return this.list().filter((t) => t.definition.category === category);
  }

  /**
   * Return tools filtered by a resolved policy.
   * deny takes precedence over allow.
   */
  resolve(policy: ResolvedToolPolicy): AgentTool[] {
    return this.list().filter((t) => isAllowed(t.definition.name, policy));
  }
}

// ─── Policy matching ─────────────────────────────────────────────────────────

function matchesGlob(name: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

function matchesAny(name: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(name, p));
}

function isAllowed(name: string, policy: ResolvedToolPolicy): boolean {
  if (matchesAny(name, policy.deny)) return false;
  if (policy.allow.length === 0) return true;
  return matchesAny(name, policy.allow);
}

// ─── Legacy adapter ──────────────────────────────────────────────────────────

/**
 * Wrap an existing RuntimeTool into the new AgentTool interface.
 *
 * This lets the current builtin tools (code_read, web_search, etc.)
 * participate in the new tool system without rewriting them.
 */
export function fromRuntimeTool(
  tool: RuntimeTool,
  category?: ToolCategory,
  riskLevel?: "low" | "medium" | "high" | "critical",
): AgentTool {
  return {
    definition: {
      name: tool.name,
      description: tool.description,
      category: category ?? tool.category,
      riskLevel: riskLevel ?? tool.riskLevel,
      parameters: tool.parameters as Record<string, unknown>,
      isLocal: true,
    },
    execute: async (
      params: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolResult> => {
      const start = Date.now();
      try {
        const raw = await tool.execute(params, {
          toolCallId: context.toolCallId,
          signal: context.abortSignal,
        });
        return normalizeRawResult(raw, Date.now() - start);
      } catch (err) {
        return {
          status: "error",
          data: null,
          error: err instanceof Error ? err.message : String(err),
          metadata: { durationMs: Date.now() - start },
        };
      }
    },
  };
}

/**
 * Normalize a raw tool return value into a ToolResult.
 *
 * Existing tools return arbitrary objects — often `{ content }` on success
 * or `{ error }` on failure. This function detects the pattern.
 */
function normalizeRawResult(raw: unknown, durationMs: number): ToolResult {
  if (raw == null) {
    return { status: "success", data: null, metadata: { durationMs } };
  }

  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.error === "string") {
      return {
        status: "error",
        data: null,
        error: obj.error,
        metadata: { durationMs },
      };
    }
  }

  return { status: "success", data: raw, metadata: { durationMs } };
}
