import { eq } from 'drizzle-orm'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../../db'
import { channels, channelMessages, channelSessions, routingRules } from '../../db/schema'
import { config } from '../../config'
import { getPlugin } from './plugins'
import './plugins' // ensure all plugins are registered on import

// ─── Channel CRUD ─────────────────────────────────────────────────────────────

export function listChannels(workspaceId: string) {
  return db.select().from(channels).where(eq(channels.workspaceId, workspaceId)).all()
}

export function getChannel(channelId: string) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get()
  if (!ch) throw Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND' })
  return ch
}

export function createChannel(data: {
  workspaceId: string
  name: string
  type: string
  configJson?: string
}) {
  const id = uuidv4()
  db.insert(channels).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    type: data.type,
    configJson: data.configJson ?? '{}',
  }).run()
  return db.select().from(channels).where(eq(channels.id, id)).get()!
}

export function updateChannel(channelId: string, data: {
  name?: string
  status?: string
  configJson?: string
}) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get()
  if (!ch) throw Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND' })

  db.update(channels).set({
    ...(data.name && { name: data.name }),
    ...(data.status && { status: data.status }),
    ...(data.configJson !== undefined && { configJson: data.configJson }),
    updatedAt: new Date().toISOString(),
  }).where(eq(channels.id, channelId)).run()

  return db.select().from(channels).where(eq(channels.id, channelId)).get()!
}

export function deleteChannel(channelId: string) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get()
  if (!ch) throw Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND' })
  db.delete(channels).where(eq(channels.id, channelId)).run()
}

// ─── Routing Rules ────────────────────────────────────────────────────────────

export function listRoutingRules(channelId: string) {
  return db.select().from(routingRules).where(eq(routingRules.channelId, channelId)).all()
}

export function createRoutingRule(data: {
  channelId: string
  field: string
  operator: string
  value?: string
  targetAgentId?: string
  priority?: number
}) {
  const id = uuidv4()
  db.insert(routingRules).values({
    id,
    channelId: data.channelId,
    field: data.field,
    operator: data.operator,
    value: data.value ?? null,
    targetAgentId: data.targetAgentId ?? null,
    priority: data.priority ?? 0,
  }).run()
  return db.select().from(routingRules).where(eq(routingRules.id, id)).get()!
}

export function updateRoutingRule(ruleId: string, data: {
  field?: string
  operator?: string
  value?: string
  targetAgentId?: string
  priority?: number
  enabled?: boolean
}) {
  const rule = db.select().from(routingRules).where(eq(routingRules.id, ruleId)).get()
  if (!rule) throw Object.assign(new Error('Routing rule not found'), { code: 'NOT_FOUND' })

  db.update(routingRules).set({
    ...(data.field && { field: data.field }),
    ...(data.operator && { operator: data.operator }),
    ...(data.value !== undefined && { value: data.value }),
    ...(data.targetAgentId !== undefined && { targetAgentId: data.targetAgentId }),
    ...(data.priority !== undefined && { priority: data.priority }),
    ...(data.enabled !== undefined && { enabled: data.enabled }),
  }).where(eq(routingRules.id, ruleId)).run()

  return db.select().from(routingRules).where(eq(routingRules.id, ruleId)).get()!
}

export function deleteRoutingRule(ruleId: string) {
  const rule = db.select().from(routingRules).where(eq(routingRules.id, ruleId)).get()
  if (!rule) throw Object.assign(new Error('Routing rule not found'), { code: 'NOT_FOUND' })
  db.delete(routingRules).where(eq(routingRules.id, ruleId)).run()
}

// ─── Webhook Handling ─────────────────────────────────────────────────────────

export function handleWebhook(
  channelId: string,
  body: string,
  headers: Record<string, string>,
): { accepted: boolean; challenge?: string; message: string } {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get()
  if (!ch || ch.status !== 'active') {
    return { accepted: false, message: 'Channel not found or inactive' }
  }

  let channelConfig: Record<string, string> = {}
  try { channelConfig = JSON.parse(ch.configJson ?? '{}') } catch { /* ignore */ }

  const plugin = getPlugin(ch.type)

  // Handle platform challenge handshake first
  const challenge = plugin.handleChallenge?.(body, channelConfig)
  if (challenge !== null && challenge !== undefined) {
    return { accepted: true, challenge, message: 'challenge' }
  }

  // Verify webhook authenticity
  if (!plugin.verifyWebhook(body, headers, channelConfig)) {
    return { accepted: false, message: 'Invalid signature' }
  }

  // Parse the message
  const parsed = plugin.parseMessage(body)
  if (!parsed) {
    // Could be a non-message event (read receipt, bot added, etc.) — acknowledge silently
    return { accepted: true, message: 'ignored' }
  }

  // Store inbound message
  const msgId = uuidv4()
  db.insert(channelMessages).values({
    id: msgId,
    channelId,
    direction: 'inbound',
    sender: parsed.sender,
    content: parsed.content,
    status: 'received',
  }).run()

  // Match routing rules (sorted by priority desc)
  const rules = db
    .select()
    .from(routingRules)
    .where(eq(routingRules.channelId, channelId))
    .all()
    .filter((r) => r.enabled)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  const matchedRule = rules.find((rule) => matchRule(rule, parsed.content))

  if (matchedRule?.targetAgentId) {
    const agentId = matchedRule.targetAgentId

    // Upsert channel session — atomic, handles concurrent webhook delivery
    const sid = uuidv4()
    db.insert(channelSessions).values({
      id: sid,
      channelId,
      workspaceId: ch.workspaceId,
      senderId: parsed.sender,
      chatId: parsed.chatId ?? '',
      agentId,
      lastActiveAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [channelSessions.channelId, channelSessions.senderId, channelSessions.chatId],
      set: { agentId, lastActiveAt: new Date().toISOString() },
    }).run()
    const session = db.select().from(channelSessions).where(eq(channelSessions.id, sid)).get()
      ?? db.select().from(channelSessions)
        .where(eq(channelSessions.channelId, channelId))
        .all()
        .find((s) => s.senderId === parsed.sender && s.chatId === (parsed.chatId ?? ''))!

    // Fire-and-forget: dispatch to runtime without blocking Feishu webhook response
    fetch(`${config.runtimeAddr}/channel-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        sessionId: session.id,
        channelId,
        agentId,
        workspaceId: ch.workspaceId,
        message: parsed.content,
        sender: parsed.sender,
        chatId: parsed.chatId ?? '',
        threadId: parsed.threadId ?? '',
        messageId: parsed.messageId ?? '',
      }),
    }).catch((err: unknown) => {
      console.error(`[channel] dispatch to runtime failed: ${err instanceof Error ? err.message : err}`)
    })
  }

  return { accepted: true, message: 'ok' }
}

function matchRule(rule: typeof routingRules.$inferSelect, content: string): boolean {
  const val = rule.value ?? ''
  switch (rule.operator) {
    case 'contains': return content.includes(val)
    case 'starts_with': return content.startsWith(val)
    case 'equals': return content === val
    case 'regex': try { return new RegExp(val).test(content) } catch { return false }
    default: return false
  }
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function listChannelMessages(channelId: string, limit = 50) {
  return db
    .select()
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channelId))
    .all()
    .slice(-limit)
}

export async function sendChannelMessage(data: {
  channelId: string
  chatId: string
  text: string
  threadId?: string
}): Promise<void> {
  const ch = db.select().from(channels).where(eq(channels.id, data.channelId)).get()
  if (!ch || ch.status !== 'active') throw Object.assign(new Error('Channel not found or inactive'), { code: 'NOT_FOUND' })

  let channelConfig: Record<string, string> = {}
  try { channelConfig = JSON.parse(ch.configJson ?? '{}') } catch { /* ignore */ }

  const plugin = getPlugin(ch.type)
  if (!plugin.sendMessage) {
    throw Object.assign(
      new Error(`Plugin ${ch.type} does not support sendMessage`),
      { code: 'UNIMPLEMENTED' }
    )
  }

  await plugin.sendMessage(data.chatId, data.text, channelConfig, data.threadId)

  // 存储出站消息
  db.insert(channelMessages).values({
    id: uuidv4(),
    channelId: data.channelId,
    direction: 'outbound',
    sender: 'agent',
    content: data.text,
    status: 'sent',
  }).run()
}
