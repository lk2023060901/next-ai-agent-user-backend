import type { NodeExecutor } from '../types.js'

export const textExecutor: NodeExecutor = async (ctx) => {
  const content = (ctx.properties.content as string) ?? ''
  ctx.setOutput('text', content)
  return 'exec_out'
}
