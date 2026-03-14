import type { IncomingMessage, ServerResponse } from 'node:http'
import { IssueRunManager, IssueRunManagerError } from './run-manager.js'
import type { IssueRunEvent, StartIssueRunRequest } from './types.js'

const manager = new IssueRunManager()

export function getIssueRunManager(): IssueRunManager {
  return manager
}

interface RouteMatch {
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>
  params: Record<string, string>
}

const routeTable: Array<{
  method: string
  pattern: RegExp
  paramNames: string[]
  handler: RouteMatch['handler']
}> = []

function addRoute(method: string, path: string, handler: RouteMatch['handler']): void {
  const paramNames: string[] = []
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  routeTable.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler })
}

export function matchRoute(method: string, url: string): RouteMatch | null {
  for (const route of routeTable) {
    if (route.method !== method) continue
    const matched = route.pattern.exec(url)
    if (!matched) continue

    const params: Record<string, string> = {}
    for (let index = 0; index < route.paramNames.length; index++) {
      params[route.paramNames[index]] = matched[index + 1]
    }
    return { handler: route.handler, params }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function writeJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJSON(res, status, { code, message })
}

function handleManagerError(res: ServerResponse, err: unknown): void {
  if (err instanceof IssueRunManagerError) {
    const status = err.code === 'NOT_FOUND' ? 404
      : err.code === 'ALREADY_FINISHED' ? 409
      : err.code === 'MAX_CONCURRENT_RUNS' ? 400
      : 500
    writeError(res, status, err.code, err.message)
    return
  }

  writeError(res, 500, 'INTERNAL_ERROR', String(err))
}

function validateStartPayload(payload: unknown): StartIssueRunRequest | null {
  if (!isRecord(payload)) return null
  if (!isNonEmptyString(payload.issueId)) return null
  if (!isNonEmptyString(payload.workspaceId)) return null
  if (!isNonEmptyString(payload.agentId)) return null
  if (typeof payload.executionMode !== 'undefined' && payload.executionMode !== 'cloud' && payload.executionMode !== 'local') return null
  if (typeof payload.executorName !== 'undefined' && !isNonEmptyString(payload.executorName)) return null
  if (typeof payload.executorHostname !== 'undefined' && !isNonEmptyString(payload.executorHostname)) return null
  if (typeof payload.executorPlatform !== 'undefined' && !isNonEmptyString(payload.executorPlatform)) return null

  const hasUserIntent = isNonEmptyString(payload.goal)
    || isNonEmptyString(payload.title)
    || isNonEmptyString(payload.userMessage)
  if (!hasUserIntent) return null

  if (typeof payload.triggerSource !== 'undefined' && !isNonEmptyString(payload.triggerSource)) return null
  if (typeof payload.triggerDetail !== 'undefined' && !isNonEmptyString(payload.triggerDetail)) return null

  return {
    runId: typeof payload.runId === 'string' && payload.runId.trim().length > 0 ? payload.runId : undefined,
    issueId: payload.issueId,
    workspaceId: payload.workspaceId,
    agentId: payload.agentId,
    executionMode: payload.executionMode === 'cloud' || payload.executionMode === 'local' ? payload.executionMode : undefined,
    executorName: typeof payload.executorName === 'string' ? payload.executorName : undefined,
    executorHostname: typeof payload.executorHostname === 'string' ? payload.executorHostname : undefined,
    executorPlatform: typeof payload.executorPlatform === 'string' ? payload.executorPlatform : undefined,
    triggerSource: typeof payload.triggerSource === 'string' ? payload.triggerSource : undefined,
    triggerDetail: typeof payload.triggerDetail === 'string' ? payload.triggerDetail : undefined,
    goal: typeof payload.goal === 'string' ? payload.goal : undefined,
    title: typeof payload.title === 'string' ? payload.title : undefined,
    userMessage: typeof payload.userMessage === 'string' ? payload.userMessage : undefined,
  }
}

function writeSSEEvent(res: ServerResponse, name: string, data: unknown): void {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
}

// POST /issue-runs
addRoute('POST', '/issue-runs', async (req, res) => {
  const rawBody = await readBody(req)
  let payload: unknown

  try {
    payload = JSON.parse(rawBody)
  } catch {
    writeError(res, 400, 'BAD_REQUEST', '请求体不是有效的 JSON')
    return
  }

  const params = validateStartPayload(payload)
  if (!params) {
    writeError(
      res,
      400,
      'BAD_REQUEST',
      'issueId、workspaceId、agentId 为必填项，且 goal、title、userMessage 至少需要一个',
    )
    return
  }

  try {
    const info = manager.start(params)
    writeJSON(res, 201, { data: info })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// GET /issue-runs/:runId
addRoute('GET', '/issue-runs/:runId', (_req, res, params) => {
  try {
    writeJSON(res, 200, { data: manager.get(params.runId) })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// GET /issue-runs/:runId/state
addRoute('GET', '/issue-runs/:runId/state', (_req, res, params) => {
  try {
    writeJSON(res, 200, { data: manager.getState(params.runId) })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// POST /issue-runs/:runId/abort
addRoute('POST', '/issue-runs/:runId/abort', (_req, res, params) => {
  try {
    writeJSON(res, 200, { data: manager.abort(params.runId) })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// GET /issue-runs/:runId/events
addRoute('GET', '/issue-runs/:runId/events', (_req, res, params) => {
  let unsubscribe: (() => void) | undefined

  try {
    const snapshot = manager.getState(params.runId)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    let lastSequence = 0

    writeSSEEvent(res, 'snapshot', snapshot)
    for (const event of snapshot.events) {
      writeSSEEvent(res, event.type, event)
      lastSequence = event.sequence
    }

    if (isTerminalStatus(snapshot.status)) {
      writeSSEEvent(res, 'done', {})
      res.end()
      return
    }

    unsubscribe = manager.subscribe(params.runId, (event: IssueRunEvent) => {
      if (event.sequence <= lastSequence) {
        return
      }
      lastSequence = event.sequence
      writeSSEEvent(res, event.type, event)

      if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.aborted') {
        writeSSEEvent(res, 'done', {})
        res.end()
      }
    })

    const latest = manager.getState(params.runId)
    for (const event of latest.events) {
      if (event.sequence <= lastSequence) continue
      lastSequence = event.sequence
      writeSSEEvent(res, event.type, event)
    }

    if (isTerminalStatus(latest.status)) {
      unsubscribe()
      unsubscribe = undefined
      writeSSEEvent(res, 'done', {})
      res.end()
      return
    }

    res.on('close', () => {
      if (unsubscribe) {
        unsubscribe()
      }
    })
  } catch (err) {
    if (unsubscribe) {
      unsubscribe()
    }
    if (!res.headersSent) {
      handleManagerError(res, err)
    }
  }
})
