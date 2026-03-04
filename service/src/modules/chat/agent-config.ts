import { z, ZodError } from "zod";

export const AGENT_CONFIG_SPEC_VERSION = "agent-config.v1";

const AGENT_ID_LIKE_REGEX = /^[A-Za-z0-9._:-]+$/;
const TOOL_PATTERN_REGEX = /^[A-Za-z0-9._:/-]+(?:\*)?$/;
const COMMAND_OR_SUBCOMMAND_PATTERN_REGEX = /^(?:[A-Za-z0-9._:/-]+)(?: [A-Za-z0-9._:/-]+)?$/;

const modelIdSchema = z
  .string()
  .trim()
  .min(1, "model id is required")
  .max(128, "model id is too long")
  .regex(AGENT_ID_LIKE_REGEX, "model id contains invalid characters");

const toolPatternSchema = z
  .string()
  .trim()
  .min(1, "tool pattern is required")
  .max(128, "tool pattern is too long")
  .regex(TOOL_PATTERN_REGEX, "tool pattern contains invalid characters");

const fsPathSchema = z
  .string()
  .trim()
  .min(1, "file system path is required")
  .max(512, "file system path is too long")
  .refine((value) => value.startsWith("/"), "file system path must be absolute");

const commandSchema = z
  .string()
  .trim()
  .min(1, "command is required")
  .max(128, "command is too long")
  .regex(
    COMMAND_OR_SUBCOMMAND_PATTERN_REGEX,
    "command must be '<command>' or '<command> <subcommand>'",
  );

const llmSchema = z
  .object({
    primaryModelIds: z.array(modelIdSchema).max(16, "too many primary model ids").default([]),
    fallbackModelIds: z.array(modelIdSchema).max(16, "too many fallback model ids").default([]),
  })
  .strict()
  .default({
    primaryModelIds: [],
    fallbackModelIds: [],
  });

const toolPolicySchema = z
  .object({
    allow: z.array(toolPatternSchema).max(128, "too many allow patterns").default([]),
    deny: z.array(toolPatternSchema).max(128, "too many deny patterns").default([]),
  })
  .strict()
  .default({
    allow: [],
    deny: [],
  });

const sandboxSchema = z
  .object({
    fsAllowedPaths: z.array(fsPathSchema).max(64, "too many file system paths").default([]),
    execAllowedCommands: z.array(commandSchema).max(128, "too many command patterns").default([]),
    maxTurns: z.number().int().min(1).max(200).default(20),
    maxSpawnDepth: z.number().int().min(1).max(8).default(3),
    timeoutMs: z.number().int().min(1_000).max(1_800_000).default(300_000),
  })
  .strict()
  .default({
    fsAllowedPaths: [],
    execAllowedCommands: [],
    maxTurns: 20,
    maxSpawnDepth: 3,
    timeoutMs: 300_000,
  });

const runtimeSchema = z
  .object({
    maxTokens: z.number().int().min(1).max(1_048_576).optional(),
  })
  .strict()
  .default({});

export const agentConfigSchema = z
  .object({
    specVersion: z.literal(AGENT_CONFIG_SPEC_VERSION).default(AGENT_CONFIG_SPEC_VERSION),
    llm: llmSchema,
    toolPolicy: toolPolicySchema,
    sandbox: sandboxSchema,
    runtime: runtimeSchema,
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;

function toValidationMessage(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      if (issue.code === "unrecognized_keys") {
        return `${path}: unrecognized keys: ${issue.keys.join(", ")}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function invalidAgentConfigError(message: string): Error & { code: string } {
  return Object.assign(new Error(`Invalid agent config: ${message}`), { code: "INVALID_ARGUMENT" });
}

function dedupeConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    llm: {
      primaryModelIds: [...new Set(config.llm.primaryModelIds)],
      fallbackModelIds: [...new Set(config.llm.fallbackModelIds)],
    },
    toolPolicy: {
      allow: [...new Set(config.toolPolicy.allow)],
      deny: [...new Set(config.toolPolicy.deny)],
    },
    sandbox: {
      ...config.sandbox,
      fsAllowedPaths: [...new Set(config.sandbox.fsAllowedPaths)],
      execAllowedCommands: [...new Set(config.sandbox.execAllowedCommands)],
    },
  };
}

export function getDefaultAgentConfig(): AgentConfig {
  return dedupeConfig(agentConfigSchema.parse({}));
}

export function parseAgentConfigObject(raw: unknown): AgentConfig {
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidAgentConfigError(toValidationMessage(parsed.error));
  }
  return dedupeConfig(parsed.data);
}

export function parseAgentConfigJson(raw: string | null | undefined): AgentConfig {
  const text = (raw ?? "").trim();
  if (!text) {
    return getDefaultAgentConfig();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw invalidAgentConfigError("json is malformed");
  }

  if (decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    throw invalidAgentConfigError("json root must be an object");
  }

  return parseAgentConfigObject(decoded);
}

export function normalizeAgentConfigJson(raw: string | null | undefined): string {
  return JSON.stringify(parseAgentConfigJson(raw));
}

export function normalizeAgentConfigObject(raw: unknown): string {
  return JSON.stringify(parseAgentConfigObject(raw));
}
