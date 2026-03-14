import type { NodeExecutor } from '../types.js'

// Placeholder — will be replaced with real pi-ai provider call
export const llmCallExecutor: NodeExecutor = async (ctx) => {
  const prompt = ctx.getInput('prompt') as string
  const _context = ctx.getInput('context') as string | undefined
  const _modelId = ctx.properties.modelId as string
  const _systemPrompt = ctx.properties.systemPrompt as string | undefined

  try {
    // TODO: integrate with pi-ai provider
    const result = `[LLM response to: ${prompt}]`
    const usage = prompt.length // placeholder token count

    ctx.setOutput('result', result)
    ctx.setOutput('usage', usage)
    return 'exec_out'
  } catch (err) {
    ctx.setOutput('result', '')
    ctx.setOutput('usage', 0)
    return 'exec_error'
  }
}
