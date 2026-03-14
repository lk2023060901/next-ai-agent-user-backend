import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadWorkflowDefinition, WorkflowDefinitionLoadError } from './workflow-definition-loader.js'

describe('workflow definition loader', () => {
  it('loads definition from gateway and forwards authorization', async () => {
    const seenRequests: Array<{ url: string; auth: string }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      seenRequests.push({
        url: String(input),
        auth: String(new Headers(init?.headers).get('authorization') ?? ''),
      })
      return new Response(JSON.stringify({
        data: {
          workflowId: 'wf1',
          revision: 7,
          definition: {
            nodes: [{ id: 'n1', typeId: 'text', properties: { content: 'hello' } }],
            connections: [],
          },
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const loaded = await loadWorkflowDefinition({
      workflowId: 'wf1',
      revision: 7,
      authorization: 'Bearer test-token',
      gatewayBaseUrl: 'http://gateway.internal:3001',
      fetchImpl,
    })

    assert.strictEqual(seenRequests.length, 1)
    assert.strictEqual(seenRequests[0].url, 'http://gateway.internal:3001/api/workflows/wf1/document?revision=7')
    assert.strictEqual(seenRequests[0].auth, 'Bearer test-token')
    assert.strictEqual(loaded.workflowId, 'wf1')
    assert.strictEqual(loaded.revision, 7)
    assert.deepStrictEqual(loaded.definition.nodes.map(node => node.typeId), ['text'])
  })

  it('requires authorization when loading from gateway', async () => {
    await assert.rejects(
      () => loadWorkflowDefinition({ workflowId: 'wf1' }),
      (err: unknown) =>
        err instanceof WorkflowDefinitionLoadError &&
        err.code === 'UNAUTHORIZED' &&
        err.status === 401,
    )
  })

  it('surfaces gateway error payloads', async () => {
    await assert.rejects(
      () => loadWorkflowDefinition({
        workflowId: 'missing',
        authorization: 'Bearer token',
        gatewayBaseUrl: 'http://gateway.internal:3001/api',
        fetchImpl: async () => new Response(
          JSON.stringify({ code: 'NOT_FOUND', message: '工作流不存在' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        ),
      }),
      (err: unknown) =>
        err instanceof WorkflowDefinitionLoadError &&
        err.code === 'NOT_FOUND' &&
        err.status === 404,
    )
  })

  it('rejects malformed gateway responses', async () => {
    await assert.rejects(
      () => loadWorkflowDefinition({
        workflowId: 'wf1',
        authorization: 'Bearer token',
        gatewayBaseUrl: 'http://gateway.internal:3001',
        fetchImpl: async () => new Response(
          JSON.stringify({ data: { workflowId: 'wf1', revision: 1 } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      }),
      (err: unknown) =>
        err instanceof WorkflowDefinitionLoadError &&
        err.code === 'BAD_GATEWAY' &&
        err.status === 502,
    )
  })
})
