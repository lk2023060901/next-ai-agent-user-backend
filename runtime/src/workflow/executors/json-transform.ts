import type { NodeExecutor } from '../types.js'

export const jsonTransformExecutor: NodeExecutor = async (ctx) => {
  const input = ctx.getInput('input')
  const expression = ctx.properties.expression as string

  try {
    // Simple JSONPath-like extraction: supports "field.subfield" notation
    let result: unknown = input
    if (expression && typeof input === 'object' && input !== null) {
      const parts = expression.split('.')
      for (const part of parts) {
        if (result && typeof result === 'object') {
          result = (result as Record<string, unknown>)[part]
        } else {
          result = undefined
          break
        }
      }
    }
    ctx.setOutput('output', result ?? null)
    return 'exec_out'
  } catch {
    ctx.setOutput('output', null)
    return 'exec_out'
  }
}
