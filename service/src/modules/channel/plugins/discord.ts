import crypto from 'crypto'
import type { ChannelPlugin, ParsedMessage, TestResult } from './types'

export const discordPlugin: ChannelPlugin = {
  type: 'discord',
  label: 'Discord',

  verifyWebhook(body, headers, config): boolean {
    const publicKey = config.publicKey
    if (!publicKey) return true

    const signature = headers['x-signature-ed25519']
    const timestamp = headers['x-signature-timestamp']
    if (!signature || !timestamp) return false

    try {
      return crypto.verify(
        'ed25519',
        Buffer.from(timestamp + body),
        Buffer.from(publicKey, 'hex'),
        Buffer.from(signature, 'hex'),
      )
    } catch { return false }
  },

  handleChallenge(body): string | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      // Discord PING interaction type = 1
      if (parsed.type === 1) return 'pong' // caller must wrap as { type: 1 }
    } catch { /* ignore */ }
    return null
  },

  parseMessage(body): ParsedMessage | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      // Only handle MESSAGE_CREATE type (0 = PING, 1 = APPLICATION_COMMAND, etc.)
      if (parsed.type === 1) return null // PING, already handled as challenge
      if (!parsed.content && !parsed.data) return null

      const member = parsed.member as Record<string, unknown> | undefined
      const author = parsed.author as Record<string, unknown> | undefined
      const user = (member?.user ?? author) as Record<string, unknown> | undefined

      return {
        content: String(parsed.content ?? ''),
        sender: String(user?.id ?? 'unknown'),
        chatId: String(parsed.channel_id ?? ''),
        threadId: '',
        messageId: String(parsed.id ?? ''),
      }
    } catch { return null }
  },

  async testConnection(config): Promise<TestResult> {
    const { botToken } = config
    if (!botToken) return { success: false, error: '缺少 Bot Token' }

    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${botToken}` },
      })
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` }
      const data = await res.json() as { username?: string }
      return { success: true, botName: data.username ?? 'Discord Bot' }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
