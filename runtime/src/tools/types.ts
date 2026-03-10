import type { TSchema } from "@sinclair/typebox";
import type { ToolCategory, RiskLevel } from "./tool-types.js";

export type { ToolCategory, RiskLevel };

export interface RuntimeTool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  category: ToolCategory;
  riskLevel: RiskLevel;
  /** If true, the stream-loop will gate execution behind user approval. */
  requiresApproval?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, context: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  toolCallId: string;
  signal?: AbortSignal;
}
