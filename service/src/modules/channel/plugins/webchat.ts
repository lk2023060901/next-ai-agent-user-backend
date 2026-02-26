import crypto from 'crypto'
import type { ChannelPlugin, ParsedMessage, TestResult } from './types'

export const webchatPlugin: ChannelPlugin = {
  type: 'webchat',
  label: 'Web Chat',

  verifyWebhook(body, headers, config): boolean {
    const secret = config.webhookSecret
    if (!secret) return true

    const signature = headers['x-webchat-signature'] ?? headers['x-hub-signature-256']
    if (!signature) return false

    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    } catch { return false }
  },

  handleChallenge(): string | null {
    return null
  },

  parseMessage(body): ParsedMessage | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      const content = parsed.message ?? parsed.content ?? parsed.text
      if (typeof content !== 'string') return null

      return {
        content,
        sender: String(parsed.userId ?? parsed.user_id ?? parsed.sender ?? 'anonymous'),
        chatId: String(parsed.sessionId ?? parsed.session_id ?? ''),
        threadId: '',
        messageId: String(parsed.messageId ?? parsed.message_id ?? ''),
      }
    } catch { return null }
  },

  async testConnection(_config): Promise<TestResult> {
    return { success: true, botName: 'Web Chat Widget' }
  },
}
