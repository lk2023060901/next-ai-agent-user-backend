import type { NodeExecutor } from '../types.js'

// Placeholder — will integrate with Go delivery
export const sendMessageExecutor: NodeExecutor = async (ctx) => {
  const content = ctx.getInput('content') as string
  const _channelId = ctx.properties.channelId as string

  try {
    // TODO: call Go gateway to deliver message
    const messageId = `msg_${Date.now()}`
    ctx.setOutput('messageId', messageId)
    return 'exec_out'
  } catch {
    ctx.setOutput('messageId', '')
    return 'exec_error'
  }
}
