import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { matchRoute, setWorkflowDefinitionLoaderForTests, getRunManager } from './routes.js'
import { WorkflowDefinitionLoadError } from './workflow-definition-loader.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

describe('workflow routes', () => {
  afterEach(() => {
    setWorkflowDefinitionLoaderForTests(null)
    getRunManager().shutdown()
  })

  it('starts a run by workflowId through the loader path', async () => {
    let seenAuthorization = ''

    setWorkflowDefinitionLoaderForTests(async (params) => {
      seenAuthorization = params.authorization ?? ''
      return {
        workflowId: params.workflowId,
        revision: 9,
        definition: {
          nodes: [{ id: 'n1', typeId: 'text', properties: { content: 'hello' } }],
          connections: [],
        },
      }
    })

    const route = matchRoute('POST', '/workflow/run')
    assert.ok(route)

    const req = createJSONRequest(
      { workflowId: 'wf1' },
      { authorization: 'Bearer route-token' },
    )
    const res = createMockResponse()

    await route!.handler(req, res as unknown as ServerResponse, route!.params)

    assert.strictEqual(seenAuthorization, 'Bearer route-token')
    assert.strictEqual(res.statusCode, 201)
    const payload = JSON.parse(res.body)
    assert.strictEqual(payload.data.workflowId, 'wf1')
    assert.strictEqual(payload.data.workflowRevision, 9)
  })

  it('rejects direct definition input on the HTTP contract', async () => {
    const route = matchRoute('POST', '/workflow/run')
    assert.ok(route)

    const req = createJSONRequest({
      workflowId: 'wf1',
      definition: { nodes: [], connections: [] },
    })
    const res = createMockResponse()

    await route!.handler(req, res as unknown as ServerResponse, route!.params)

    assert.strictEqual(res.statusCode, 400)
    assert.deepStrictEqual(JSON.parse(res.body), {
      code: 'BAD_REQUEST',
      message: 'definition 不是合法输入，请仅传 workflowId',
    })
  })

  it('maps loader errors onto the HTTP response', async () => {
    setWorkflowDefinitionLoaderForTests(async () => {
      throw new WorkflowDefinitionLoadError('UNAUTHORIZED', '缺少 Authorization 请求头', 401)
    })

    const route = matchRoute('POST', '/workflow/run')
    assert.ok(route)

    const req = createJSONRequest({ workflowId: 'wf1' })
    const res = createMockResponse()

    await route!.handler(req, res as unknown as ServerResponse, route!.params)

    assert.strictEqual(res.statusCode, 401)
    assert.deepStrictEqual(JSON.parse(res.body), {
      code: 'UNAUTHORIZED',
      message: '缺少 Authorization 请求头',
    })
  })
})

function createJSONRequest(body: unknown, headers?: Record<string, string>): IncomingMessage {
  const req = new PassThrough() as IncomingMessage & PassThrough
  req.headers = headers ?? {}
  req.method = 'POST'
  req.url = '/workflow/run'
  req.end(JSON.stringify(body))
  return req
}

interface MockResponse {
  statusCode: number
  body: string
  headers: Record<string, string>
  writeHead: (status: number, headers?: Record<string, string>) => MockResponse
  setHeader: (name: string, value: string) => void
  end: (chunk?: string) => void
}

function createMockResponse(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: '',
    headers: {},
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status
      if (headers) {
        res.headers = { ...res.headers, ...headers }
      }
      return res
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') {
        res.body += chunk
      }
    },
  }
  return res
}
