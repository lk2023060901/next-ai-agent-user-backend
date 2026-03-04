import type { ChannelPlugin, ParsedMessage, TestResult } from './types'

export const dingtalkPlugin: ChannelPlugin = {
  type: 'dingtalk',
  label: '钉钉',

  verifyWebhook(): boolean {
    return true
  },

  handleChallenge(): string | null {
    return null
  },

  parseMessage(body): ParsedMessage | null {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      const text = parsed.text?.toString().trim() || parsed.content?.toString().trim() || ''
      if (!text) return null

      return {
        content: text,
        sender: String(parsed.senderStaffId ?? parsed.senderId ?? 'unknown'),
        chatId: String(parsed.conversationId ?? parsed.chatId ?? ''),
        threadId: '',
        messageId: String(parsed.msgId ?? parsed.messageId ?? ''),
      }
    } catch {
      return null
    }
  },

  async testConnection(): Promise<TestResult> {
    return {
      success: false,
      error: '钉钉连接测试暂未实现，请保存配置后进行实链路联调',
    }
  },
}
