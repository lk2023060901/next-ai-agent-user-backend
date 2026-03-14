import type { NodeExecutor } from '../types.js'

export const conditionExecutor: NodeExecutor = async (ctx) => {
  const condition = ctx.getInput('condition')
  return condition ? 'exec_true' : 'exec_false'
}
