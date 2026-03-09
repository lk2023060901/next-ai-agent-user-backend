import type {
  PromptBuilder,
  PromptBuildParams,
} from "./context-types.js";

/**
 * System prompt assembler (design doc §6.2).
 *
 * Builds the system prompt by concatenating sections in order:
 * 1. System identity + agent system prompt
 * 2. Core memory blocks (persona, user, working, knowledge summary)
 * 3. Injected memories (relevance-ranked)
 * 4. Tool catalog (names + descriptions)
 * 5. Channel constraints (optional)
 * 6. Current date & environment
 *
 * Each section is only included when content is present.
 */
export class DefaultPromptBuilder implements PromptBuilder {
  build(params: PromptBuildParams): string {
    const sections: string[] = [];

    // 1. System identity
    if (params.agent.systemPrompt) {
      sections.push(params.agent.systemPrompt);
    }

    // 2. Core memory
    const coreMemoryBlock = buildCoreMemoryBlock(params.coreMemory);
    if (coreMemoryBlock) {
      sections.push(coreMemoryBlock);
    }

    // 3. Injected memories
    if (params.injectedMemories && params.injectedMemories.length > 0) {
      const lines = params.injectedMemories.map(
        (m) => `- ${m.content} (source: ${m.source}, relevance: ${m.score.toFixed(2)})`,
      );
      sections.push(
        "## Relevant Memories\nThe following may be relevant to the current conversation:\n" +
        lines.join("\n"),
      );
    }

    // 4. Tool catalog
    if (params.tools.length > 0) {
      const toolLines = params.tools.map(
        (t) => `- **${t.definition.name}**: ${t.definition.description}`,
      );
      sections.push("## Available Tools\n" + toolLines.join("\n"));
    }

    // 5. Channel constraints
    if (params.channelContext?.constraints) {
      sections.push(params.channelContext.constraints);
    }

    // 6. Current date
    const date = params.currentDate ?? new Date().toISOString().slice(0, 10);
    sections.push(`Current date: ${date}`);

    return sections.join("\n\n");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCoreMemoryBlock(
  snapshot: PromptBuildParams["coreMemory"],
): string | null {
  if (!snapshot) return null;

  const blocks: string[] = [];

  if (snapshot.persona) {
    blocks.push(`### Persona\n${snapshot.persona}`);
  }
  if (snapshot.user) {
    blocks.push(`### User Profile\n${snapshot.user}`);
  }
  if (snapshot.working) {
    blocks.push(`### Working Context\n${snapshot.working}`);
  }
  if (snapshot.knowledgeSummary) {
    blocks.push(`### Knowledge Summary\n${snapshot.knowledgeSummary}`);
  }

  if (blocks.length === 0) return null;
  return "## Core Memory\n" + blocks.join("\n\n");
}
