export type IssueRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

export type IssueRunEventType =
  | 'run.started'
  | 'agent.thinking'
  | 'tool.called'
  | 'comment.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.aborted'

export interface StartIssueRunRequest {
  runId?: string
  issueId: string
  workspaceId: string
  agentId: string
  executionMode?: 'cloud' | 'local'
  executorName?: string
  executorHostname?: string
  executorPlatform?: string
  triggerSource?: string
  triggerDetail?: string
  goal?: string
  title?: string
  userMessage?: string
}

export interface IssueRunEvent {
  sequence: number
  runId: string
  type: IssueRunEventType
  at: number
  data?: Record<string, unknown>
}

export interface IssueRunInfo {
  runId: string
  issueId: string
  workspaceId: string
  agentId: string
  executionMode?: 'cloud' | 'local'
  executorName?: string
  executorHostname?: string
  executorPlatform?: string
  triggerSource?: string
  triggerDetail?: string
  goal?: string
  title?: string
  userMessage?: string
  status: IssueRunStatus
  startedAt: number
  completedAt?: number
  currentStep?: string
  resultText?: string
  lastEventType?: IssueRunEventType
  errorMessage?: string
}

export interface IssueRunState extends IssueRunInfo {
  events: IssueRunEvent[]
}
