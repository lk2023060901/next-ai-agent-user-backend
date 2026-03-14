import type { NodeExecutor } from '../types.js'

// Placeholder — will integrate with Milvus
export const kbSearchExecutor: NodeExecutor = async (ctx) => {
  const query = ctx.getInput('query') as string
  const _kbId = ctx.properties.knowledgeBaseId as string
  const _topK = (ctx.properties.topK as number) ?? 5

  // TODO: integrate with Milvus vector search
  const results = [{ content: `[Search result for: ${query}]`, score: 0.95 }]

  ctx.setOutput('results', results)
  ctx.setOutput('topResult', results[0]?.content ?? '')
  return 'exec_out'
}
