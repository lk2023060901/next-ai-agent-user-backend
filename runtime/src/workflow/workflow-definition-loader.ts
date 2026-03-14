import type { WorkflowDefinition } from './types.js'

const DEFAULT_GATEWAY_BASE_URL = 'http://127.0.0.1:3001/api'
const DEFAULT_GATEWAY_TIMEOUT_MS = 5000

interface WorkflowDocumentEnvelope {
  data?: {
    workflowId?: string
    revision?: number
    definition?: WorkflowDefinition
  }
  code?: string
  message?: string
  details?: unknown
}

export interface LoadWorkflowDefinitionParams {
  workflowId: string
  revision?: number
  authorization?: string
  gatewayBaseUrl?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface LoadedWorkflowDefinition {
  workflowId: string
  revision: number
  definition: WorkflowDefinition
}

export class WorkflowDefinitionLoadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'WorkflowDefinitionLoadError'
  }
}

export async function loadWorkflowDefinition(params: LoadWorkflowDefinitionParams): Promise<LoadedWorkflowDefinition> {
  const authorization = params.authorization?.trim()
  if (!authorization) {
    throw new WorkflowDefinitionLoadError(
      'UNAUTHORIZED',
      '缺少 Authorization 请求头，无法从 gateway 读取 workflow document',
      401,
    )
  }

  const fetchImpl = params.fetchImpl ?? fetch
  const url = buildDocumentURL(resolveGatewayBaseUrl(params.gatewayBaseUrl), params.workflowId, params.revision)
  const controller = new AbortController()
  const timeoutMs = resolveGatewayTimeoutMs(params.timeoutMs)
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': authorization,
      },
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new WorkflowDefinitionLoadError('GATEWAY_TIMEOUT', '读取 workflow document 超时', 504)
    }
    throw new WorkflowDefinitionLoadError('GATEWAY_UNAVAILABLE', '无法连接 gateway', 502, err)
  }
  clearTimeout(timer)

  const payload = await readEnvelope(response)
  if (!response.ok) {
    throw new WorkflowDefinitionLoadError(
      payload?.code ?? 'GATEWAY_ERROR',
      payload?.message ?? `gateway 响应异常 (${response.status})`,
      response.status,
      payload?.details,
    )
  }

  const doc = payload?.data
  if (!doc || typeof doc.workflowId !== 'string' || typeof doc.revision !== 'number' || !isWorkflowDefinition(doc.definition)) {
    throw new WorkflowDefinitionLoadError('BAD_GATEWAY', 'gateway 返回的 workflow document 非法', 502, payload)
  }

  return {
    workflowId: doc.workflowId,
    revision: doc.revision,
    definition: doc.definition,
  }
}

function resolveGatewayBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? process.env.GATEWAY_BASE_URL ?? DEFAULT_GATEWAY_BASE_URL).trim()
  const trimmed = raw.replace(/\/+$/, '')
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`
}

function resolveGatewayTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    return timeoutMs
  }

  const raw = Number(process.env.GATEWAY_TIMEOUT_MS ?? DEFAULT_GATEWAY_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GATEWAY_TIMEOUT_MS
}

function buildDocumentURL(baseUrl: string, workflowId: string, revision?: number): string {
  const url = new URL(`${baseUrl}/workflows/${encodeURIComponent(workflowId)}/document`)
  if (typeof revision === 'number') {
    url.searchParams.set('revision', String(revision))
  }
  return url.toString()
}

async function readEnvelope(response: Response): Promise<WorkflowDocumentEnvelope | null> {
  try {
    return await response.json() as WorkflowDocumentEnvelope
  } catch {
    return null
  }
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== 'object') {
    return false
  }

  const maybe = value as Partial<WorkflowDefinition>
  return Array.isArray(maybe.nodes) && Array.isArray(maybe.connections)
}
