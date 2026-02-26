// Tool policy — ported from OpenClaw pi-tools.policy.ts
// Deny always wins. Sub-agent permissions can only be narrowed, never expanded.

export interface ToolPolicy {
  allow: string[];
  deny: string[];
}

// Tools always denied for sub-agents regardless of spawn depth
const ALWAYS_DENY_FOR_SUBAGENT = ["delegate_to_agent"];

// Additional denials for leaf agents (at max depth — can't spawn further)
const LEAF_EXTRA_DENY: string[] = [];

function matchesGlob(name: string, pattern: string): boolean {
  // Simple glob: exact match or wildcard * suffix/prefix
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1));
  return name === pattern;
}

function matchesAnyGlob(name: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesGlob(name, p));
}

/**
 * Check if a tool is allowed by the given policy.
 * Deny always takes precedence over allow.
 */
export function isToolAllowed(name: string, policy: ToolPolicy): boolean {
  if (matchesAnyGlob(name, policy.deny)) return false;
  if (policy.allow.length === 0) return true;
  return matchesAnyGlob(name, policy.allow);
}

/**
 * Narrow a parent policy for a sub-agent.
 * Sub-agents always have delegate_to_agent denied.
 * Leaf agents (at maxDepth) also get LEAF_EXTRA_DENY applied.
 */
export function narrowForSubagent(
  parent: ToolPolicy,
  depth: number,
  maxDepth: number
): ToolPolicy {
  const isLeaf = depth >= maxDepth;
  const extraDeny = isLeaf
    ? [...ALWAYS_DENY_FOR_SUBAGENT, ...LEAF_EXTRA_DENY]
    : [...ALWAYS_DENY_FOR_SUBAGENT];

  return {
    allow: parent.allow,
    deny: [...new Set([...parent.deny, ...extraDeny])],
  };
}

/**
 * Parse tool policy from JSON strings stored in agent config.
 */
export function parsePolicyFromAgent(allowJson: string, denyJson: string): ToolPolicy {
  try {
    return {
      allow: JSON.parse(allowJson) as string[],
      deny: JSON.parse(denyJson) as string[],
    };
  } catch {
    return { allow: [], deny: [] };
  }
}
