import type {
  PolicyContext,
  PolicyLayer,
  ResolvedToolPolicy,
  ToolPolicy,
  ToolPolicyPipeline,
} from "./tool-types.js";

/**
 * Multi-layer tool policy pipeline.
 *
 * Layers are evaluated in order. Merge rules:
 * - deny: union (any layer can deny)
 * - allow: intersection (must pass all layers that specify allow)
 * - deny always wins over allow
 *
 * Pipeline layers (from design doc §5.6):
 * 1. GlobalPolicy        — platform-wide defaults
 * 2. AgentPolicy         — per-agent allow/deny
 * 3. ProviderPolicy      — provider-specific tool restrictions
 * 4. SubAgentDepthPolicy — depth-based narrowing
 * 5. ChannelPolicy       — channel-specific restrictions
 */
export class DefaultToolPolicyPipeline implements ToolPolicyPipeline {
  private readonly layers: PolicyLayer[];

  constructor(layers?: PolicyLayer[]) {
    this.layers = layers ?? [];
  }

  resolve(context: PolicyContext): ResolvedToolPolicy {
    const allDeny: string[] = [];
    const allowSets: string[][] = [];

    for (const layer of this.layers) {
      const policy = layer.resolve(context);
      if (policy.deny && policy.deny.length > 0) {
        allDeny.push(...policy.deny);
      }
      if (policy.allow && policy.allow.length > 0) {
        allowSets.push(policy.allow);
      }
    }

    // deny = union of all layers
    const deny = [...new Set(allDeny)];

    // allow = intersection of layers that specified allow
    // (layers without allow are permissive — they don't restrict)
    const allow = intersectAllowSets(allowSets);

    return { allow, deny };
  }
}

/**
 * Intersect multiple allow sets.
 *
 * Each set is an array of glob patterns. A name passes the intersection
 * if it matches at least one pattern in every set.
 *
 * When no sets are provided, the result is empty (= all allowed).
 * When one set is provided, it's returned as-is.
 * When multiple sets are provided, we keep only patterns that appear
 * in all sets (exact intersection).
 *
 * Note: true glob intersection is complex. For pragmatic first
 * implementation, we intersect by exact pattern matching. Glob
 * expansion (e.g., "code_*" ∩ "code_read") is left to the registry
 * filter step.
 */
function intersectAllowSets(sets: string[][]): string[] {
  if (sets.length === 0) return [];
  if (sets.length === 1) return sets[0]!;

  // Keep patterns that appear in ALL sets
  const first = new Set(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    const current = new Set(sets[i]);
    for (const pattern of first) {
      if (!current.has(pattern)) {
        first.delete(pattern);
      }
    }
  }
  return [...first];
}

// ─── Built-in policy layers ──────────────────────────────────────────────────

/**
 * Sub-agent depth policy (design doc §5.6).
 *
 * - At maxDepth: deny delegate_to_agent (leaf agent, no further delegation)
 * - At maxDepth-1: deny sessions_spawn (can delegate but not spawn sessions)
 */
export class SubAgentDepthLayer implements PolicyLayer {
  readonly name = "sub-agent-depth";

  resolve(context: PolicyContext): ToolPolicy {
    if (context.subAgentDepth >= context.maxDepth) {
      return { deny: ["delegate_to_agent", "sessions_spawn"] };
    }
    if (context.subAgentDepth >= context.maxDepth - 1) {
      return { deny: ["sessions_spawn"] };
    }
    return {};
  }
}

/**
 * Static policy layer — wraps a fixed ToolPolicy.
 * Useful for global defaults or per-agent policies loaded from config.
 */
export class StaticPolicyLayer implements PolicyLayer {
  constructor(
    readonly name: string,
    private readonly policy: ToolPolicy,
  ) {}

  resolve(): ToolPolicy {
    return this.policy;
  }
}
