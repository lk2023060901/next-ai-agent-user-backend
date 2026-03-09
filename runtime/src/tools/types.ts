import type { TSchema } from "@sinclair/typebox";

export interface RuntimeTool<T extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute: (args: any, context: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  toolCallId: string;
  signal?: AbortSignal;
}
