import { randomUUID } from 'node:crypto'
import { WorkflowEngine } from './engine.js'
import type { WorkflowDefinition, Breakpoint, ExecEvent, RunState, NodeState } from './types.js'

// --- Types ---

export interface RunInfo {
  runId: string
  workflowId: string
  workflowRevision: number | null
  status: RunState['status']
  currentNodeId: string | null
  failedNodeId: string | null
  pausedAtNodeId: string | null
  pausedBreakpointType: Breakpoint['type'] | null
  errorMessage?: string
  startedAt: number
  completedAt?: number
}

export interface RunSnapshot {
  runId: string
  workflowId: string
  workflowRevision: number | null
  status: RunState['status']
  currentNodeId: string | null
  failedNodeId: string | null
  pausedAtNodeId: string | null
  pausedBreakpointType: Breakpoint['type'] | null
  errorMessage?: string
  nodeStates: Record<string, NodeState>
  variables: Record<string, unknown>
  startedAt: number
  completedAt?: number
}

interface ResolvedRunParams {
  workflowId: string
  workflowRevision?: number | null
  definition: WorkflowDefinition
  breakpoints?: Breakpoint[]
}

// --- Managed run ---

interface ManagedRun {
  engine: WorkflowEngine
  sseClients: Set<(event: ExecEvent) => void>
  runPromise: Promise<RunState>
  createdAt: number
}

// --- Run Manager ---

const MAX_CONCURRENT_RUNS = 100
const COMPLETED_RUN_TTL_MS = 30 * 60 * 1000 // 30 minutes

export class RunManager {
  private runs = new Map<string, ManagedRun>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Periodic cleanup of completed/expired runs
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    // Abort all active runs
    for (const [, run] of this.runs) {
      run.engine.abort()
      run.sseClients.clear()
    }
    this.runs.clear()
  }

  startResolvedDefinition(params: ResolvedRunParams): RunInfo {
    if (this.activeRunCount() >= MAX_CONCURRENT_RUNS) {
      throw new RunManagerError('MAX_CONCURRENT_RUNS', `并发执行数已达上限 (${MAX_CONCURRENT_RUNS})`)
    }

    if (!params.definition.nodes || params.definition.nodes.length === 0) {
      throw new RunManagerError('EMPTY_DEFINITION', '工作流定义为空')
    }

    const runId = randomUUID()
    const engine = new WorkflowEngine(
      runId,
      params.workflowId,
      params.definition,
      params.breakpoints ?? [],
      params.workflowRevision ?? null,
    )
    const sseClients = new Set<(event: ExecEvent) => void>()

    engine.onEvent((event) => {
      for (const client of sseClients) {
        try { client(event) } catch { /* client error, ignore */ }
      }
    })

    const runPromise = engine.run().finally(() => {
      // Don't clear SSE clients immediately — allow late subscribers to read final state
    })

    const managed: ManagedRun = { engine, sseClients, runPromise, createdAt: Date.now() }
    this.runs.set(runId, managed)

    return this.toRunInfo(runId, engine.getState())
  }

  get(runId: string): RunInfo {
    const run = this.requireRun(runId)
    return this.toRunInfo(runId, run.engine.getState())
  }

  getSnapshot(runId: string): RunSnapshot {
    const run = this.requireRun(runId)
    const state = run.engine.getState()

    const nodeStates: Record<string, NodeState> = {}
    for (const [id, ns] of state.nodeStates) {
      nodeStates[id] = ns
    }

    const variables: Record<string, unknown> = {}
    for (const [k, v] of state.variables) {
      variables[k] = v
    }

    return {
      runId: state.runId,
      workflowId: state.workflowId,
      workflowRevision: state.workflowRevision,
      status: state.status,
      currentNodeId: state.currentNodeId,
      failedNodeId: state.failedNodeId,
      pausedAtNodeId: state.pausedAtNodeId,
      pausedBreakpointType: state.pausedBreakpointType,
      errorMessage: state.errorMessage,
      nodeStates,
      variables,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    }
  }

  resume(runId: string): RunInfo {
    const run = this.requireRun(runId)
    const state = run.engine.getState()
    if (state.status !== 'paused') {
      throw new RunManagerError('NOT_PAUSED', `运行状态为 ${state.status}，无法恢复`)
    }
    run.engine.resume()
    return this.toRunInfo(runId, run.engine.getState())
  }

  step(runId: string): RunInfo {
    const run = this.requireRun(runId)
    const state = run.engine.getState()
    if (state.status !== 'paused') {
      throw new RunManagerError('NOT_PAUSED', `运行状态为 ${state.status}，无法单步执行`)
    }
    run.engine.step()
    return this.toRunInfo(runId, run.engine.getState())
  }

  abort(runId: string): RunInfo {
    const run = this.requireRun(runId)
    const state = run.engine.getState()
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'aborted') {
      throw new RunManagerError('ALREADY_FINISHED', `运行已结束 (${state.status})`)
    }
    run.engine.abort()
    return this.toRunInfo(runId, run.engine.getState())
  }

  subscribe(runId: string, listener: (event: ExecEvent) => void): () => void {
    const run = this.requireRun(runId)
    run.sseClients.add(listener)
    return () => { run.sseClients.delete(listener) }
  }

  // --- Internal ---

  private requireRun(runId: string): ManagedRun {
    const run = this.runs.get(runId)
    if (!run) {
      throw new RunManagerError('NOT_FOUND', `运行 ${runId} 不存在`)
    }
    return run
  }

  private activeRunCount(): number {
    let count = 0
    for (const [, run] of this.runs) {
      const status = run.engine.getState().status
      if (status === 'running' || status === 'paused' || status === 'pending') {
        count++
      }
    }
    return count
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [runId, run] of this.runs) {
      const state = run.engine.getState()
      const isFinished = state.status === 'completed' || state.status === 'failed' || state.status === 'aborted'
      if (isFinished && (now - run.createdAt) > COMPLETED_RUN_TTL_MS) {
        run.sseClients.clear()
        this.runs.delete(runId)
      }
    }
  }

  private toRunInfo(runId: string, state: RunState): RunInfo {
    return {
      runId,
      workflowId: state.workflowId,
      workflowRevision: state.workflowRevision,
      status: state.status,
      currentNodeId: state.currentNodeId,
      failedNodeId: state.failedNodeId,
      pausedAtNodeId: state.pausedAtNodeId,
      pausedBreakpointType: state.pausedBreakpointType,
      errorMessage: state.errorMessage,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
    }
  }
}

// --- Error ---

export class RunManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'RunManagerError'
  }
}
