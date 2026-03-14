import type { NodeExecutor } from '../types.js'

// Loop is special — the engine handles iteration.
// This executor runs once per iteration, setting item + index.
export const loopExecutor: NodeExecutor = async (ctx) => {
  // The engine sets __loopItem and __loopIndex before each call
  const item = ctx.properties.__loopItem
  const index = ctx.properties.__loopIndex as number
  ctx.setOutput('item', item)
  ctx.setOutput('index', index)
  return 'exec_body'
}

// Called when loop ends
export const loopDoneExecutor: NodeExecutor = async () => {
  return 'exec_done'
}
