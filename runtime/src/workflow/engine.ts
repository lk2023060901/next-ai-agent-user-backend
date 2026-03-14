import type {
  WorkflowDefinition,
  DefinitionNode,
  RunState,
  NodeState,
  ExecEvent,
  Breakpoint,
  NodeExecutorContext,
} from './types.js'
import { getExecutor } from './executor-registry.js'

export class WorkflowEngine {
  private definition: WorkflowDefinition
  private state: RunState
  private eventListeners: ((event: ExecEvent) => void)[] = []
  private pausePromise: { resolve: () => void; promise: Promise<void> } | null = null
  private aborted = false
  private stepMode = false

  constructor(
    runId: string,
    workflowId: string,
    definition: WorkflowDefinition,
    breakpoints: Breakpoint[] = [],
    workflowRevision: number | null = null,
  ) {
    this.definition = definition
    this.state = {
      runId,
      workflowId,
      workflowRevision,
      status: 'pending',
      currentNodeId: null,
      failedNodeId: null,
      pausedAtNodeId: null,
      pausedBreakpointType: null,
      nodeStates: new Map(),
      variables: new Map(),
      breakpoints,
      startedAt: Date.now(),
    }
  }

  // --- Event system ---

  onEvent(listener: (event: ExecEvent) => void) {
    this.eventListeners.push(listener)
  }

  private emit(event: Omit<ExecEvent, 'runId' | 'timestamp'>) {
    const full: ExecEvent = { ...event, runId: this.state.runId, timestamp: Date.now() }
    for (const l of this.eventListeners) {
      l(full)
    }
  }

  // --- Control ---

  async run(): Promise<RunState> {
    this.state.status = 'running'
    this.emit({ type: 'run.started' })

    try {
      this.state.errorMessage = undefined
      this.state.failedNodeId = null
      // Find start nodes: nodes with no exec input connections
      const startNodes = this.findStartNodes()
      if (startNodes.length === 0) {
        throw new Error('No start node found')
      }

      for (const startNode of startNodes) {
        await this.executeFrom(startNode.id)
        if (this.aborted) break
      }

      if (this.aborted) {
        this.state.status = 'aborted'
        this.emit({ type: 'run.aborted' })
      } else {
        this.state.status = 'completed'
        this.state.completedAt = Date.now()
        this.emit({ type: 'run.completed' })
      }
    } catch (err) {
      this.state.status = 'failed'
      this.state.completedAt = Date.now()
      this.state.errorMessage = normalizeErrorMessage(err)
      this.emit({
        type: 'run.failed',
        nodeId: this.state.failedNodeId ?? undefined,
        data: { error: this.state.errorMessage },
      })
    }

    return this.state
  }

  resume() {
    if (this.state.status === 'paused') {
      this.state.status = 'running'
      this.state.pausedAtNodeId = null
      this.state.pausedBreakpointType = null
    }
    if (this.pausePromise) {
      this.pausePromise.resolve()
      this.pausePromise = null
    }
  }

  async step(): Promise<void> {
    // Resume but pause again before the next node
    this.stepMode = true
    this.resume()
  }

  abort() {
    this.aborted = true
    this.resume() // unblock if paused
  }

  getState(): RunState {
    return this.state
  }

  getNodeState(nodeId: string): NodeState | undefined {
    return this.state.nodeStates.get(nodeId)
  }

  // --- Execution ---

  private async executeFrom(nodeId: string): Promise<void> {
    if (this.aborted) return

    const node = this.definition.nodes.find(n => n.id === nodeId)
    if (!node) return
    if (node.typeId === 'comment') return // skip comments

    const nodeState: NodeState = {
      nodeId,
      status: 'running',
      inputs: [],
      outputs: [],
      startedAt: Date.now(),
    }
    this.state.nodeStates.set(nodeId, nodeState)
    this.state.currentNodeId = nodeId
    this.emit({ type: 'node.started', nodeId })

    // Resolve data inputs and emit their values
    this.resolveInputs(nodeId, nodeState)
    for (const pv of nodeState.inputs) {
      this.emit({ type: 'pin.value', nodeId, pinId: pv.pinId, data: pv.value })
    }

    // Pause after preparing the pending node so the debugger can inspect inputs.
    await this.checkBreakpoint(nodeId, 'before')
    if (this.aborted) return

    // Get executor
    const executor = getExecutor(node.typeId)
    if (!executor) {
      nodeState.status = 'failed'
      nodeState.error = `No executor for node type: ${node.typeId}`
      nodeState.completedAt = Date.now()
      this.emit({ type: 'node.failed', nodeId, data: { error: nodeState.error } })
      this.failRunAtNode(nodeId, nodeState.error)
    }

    // Handle loop node specially
    if (node.typeId === 'loop') {
      await this.executeLoop(node, nodeState)
      return
    }

    let nextExecPinId: string | void
    try {
      const ctx = this.buildContext(node, nodeState)
      nextExecPinId = await executor(ctx)

      nodeState.status = 'completed'
      nodeState.completedAt = Date.now()

      // Emit output pin values
      for (const pv of nodeState.outputs) {
        this.emit({ type: 'pin.value', nodeId, pinId: pv.pinId, data: pv.value })
      }
      this.emit({ type: 'node.completed', nodeId })

      // Check breakpoint (after)
      await this.checkBreakpoint(nodeId, 'after')
    } catch (err) {
      nodeState.status = 'failed'
      nodeState.error = normalizeErrorMessage(err)
      nodeState.completedAt = Date.now()
      this.emit({ type: 'node.failed', nodeId, data: { error: nodeState.error } })
      this.failRunAtNode(nodeId, nodeState.error)
    }

    // Follow exec output after the current node has succeeded.
    if (nextExecPinId) {
      const nextNodeId = this.findTargetNode(nodeId, nextExecPinId)
      if (nextNodeId) {
        await this.executeFrom(nextNodeId)
      }
    }
  }

  private async executeLoop(node: DefinitionNode, nodeState: NodeState): Promise<void> {
    const items = this.resolveDataInput(node.id, 'items')
    if (!Array.isArray(items)) {
      nodeState.status = 'failed'
      nodeState.error = 'Loop items is not an array'
      nodeState.completedAt = Date.now()
      this.emit({ type: 'node.failed', nodeId: node.id, data: { error: nodeState.error } })
      this.failRunAtNode(node.id, nodeState.error)
    }

    for (let i = 0; i < items.length; i++) {
      if (this.aborted) return

      // Set loop item/index as outputs
      const itemPV = { pinId: 'item', value: items[i] }
      const indexPV = { pinId: 'index', value: i }
      nodeState.outputs = [itemPV, indexPV]

      this.emit({ type: 'pin.value', nodeId: node.id, pinId: 'item', data: items[i] })
      this.emit({ type: 'pin.value', nodeId: node.id, pinId: 'index', data: i })

      // Execute loop body
      const bodyTargetId = this.findTargetNode(node.id, 'exec_body')
      if (bodyTargetId) {
        await this.executeFrom(bodyTargetId)
      }
    }

    nodeState.status = 'completed'
    nodeState.completedAt = Date.now()
    this.emit({ type: 'node.completed', nodeId: node.id })

    // Follow exec_done
    const doneTargetId = this.findTargetNode(node.id, 'exec_done')
    if (doneTargetId) {
      await this.executeFrom(doneTargetId)
    }
  }

  // --- Breakpoint handling ---

  private async checkBreakpoint(nodeId: string, type: 'before' | 'after'): Promise<void> {
    const hasBP = this.state.breakpoints.some(bp => bp.nodeId === nodeId && bp.type === type)
    // Step mode only triggers on 'before' — it means "run one node then pause before the next"
    const isStep = this.stepMode && type === 'before'

    if (!hasBP && !isStep) return

    // Clear step mode (one-shot)
    if (isStep) this.stepMode = false

    this.state.status = 'paused'
    this.state.pausedAtNodeId = nodeId
    this.state.pausedBreakpointType = type
    this.emit({ type: 'run.paused', nodeId, data: { breakpointType: type } })
    this.emit({ type: 'breakpoint.hit', nodeId, data: { breakpointType: type } })

    // Wait for resume/step/abort
    await new Promise<void>(resolve => {
      this.pausePromise = { resolve, promise: Promise.resolve() }
    })

    if (!this.aborted) {
      this.state.status = 'running'
      this.state.pausedAtNodeId = null
      this.state.pausedBreakpointType = null
    }
  }

  // --- Data resolution ---

  private resolveInputs(nodeId: string, nodeState: NodeState): void {
    const incomingDataEdges = this.definition.connections.filter(
      e => e.targetNodeId === nodeId && !this.isExecPin(e.targetPinId)
    )
    for (const edge of incomingDataEdges) {
      const value = this.getOutputValue(edge.sourceNodeId, edge.sourcePinId)
      nodeState.inputs.push({ pinId: edge.targetPinId, value })
    }
  }

  private resolveDataInput(nodeId: string, pinId: string): unknown {
    const edge = this.definition.connections.find(e => e.targetNodeId === nodeId && e.targetPinId === pinId)
    if (!edge) return undefined
    return this.getOutputValue(edge.sourceNodeId, edge.sourcePinId)
  }

  private getOutputValue(nodeId: string, pinId: string): unknown {
    // If the source node is a pure data node (no exec), execute it on demand
    const sourceNode = this.definition.nodes.find(n => n.id === nodeId)
    if (sourceNode) {
      const existing = this.state.nodeStates.get(nodeId)
      if (!existing || existing.status === 'pending') {
        // Synchronously check if it's a data-only node (variable-get)
        const executor = getExecutor(sourceNode.typeId)
        if (executor && !this.hasExecInput(nodeId)) {
          const ns: NodeState = { nodeId, status: 'running', inputs: [], outputs: [], startedAt: Date.now() }
          this.state.nodeStates.set(nodeId, ns)
          const ctx = this.buildContext(sourceNode, ns)
          // Run synchronously for data nodes
          executor(ctx).then(() => { ns.status = 'completed'; ns.completedAt = Date.now() })
        }
      }
    }

    const state = this.state.nodeStates.get(nodeId)
    if (!state) return undefined
    const pv = state.outputs.find(o => o.pinId === pinId)
    return pv?.value
  }

  // --- Helpers ---

  private buildContext(node: DefinitionNode, nodeState: NodeState): NodeExecutorContext {
    return {
      nodeId: node.id,
      properties: node.properties ?? {},
      getInput: (pinId: string) => {
        const pv = nodeState.inputs.find(i => i.pinId === pinId)
        return pv?.value
      },
      setOutput: (pinId: string, value: unknown) => {
        const existing = nodeState.outputs.findIndex(o => o.pinId === pinId)
        if (existing >= 0) {
          nodeState.outputs[existing] = { pinId, value }
        } else {
          nodeState.outputs.push({ pinId, value })
        }
      },
      getVariable: (name: string) => this.state.variables.get(name),
      setVariable: (name: string, value: unknown) => { this.state.variables.set(name, value) },
    }
  }

  private findStartNodes(): DefinitionNode[] {
    // Nodes that have exec outputs but no incoming exec connections
    const nodesWithExecIn = new Set<string>()
    for (const edge of this.definition.connections) {
      if (this.isExecPin(edge.targetPinId)) {
        nodesWithExecIn.add(edge.targetNodeId)
      }
    }
    return this.definition.nodes.filter(n =>
      n.typeId !== 'comment' &&
      n.typeId !== 'variable-get' &&
      !nodesWithExecIn.has(n.id)
    )
  }

  private findTargetNode(sourceNodeId: string, sourcePinId: string): string | undefined {
    const edge = this.definition.connections.find(
      e => e.sourceNodeId === sourceNodeId && e.sourcePinId === sourcePinId
    )
    return edge?.targetNodeId
  }

  private isExecPin(pinId: string): boolean {
    return pinId.startsWith('exec_') || pinId === 'exec_in'
  }

  private hasExecInput(nodeId: string): boolean {
    return this.definition.connections.some(e => e.targetNodeId === nodeId && this.isExecPin(e.targetPinId))
  }

  private failRunAtNode(nodeId: string, errorMessage: string): never {
    this.state.failedNodeId = nodeId
    this.state.errorMessage = errorMessage
    throw new Error(errorMessage)
  }
}

function normalizeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
