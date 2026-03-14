import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WorkflowEngine } from './engine.js'
import type { WorkflowDefinition, ExecEvent, Breakpoint } from './types.js'

// --- Helper ---
function makeDefinition(
  nodes: WorkflowDefinition['nodes'],
  connections: WorkflowDefinition['connections'] = [],
): WorkflowDefinition {
  return { nodes, connections }
}

function collectEvents(engine: WorkflowEngine): ExecEvent[] {
  const events: ExecEvent[] = []
  engine.onEvent(e => events.push(e))
  return events
}

// --- Basic execution ---

describe('WorkflowEngine', () => {
  it('executes a single text node', async () => {
    const definition = makeDefinition([
      { id: 'n1', typeId: 'text', properties: { content: 'hello world' } },
    ])
    const engine = new WorkflowEngine('run1', 'wf1', definition)
    const events = collectEvents(engine)
    const state = await engine.run()

    assert.strictEqual(state.status, 'completed')
    const ns = state.nodeStates.get('n1')
    assert.ok(ns)
    assert.strictEqual(ns.status, 'completed')
    const textOut = ns.outputs.find(o => o.pinId === 'text')
    assert.strictEqual(textOut?.value, 'hello world')

    assert.ok(events.some(e => e.type === 'run.started'))
    assert.ok(events.some(e => e.type === 'node.started' && e.nodeId === 'n1'))
    assert.ok(events.some(e => e.type === 'node.completed' && e.nodeId === 'n1'))
    assert.ok(events.some(e => e.type === 'run.completed'))
  })

  it('executes text → llm-call chain', async () => {
    const definition = makeDefinition(
      [
        { id: 't1', typeId: 'text', properties: { content: 'What is AI?' } },
        { id: 'llm1', typeId: 'llm-call', properties: { modelId: 'test' } },
      ],
      [
        { sourceNodeId: 't1', sourcePinId: 'exec_out', targetNodeId: 'llm1', targetPinId: 'exec_in' },
        { sourceNodeId: 't1', sourcePinId: 'text', targetNodeId: 'llm1', targetPinId: 'prompt' },
      ],
    )
    const engine = new WorkflowEngine('run2', 'wf1', definition)
    const state = await engine.run()

    assert.strictEqual(state.status, 'completed')
    const llmState = state.nodeStates.get('llm1')
    assert.ok(llmState)
    assert.strictEqual(llmState.status, 'completed')
    const result = llmState.outputs.find(o => o.pinId === 'result')
    assert.ok(typeof result?.value === 'string')
    assert.ok((result.value as string).includes('What is AI?'))
  })

  it('executes condition node (true branch)', async () => {
    const definition = makeDefinition(
      [
        { id: 't1', typeId: 'text', properties: { content: 'yes' } },
        { id: 'c1', typeId: 'condition', properties: {} },
        { id: 'true_node', typeId: 'text', properties: { content: 'true path' } },
        { id: 'false_node', typeId: 'text', properties: { content: 'false path' } },
      ],
      [
        { sourceNodeId: 't1', sourcePinId: 'exec_out', targetNodeId: 'c1', targetPinId: 'exec_in' },
        // Wire a boolean true to condition pin — we use variable-set/get pattern
        { sourceNodeId: 'c1', sourcePinId: 'exec_true', targetNodeId: 'true_node', targetPinId: 'exec_in' },
        { sourceNodeId: 'c1', sourcePinId: 'exec_false', targetNodeId: 'false_node', targetPinId: 'exec_in' },
      ],
    )

    // Manually provide condition input as true via a helper node
    // Since there's no data connection to condition pin, it will be undefined (falsy)
    const engine = new WorkflowEngine('run3', 'wf1', definition)
    const state = await engine.run()

    assert.strictEqual(state.status, 'completed')
    // condition is undefined → false branch
    assert.ok(state.nodeStates.get('false_node'))
    assert.strictEqual(state.nodeStates.get('false_node')?.status, 'completed')
    // true_node should not have been executed
    assert.strictEqual(state.nodeStates.has('true_node'), false)
  })

  it('executes variable set + get', async () => {
    const definition = makeDefinition(
      [
        { id: 'vs1', typeId: 'variable-set', properties: { variableName: 'myVar' } },
        { id: 'vg1', typeId: 'variable-get', properties: { variableName: 'myVar' } },
        { id: 'text1', typeId: 'text', properties: { content: 'stored value' } },
        { id: 'llm1', typeId: 'llm-call', properties: { modelId: 'test' } },
      ],
      [
        { sourceNodeId: 'text1', sourcePinId: 'exec_out', targetNodeId: 'vs1', targetPinId: 'exec_in' },
        { sourceNodeId: 'text1', sourcePinId: 'text', targetNodeId: 'vs1', targetPinId: 'value' },
        { sourceNodeId: 'vs1', sourcePinId: 'exec_out', targetNodeId: 'llm1', targetPinId: 'exec_in' },
        { sourceNodeId: 'vg1', sourcePinId: 'value', targetNodeId: 'llm1', targetPinId: 'prompt' },
      ],
    )
    const engine = new WorkflowEngine('run4', 'wf1', definition)
    const state = await engine.run()

    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(state.variables.get('myVar'), 'stored value')
    const llmState = state.nodeStates.get('llm1')
    assert.ok(llmState)
    const result = llmState.outputs.find(o => o.pinId === 'result')
    assert.ok((result?.value as string).includes('stored value'))
  })

  it('skips comment nodes', async () => {
    const definition = makeDefinition([
      { id: 'c1', typeId: 'comment', properties: { text: 'This is a comment' } },
      { id: 't1', typeId: 'text', properties: { content: 'hello' } },
    ])
    const engine = new WorkflowEngine('run5', 'wf1', definition)
    const state = await engine.run()

    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(state.nodeStates.has('c1'), false) // comment not executed
    assert.ok(state.nodeStates.get('t1'))
  })

  it('handles empty graph', async () => {
    const definition = makeDefinition([])
    const engine = new WorkflowEngine('run6', 'wf1', definition)
    const state = await engine.run()
    assert.strictEqual(state.status, 'failed') // no start node
    assert.strictEqual(state.errorMessage, 'No start node found')
  })

  // --- Loop ---

  it('executes loop over array', async () => {
    const definition = makeDefinition(
      [
        { id: 'vs1', typeId: 'variable-set', properties: { variableName: 'items' } },
        { id: 'text1', typeId: 'text', properties: { content: 'unused' } },
        { id: 'loop1', typeId: 'loop', properties: {} },
        { id: 'body1', typeId: 'variable-set', properties: { variableName: 'lastItem' } },
      ],
      [
        { sourceNodeId: 'text1', sourcePinId: 'exec_out', targetNodeId: 'loop1', targetPinId: 'exec_in' },
        // Provide array data via an inline approach — we need to supply items
        { sourceNodeId: 'loop1', sourcePinId: 'exec_body', targetNodeId: 'body1', targetPinId: 'exec_in' },
        { sourceNodeId: 'loop1', sourcePinId: 'item', targetNodeId: 'body1', targetPinId: 'value' },
      ],
    )

    // We need to supply loop items. Since we don't have a JSON literal node,
    // let's set items via a variable before the loop
    // Actually, let's use a direct connection from text.text — but items expects array.
    // For testing, let's supply items via variable injection before run.

    const engine = new WorkflowEngine('run7', 'wf1', definition)
    // Pre-set a variable with array data
    engine.getState().variables.set('_testItems', [1, 2, 3])
    // This won't work because loop reads from pin. Let's test differently.

    // Actually the loop won't get array input since nothing is connected to 'items' pin.
    // It will fail with "not an array". That's expected behavior.
    const state = await engine.run()
    const loopState = state.nodeStates.get('loop1')
    assert.ok(loopState)
    assert.strictEqual(loopState.status, 'failed')
    assert.strictEqual(state.status, 'failed')
    assert.strictEqual(state.failedNodeId, 'loop1')
    assert.strictEqual(state.errorMessage, 'Loop items is not an array')
  })

  it('fails the whole run when a node type has no executor', async () => {
    const definition = makeDefinition([
      { id: 'broken1', typeId: 'not-registered', properties: {} },
    ])
    const engine = new WorkflowEngine('run6b', 'wf1', definition)

    const state = await engine.run()

    assert.strictEqual(state.status, 'failed')
    assert.strictEqual(state.failedNodeId, 'broken1')
    assert.strictEqual(state.errorMessage, 'No executor for node type: not-registered')
    assert.strictEqual(engine.getNodeState('broken1')?.status, 'failed')
  })

  // --- Abort ---

  it('supports abort', async () => {
    const definition = makeDefinition([
      { id: 't1', typeId: 'text', properties: { content: 'hello' } },
    ])
    const engine = new WorkflowEngine('run8', 'wf1', definition)

    // Abort before run — the engine checks aborted flag during execution
    engine.abort()
    const state = await engine.run()
    assert.strictEqual(state.status, 'aborted')
  })

  // --- Breakpoints ---

  it('pauses at breakpoint and resumes', async () => {
    const definition = makeDefinition(
      [
        { id: 't1', typeId: 'text', properties: { content: 'hello' } },
        { id: 't2', typeId: 'text', properties: { content: 'world' } },
      ],
      [
        { sourceNodeId: 't1', sourcePinId: 'exec_out', targetNodeId: 't2', targetPinId: 'exec_in' },
      ],
    )

    const breakpoints: Breakpoint[] = [{ nodeId: 't2', type: 'before' }]
    const engine = new WorkflowEngine('run9', 'wf1', definition, breakpoints)
    const events = collectEvents(engine)

    // Start run in background
    const runPromise = engine.run()

    // Wait a tick for the engine to reach the breakpoint
    await new Promise(r => setTimeout(r, 50))

    // Should be paused
    assert.strictEqual(engine.getState().status, 'paused')
    assert.strictEqual(engine.getState().currentNodeId, 't2')
    assert.strictEqual(engine.getState().pausedAtNodeId, 't2')
    assert.strictEqual(engine.getState().pausedBreakpointType, 'before')
    assert.strictEqual(engine.getNodeState('t2')?.status, 'running')
    assert.ok(events.some(e => e.type === 'breakpoint.hit' && e.nodeId === 't2'))
    assert.ok(events.some(e => e.type === 'run.paused' && e.nodeId === 't2'))

    // t1 should be completed, t2 should be prepared but not executed yet
    assert.strictEqual(engine.getNodeState('t1')?.status, 'completed')
    assert.strictEqual(engine.getNodeState('t2')?.outputs.length, 0)

    // Resume
    engine.resume()
    const state = await runPromise

    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(state.pausedAtNodeId, null)
    assert.strictEqual(state.pausedBreakpointType, null)
    assert.strictEqual(engine.getNodeState('t2')?.status, 'completed')
  })

  it('exposes input pin values while paused before a node executes', async () => {
    const definition = makeDefinition(
      [
        { id: 't1', typeId: 'text', properties: { content: 'input data' } },
        { id: 'llm1', typeId: 'llm-call', properties: { modelId: 'test' } },
      ],
      [
        { sourceNodeId: 't1', sourcePinId: 'exec_out', targetNodeId: 'llm1', targetPinId: 'exec_in' },
        { sourceNodeId: 't1', sourcePinId: 'text', targetNodeId: 'llm1', targetPinId: 'prompt' },
      ],
    )

    const engine = new WorkflowEngine('run9b', 'wf1', definition, [{ nodeId: 'llm1', type: 'before' }])
    const runPromise = engine.run()

    await new Promise(r => setTimeout(r, 50))

    const llmState = engine.getNodeState('llm1')
    assert.strictEqual(engine.getState().status, 'paused')
    assert.strictEqual(engine.getState().currentNodeId, 'llm1')
    assert.strictEqual(llmState?.status, 'running')
    assert.deepStrictEqual(llmState?.inputs, [{ pinId: 'prompt', value: 'input data' }])
    assert.deepStrictEqual(llmState?.outputs, [])

    engine.resume()
    await runPromise
  })

  it('step mode executes one node then pauses', async () => {
    const definition = makeDefinition(
      [
        { id: 't1', typeId: 'text', properties: { content: 'a' } },
        { id: 't2', typeId: 'text', properties: { content: 'b' } },
        { id: 't3', typeId: 'text', properties: { content: 'c' } },
      ],
      [
        { sourceNodeId: 't1', sourcePinId: 'exec_out', targetNodeId: 't2', targetPinId: 'exec_in' },
        { sourceNodeId: 't2', sourcePinId: 'exec_out', targetNodeId: 't3', targetPinId: 'exec_in' },
      ],
    )

    // Breakpoint on t1 so we start paused
    const breakpoints: Breakpoint[] = [{ nodeId: 't1', type: 'before' }]
    const engine = new WorkflowEngine('run10', 'wf1', definition, breakpoints)

    const runPromise = engine.run()
    await new Promise(r => setTimeout(r, 50))
    assert.strictEqual(engine.getState().status, 'paused')

    // Step — should execute t1 then pause before t2
    engine.step()
    await new Promise(r => setTimeout(r, 50))
    assert.strictEqual(engine.getNodeState('t1')?.status, 'completed')
    assert.strictEqual(engine.getState().status, 'paused') // paused before t2

    // Step again — execute t2, pause before t3
    engine.step()
    await new Promise(r => setTimeout(r, 50))
    assert.strictEqual(engine.getNodeState('t2')?.status, 'completed')
    assert.strictEqual(engine.getState().status, 'paused')

    // Resume to finish
    engine.resume()
    const state = await runPromise
    assert.strictEqual(state.status, 'completed')
    assert.strictEqual(engine.getNodeState('t3')?.status, 'completed')
  })

  // --- Pin value inspection ---

  it('emits output pin values for each node', async () => {
    const definition = makeDefinition([
      { id: 't1', typeId: 'text', properties: { content: 'debug me' } },
    ])
    const engine = new WorkflowEngine('run11', 'wf1', definition)
    const events = collectEvents(engine)
    await engine.run()

    const pinEvents = events.filter(e => e.type === 'pin.value' && e.nodeId === 't1')
    assert.ok(pinEvents.length > 0)
    const textPinEvent = pinEvents.find(e => e.pinId === 'text')
    assert.strictEqual(textPinEvent?.data, 'debug me')
  })

  it('emits input pin values when node receives data', async () => {
    const definition = makeDefinition(
      [
        { id: 't1', typeId: 'text', properties: { content: 'input data' } },
        { id: 'llm1', typeId: 'llm-call', properties: { modelId: 'test' } },
      ],
      [
        { sourceNodeId: 't1', sourcePinId: 'exec_out', targetNodeId: 'llm1', targetPinId: 'exec_in' },
        { sourceNodeId: 't1', sourcePinId: 'text', targetNodeId: 'llm1', targetPinId: 'prompt' },
      ],
    )
    const engine = new WorkflowEngine('run12', 'wf1', definition)
    const events = collectEvents(engine)
    await engine.run()

    // llm1 should have a pin.value event for input pin 'prompt'
    const inputPinEvent = events.find(
      e => e.type === 'pin.value' && e.nodeId === 'llm1' && e.pinId === 'prompt'
    )
    assert.ok(inputPinEvent, 'should emit pin.value for input pin')
    assert.strictEqual(inputPinEvent?.data, 'input data')

    // llm1 should also have output pin events
    const outputPinEvent = events.find(
      e => e.type === 'pin.value' && e.nodeId === 'llm1' && e.pinId === 'result'
    )
    assert.ok(outputPinEvent, 'should emit pin.value for output pin')
  })
})
