import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getIssueRunManager, matchRoute } from './routes.js'

describe('issue-runs routes', () => {
  afterEach(() => {
    getIssueRunManager().shutdown()
  })

  it('matches issue-run routes and starts a run', async () => {
    const startRoute = matchRoute('POST', '/issue-runs')
    assert.ok(startRoute)

    const stateRoute = matchRoute('GET', '/issue-runs/run-123/state')
    assert.ok(stateRoute)
    assert.deepStrictEqual(stateRoute.params, { runId: 'run-123' })

    const req = createJSONRequest({
      issueId: 'issue-1',
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      title: 'Investigate login failure',
      userMessage: 'Please post a status update.',
    })
    const res = createMockResponse()

    await startRoute.handler(req, res as unknown as ServerResponse, startRoute.params)

    assert.strictEqual(res.statusCode, 201)
    const payload = JSON.parse(res.body)
    assert.strictEqual(payload.data.issueId, 'issue-1')
    assert.strictEqual(payload.data.workspaceId, 'workspace-1')
    assert.strictEqual(payload.data.agentId, 'agent-1')
    assert.strictEqual(payload.data.status, 'running')
    assert.strictEqual(payload.data.lastEventType, 'run.started')

    const state = getIssueRunManager().getState(payload.data.runId)
    assert.strictEqual(state.events[0]?.type, 'run.started')
  })

  it('rejects invalid start payloads', async () => {
    const route = matchRoute('POST', '/issue-runs')
    assert.ok(route)

    const req = createJSONRequest({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      title: 'Missing issue id',
    })
    const res = createMockResponse()

    await route.handler(req, res as unknown as ServerResponse, route.params)

    assert.strictEqual(res.statusCode, 400)
    assert.deepStrictEqual(JSON.parse(res.body), {
      code: 'BAD_REQUEST',
      message: 'issueId、workspaceId、agentId 为必填项，且 goal、title、userMessage 至少需要一个',
    })
  })
})

function createJSONRequest(body: unknown, headers?: Record<string, string>): IncomingMessage {
  const req = new PassThrough() as IncomingMessage & PassThrough
  req.headers = headers ?? {}
  req.method = 'POST'
  req.url = '/issue-runs'
  req.end(JSON.stringify(body))
  return req
}

interface MockResponse {
  statusCode: number
  body: string
  headers: Record<string, string>
  headersSent: boolean
  writeHead: (status: number, headers?: Record<string, string>) => MockResponse
  setHeader: (name: string, value: string) => void
  write: (chunk: string) => boolean
  on: (event: string, listener: () => void) => MockResponse
  end: (chunk?: string) => void
}

function createMockResponse(): MockResponse {
  const listeners = new Map<string, () => void>()
  const res: MockResponse = {
    statusCode: 200,
    body: '',
    headers: {},
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status
      res.headersSent = true
      if (headers) {
        res.headers = { ...res.headers, ...headers }
      }
      return res
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value
    },
    write(chunk: string) {
      res.body += chunk
      return true
    },
    on(event: string, listener: () => void) {
      listeners.set(event, listener)
      return res
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') {
        res.body += chunk
      }
    },
  }

  return res
}
