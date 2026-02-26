export interface ParsedMessage {
  content: string
  sender: string
  chatId?: string      // platform-specific chat/channel ID (for replies)
  threadId?: string    // feishu root_id, slack thread_ts, telegram message_thread_id
  messageId?: string
}

export interface TestResult {
  success: boolean
  botName?: string
  error?: string
}

export interface ChannelPlugin {
  /** Unique type identifier, must match DB channel.type */
  readonly type: string
  /** Human-readable display name */
  readonly label: string

  /** Verify incoming webhook request authenticity */
  verifyWebhook(
    body: string,
    headers: Record<string, string>,
    config: Record<string, string>,
  ): boolean

  /** Parse webhook body into a structured message */
  parseMessage(body: string): ParsedMessage | null

  /**
   * Handle platform challenge handshakes (e.g. Feishu URL verification).
   * Return the challenge string to respond with, or null if not a challenge.
   */
  handleChallenge?(body: string, config: Record<string, string>): string | null

  /** Test that the provided credentials can authenticate with the platform */
  testConnection(config: Record<string, string>): Promise<TestResult>

  /**
   * Send a text reply back to the platform.
   * chatId: platform chat/conversation ID (from ParsedMessage.chatId)
   * threadId: optional, reply inside a thread (Feishu root_id)
   */
  sendMessage?(
    chatId: string,
    text: string,
    config: Record<string, string>,
    threadId?: string,
  ): Promise<void>
}
