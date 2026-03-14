import type { NodeExecutor } from '../types.js'

export const variableSetExecutor: NodeExecutor = async (ctx) => {
  const name = ctx.properties.variableName as string
  const value = ctx.getInput('value')
  ctx.setVariable(name, value)
  return 'exec_out'
}

export const variableGetExecutor: NodeExecutor = async (ctx) => {
  const name = ctx.properties.variableName as string
  const value = ctx.getVariable(name)
  ctx.setOutput('value', value ?? null)
  // No exec pin — pure data node
  return undefined
}
