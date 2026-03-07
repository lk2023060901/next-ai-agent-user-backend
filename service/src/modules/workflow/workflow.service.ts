import { asc, eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";

import { db } from "../../db";
import { workflows } from "../../db/schema";

export type PinDirection = "input" | "output";
export type PinKind = "exec" | "data";

export type ValueType =
  | "any"
  | "bool"
  | "int"
  | "float"
  | "number"
  | "string"
  | "json"
  | "audio"
  | "image"
  | "video"
  | `enum:${string}`;

export type NodeCategory =
  | "Agent"
  | "Event"
  | "ControlFlow"
  | "Transform"
  | "IndexTTS"
  | "ComfyUI"
  | "Custom";

export interface PinUiMeta {
  order?: number;
  color?: string;
  hidden?: boolean;
  orphaned?: boolean;
}

export interface PinDefinition {
  pinId: string;
  label: string;
  direction: PinDirection;
  kind: PinKind;
  valueType?: ValueType;
  required?: boolean;
  multiLinks?: boolean;
  defaultValue?: unknown;
  allowTypes?: ValueType[];
  denyTypes?: ValueType[];
  ui?: PinUiMeta;
}

export interface NodeTypeOption {
  label: string;
  value: string | number;
}

export interface PropertyDefinition {
  key: string;
  label: string;
  kind: "number" | "string" | "boolean" | "select" | "json" | "code";
  required?: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: NodeTypeOption[];
  validate?: string;
  helpText?: string;
}

export interface ExecutionPolicy {
  mode: "sync" | "async";
  retryable?: boolean;
  timeoutMs?: number;
}

export interface SchemaFlags {
  allowDynamicPins?: boolean;
}

export interface NodeTypeDefinition {
  typeId: string;
  version: number;
  displayName: string;
  category: NodeCategory;
  description?: string;
  icon?: string;
  tags?: string[];
  inputs: PinDefinition[];
  outputs: PinDefinition[];
  properties: PropertyDefinition[];
  execution: ExecutionPolicy;
  schemaFlags?: SchemaFlags;
}

export interface NodePinOverrides {
  inputs?: PinDefinition[];
  outputs?: PinDefinition[];
}

export interface WorkflowNodeInstance {
  nodeId: string;
  typeId: string;
  typeVersion: number;
  title: string;
  x: number;
  y: number;
  width?: number;
  collapsed?: boolean;
  pinOverrides?: NodePinOverrides;
  properties: Record<string, unknown>;
  metadata?: {
    indexNo?: number;
    notes?: string;
    legacyKind?: string;
    createdAt?: string;
    updatedAt?: string;
  };
}

export interface WorkflowEdge {
  edgeId: string;
  fromNodeId: string;
  fromPinId: string;
  toNodeId: string;
  toPinId: string;
  kind: PinKind;
  valueType?: ValueType;
  metadata?: {
    order?: number;
    createdAt?: string;
  };
}

export interface WorkflowLayout {
  zoom: number;
  panX: number;
  panY: number;
}

export interface WorkflowDefinition {
  workflowId: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: "draft" | "published" | "archived";
  specVersion: "wf.v1";
  revision: number;
  nodes: WorkflowNodeInstance[];
  edges: WorkflowEdge[];
  entryNodeId?: string;
  layout?: WorkflowLayout;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowValidationIssue {
  code: string;
  message: string;
  severity: "error" | "warning";
  nodeId?: string;
  pinId?: string;
  edgeId?: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
}

export interface LegacyBlueprintPort {
  id: string;
  type: "exec" | "data";
  direction: PinDirection;
  label: string;
  valueType?: ValueType;
  maxConnections?: number;
}

export interface LegacyBlueprintNodeData {
  kind: string;
  label: string;
  color?: string;
  inputs: LegacyBlueprintPort[];
  outputs: LegacyBlueprintPort[];
  [key: string]: unknown;
}

export interface LegacyBlueprintNodeEntry {
  id: string;
  kind: string;
  data: LegacyBlueprintNodeData;
  position: { x: number; y: number };
}

export interface LegacyBlueprintConnection {
  id: string;
  sourceNodeId: string;
  sourcePortId: string;
  targetNodeId: string;
  targetPortId: string;
  portType: "exec" | "data";
}

export interface LegacyBlueprintData {
  id: string;
  workspaceId: string;
  nodes: LegacyBlueprintNodeEntry[];
  connections: LegacyBlueprintConnection[];
  updatedAt: string;
}

const DEFAULT_WORKFLOW_NAME = "Default Workflow";

const LEGACY_KIND_TO_TYPE_ID: Record<string, string> = {
  agent: "agent.task",
  trigger: "event.trigger",
  condition: "control.branch",
  router: "control.router",
  merge: "control.merge",
  output: "utility.output",
  transform: "utility.transform",
  index_tts_pro: "indextts.pro",
  comfyui_save_video: "comfyui.save_video",
};

const TYPE_ID_TO_LEGACY_KIND: Record<string, string> = Object.fromEntries(
  Object.entries(LEGACY_KIND_TO_TYPE_ID).map(([k, v]) => [v, k]),
);

const NODE_TYPE_REGISTRY: NodeTypeDefinition[] = [
  {
    typeId: "agent.task",
    version: 2,
    displayName: "Agent",
    category: "Agent",
    description: "Run an AI agent task.",
    icon: "🤖",
    tags: ["agent", "task"],
    inputs: [
      { pinId: "exec_in", label: "Exec In", direction: "input", kind: "exec", multiLinks: false },
      { pinId: "agent_id", label: "Agent", direction: "input", kind: "data", valueType: "string" },
      { pinId: "in_string", label: "In String", direction: "input", kind: "data", valueType: "string" },
      {
        pinId: "message_in",
        label: "Message In",
        direction: "input",
        kind: "data",
        valueType: "string",
        ui: { hidden: true },
      },
      {
        pinId: "data_in",
        label: "Data In",
        direction: "input",
        kind: "data",
        valueType: "json",
        ui: { hidden: true },
      },
    ],
    outputs: [
      { pinId: "exec_out", label: "Exec Out", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "message_out", label: "Message Out", direction: "output", kind: "data", valueType: "string" },
      { pinId: "data_out", label: "Data Out", direction: "output", kind: "data", valueType: "json" },
    ],
    properties: [
      { key: "agentId", label: "Agent ID", kind: "string" },
      { key: "agentRole", label: "Agent Role", kind: "string" },
      { key: "agentModel", label: "Agent Model", kind: "string" },
      { key: "inString", label: "In String", kind: "string", defaultValue: "" },
    ],
    execution: { mode: "async", retryable: true, timeoutMs: 300000 },
  },
  {
    typeId: "event.trigger",
    version: 1,
    displayName: "Trigger",
    category: "Event",
    description: "Workflow entry trigger.",
    icon: "⚡",
    tags: ["entry", "trigger"],
    inputs: [],
    outputs: [
      { pinId: "exec_out", label: "Exec Out", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "message_out", label: "Message", direction: "output", kind: "data", valueType: "string" },
    ],
    properties: [
      {
        key: "triggerType",
        label: "Trigger Type",
        kind: "select",
        required: true,
        defaultValue: "manual",
        options: [
          { label: "Manual", value: "manual" },
          { label: "Message", value: "message" },
          { label: "Webhook", value: "webhook" },
          { label: "Cron", value: "cron" },
        ],
      },
    ],
    execution: { mode: "sync" },
  },
  {
    typeId: "control.branch",
    version: 1,
    displayName: "Branch",
    category: "ControlFlow",
    description: "Split execution based on condition.",
    icon: "🔀",
    tags: ["if", "branch"],
    inputs: [
      { pinId: "exec_in", label: "Exec In", direction: "input", kind: "exec", multiLinks: false },
      { pinId: "condition", label: "Condition", direction: "input", kind: "data", valueType: "bool", required: true },
    ],
    outputs: [
      { pinId: "exec_true", label: "True", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "exec_false", label: "False", direction: "output", kind: "exec", multiLinks: false },
    ],
    properties: [],
    execution: { mode: "sync" },
  },
  {
    typeId: "control.sequence",
    version: 1,
    displayName: "Sequence",
    category: "ControlFlow",
    description: "Fan-out execution in explicit ordered outputs.",
    icon: "📚",
    tags: ["sequence", "flow"],
    inputs: [{ pinId: "exec_in", label: "Exec In", direction: "input", kind: "exec", multiLinks: false }],
    outputs: [
      { pinId: "then_1", label: "Then 1", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "then_2", label: "Then 2", direction: "output", kind: "exec", multiLinks: false },
    ],
    properties: [],
    execution: { mode: "sync" },
    schemaFlags: { allowDynamicPins: true },
  },
  {
    typeId: "control.router",
    version: 1,
    displayName: "Router",
    category: "ControlFlow",
    description: "Route by strategy.",
    icon: "🧭",
    tags: ["router", "route"],
    inputs: [
      { pinId: "exec_in", label: "Exec In", direction: "input", kind: "exec", multiLinks: false },
      { pinId: "message_in", label: "Message In", direction: "input", kind: "data", valueType: "string" },
    ],
    outputs: [
      { pinId: "route_a", label: "Route A", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "route_b", label: "Route B", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "message_out", label: "Message Out", direction: "output", kind: "data", valueType: "string" },
    ],
    properties: [],
    execution: { mode: "sync" },
  },
  {
    typeId: "control.merge",
    version: 1,
    displayName: "Merge",
    category: "ControlFlow",
    description: "Merge multiple execution inputs.",
    icon: "🔗",
    tags: ["merge", "join"],
    inputs: [
      { pinId: "exec_a", label: "Exec A", direction: "input", kind: "exec", multiLinks: false },
      { pinId: "exec_b", label: "Exec B", direction: "input", kind: "exec", multiLinks: false },
    ],
    outputs: [{ pinId: "exec_out", label: "Exec Out", direction: "output", kind: "exec", multiLinks: false }],
    properties: [],
    execution: { mode: "sync" },
  },
  {
    typeId: "utility.output",
    version: 1,
    displayName: "Output",
    category: "Transform",
    description: "Terminal output node.",
    icon: "📤",
    tags: ["output"],
    inputs: [
      { pinId: "exec_in", label: "Exec In", direction: "input", kind: "exec", multiLinks: false },
      { pinId: "message_in", label: "Message In", direction: "input", kind: "data", valueType: "string" },
      { pinId: "data_in", label: "Data In", direction: "input", kind: "data", valueType: "json" },
    ],
    outputs: [],
    properties: [],
    execution: { mode: "sync" },
  },
  {
    typeId: "utility.transform",
    version: 1,
    displayName: "Transform",
    category: "Transform",
    description: "Transform payload.",
    icon: "🔄",
    tags: ["transform"],
    inputs: [{ pinId: "data_in", label: "Data In", direction: "input", kind: "data", valueType: "json" }],
    outputs: [{ pinId: "data_out", label: "Data Out", direction: "output", kind: "data", valueType: "json" }],
    properties: [
      {
        key: "transformType",
        label: "Transform Type",
        kind: "select",
        required: true,
        defaultValue: "passthrough",
        options: [
          { label: "Passthrough", value: "passthrough" },
          { label: "Map", value: "map" },
          { label: "Template", value: "template" },
        ],
      },
    ],
    execution: { mode: "sync" },
  },
  {
    typeId: "indextts.pro",
    version: 2,
    displayName: "Index TTS Pro",
    category: "IndexTTS",
    description: "IndexTTS multi-character synthesis.",
    icon: "🔊",
    tags: ["tts", "audio", "indextts"],
    inputs: [
      { pinId: "exec_in", label: "Exec In", direction: "input", kind: "exec", multiLinks: false },
      { pinId: "narrator_audio", label: "narrator_audio", direction: "input", kind: "data", valueType: "string" },
      { pinId: "character1_audio", label: "character1_audio", direction: "input", kind: "data", valueType: "string" },
    ],
    outputs: [
      { pinId: "exec_out", label: "Exec Out", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "audio", label: "audio", direction: "output", kind: "data", valueType: "audio" },
      { pinId: "seed", label: "seed", direction: "output", kind: "data", valueType: "int" },
      { pinId: "Subtitle", label: "Subtitle", direction: "output", kind: "data", valueType: "string" },
      { pinId: "SimplifiedSubtitle", label: "SimplifiedSubtitle", direction: "output", kind: "data", valueType: "string" },
    ],
    properties: [
      {
        key: "model_version",
        label: "Model Version",
        kind: "select",
        required: true,
        defaultValue: "Index-TTS",
        options: [{ label: "Index-TTS", value: "Index-TTS" }],
      },
      { key: "language", label: "Language", kind: "select", defaultValue: "auto", options: [{ label: "auto", value: "auto" }] },
      { key: "speed", label: "Speed", kind: "number", defaultValue: 1.0, min: 0.5, max: 2.0, step: 0.1 },
      { key: "seed", label: "Seed", kind: "number", defaultValue: 0, min: 0, max: 2147483647, step: 1 },
      {
        key: "control_after_generate",
        label: "Control After Generate",
        kind: "select",
        defaultValue: "randomize",
        options: [
          { label: "randomize", value: "randomize" },
          { label: "keep_seed", value: "keep_seed" },
        ],
      },
      { key: "temperature", label: "Temperature", kind: "number", defaultValue: 1.0, min: 0, max: 2, step: 0.1 },
      { key: "top_p", label: "Top P", kind: "number", defaultValue: 0.8, min: 0, max: 1, step: 0.01 },
      { key: "top_k", label: "Top K", kind: "number", defaultValue: 30, min: 1, max: 200, step: 1 },
      { key: "repetition_penalty", label: "Repetition Penalty", kind: "number", defaultValue: 10.0, min: 0, max: 20, step: 0.1 },
      { key: "length_penalty", label: "Length Penalty", kind: "number", defaultValue: 0.0, min: 0, max: 5, step: 0.1 },
      { key: "num_beams", label: "Num Beams", kind: "number", defaultValue: 3, min: 1, max: 10, step: 1 },
      { key: "max_mel_tokens", label: "Max Mel Tokens", kind: "number", defaultValue: 600, min: 64, max: 4096, step: 1 },
      { key: "text", label: "Text", kind: "string" },
      { key: "characterCount", label: "Character Count", kind: "number", defaultValue: 1, min: 1, max: 20, step: 1 },
    ],
    execution: { mode: "async", retryable: true, timeoutMs: 600000 },
    schemaFlags: { allowDynamicPins: true },
  },
  {
    typeId: "comfyui.save_video",
    version: 2,
    displayName: "Save Video",
    category: "ComfyUI",
    description: "ComfyUI Save Video node.",
    icon: "💾",
    tags: ["comfyui", "video"],
    inputs: [
      { pinId: "exec_in", label: "Exec In", direction: "input", kind: "exec", multiLinks: false },
      { pinId: "video", label: "video", direction: "input", kind: "data", valueType: "video", required: true },
      { pinId: "filename_prefix", label: "filename_prefix", direction: "input", kind: "data", valueType: "string" },
    ],
    outputs: [
      { pinId: "exec_out", label: "Exec Out", direction: "output", kind: "exec", multiLinks: false },
      { pinId: "video_url", label: "video_url", direction: "output", kind: "data", valueType: "string" },
    ],
    properties: [
      { key: "filename_prefix", label: "Filename Prefix", kind: "string", defaultValue: "video/ComfyUI" },
      { key: "format", label: "Format", kind: "select", defaultValue: "auto", options: [{ label: "auto", value: "auto" }] },
      { key: "codec", label: "Codec", kind: "select", defaultValue: "auto", options: [{ label: "auto", value: "auto" }] },
    ],
    execution: { mode: "async", retryable: true, timeoutMs: 600000 },
  },
];

const NODE_TYPE_MAP = new Map(NODE_TYPE_REGISTRY.map((nodeType) => [nodeType.typeId, nodeType]));

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeWorkflowStatus(status: string | undefined): WorkflowDefinition["status"] {
  if (status === "published" || status === "archived" || status === "draft") {
    return status;
  }
  return "draft";
}

function normalizePinDefinition(pin: Partial<PinDefinition>, fallbackDirection: PinDirection): PinDefinition | null {
  const pinId = String(pin.pinId ?? "").trim();
  if (!pinId) return null;

  const direction = pin.direction === "input" || pin.direction === "output"
    ? pin.direction
    : fallbackDirection;
  const kind = pin.kind === "exec" || pin.kind === "data" ? pin.kind : "data";
  const label = String(pin.label ?? pinId);
  const valueType = typeof pin.valueType === "string" ? pin.valueType : undefined;

  return {
    pinId,
    label,
    direction,
    kind,
    ...(valueType ? { valueType } : {}),
    ...(typeof pin.required === "boolean" ? { required: pin.required } : {}),
    ...(typeof pin.multiLinks === "boolean" ? { multiLinks: pin.multiLinks } : {}),
    ...(pin.defaultValue !== undefined ? { defaultValue: pin.defaultValue } : {}),
    ...(Array.isArray(pin.allowTypes) ? { allowTypes: pin.allowTypes.filter((item): item is ValueType => typeof item === "string") } : {}),
    ...(Array.isArray(pin.denyTypes) ? { denyTypes: pin.denyTypes.filter((item): item is ValueType => typeof item === "string") } : {}),
    ...(pin.ui && typeof pin.ui === "object" ? { ui: pin.ui as PinUiMeta } : {}),
  };
}

function normalizeNodePinOverrides(raw: unknown): NodePinOverrides | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as { inputs?: unknown; outputs?: unknown };

  const normalizeList = (listRaw: unknown, direction: PinDirection): PinDefinition[] | undefined => {
    if (!Array.isArray(listRaw)) return undefined;
    const out: PinDefinition[] = [];
    for (const item of listRaw) {
      if (!item || typeof item !== "object") continue;
      const normalized = normalizePinDefinition(item as Partial<PinDefinition>, direction);
      if (normalized) out.push(normalized);
    }
    return out;
  };

  const inputs = normalizeList(data.inputs, "input");
  const outputs = normalizeList(data.outputs, "output");

  if (!inputs && !outputs) return undefined;
  return {
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
  };
}

function normalizeWorkflowNode(raw: unknown): WorkflowNodeInstance | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const nodeId = String(data.nodeId ?? "").trim();
  const typeId = String(data.typeId ?? "").trim();
  const title = String(data.title ?? "").trim();
  const x = Number(data.x);
  const y = Number(data.y);

  if (!nodeId || !typeId || !title || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const typeVersionRaw = Number(data.typeVersion);
  const typeVersion = Number.isFinite(typeVersionRaw) && typeVersionRaw > 0 ? Math.floor(typeVersionRaw) : 1;

  const propertiesRaw = data.properties;
  const properties = propertiesRaw && typeof propertiesRaw === "object" && !Array.isArray(propertiesRaw)
    ? (propertiesRaw as Record<string, unknown>)
    : {};

  const metadataRaw = data.metadata;
  const metadata = metadataRaw && typeof metadataRaw === "object" && !Array.isArray(metadataRaw)
    ? (metadataRaw as WorkflowNodeInstance["metadata"])
    : undefined;

  const pinOverrides = normalizeNodePinOverrides(data.pinOverrides);

  return {
    nodeId,
    typeId,
    typeVersion,
    title,
    x,
    y,
    ...(typeof data.width === "number" ? { width: data.width } : {}),
    ...(typeof data.collapsed === "boolean" ? { collapsed: data.collapsed } : {}),
    ...(pinOverrides ? { pinOverrides } : {}),
    properties,
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeWorkflowEdge(raw: unknown): WorkflowEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const edgeId = String(data.edgeId ?? "").trim();
  const fromNodeId = String(data.fromNodeId ?? "").trim();
  const fromPinId = String(data.fromPinId ?? "").trim();
  const toNodeId = String(data.toNodeId ?? "").trim();
  const toPinId = String(data.toPinId ?? "").trim();
  const kind = data.kind === "exec" || data.kind === "data" ? data.kind : null;

  if (!edgeId || !fromNodeId || !fromPinId || !toNodeId || !toPinId || !kind) {
    return null;
  }

  const valueType = typeof data.valueType === "string" ? data.valueType : undefined;
  const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? (data.metadata as WorkflowEdge["metadata"])
    : undefined;

  return {
    edgeId,
    fromNodeId,
    fromPinId,
    toNodeId,
    toPinId,
    kind,
    ...(valueType ? { valueType: valueType as ValueType } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeWorkflowData(input: {
  name?: string;
  description?: string | null;
  status?: string;
  specVersion?: string;
  revision?: number;
  nodes?: unknown;
  edges?: unknown;
  entryNodeId?: string;
  layout?: unknown;
}): Omit<WorkflowDefinition, "workflowId" | "workspaceId" | "createdAt" | "updatedAt"> {
  const nodesRaw = Array.isArray(input.nodes) ? input.nodes : [];
  const edgesRaw = Array.isArray(input.edges) ? input.edges : [];

  const nodes = nodesRaw.map(normalizeWorkflowNode).filter((item): item is WorkflowNodeInstance => item !== null);
  const edges = edgesRaw.map(normalizeWorkflowEdge).filter((item): item is WorkflowEdge => item !== null);

  return {
    name: String(input.name ?? DEFAULT_WORKFLOW_NAME).trim() || DEFAULT_WORKFLOW_NAME,
    ...(input.description !== undefined ? { description: (input.description ?? "").trim() || undefined } : {}),
    status: normalizeWorkflowStatus(input.status),
    specVersion: "wf.v1",
    revision: Math.max(1, Math.floor(Number(input.revision ?? 1))),
    nodes,
    edges,
    ...(typeof input.entryNodeId === "string" && input.entryNodeId.trim().length > 0
      ? { entryNodeId: input.entryNodeId.trim() }
      : {}),
    ...(input.layout && typeof input.layout === "object" ? { layout: input.layout as WorkflowLayout } : {}),
  };
}

function parseWorkflowDataJson(dataJson: string): Omit<WorkflowDefinition, "workflowId" | "workspaceId" | "createdAt" | "updatedAt"> {
  const text = dataJson.trim();
  if (!text) {
    return normalizeWorkflowData({});
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("Invalid workflow JSON"), { code: "INVALID_ARGUMENT" });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Workflow JSON must be an object"), { code: "INVALID_ARGUMENT" });
  }

  return normalizeWorkflowData(parsed as Record<string, unknown>);
}

function serializeWorkflowData(workflow: Omit<WorkflowDefinition, "workflowId" | "workspaceId" | "createdAt" | "updatedAt">): string {
  return JSON.stringify({
    name: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    status: workflow.status,
    specVersion: workflow.specVersion,
    revision: workflow.revision,
    nodes: workflow.nodes,
    edges: workflow.edges,
    ...(workflow.entryNodeId ? { entryNodeId: workflow.entryNodeId } : {}),
    ...(workflow.layout ? { layout: workflow.layout } : {}),
  });
}

function rowToWorkflow(row: typeof workflows.$inferSelect): WorkflowDefinition {
  const parsed = parseWorkflowDataJson(row.dataJson);
  return {
    workflowId: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    status: normalizeWorkflowStatus(row.status),
    specVersion: "wf.v1",
    revision: row.revision,
    nodes: parsed.nodes,
    edges: parsed.edges,
    ...(parsed.entryNodeId ? { entryNodeId: parsed.entryNodeId } : {}),
    ...(parsed.layout ? { layout: parsed.layout } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function resolveNodePins(node: WorkflowNodeInstance): { inputs: PinDefinition[]; outputs: PinDefinition[] } {
  const definition = NODE_TYPE_MAP.get(node.typeId);
  const fallback = {
    inputs: [] as PinDefinition[],
    outputs: [] as PinDefinition[],
  };

  if (!definition && !node.pinOverrides) return fallback;

  const baseInputs = definition ? deepClone(definition.inputs) : [];
  const baseOutputs = definition ? deepClone(definition.outputs) : [];

  const overrideInputs = node.pinOverrides?.inputs;
  const overrideOutputs = node.pinOverrides?.outputs;

  return {
    inputs: overrideInputs && overrideInputs.length > 0 ? deepClone(overrideInputs) : baseInputs,
    outputs: overrideOutputs && overrideOutputs.length > 0 ? deepClone(overrideOutputs) : baseOutputs,
  };
}

function isValueTypeCompatible(sourceType: ValueType | undefined, targetType: ValueType | undefined): boolean {
  if (!sourceType || !targetType) return true;
  if (sourceType === "any" || targetType === "any") return true;
  if (sourceType === targetType) return true;

  const numberSet = new Set<ValueType>(["int", "float", "number"]);
  if (numberSet.has(sourceType) && numberSet.has(targetType)) return true;

  return false;
}

function isPinOrphaned(pin: PinDefinition): boolean {
  if (pin.ui?.orphaned === true) return true;
  const raw = pin as PinDefinition & { orphaned?: unknown };
  return raw.orphaned === true;
}

function resolveSourcePinLinkLimit(pin: PinDefinition): number {
  if (typeof pin.multiLinks === "boolean") {
    return pin.multiLinks ? Number.POSITIVE_INFINITY : 1;
  }
  // UE-like default semantics:
  // - Exec output: single
  // - Data output: multi
  if (pin.direction === "output" && pin.kind === "data") {
    return Number.POSITIVE_INFINITY;
  }
  return 1;
}

function resolveTargetPinLinkLimit(pin: PinDefinition): number {
  if (typeof pin.multiLinks === "boolean") {
    return pin.multiLinks ? Number.POSITIVE_INFINITY : 1;
  }
  // UE-like default semantics:
  // - Exec input: single
  // - Data input: single
  return 1;
}

function validatePropertyValue(
  node: WorkflowNodeInstance,
  property: PropertyDefinition,
  issues: WorkflowValidationIssue[],
) {
  const value = node.properties[property.key];
  if ((value === undefined || value === null || value === "") && property.required) {
    issues.push({
      code: "REQUIRED_PROPERTY_MISSING",
      message: `Required property missing: ${property.key}`,
      severity: "error",
      nodeId: node.nodeId,
    });
    return;
  }

  if (value === undefined || value === null || value === "") return;

  if (property.kind === "number") {
    const numericValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numericValue)) {
      issues.push({
        code: "INVALID_PROPERTY_TYPE",
        message: `Property ${property.key} must be numeric`,
        severity: "error",
        nodeId: node.nodeId,
      });
      return;
    }
    if (property.min !== undefined && numericValue < property.min) {
      issues.push({
        code: "PROPERTY_BELOW_MIN",
        message: `Property ${property.key} must be >= ${property.min}`,
        severity: "error",
        nodeId: node.nodeId,
      });
    }
    if (property.max !== undefined && numericValue > property.max) {
      issues.push({
        code: "PROPERTY_ABOVE_MAX",
        message: `Property ${property.key} must be <= ${property.max}`,
        severity: "error",
        nodeId: node.nodeId,
      });
    }
  }

  if (property.kind === "select" && Array.isArray(property.options) && property.options.length > 0) {
    const normalizedValue = String(value);
    const allowed = new Set(property.options.map((item) => String(item.value)));
    if (!allowed.has(normalizedValue)) {
      issues.push({
        code: "INVALID_PROPERTY_OPTION",
        message: `Property ${property.key} has unsupported option ${normalizedValue}`,
        severity: "error",
        nodeId: node.nodeId,
      });
    }
  }
}

function validateWorkflow(definition: {
  nodes: WorkflowNodeInstance[];
  edges: WorkflowEdge[];
}): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = [];

  const nodeById = new Map<string, WorkflowNodeInstance>();
  for (const node of definition.nodes) {
    if (nodeById.has(node.nodeId)) {
      issues.push({
        code: "DUPLICATE_NODE_ID",
        message: `Duplicate node id: ${node.nodeId}`,
        severity: "error",
        nodeId: node.nodeId,
      });
      continue;
    }
    nodeById.set(node.nodeId, node);

    const nodeType = NODE_TYPE_MAP.get(node.typeId);
    if (!nodeType) {
      issues.push({
        code: "UNKNOWN_NODE_TYPE",
        message: `Unknown node type: ${node.typeId}`,
        severity: "error",
        nodeId: node.nodeId,
      });
      continue;
    }

    for (const property of nodeType.properties) {
      validatePropertyValue(node, property, issues);
    }
  }

  const pinLookup = new Map<string, { nodeId: string; pin: PinDefinition }>();
  for (const node of definition.nodes) {
    const resolvedPins = resolveNodePins(node);
    for (const pin of [...resolvedPins.inputs, ...resolvedPins.outputs]) {
      const key = `${node.nodeId}::${pin.pinId}`;
      pinLookup.set(key, { nodeId: node.nodeId, pin });
    }
  }

  const edgeKeySet = new Set<string>();
  const sourcePinUsage = new Map<string, string[]>();
  const targetPinUsage = new Map<string, string[]>();

  for (const edge of definition.edges) {
    const duplicateEdgeKey = `${edge.fromNodeId}:${edge.fromPinId}->${edge.toNodeId}:${edge.toPinId}`;
    if (edgeKeySet.has(duplicateEdgeKey)) {
      issues.push({
        code: "DUPLICATE_EDGE",
        message: `Duplicate edge ${duplicateEdgeKey}`,
        severity: "error",
        edgeId: edge.edgeId,
      });
      continue;
    }
    edgeKeySet.add(duplicateEdgeKey);

    if (edge.fromNodeId === edge.toNodeId) {
      issues.push({
        code: "SELF_CONNECTION",
        message: "Self connection is not allowed",
        severity: "error",
        edgeId: edge.edgeId,
      });
      continue;
    }

    const sourceNode = nodeById.get(edge.fromNodeId);
    const targetNode = nodeById.get(edge.toNodeId);

    if (!sourceNode) {
      issues.push({
        code: "SOURCE_NODE_NOT_FOUND",
        message: `Source node not found: ${edge.fromNodeId}`,
        severity: "error",
        edgeId: edge.edgeId,
      });
      continue;
    }
    if (!targetNode) {
      issues.push({
        code: "TARGET_NODE_NOT_FOUND",
        message: `Target node not found: ${edge.toNodeId}`,
        severity: "error",
        edgeId: edge.edgeId,
      });
      continue;
    }

    const sourceRef = pinLookup.get(`${edge.fromNodeId}::${edge.fromPinId}`);
    const targetRef = pinLookup.get(`${edge.toNodeId}::${edge.toPinId}`);

    if (!sourceRef) {
      issues.push({
        code: "SOURCE_PIN_NOT_FOUND",
        message: `Source pin not found: ${edge.fromPinId}`,
        severity: "error",
        edgeId: edge.edgeId,
        nodeId: edge.fromNodeId,
        pinId: edge.fromPinId,
      });
      continue;
    }

    if (!targetRef) {
      issues.push({
        code: "TARGET_PIN_NOT_FOUND",
        message: `Target pin not found: ${edge.toPinId}`,
        severity: "error",
        edgeId: edge.edgeId,
        nodeId: edge.toNodeId,
        pinId: edge.toPinId,
      });
      continue;
    }

    if (sourceRef.pin.direction !== "output") {
      issues.push({
        code: "SOURCE_PIN_DIRECTION_INVALID",
        message: `Source pin ${edge.fromPinId} must be output`,
        severity: "error",
        edgeId: edge.edgeId,
        nodeId: edge.fromNodeId,
        pinId: edge.fromPinId,
      });
      continue;
    }

    if (targetRef.pin.direction !== "input") {
      issues.push({
        code: "TARGET_PIN_DIRECTION_INVALID",
        message: `Target pin ${edge.toPinId} must be input`,
        severity: "error",
        edgeId: edge.edgeId,
        nodeId: edge.toNodeId,
        pinId: edge.toPinId,
      });
      continue;
    }

    if (isPinOrphaned(sourceRef.pin)) {
      issues.push({
        code: "SOURCE_PIN_ORPHANED",
        message: `Source pin ${edge.fromPinId} is orphaned`,
        severity: "error",
        edgeId: edge.edgeId,
        nodeId: edge.fromNodeId,
        pinId: edge.fromPinId,
      });
      continue;
    }

    if (isPinOrphaned(targetRef.pin)) {
      issues.push({
        code: "TARGET_PIN_ORPHANED",
        message: `Target pin ${edge.toPinId} is orphaned`,
        severity: "error",
        edgeId: edge.edgeId,
        nodeId: edge.toNodeId,
        pinId: edge.toPinId,
      });
      continue;
    }

    if (sourceRef.pin.kind !== targetRef.pin.kind || sourceRef.pin.kind !== edge.kind) {
      issues.push({
        code: "PIN_KIND_MISMATCH",
        message: `Pin kind mismatch for edge ${edge.edgeId}`,
        severity: "error",
        edgeId: edge.edgeId,
      });
      continue;
    }

    if (edge.kind === "data") {
      if (!isValueTypeCompatible(sourceRef.pin.valueType, targetRef.pin.valueType)) {
        issues.push({
          code: "DATA_TYPE_MISMATCH",
          message: `Data type mismatch ${String(sourceRef.pin.valueType ?? "any")} -> ${String(targetRef.pin.valueType ?? "any")}`,
          severity: "error",
          edgeId: edge.edgeId,
        });
      }

      if (Array.isArray(targetRef.pin.allowTypes) && targetRef.pin.allowTypes.length > 0) {
        const actual = (sourceRef.pin.valueType ?? "any") as ValueType;
        if (!targetRef.pin.allowTypes.includes(actual)) {
          issues.push({
            code: "TARGET_ALLOW_TYPES_VIOLATION",
            message: `Target pin ${edge.toPinId} does not allow ${actual}`,
            severity: "error",
            edgeId: edge.edgeId,
          });
        }
      }

      if (Array.isArray(targetRef.pin.denyTypes) && targetRef.pin.denyTypes.length > 0) {
        const actual = (sourceRef.pin.valueType ?? "any") as ValueType;
        if (targetRef.pin.denyTypes.includes(actual)) {
          issues.push({
            code: "TARGET_DENY_TYPES_VIOLATION",
            message: `Target pin ${edge.toPinId} denies ${actual}`,
            severity: "error",
            edgeId: edge.edgeId,
          });
        }
      }
    }

    const sourceUsageKey = `${edge.fromNodeId}::${edge.fromPinId}`;
    const targetUsageKey = `${edge.toNodeId}::${edge.toPinId}`;

    const sourceEdges = sourcePinUsage.get(sourceUsageKey) ?? [];
    sourceEdges.push(edge.edgeId);
    sourcePinUsage.set(sourceUsageKey, sourceEdges);

    const targetEdges = targetPinUsage.get(targetUsageKey) ?? [];
    targetEdges.push(edge.edgeId);
    targetPinUsage.set(targetUsageKey, targetEdges);
  }

  for (const [key, edges] of sourcePinUsage.entries()) {
    const sourceRef = pinLookup.get(key);
    if (!sourceRef) continue;
    const maxAllowed = resolveSourcePinLinkLimit(sourceRef.pin);
    if (edges.length > maxAllowed) {
      issues.push({
        code: "SOURCE_PIN_LINK_LIMIT_EXCEEDED",
        message: `Source pin ${sourceRef.pin.pinId} exceeded link limit (${maxAllowed})`,
        severity: "error",
        nodeId: sourceRef.nodeId,
        pinId: sourceRef.pin.pinId,
      });
    }
  }

  for (const [key, edges] of targetPinUsage.entries()) {
    const targetRef = pinLookup.get(key);
    if (!targetRef) continue;
    const maxAllowed = resolveTargetPinLinkLimit(targetRef.pin);
    if (edges.length > maxAllowed) {
      issues.push({
        code: "TARGET_PIN_LINK_LIMIT_EXCEEDED",
        message: `Target pin ${targetRef.pin.pinId} exceeded link limit (${maxAllowed})`,
        severity: "error",
        nodeId: targetRef.nodeId,
        pinId: targetRef.pin.pinId,
      });
    }
  }

  return {
    valid: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}

function assertWorkflowValid(definition: { nodes: WorkflowNodeInstance[]; edges: WorkflowEdge[] }) {
  const validation = validateWorkflow(definition);
  if (!validation.valid) {
    const first = validation.issues.find((issue) => issue.severity === "error");
    throw Object.assign(new Error(first?.message ?? "Invalid workflow definition"), {
      code: "INVALID_ARGUMENT",
      details: validation.issues,
    });
  }
}

function isWorkflowNameConflictError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null ? String((err as { code?: unknown }).code ?? "") : "";
  if (code === "SQLITE_CONSTRAINT" || code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }

  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("UNIQUE constraint failed: workflows.workspace_id, workflows.name") ||
    message.includes("workflows_workspace_name_uq")
  );
}

function parseRowJson(row: typeof workflows.$inferSelect): Omit<WorkflowDefinition, "workflowId" | "workspaceId" | "createdAt" | "updatedAt"> {
  return parseWorkflowDataJson(row.dataJson);
}

function getWorkflowRow(workflowId: string): typeof workflows.$inferSelect {
  const row = db.select().from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!row) {
    throw Object.assign(new Error("Workflow not found"), { code: "NOT_FOUND" });
  }
  return row;
}

function ensureDefaultWorkflow(workspaceId: string): typeof workflows.$inferSelect {
  const existingRows = db
    .select()
    .from(workflows)
    .where(eq(workflows.workspaceId, workspaceId))
    .orderBy(asc(workflows.createdAt))
    .all();

  // Legacy blueprint should bind to an existing workflow in this workspace.
  // Do not require a fixed "Default Workflow" name, otherwise renaming that row
  // would create a second default row on the next blueprint read/save.
  if (existingRows.length > 0) {
    const namedDefault = existingRows.find((row) => row.name === DEFAULT_WORKFLOW_NAME);
    if (namedDefault) return namedDefault;

    const active = existingRows.find((row) => normalizeWorkflowStatus(row.status) !== "archived");
    if (active) return active;

    return existingRows[0];
  }

  const id = uuidv4();
  const at = nowIso();
  const initialData = normalizeWorkflowData({
    name: DEFAULT_WORKFLOW_NAME,
    nodes: [],
    edges: [],
    status: "draft",
    revision: 1,
  });

  db.insert(workflows)
    .values({
      id,
      workspaceId,
      name: DEFAULT_WORKFLOW_NAME,
      description: null,
      status: "draft",
      specVersion: "wf.v1",
      revision: 1,
      dataJson: serializeWorkflowData(initialData),
      createdAt: at,
      updatedAt: at,
    })
    .run();

  return getWorkflowRow(id);
}

function toLegacyPort(pin: PinDefinition): LegacyBlueprintPort {
  return {
    id: pin.pinId,
    type: pin.kind,
    direction: pin.direction,
    label: pin.label,
    ...(typeof pin.valueType === "string" ? { valueType: pin.valueType } : {}),
    ...(pin.multiLinks === false ? { maxConnections: 1 } : {}),
  };
}

function fromLegacyPort(port: LegacyBlueprintPort): PinDefinition {
  return {
    pinId: port.id,
    label: port.label,
    direction: port.direction,
    kind: port.type,
    ...(typeof port.valueType === "string" ? { valueType: port.valueType } : {}),
    ...(typeof port.maxConnections === "number" ? { multiLinks: port.maxConnections !== 1 } : {}),
  };
}

function toWorkflowNodeEntry(node: LegacyBlueprintNodeEntry): WorkflowNodeInstance {
  const typeId = LEGACY_KIND_TO_TYPE_ID[node.kind] ?? "custom.unknown";
  const { inputs: _inputs, outputs: _outputs, kind: _kind, label: _label, ...properties } = node.data;
  const normalizedProperties: Record<string, unknown> = { ...properties };

  if (node.kind === "index_tts_pro") {
    const indexTtsParams = Array.isArray(node.data.indexTtsParams)
      ? node.data.indexTtsParams
      : [];
    for (const item of indexTtsParams) {
      if (!item || typeof item !== "object") continue;
      const key = typeof (item as { key?: unknown }).key === "string"
        ? String((item as { key?: unknown }).key).trim()
        : "";
      if (!key) continue;
      const valueRaw = (item as { value?: unknown }).value;
      if (valueRaw === undefined || valueRaw === null) continue;
      normalizedProperties[key] = String(valueRaw);
    }

    if (typeof node.data.indexTtsText === "string") {
      normalizedProperties.text = node.data.indexTtsText;
    }
    if (typeof node.data.indexTtsCharacterCount === "number" && Number.isFinite(node.data.indexTtsCharacterCount)) {
      normalizedProperties.characterCount = Math.max(1, Math.floor(node.data.indexTtsCharacterCount));
    }
  }

  if (node.kind === "comfyui_save_video") {
    const comfyParams = Array.isArray(node.data.comfyParams)
      ? node.data.comfyParams
      : [];
    for (const item of comfyParams) {
      if (!item || typeof item !== "object") continue;
      const key = typeof (item as { key?: unknown }).key === "string"
        ? String((item as { key?: unknown }).key).trim()
        : "";
      if (!key) continue;
      const valueRaw = (item as { value?: unknown }).value;
      if (valueRaw === undefined || valueRaw === null) continue;
      normalizedProperties[key] = String(valueRaw);
    }

    if (typeof node.data.comfyFilenamePrefix === "string") {
      normalizedProperties.filename_prefix = node.data.comfyFilenamePrefix;
    }
  }

  return {
    nodeId: node.id,
    typeId,
    typeVersion: NODE_TYPE_MAP.get(typeId)?.version ?? 1,
    title: String(node.data.label ?? node.kind),
    x: Number(node.position?.x ?? 0),
    y: Number(node.position?.y ?? 0),
    properties: normalizedProperties,
    pinOverrides: {
      inputs: Array.isArray(node.data.inputs) ? node.data.inputs.map(fromLegacyPort) : [],
      outputs: Array.isArray(node.data.outputs) ? node.data.outputs.map(fromLegacyPort) : [],
    },
    metadata: {
      legacyKind: node.kind,
    },
  };
}

function toLegacyNodeEntry(node: WorkflowNodeInstance): LegacyBlueprintNodeEntry {
  const pins = resolveNodePins(node);
  const visibleInputs = pins.inputs.filter((pin) => pin.ui?.hidden !== true);
  const visibleOutputs = pins.outputs.filter((pin) => pin.ui?.hidden !== true);
  const legacyKind = node.metadata?.legacyKind || TYPE_ID_TO_LEGACY_KIND[node.typeId] || "agent";
  const properties = { ...node.properties };

  if (legacyKind === "index_tts_pro") {
    const nodeType = NODE_TYPE_MAP.get(node.typeId);
    const paramKeys = (nodeType?.properties ?? [])
      .map((item) => item.key)
      .filter((key) => key !== "text" && key !== "characterCount");

    const indexTtsParams = paramKeys
      .map((key) => {
        const value = properties[key];
        if (value === undefined || value === null) return null;
        return { key, value: String(value) };
      })
      .filter((item): item is { key: string; value: string } => item !== null);

    if (indexTtsParams.length > 0) {
      properties.indexTtsParams = indexTtsParams;
    }
    if (typeof properties.text === "string") {
      properties.indexTtsText = properties.text;
    }
    if (typeof properties.characterCount === "number" && Number.isFinite(properties.characterCount)) {
      properties.indexTtsCharacterCount = Math.max(1, Math.floor(properties.characterCount));
    }
  }

  if (legacyKind === "comfyui_save_video") {
    const nodeType = NODE_TYPE_MAP.get(node.typeId);
    const paramKeys = (nodeType?.properties ?? [])
      .map((item) => item.key)
      .filter((key) => key !== "filename_prefix");

    const comfyParams = paramKeys
      .map((key) => {
        const value = properties[key];
        if (value === undefined || value === null) return null;
        return { key, value: String(value) };
      })
      .filter((item): item is { key: string; value: string } => item !== null);

    if (comfyParams.length > 0) {
      properties.comfyParams = comfyParams;
    }
    if (typeof properties.filename_prefix === "string") {
      properties.comfyFilenamePrefix = properties.filename_prefix;
    }
  }

  return {
    id: node.nodeId,
    kind: legacyKind,
    position: { x: node.x, y: node.y },
    data: {
      kind: legacyKind,
      label: node.title,
      ...(typeof properties.color === "string" ? { color: properties.color } : {}),
      inputs: visibleInputs.map(toLegacyPort),
      outputs: visibleOutputs.map(toLegacyPort),
      ...properties,
    },
  };
}

function toWorkflowEdge(conn: LegacyBlueprintConnection): WorkflowEdge {
  return {
    edgeId: conn.id,
    fromNodeId: conn.sourceNodeId,
    fromPinId: conn.sourcePortId,
    toNodeId: conn.targetNodeId,
    toPinId: conn.targetPortId,
    kind: conn.portType,
  };
}

function toLegacyConnection(edge: WorkflowEdge): LegacyBlueprintConnection {
  return {
    id: edge.edgeId,
    sourceNodeId: edge.fromNodeId,
    sourcePortId: edge.fromPinId,
    targetNodeId: edge.toNodeId,
    targetPortId: edge.toPinId,
    portType: edge.kind,
  };
}

export function listNodeTypes(): NodeTypeDefinition[] {
  return deepClone(NODE_TYPE_REGISTRY);
}

export function getLegacyKindByTypeId(typeId: string): string | undefined {
  const normalized = typeId.trim();
  if (!normalized) return undefined;
  return TYPE_ID_TO_LEGACY_KIND[normalized];
}

export function listWorkflows(workspaceId: string): WorkflowDefinition[] {
  const rows = db
    .select()
    .from(workflows)
    .where(eq(workflows.workspaceId, workspaceId))
    .all();
  return rows.map(rowToWorkflow);
}

export function createWorkflow(input: {
  workspaceId: string;
  name?: string;
  description?: string;
  status?: string;
  dataJson?: string;
}): WorkflowDefinition {
  const at = nowIso();
  const id = uuidv4();

  const normalized = input.dataJson
    ? parseWorkflowDataJson(input.dataJson)
    : normalizeWorkflowData({
        name: input.name,
        description: input.description,
        status: input.status,
        nodes: [],
        edges: [],
      });

  normalized.name = (input.name ?? normalized.name).trim() || normalized.name;
  if (input.description !== undefined) {
    normalized.description = input.description.trim() || undefined;
  }
  normalized.status = normalizeWorkflowStatus(input.status ?? normalized.status);
  normalized.revision = 1;

  assertWorkflowValid({ nodes: normalized.nodes, edges: normalized.edges });

  try {
    db.insert(workflows)
      .values({
        id,
        workspaceId: input.workspaceId,
        name: normalized.name,
        description: normalized.description ?? null,
        status: normalized.status,
        specVersion: normalized.specVersion,
        revision: 1,
        dataJson: serializeWorkflowData(normalized),
        createdAt: at,
        updatedAt: at,
      })
      .run();
  } catch (err) {
    if (isWorkflowNameConflictError(err)) {
      throw Object.assign(new Error("Workflow name already exists"), { code: "ALREADY_EXISTS" });
    }
    throw err;
  }

  return rowToWorkflow(getWorkflowRow(id));
}

export function getWorkflow(workflowId: string): WorkflowDefinition {
  return rowToWorkflow(getWorkflowRow(workflowId));
}

export function updateWorkflow(input: {
  workflowId: string;
  name?: string;
  description?: string | null;
  status?: string;
  revision?: number;
  dataJson?: string;
}): WorkflowDefinition {
  const row = getWorkflowRow(input.workflowId);
  const parsedCurrent = parseRowJson(row);

  if (input.revision !== undefined && input.revision !== row.revision) {
    throw Object.assign(new Error("Workflow revision conflict"), { code: "ALREADY_EXISTS" });
  }

  const parsedNext = input.dataJson ? parseWorkflowDataJson(input.dataJson) : parsedCurrent;

  const nextName = input.name !== undefined ? input.name.trim() : row.name;
  if (!nextName) {
    throw Object.assign(new Error("Workflow name is required"), { code: "INVALID_ARGUMENT" });
  }

  const nextDescription = input.description !== undefined
    ? (input.description ?? "").trim() || null
    : row.description;

  const nextStatus = normalizeWorkflowStatus(input.status ?? row.status);
  const nextRevision = row.revision + 1;

  const normalized = normalizeWorkflowData({
    ...parsedNext,
    name: nextName,
    description: nextDescription ?? undefined,
    status: nextStatus,
    revision: nextRevision,
  });

  // Only re-validate when workflow data is actually changing.
  // Metadata-only updates (name, description, status) should not be blocked
  // by pre-existing validation issues in the workflow definition.
  if (input.dataJson) {
    assertWorkflowValid({ nodes: normalized.nodes, edges: normalized.edges });
  }

  try {
    db.update(workflows)
      .set({
        name: normalized.name,
        description: normalized.description ?? null,
        status: normalized.status,
        revision: nextRevision,
        dataJson: serializeWorkflowData(normalized),
        updatedAt: nowIso(),
      })
      .where(eq(workflows.id, row.id))
      .run();
  } catch (err) {
    if (isWorkflowNameConflictError(err)) {
      throw Object.assign(new Error("Workflow name already exists"), { code: "ALREADY_EXISTS" });
    }
    throw err;
  }

  return rowToWorkflow(getWorkflowRow(row.id));
}

export function validateWorkflowById(workflowId: string): WorkflowValidationResult {
  const workflow = getWorkflow(workflowId);
  return validateWorkflow({ nodes: workflow.nodes, edges: workflow.edges });
}

export function validateWorkflowDataJson(dataJson: string): WorkflowValidationResult {
  const parsed = parseWorkflowDataJson(dataJson);
  return validateWorkflow({ nodes: parsed.nodes, edges: parsed.edges });
}

export function getLegacyBlueprint(workspaceId: string): LegacyBlueprintData {
  const row = ensureDefaultWorkflow(workspaceId);
  const workflow = rowToWorkflow(row);

  return {
    id: workflow.workflowId,
    workspaceId,
    nodes: workflow.nodes.map(toLegacyNodeEntry),
    connections: workflow.edges.map(toLegacyConnection),
    updatedAt: workflow.updatedAt,
  };
}

function resolveLegacyBlueprintRow(input: { workspaceId: string; workflowId?: string }): typeof workflows.$inferSelect {
  const workflowId = String(input.workflowId ?? "").trim();
  if (!workflowId) {
    return ensureDefaultWorkflow(input.workspaceId);
  }

  const row = getWorkflowRow(workflowId);
  if (row.workspaceId !== input.workspaceId) {
    throw Object.assign(new Error("Workflow not found"), { code: "NOT_FOUND" });
  }
  return row;
}

export function getLegacyBlueprintByWorkflow(input: {
  workspaceId: string;
  workflowId?: string;
}): LegacyBlueprintData {
  const row = resolveLegacyBlueprintRow(input);
  const workflow = rowToWorkflow(row);

  return {
    id: workflow.workflowId,
    workspaceId: workflow.workspaceId,
    nodes: workflow.nodes.map(toLegacyNodeEntry),
    connections: workflow.edges.map(toLegacyConnection),
    updatedAt: workflow.updatedAt,
  };
}

export function saveLegacyBlueprint(input: {
  workspaceId: string;
  workflowId?: string;
  nodes: LegacyBlueprintNodeEntry[];
  connections: LegacyBlueprintConnection[];
}): LegacyBlueprintData {
  const row = resolveLegacyBlueprintRow({
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
  });
  const nextNodes = input.nodes.map(toWorkflowNodeEntry);
  const nextEdges = input.connections.map(toWorkflowEdge);

  const nextRevision = row.revision + 1;
  const payload = normalizeWorkflowData({
    name: row.name,
    description: row.description ?? undefined,
    status: row.status,
    revision: nextRevision,
    nodes: nextNodes,
    edges: nextEdges,
  });

  db.update(workflows)
    .set({
      revision: nextRevision,
      dataJson: serializeWorkflowData(payload),
      updatedAt: nowIso(),
    })
    .where(eq(workflows.id, row.id))
    .run();

  return getLegacyBlueprintByWorkflow({
    workspaceId: input.workspaceId,
    workflowId: row.id,
  });
}
