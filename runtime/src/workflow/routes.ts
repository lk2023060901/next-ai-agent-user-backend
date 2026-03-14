import type { IncomingMessage, ServerResponse } from 'node:http'
import { RunManager, RunManagerError } from './run-manager.js'
import type { Breakpoint, ExecEvent } from './types.js'
import {
  loadWorkflowDefinition,
  WorkflowDefinitionLoadError,
  type LoadedWorkflowDefinition,
} from './workflow-definition-loader.js'

const manager = new RunManager()
let workflowDefinitionLoader = loadWorkflowDefinition

export function getRunManager(): RunManager {
  return manager
}

export function setWorkflowDefinitionLoaderForTests(
  loader: typeof loadWorkflowDefinition | null,
): void {
  workflowDefinitionLoader = loader ?? loadWorkflowDefinition
}

// --- Route matcher ---

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
  const patternStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name)
    return '([^/]+)'
  })
  routeTable.push({ method, pattern: new RegExp(`^${patternStr}$`), paramNames, handler })
}

export function matchRoute(method: string, url: string): RouteMatch | null {
  for (const r of routeTable) {
    if (r.method !== method) continue
    const m = r.pattern.exec(url)
    if (!m) continue
    const params: Record<string, string> = {}
    for (let i = 0; i < r.paramNames.length; i++) {
      params[r.paramNames[i]] = m[i + 1]
    }
    return { handler: r.handler, params }
  }
  return null
}

// --- Helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
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

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'aborted'
}

function handleManagerError(res: ServerResponse, err: unknown): void {
  if (err instanceof RunManagerError) {
    const status = err.code === 'NOT_FOUND' ? 404
      : err.code === 'NOT_PAUSED' || err.code === 'ALREADY_FINISHED' ? 409
      : err.code === 'MAX_CONCURRENT_RUNS' || err.code === 'EMPTY_DEFINITION' ? 400
      : 500
    writeError(res, status, err.code, err.message)
  } else {
    writeError(res, 500, 'INTERNAL_ERROR', String(err))
  }
}

function handleDefinitionLoadError(res: ServerResponse, err: WorkflowDefinitionLoadError): void {
  const body: Record<string, unknown> = {
    code: err.code,
    message: err.message,
  }
  if (typeof err.details !== 'undefined') {
    body.details = err.details
  }
  writeJSON(res, err.status, body)
}

async function resolveStartParams(req: IncomingMessage, body: StartRunRequest): Promise<StartRunParams> {
  const authorization = typeof req.headers.authorization === 'string'
    ? req.headers.authorization
    : undefined
  const loaded = await workflowDefinitionLoader({
    workflowId: body.workflowId,
    revision: body.revision,
    authorization,
  })

  return {
    workflowId: loaded.workflowId,
    workflowRevision: loaded.revision,
    definition: loaded.definition,
    breakpoints: body.breakpoints,
  }
}

interface StartRunRequest {
  workflowId: string
  revision?: number
  breakpoints?: Breakpoint[]
  definition?: unknown
}

interface StartRunParams {
  workflowId: string
  workflowRevision: number | null
  definition: LoadedWorkflowDefinition['definition']
  breakpoints?: Breakpoint[]
}

// --- Endpoints ---

// POST /workflow/run
addRoute('POST', '/workflow/run', async (req, res) => {
  const body = await readBody(req)
  let params: StartRunRequest
  try {
    params = JSON.parse(body) as StartRunRequest
  } catch {
    writeError(res, 400, 'BAD_REQUEST', '请求体不是有效的 JSON')
    return
  }

  if (!params.workflowId) {
    writeError(res, 400, 'BAD_REQUEST', 'workflowId 是必填项')
    return
  }
  if (typeof params.definition !== 'undefined') {
    writeError(res, 400, 'BAD_REQUEST', 'definition 不是合法输入，请仅传 workflowId')
    return
  }

  try {
    const startParams = await resolveStartParams(req, params)
    const info = manager.startResolvedDefinition(startParams)
    writeJSON(res, 201, { data: info })
  } catch (err) {
    if (err instanceof WorkflowDefinitionLoadError) {
      handleDefinitionLoadError(res, err)
      return
    }
    handleManagerError(res, err)
  }
})

// GET /workflow/run/:runId
addRoute('GET', '/workflow/run/:runId', (_req, res, params) => {
  try {
    const info = manager.get(params.runId)
    writeJSON(res, 200, { data: info })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// GET /workflow/run/:runId/state
addRoute('GET', '/workflow/run/:runId/state', (_req, res, params) => {
  try {
    const snapshot = manager.getSnapshot(params.runId)
    writeJSON(res, 200, { data: snapshot })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// POST /workflow/run/:runId/resume
addRoute('POST', '/workflow/run/:runId/resume', (_req, res, params) => {
  try {
    const info = manager.resume(params.runId)
    writeJSON(res, 200, { data: info })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// POST /workflow/run/:runId/step
addRoute('POST', '/workflow/run/:runId/step', (_req, res, params) => {
  try {
    const info = manager.step(params.runId)
    writeJSON(res, 200, { data: info })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// POST /workflow/run/:runId/abort
addRoute('POST', '/workflow/run/:runId/abort', (_req, res, params) => {
  try {
    const info = manager.abort(params.runId)
    writeJSON(res, 200, { data: info })
  } catch (err) {
    handleManagerError(res, err)
  }
})

// GET /workflow/run/:runId/events (SSE)
addRoute('GET', '/workflow/run/:runId/events', (_req, res, params) => {
  let unsubscribe: (() => void) | undefined
  try {
    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Send initial state snapshot as first event
    const snapshot = manager.getSnapshot(params.runId)
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
    if (isTerminalStatus(snapshot.status)) {
      res.write('event: done\ndata: {}\n\n')
      res.end()
      return
    }

    // Subscribe to live events
    unsubscribe = manager.subscribe(params.runId, (event: ExecEvent) => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)

      // Close stream when run finishes
      if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.aborted') {
        res.write('event: done\ndata: {}\n\n')
        res.end()
      }
    })

    const latest = manager.getSnapshot(params.runId)
    if (isTerminalStatus(latest.status)) {
      if (unsubscribe) unsubscribe()
      res.write('event: done\ndata: {}\n\n')
      res.end()
      return
    }

    // Clean up on client disconnect
    res.on('close', () => {
      if (unsubscribe) unsubscribe()
    })
  } catch (err) {
    if (unsubscribe) unsubscribe()
    if (!res.headersSent) {
      handleManagerError(res, err)
    }
  }
})
