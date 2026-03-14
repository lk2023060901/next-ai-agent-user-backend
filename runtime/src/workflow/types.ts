// --- Workflow definition (matches gateway-side schema) ---

export type PinKind = 'exec' | 'data'
export type DataType = 'string' | 'number' | 'boolean' | 'json'
export type ContainerType = 'none' | 'array'
export type PinDirection = 'input' | 'output'

export interface PinDef {
  pinId: string
  label: string
  direction: PinDirection
  kind: PinKind
  valueType?: DataType
  containerType?: ContainerType
  required?: boolean
  multiLinks?: boolean
  defaultValue?: unknown
}

export interface PropertyDef {
  key: string
  label: string
  kind: string
  required?: boolean
  defaultValue?: unknown
}

export interface NodeTypeDef {
  typeId: string
  version?: number
  displayName?: string
  category: string
  description?: string
  icon?: string
  tags?: string[]
  inputs: PinDef[]
  outputs: PinDef[]
  properties: PropertyDef[]
  execution?: Record<string, unknown>
  schemaFlags?: Record<string, unknown>
}

// --- Workflow instance (from workflow definition JSON) ---

export interface DefinitionNode {
  id: string
  typeId: string
  version?: number
  properties?: Record<string, unknown>
}

export interface DefinitionConnection {
  id?: string
  sourceNodeId: string
  sourcePinId: string
  targetNodeId: string
  targetPinId: string
}

export interface WorkflowDefinition {
  specVersion?: string
  nodes: DefinitionNode[]
  connections: DefinitionConnection[]
}

// --- Execution state ---

export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'aborted'

export type NodeExecStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface PinValue {
  pinId: string
  value: unknown
}

export interface NodeState {
  nodeId: string
  status: NodeExecStatus
  inputs: PinValue[]
  outputs: PinValue[]
  error?: string
  startedAt?: number
  completedAt?: number
}

export interface Breakpoint {
  nodeId: string
  type: 'before' | 'after'
}

export interface RunState {
  runId: string
  workflowId: string
  workflowRevision: number | null
  status: RunStatus
  currentNodeId: string | null
  failedNodeId: string | null
  pausedAtNodeId: string | null
  pausedBreakpointType: Breakpoint['type'] | null
  errorMessage?: string
  nodeStates: Map<string, NodeState>
  variables: Map<string, unknown>
  breakpoints: Breakpoint[]
  startedAt: number
  completedAt?: number
}

// --- Execution events (streamed via SSE) ---

export type ExecEventType =
  | 'run.started'
  | 'run.completed'
  | 'run.failed'
  | 'run.paused'
  | 'run.aborted'
  | 'node.started'
  | 'node.completed'
  | 'node.failed'
  | 'node.skipped'
  | 'breakpoint.hit'
  | 'pin.value'

export interface ExecEvent {
  type: ExecEventType
  runId: string
  nodeId?: string
  pinId?: string
  data?: unknown
  timestamp: number
}

// --- Node executor interface ---

export interface NodeExecutorContext {
  nodeId: string
  properties: Record<string, unknown>
  getInput: (pinId: string) => unknown
  setOutput: (pinId: string, value: unknown) => void
  getVariable: (name: string) => unknown
  setVariable: (name: string, value: unknown) => void
}

export type NodeExecutor = (ctx: NodeExecutorContext) => Promise<string | void>
// Returns the pinId of the exec output to follow, or void for default (first exec output)
