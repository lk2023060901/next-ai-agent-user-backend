import { randomUUID } from 'node:crypto'
import type {
  IssueRunEvent,
  IssueRunEventType,
  IssueRunInfo,
  IssueRunState,
  IssueRunStatus,
  StartIssueRunRequest,
} from './types.js'

interface ManagedIssueRun {
  state: IssueRunState
  subscribers: Set<(event: IssueRunEvent) => void>
  timers: Set<ReturnType<typeof setTimeout>>
  createdAt: number
}

const MAX_CONCURRENT_RUNS = 100
const COMPLETED_RUN_TTL_MS = 30 * 60 * 1000

export class IssueRunManager {
  private readonly runs = new Map<string, ManagedIssueRun>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }

    for (const run of this.runs.values()) {
      this.clearTimers(run)
      run.subscribers.clear()
    }

    this.runs.clear()
  }

  start(params: StartIssueRunRequest): IssueRunInfo {
    if (this.activeRunCount() >= MAX_CONCURRENT_RUNS) {
      throw new IssueRunManagerError('MAX_CONCURRENT_RUNS', `并发 issue run 数已达上限 (${MAX_CONCURRENT_RUNS})`)
    }

    const runId = params.runId ?? randomUUID()
    const state: IssueRunState = {
      runId,
      issueId: params.issueId,
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      executionMode: params.executionMode,
      executorName: params.executorName,
      executorHostname: params.executorHostname,
      executorPlatform: params.executorPlatform,
      triggerSource: params.triggerSource,
      triggerDetail: params.triggerDetail,
      goal: params.goal,
      title: params.title,
      userMessage: params.userMessage,
      status: 'pending',
      startedAt: Date.now(),
      events: [],
    }

    const run: ManagedIssueRun = {
      state,
      subscribers: new Set(),
      timers: new Set(),
      createdAt: Date.now(),
    }
    this.runs.set(runId, run)

    this.transition(run, 'running')
      this.emit(run, 'run.started', {
        issueId: state.issueId,
        workspaceId: state.workspaceId,
        agentId: state.agentId,
        executionMode: state.executionMode,
        executorName: state.executorName,
        executorHostname: state.executorHostname,
        executorPlatform: state.executorPlatform,
      })

    this.schedule(runId, 25, (activeRun) => {
      activeRun.state.currentStep = 'thinking'
      this.emit(activeRun, 'agent.thinking', {
        summary: buildThinkingSummary(activeRun.state),
      })
    })

    this.schedule(runId, 60, (activeRun) => {
      activeRun.state.currentStep = 'tool.called'
      this.emit(activeRun, 'tool.called', {
        toolName: 'issue.fetchContext',
        arguments: {
          issueId: activeRun.state.issueId,
          workspaceId: activeRun.state.workspaceId,
        },
      })
    })

    this.schedule(runId, 95, (activeRun) => {
      activeRun.state.currentStep = 'comment.created'
      activeRun.state.resultText = buildCommentBody(activeRun.state)
      this.emit(activeRun, 'comment.created', {
        commentId: `comment_${activeRun.state.runId.slice(0, 8)}`,
        body: activeRun.state.resultText,
      })
    })

    this.schedule(runId, 130, (activeRun) => {
      if (shouldSimulateFailure(activeRun.state)) {
        this.fail(activeRun, '模拟 issue run 失败')
        return
      }
      this.finish(activeRun, 'completed', 'run.completed')
    })

    return this.toInfo(state)
  }

  get(runId: string): IssueRunInfo {
    return this.toInfo(this.requireRun(runId).state)
  }

  getState(runId: string): IssueRunState {
    return cloneState(this.requireRun(runId).state)
  }

  abort(runId: string): IssueRunInfo {
    const run = this.requireRun(runId)
    if (isTerminalStatus(run.state.status)) {
      throw new IssueRunManagerError('ALREADY_FINISHED', `issue run 已结束 (${run.state.status})`)
    }

    this.clearTimers(run)
    this.finish(run, 'aborted', 'run.aborted')
    return this.toInfo(run.state)
  }

  subscribe(runId: string, listener: (event: IssueRunEvent) => void): () => void {
    const run = this.requireRun(runId)
    run.subscribers.add(listener)
    return () => {
      run.subscribers.delete(listener)
    }
  }

  private requireRun(runId: string): ManagedIssueRun {
    const run = this.runs.get(runId)
    if (!run) {
      throw new IssueRunManagerError('NOT_FOUND', `issue run ${runId} 不存在`)
    }
    return run
  }

  private activeRunCount(): number {
    let count = 0
    for (const run of this.runs.values()) {
      if (!isTerminalStatus(run.state.status)) {
        count++
      }
    }
    return count
  }

  private schedule(runId: string, delayMs: number, action: (run: ManagedIssueRun) => void): void {
    const run = this.runs.get(runId)
    if (!run) return

    const timer = setTimeout(() => {
      run.timers.delete(timer)
      const currentRun = this.runs.get(runId)
      if (!currentRun || isTerminalStatus(currentRun.state.status)) {
        return
      }

      try {
        action(currentRun)
      } catch (error) {
        this.fail(currentRun, String(error))
      }
    }, delayMs)

    run.timers.add(timer)
  }

  private clearTimers(run: ManagedIssueRun): void {
    for (const timer of run.timers) {
      clearTimeout(timer)
    }
    run.timers.clear()
  }

  private transition(run: ManagedIssueRun, status: IssueRunStatus): void {
    run.state.status = status
  }

  private emit(
    run: ManagedIssueRun,
    type: IssueRunEventType,
    data?: Record<string, unknown>,
  ): void {
    const event: IssueRunEvent = {
      sequence: run.state.events.length + 1,
      runId: run.state.runId,
      type,
      at: Date.now(),
      data,
    }

    run.state.lastEventType = type
    run.state.events.push(event)

    for (const subscriber of run.subscribers) {
      try {
        subscriber(event)
      } catch {
        // Ignore listener failures to keep the runtime stable.
      }
    }
  }

  private finish(
    run: ManagedIssueRun,
    status: Extract<IssueRunStatus, 'completed' | 'aborted'>,
    eventType: Extract<IssueRunEventType, 'run.completed' | 'run.aborted'>,
  ): void {
    this.clearTimers(run)
    run.state.completedAt = Date.now()
    run.state.currentStep = undefined
    this.transition(run, status)
    this.emit(run, eventType)
  }

  private fail(run: ManagedIssueRun, message: string): void {
    this.clearTimers(run)
    run.state.errorMessage = message
    run.state.completedAt = Date.now()
    run.state.currentStep = undefined
    this.transition(run, 'failed')
    this.emit(run, 'run.failed', { message })
  }

  private cleanup(): void {
    const now = Date.now()
    for (const [runId, run] of this.runs) {
      if (isTerminalStatus(run.state.status) && now - run.createdAt > COMPLETED_RUN_TTL_MS) {
        this.clearTimers(run)
        run.subscribers.clear()
        this.runs.delete(runId)
      }
    }
  }

  private toInfo(state: IssueRunState): IssueRunInfo {
    return {
      runId: state.runId,
      issueId: state.issueId,
      workspaceId: state.workspaceId,
      agentId: state.agentId,
      executionMode: state.executionMode,
      executorName: state.executorName,
      executorHostname: state.executorHostname,
      executorPlatform: state.executorPlatform,
      triggerSource: state.triggerSource,
      triggerDetail: state.triggerDetail,
      goal: state.goal,
      title: state.title,
      userMessage: state.userMessage,
      status: state.status,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      currentStep: state.currentStep,
      resultText: state.resultText,
      lastEventType: state.lastEventType,
      errorMessage: state.errorMessage,
    }
  }
}

export class IssueRunManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'IssueRunManagerError'
  }
}

function cloneState(state: IssueRunState): IssueRunState {
  return {
    ...state,
    events: state.events.map((event) => ({
      ...event,
      data: event.data ? { ...event.data } : undefined,
    })),
  }
}

function isTerminalStatus(status: IssueRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

function buildThinkingSummary(state: IssueRunState): string {
  const goal = state.goal ?? state.title ?? state.userMessage ?? `issue ${state.issueId}`
  return `Planning next steps for ${goal}`
}

function buildCommentBody(state: IssueRunState): string {
  const focus = state.goal ?? state.title ?? state.userMessage ?? `issue ${state.issueId}`
  return `Started issue run for ${focus} in workspace ${state.workspaceId}.`
}

function shouldSimulateFailure(state: IssueRunState): boolean {
  const combined = [
    state.goal,
    state.title,
    state.userMessage,
    state.triggerDetail,
    state.triggerSource,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' ')

  return /\[(?:fail|error)\]|(?:^|\W)(?:fail|error)(?:$|\W)/i.test(combined)
}
