import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { RunManager, RunManagerError } from './run-manager.js'
import type { WorkflowDefinition, Breakpoint } from './types.js'

function textDefinition(content = 'hello'): WorkflowDefinition {
  return {
    nodes: [{ id: 'n1', typeId: 'text', properties: { content } }],
    connections: [],
  }
}

function chainDefinition(): WorkflowDefinition {
  return {
    nodes: [
      { id: 't1', typeId: 'text', properties: { content: 'start' } },
      { id: 't2', typeId: 'text', properties: { content: 'end' } },
    ],
    connections: [
      { sourceNodeId: 't1', sourcePinId: 'exec_out', targetNodeId: 't2', targetPinId: 'exec_in' },
    ],
  }
}

describe('RunManager', () => {
  let mgr: RunManager

  afterEach(() => {
    mgr?.shutdown()
  })

  it('starts a run and returns info with UUID', () => {
    mgr = new RunManager()
    const info = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: textDefinition() })
    assert.ok(info.runId)
    assert.match(info.runId, /^[0-9a-f]{8}-/) // UUID format
    assert.strictEqual(info.workflowId, 'wf1')
    assert.ok(['pending', 'running', 'completed'].includes(info.status))
  })

  it('tracks the workflow revision used for the run', async () => {
    mgr = new RunManager()
    const info = mgr.startResolvedDefinition({ workflowId: 'wf1', workflowRevision: 3, definition: textDefinition() })
    assert.strictEqual(info.workflowRevision, 3)

    await new Promise(r => setTimeout(r, 50))
    const snapshot = mgr.getSnapshot(info.runId)
    assert.strictEqual(snapshot.workflowRevision, 3)
  })

  it('get returns run info', async () => {
    mgr = new RunManager()
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: textDefinition() })
    await new Promise(r => setTimeout(r, 50))
    const info = mgr.get(runId)
    assert.strictEqual(info.runId, runId)
  })

  it('get throws NOT_FOUND for unknown runId', () => {
    mgr = new RunManager()
    assert.throws(() => mgr.get('nonexistent'), (err: unknown) => {
      return err instanceof RunManagerError && err.code === 'NOT_FOUND'
    })
  })

  it('getSnapshot returns full state with nodeStates and variables', async () => {
    mgr = new RunManager()
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: textDefinition('snapshot test') })
    await new Promise(r => setTimeout(r, 100))
    const snapshot = mgr.getSnapshot(runId)
    assert.strictEqual(snapshot.runId, runId)
    assert.strictEqual(snapshot.status, 'completed')
    assert.ok(snapshot.nodeStates.n1)
    assert.strictEqual(snapshot.nodeStates.n1.status, 'completed')
    const textOut = snapshot.nodeStates.n1.outputs.find(o => o.pinId === 'text')
    assert.strictEqual(textOut?.value, 'snapshot test')
  })

  it('exposes failed node and error message in run snapshots', async () => {
    mgr = new RunManager()
    const info = mgr.startResolvedDefinition({
      workflowId: 'wf1',
      definition: { nodes: [{ id: 'broken1', typeId: 'missing-executor' }], connections: [] },
    })

    await new Promise(r => setTimeout(r, 50))
    const snapshot = mgr.getSnapshot(info.runId)
    assert.strictEqual(snapshot.status, 'failed')
    assert.strictEqual(snapshot.failedNodeId, 'broken1')
    assert.strictEqual(snapshot.errorMessage, 'No executor for node type: missing-executor')
  })

  it('rejects empty definition', () => {
    mgr = new RunManager()
    assert.throws(
      () => mgr.startResolvedDefinition({ workflowId: 'wf1', definition: { nodes: [], connections: [] } }),
      (err: unknown) => err instanceof RunManagerError && err.code === 'EMPTY_DEFINITION',
    )
  })

  // --- Breakpoint + resume ---

  it('pauses at breakpoint and resumes', async () => {
    mgr = new RunManager()
    const bps: Breakpoint[] = [{ nodeId: 't2', type: 'before' }]
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: chainDefinition(), breakpoints: bps })

    await new Promise(r => setTimeout(r, 100))
    const info = mgr.get(runId)
    assert.strictEqual(info.status, 'paused')
    assert.strictEqual(info.currentNodeId, 't2')
    assert.strictEqual(info.pausedAtNodeId, 't2')
    assert.strictEqual(info.pausedBreakpointType, 'before')

    const pausedSnapshot = mgr.getSnapshot(runId)
    assert.strictEqual(pausedSnapshot.currentNodeId, 't2')
    assert.strictEqual(pausedSnapshot.pausedAtNodeId, 't2')
    assert.strictEqual(pausedSnapshot.pausedBreakpointType, 'before')
    assert.strictEqual(pausedSnapshot.nodeStates.t2?.status, 'running')

    const resumed = mgr.resume(runId)
    assert.ok(['running', 'completed'].includes(resumed.status))
    assert.strictEqual(resumed.pausedAtNodeId, null)
    assert.strictEqual(resumed.pausedBreakpointType, null)

    await new Promise(r => setTimeout(r, 100))
    assert.strictEqual(mgr.get(runId).status, 'completed')
  })

  it('resume throws when not paused', async () => {
    mgr = new RunManager()
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: textDefinition() })
    await new Promise(r => setTimeout(r, 100))
    assert.throws(
      () => mgr.resume(runId),
      (err: unknown) => err instanceof RunManagerError && err.code === 'NOT_PAUSED',
    )
  })

  // --- Step ---

  it('step executes one node then pauses', async () => {
    mgr = new RunManager()
    const bps: Breakpoint[] = [{ nodeId: 't1', type: 'before' }]
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: chainDefinition(), breakpoints: bps })

    await new Promise(r => setTimeout(r, 100))
    assert.strictEqual(mgr.get(runId).status, 'paused')

    const stepped = mgr.step(runId)
    assert.ok(['running', 'completed'].includes(stepped.status))
    assert.strictEqual(stepped.pausedAtNodeId, null)
    assert.strictEqual(stepped.pausedBreakpointType, null)
    await new Promise(r => setTimeout(r, 100))

    const snapshot = mgr.getSnapshot(runId)
    assert.strictEqual(snapshot.nodeStates.t1?.status, 'completed')
    assert.strictEqual(snapshot.status, 'paused') // paused before t2
    assert.strictEqual(snapshot.currentNodeId, 't2')
    assert.strictEqual(snapshot.pausedAtNodeId, 't2')
    assert.strictEqual(snapshot.pausedBreakpointType, 'before')
  })

  // --- Abort ---

  it('aborts a running/paused run', async () => {
    mgr = new RunManager()
    const bps: Breakpoint[] = [{ nodeId: 't2', type: 'before' }]
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: chainDefinition(), breakpoints: bps })

    await new Promise(r => setTimeout(r, 100))
    assert.strictEqual(mgr.get(runId).status, 'paused')

    mgr.abort(runId)
    await new Promise(r => setTimeout(r, 100))
    assert.strictEqual(mgr.get(runId).status, 'aborted')
  })

  it('abort throws when already finished', async () => {
    mgr = new RunManager()
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: textDefinition() })
    await new Promise(r => setTimeout(r, 100))
    assert.throws(
      () => mgr.abort(runId),
      (err: unknown) => err instanceof RunManagerError && err.code === 'ALREADY_FINISHED',
    )
  })

  // --- Subscribe ---

  it('subscribe delivers events to listener', async () => {
    mgr = new RunManager()
    const events: string[] = []
    const bps: Breakpoint[] = [{ nodeId: 't2', type: 'before' }]
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: chainDefinition(), breakpoints: bps })
    await new Promise(r => setTimeout(r, 100))
    mgr.subscribe(runId, (e) => events.push(e.type))

    mgr.resume(runId)
    await new Promise(r => setTimeout(r, 100))
    assert.ok(events.includes('node.completed'))
    assert.ok(events.includes('run.completed'))
  })

  it('unsubscribe stops event delivery', async () => {
    mgr = new RunManager()
    const bps: Breakpoint[] = [{ nodeId: 'n1', type: 'before' }]
    const { runId } = mgr.startResolvedDefinition({ workflowId: 'wf1', definition: textDefinition(), breakpoints: bps })

    await new Promise(r => setTimeout(r, 50))

    const events: string[] = []
    const unsub = mgr.subscribe(runId, (e) => events.push(e.type))
    unsub() // immediately unsubscribe

    mgr.resume(runId)
    await new Promise(r => setTimeout(r, 100))

    // Should have no events since we unsubscribed
    assert.strictEqual(events.length, 0)
  })
})
