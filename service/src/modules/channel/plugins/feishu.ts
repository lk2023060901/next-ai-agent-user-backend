/**
 * Feishu/Lark channel plugin — adapter over @larksuiteoapi/node-sdk.
 * Webhook verification and challenge follow SDK conventions (EventDispatcher internals).
 * testConnection mirrors OpenClaw's probe.ts using /open-apis/bot/v3/info.
 */
import crypto from 'crypto'
import * as Lark from '@larksuiteoapi/node-sdk'
import type { ChannelPlugin, ParsedMessage, TestResult } from './types'

// Client cache keyed by appId
const clientCache = new Map<string, { client: Lark.Client; appSecret: string }>()

function getLarkClient(appId: string, appSecret: string): Lark.Client {
  const cached = clientCache.get(appId)
  if (cached && cached.appSecret === appSecret) return cached.client
  const client = new Lark.Client({ appId, appSecret, appType: Lark.AppType.SelfBuild })
  clientCache.set(appId, { client, appSecret })
  return client
}

export const feishuPlugin: ChannelPlugin = {
  type: 'feishu',
  label: '飞书',

  /**
   * Verify webhook signature using the same algorithm as Lark.EventDispatcher:
   * sha256(timestamp + nonce + encryptKey + body) == x-lark-signature
   * If no encryptKey configured, allow through (development mode).
   */
  verifyWebhook(body, headers, config): boolean {
    const { encryptKey } = config
    if (!encryptKey) return true

    const timestamp = headers['x-lark-request-timestamp'] ?? ''
    const nonce = headers['x-lark-request-nonce'] ?? ''
    const signature = headers['x-lark-signature'] ?? ''
    if (!timestamp || !signature) return true // unsigned request (e.g. plain challenge)

    const toSign = timestamp + nonce + encryptKey + body
    const expected = crypto.createHash('sha256').update(toSign).digest('hex')
    return expected === signature
  },

  /**
   * Handle Lark URL verification challenge.
   * Supports both plaintext and AES-encrypted challenge (EventDispatcher behavior).
   */
  handleChallenge(body, config): string | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      // Plaintext challenge
      if (parsed.type === 'url_verification' && typeof parsed.challenge === 'string') {
        return parsed.challenge
      }
      // Encrypted challenge — delegate to EventDispatcher for AES-CBC decryption
      if (typeof parsed.encrypt === 'string' && config.encryptKey) {
        const dispatcher = new Lark.EventDispatcher({ encryptKey: config.encryptKey })
        // EventDispatcher.decrypt is internal but accessible
        const decrypted = (dispatcher as unknown as { decrypt: (s: string) => string }).decrypt(
          parsed.encrypt,
        )
        const inner = JSON.parse(decrypted) as Record<string, unknown>
        if (inner.type === 'url_verification' && typeof inner.challenge === 'string') {
          return inner.challenge
        }
      }
    } catch { /* ignore */ }
    return null
  },

  /**
   * Parse incoming Feishu IM message event (im.message.receive_v1).
   */
  parseMessage(body): ParsedMessage | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      const event = parsed.event as Record<string, unknown> | undefined
      if (!event) return null

      const message = event.message as Record<string, unknown> | undefined
      const msgType = message?.message_type as string | undefined
      if (msgType && msgType !== 'text') return null

      let content = ''
      if (typeof message?.content === 'string') {
        try {
          const c = JSON.parse(message.content) as { text?: string }
          content = c.text ?? ''
        } catch { content = message.content }
      }

      const sender = event.sender as Record<string, unknown> | undefined
      const senderId =
        ((sender?.sender_id as Record<string, unknown>)?.open_id as string | undefined) ??
        'unknown'

      return {
        content,
        sender: senderId,
        chatId: String(message?.chat_id ?? ''),
        threadId: (event.root_id as string | undefined) || undefined,
        messageId: String(message?.message_id ?? ''),
      }
    } catch { return null }
  },

  /**
   * Test connection by calling /open-apis/bot/v3/info — same as OpenClaw probe.ts.
   */
  async testConnection(config): Promise<TestResult> {
    const { appId, appSecret } = config
    if (!appId || !appSecret) return { success: false, error: '缺少 App ID 或 App Secret' }

    try {
      const client = getLarkClient(appId, appSecret)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client as any).request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
        data: {},
      })

      if (response.code !== 0) {
        return { success: false, error: `API error: ${response.msg ?? `code ${response.code}`}` }
      }

      const bot = response.bot ?? response.data?.bot
      return { success: true, botName: bot?.bot_name ?? '飞书应用' }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async sendMessage(chatId, text, config, threadId): Promise<void> {
    const { appId, appSecret } = config
    if (!appId || !appSecret) throw new Error('缺少 appId / appSecret')
    const client = getLarkClient(appId, appSecret)
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        ...(threadId ? { root_id: threadId } : {}),
      },
    })
  },
}
