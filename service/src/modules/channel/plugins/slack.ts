import crypto from 'crypto'
import type { ChannelPlugin, ParsedMessage, TestResult } from './types'

export const slackPlugin: ChannelPlugin = {
  type: 'slack',
  label: 'Slack',

  verifyWebhook(body, headers, config): boolean {
    const secret = config.signingSecret
    if (!secret) return true

    const ts = headers['x-slack-request-timestamp']
    const sig = headers['x-slack-signature']
    if (!ts || !sig) return false

    // Reject requests older than 5 minutes
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false

    const base = `v0:${ts}:${body}`
    const expected = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex')
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  },

  handleChallenge(body): string | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (parsed.type === 'url_verification' && typeof parsed.challenge === 'string') {
        return parsed.challenge
      }
    } catch { /* ignore */ }
    return null
  },

  parseMessage(body): ParsedMessage | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      // Skip retries and bot messages
      if (parsed.retry_num) return null
      const event = parsed.event as Record<string, unknown> | undefined
      if (!event || event.bot_id) return null
      if (event.type !== 'message' && event.type !== 'app_mention') return null

      return {
        content: String(event.text ?? ''),
        sender: String(event.user ?? 'unknown'),
        chatId: String(event.channel ?? ''),
        threadId: String(event.thread_ts ?? ''),
        messageId: String(event.ts ?? ''),
      }
    } catch { return null }
  },

  async testConnection(config): Promise<TestResult> {
    const { botToken } = config
    if (!botToken) return { success: false, error: '缺少 Bot Token' }

    try {
      const res = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${botToken}` },
      })
      const data = await res.json() as { ok: boolean; error?: string; bot_id?: string; user?: string }
      if (data.ok) return { success: true, botName: data.user ?? data.bot_id ?? 'Slack Bot' }
      return { success: false, error: data.error ?? '认证失败' }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
