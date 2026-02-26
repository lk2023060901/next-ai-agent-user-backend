import crypto from 'crypto'
import type { ChannelPlugin, ParsedMessage, TestResult } from './types'

export const telegramPlugin: ChannelPlugin = {
  type: 'telegram',
  label: 'Telegram',

  verifyWebhook(_body, headers, config): boolean {
    // Telegram sends a secret token in X-Telegram-Bot-Api-Secret-Token header
    const secretToken = config.secretToken
    if (!secretToken) return true // skip if not configured

    const received = headers['x-telegram-bot-api-secret-token']
    if (!received) return false

    // Constant-time comparison
    try {
      return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(secretToken))
    } catch { return false }
  },

  handleChallenge(): string | null {
    // Telegram has no challenge handshake
    return null
  },

  parseMessage(body): ParsedMessage | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      const message = (parsed.message ?? parsed.edited_message ?? parsed.channel_post) as Record<string, unknown> | undefined
      if (!message) return null

      const text = message.text as string | undefined
      if (text === undefined) return null // only handle text messages

      const from = message.from as Record<string, unknown> | undefined
      const chat = message.chat as Record<string, unknown> | undefined

      return {
        content: text,
        sender: String(from?.id ?? 'unknown'),
        chatId: String(chat?.id ?? ''),
        threadId: String(message.message_thread_id ?? ''),
        messageId: String(message.message_id ?? ''),
      }
    } catch { return null }
  },

  async testConnection(config): Promise<TestResult> {
    const { botToken } = config
    if (!botToken) return { success: false, error: '缺少 Bot Token' }

    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
      const data = await res.json() as { ok: boolean; result?: { username?: string }; description?: string }
      if (data.ok && data.result) {
        return { success: true, botName: `@${data.result.username ?? 'telegram_bot'}` }
      }
      return { success: false, error: data.description ?? '认证失败' }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
