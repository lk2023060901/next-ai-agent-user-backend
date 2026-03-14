import type { NodeExecutor } from '../types.js'

// This node intentionally evaluates user-provided code.
// In production, this should run in an isolated sandbox (e.g. VM2, isolated-vm, or a container).
// Current implementation uses Function constructor as a placeholder.
export const codeExecuteExecutor: NodeExecutor = async (ctx) => {
  const input = ctx.getInput('input')
  const code = ctx.properties.code as string

  try {
    // SECURITY NOTE: This is a placeholder. Production must use a sandboxed runtime.
    const fn = new Function('input', `'use strict'; ${code}`) // eslint-disable-line no-new-func
    const output = fn(input)
    ctx.setOutput('output', output ?? null)
    return 'exec_out'
  } catch {
    ctx.setOutput('output', null)
    return 'exec_error'
  }
}
