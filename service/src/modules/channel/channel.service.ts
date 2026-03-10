import { and, eq, inArray } from 'drizzle-orm'
import * as Lark from '@larksuiteoapi/node-sdk'
import { v4 as uuidv4 } from 'uuid'
import { db } from '../../db/index.js'
import {
  channels,
  channelMessages,
  channelSessions,
  chatSessions,
  installedPlugins,
  routingRules,
} from '../../db/schema.js'
import { config } from '../../config.js'
import { getPlugin, type ParsedMessage } from './plugins/index.js'
import './plugins/index.js' // ensure all plugins are registered on import

type ChannelRow = typeof channels.$inferSelect

// ─── Runtime Connection State ───────────────────────────────────────────────

type FeishuConnectionMode = 'websocket' | 'webhook'

type FeishuRuntimeState = {
  channelId: string
  mode: FeishuConnectionMode
  state: 'inactive' | 'webhook' | 'disconnected' | 'connecting' | 'connected' | 'error'
  connected: boolean
  lastConnectedAt: string
  lastError: string
  wsClient?: Lark.WSClient
  pollTimer?: ReturnType<typeof setInterval>
}

type ChannelRuntimeConnection = {
  realtimeConnected: boolean
  connectionState: string
  connectionMode: string
  lastConnectedAt: string
  connectionLastError: string
}

const FEISHU_POLL_INTERVAL_MS = 3000
const feishuRuntimeByChannel = new Map<string, FeishuRuntimeState>()
const SUPPORTED_CHANNEL_TYPES = new Set([
  'slack',
  'discord',
  'telegram',
  'feishu',
  'dingtalk',
  'wecom',
])

export function isSupportedChannelType(type: string): boolean {
  return SUPPORTED_CHANNEL_TYPES.has(type.trim().toLowerCase())
}

function assertSupportedChannelType(type: string): void {
  if (isSupportedChannelType(type)) return
  throw Object.assign(new Error(`Unsupported channel type: ${type}`), { code: 'INVALID_ARGUMENT' })
}

function assertChannelPluginInstalled(workspaceId: string, channelType: string): void {
  const row = db
    .select({ status: installedPlugins.status })
    .from(installedPlugins)
    .where(
      and(
        eq(installedPlugins.workspaceId, workspaceId),
        eq(installedPlugins.pluginId, channelType),
      ),
    )
    .get()

  const status = (row?.status ?? '').trim().toLowerCase()
  if (status === 'enabled' || status === 'active') return

  throw Object.assign(
    new Error(`Channel plugin "${channelType}" is not installed or not enabled`),
    { code: 'FAILED_PRECONDITION' },
  )
}

function parseChannelConfig(configJson?: string | null): Record<string, string> {
  if (!configJson) return {}
  try {
    const parsed = JSON.parse(configJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[channel] parseChannelConfig: parsed value is not a plain object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`)
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]),
    )
  } catch (err) {
    console.warn(`[channel] parseChannelConfig: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

function resolveFeishuConnectionMode(configMap: Record<string, string>): FeishuConnectionMode {
  return configMap.connectionMode?.trim().toLowerCase() === 'webhook' ? 'webhook' : 'websocket'
}

function resolveFeishuDomain(raw: string | undefined): Lark.Domain | string {
  const normalized = (raw ?? '').trim().toLowerCase()
  if (!normalized || normalized === 'feishu') return Lark.Domain.Feishu
  if (normalized === 'lark') return Lark.Domain.Lark
  return raw?.trim().replace(/\/+$/, '') ?? Lark.Domain.Feishu
}

function getChannelRuntimeConnection(
  channel: Pick<ChannelRow, 'id' | 'type' | 'status'> & { configJson?: string | null },
): ChannelRuntimeConnection {
  if (channel.type !== 'feishu') {
    const connected = channel.status === 'active'
    return {
      realtimeConnected: connected,
      connectionState: connected ? 'connected' : 'disconnected',
      connectionMode: '',
      lastConnectedAt: '',
      connectionLastError: '',
    }
  }

  const cfg = parseChannelConfig(channel.configJson)
  const mode = resolveFeishuConnectionMode(cfg)

  if (channel.status !== 'active') {
    return {
      realtimeConnected: false,
      connectionState: 'inactive',
      connectionMode: mode,
      lastConnectedAt: '',
      connectionLastError: '',
    }
  }

  if (mode === 'webhook') {
    return {
      realtimeConnected: false,
      connectionState: 'webhook',
      connectionMode: mode,
      lastConnectedAt: '',
      connectionLastError: '',
    }
  }

  const runtime = feishuRuntimeByChannel.get(channel.id)
  return {
    realtimeConnected: runtime?.connected ?? false,
    connectionState: runtime?.state ?? 'disconnected',
    connectionMode: mode,
    lastConnectedAt: runtime?.lastConnectedAt ?? '',
    connectionLastError: runtime?.lastError ?? '',
  }
}

function updateFeishuRuntimeState(channelId: string, update: Partial<FeishuRuntimeState>): void {
  const current = feishuRuntimeByChannel.get(channelId)
  if (!current) return
  feishuRuntimeByChannel.set(channelId, { ...current, ...update })
}

function stopFeishuLongConnection(channelId: string): void {
  const current = feishuRuntimeByChannel.get(channelId)
  if (!current) return

  if (current.pollTimer) {
    clearInterval(current.pollTimer)
  }
  try {
    current.wsClient?.close({ force: true })
  } catch {
    // ignore close errors
  }

  feishuRuntimeByChannel.delete(channelId)
}

function dispatchInboundToRuntime(params: {
  channel: ChannelRow
  parsed: ParsedMessage
  agentId: string
  sessionId: string
}): void {
  void fetch(`${config.runtimeAddr}/channel-run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Runtime-Secret': config.runtimeSecret,
    },
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({
      sessionId: params.sessionId,
      channelId: params.channel.id,
      agentId: params.agentId,
      workspaceId: params.channel.workspaceId,
      message: params.parsed.content,
      sender: params.parsed.sender,
      chatId: params.parsed.chatId ?? '',
      threadId: params.parsed.threadId ?? '',
      messageId: params.parsed.messageId ?? '',
    }),
  }).catch((err: unknown) => {
    console.error(`[channel] dispatch to runtime failed: ${err instanceof Error ? err.message : err}`)
  })
}

function ingestParsedMessage(channel: ChannelRow, parsed: ParsedMessage): void {
  db.insert(channelMessages).values({
    id: uuidv4(),
    channelId: channel.id,
    direction: 'inbound',
    sender: parsed.sender,
    content: parsed.content,
    status: 'received',
  }).run()

  const rules = db
    .select()
    .from(routingRules)
    .where(eq(routingRules.channelId, channel.id))
    .all()
    .filter((r) => r.enabled)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  const matchedRule = rules.find((rule) => matchRule(rule, parsed.content))
  if (!matchedRule?.targetAgentId) return

  const agentId = matchedRule.targetAgentId
  const sid = uuidv4()
  db.insert(channelSessions).values({
    id: sid,
    channelId: channel.id,
    workspaceId: channel.workspaceId,
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
      .where(eq(channelSessions.channelId, channel.id))
      .all()
      .find((s) => s.senderId === parsed.sender && s.chatId === (parsed.chatId ?? ''))!

  db.insert(chatSessions).values({
    id: session.id,
    workspaceId: channel.workspaceId,
    title: `${channel.name} / ${parsed.sender}`,
    status: 'active',
    messageCount: 0,
    lastMessageAt: new Date().toISOString(),
  }).onConflictDoNothing().run()

  db.update(chatSessions)
    .set({ lastMessageAt: new Date().toISOString() })
    .where(eq(chatSessions.id, session.id))
    .run()

  dispatchInboundToRuntime({
    channel,
    parsed,
    agentId,
    sessionId: session.id,
  })
}

function startFeishuLongConnection(channel: ChannelRow): void {
  stopFeishuLongConnection(channel.id)

  const cfg = parseChannelConfig(channel.configJson)
  const mode = resolveFeishuConnectionMode(cfg)

  if (mode === 'webhook') {
    feishuRuntimeByChannel.set(channel.id, {
      channelId: channel.id,
      mode,
      state: 'webhook',
      connected: false,
      lastConnectedAt: '',
      lastError: '',
    })
    return
  }

  const appId = cfg.appId?.trim()
  const appSecret = cfg.appSecret?.trim()
  if (!appId || !appSecret) {
    console.warn(`[channel][feishu] channel=${channel.id} missing appId/appSecret, websocket not started`)
    feishuRuntimeByChannel.set(channel.id, {
      channelId: channel.id,
      mode,
      state: 'error',
      connected: false,
      lastConnectedAt: '',
      lastError: '缺少 App ID 或 App Secret',
    })
    return
  }

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    domain: resolveFeishuDomain(cfg.domain),
    loggerLevel: Lark.LoggerLevel.info,
  })

  feishuRuntimeByChannel.set(channel.id, {
    channelId: channel.id,
    mode,
    state: 'connecting',
    connected: false,
    lastConnectedAt: '',
    lastError: '',
    wsClient,
  })

  const eventDispatcher = new Lark.EventDispatcher({
    encryptKey: cfg.encryptKey?.trim() || undefined,
    verificationToken: cfg.verificationToken?.trim() || undefined,
  })

  eventDispatcher.register({
    'im.message.receive_v1': async (data) => {
      const now = new Date().toISOString()
      updateFeishuRuntimeState(channel.id, {
        state: 'connected',
        connected: true,
        lastConnectedAt: now,
        lastError: '',
      })

      try {
        const parser = getPlugin('feishu')
        const body = JSON.stringify({ event: data ?? {} })
        const parsed = parser.parseMessage(body)
        if (parsed) ingestParsedMessage(channel, parsed)
      } catch (err) {
        console.error(`[channel][feishu] parse websocket event failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })

  const pollTimer = setInterval(() => {
    const runtime = feishuRuntimeByChannel.get(channel.id)
    if (!runtime?.wsClient) return

    const wsInstance = (
      runtime.wsClient as unknown as { wsConfig?: { getWSInstance?: () => { readyState?: number } | null } }
    ).wsConfig?.getWSInstance?.()

    const isOpen = wsInstance?.readyState === 1
    if (isOpen) {
      updateFeishuRuntimeState(channel.id, {
        state: 'connected',
        connected: true,
        lastConnectedAt: runtime.lastConnectedAt || new Date().toISOString(),
      })
      return
    }

    if (runtime.state !== 'error' && runtime.state !== 'inactive' && runtime.state !== 'webhook') {
      updateFeishuRuntimeState(channel.id, {
        state: 'connecting',
        connected: false,
      })
    }
  }, FEISHU_POLL_INTERVAL_MS)

  updateFeishuRuntimeState(channel.id, { pollTimer })

  console.log(`[channel][feishu] channel=${channel.id} starting websocket connection`)
  void wsClient.start({ eventDispatcher }).catch((err: unknown) => {
    updateFeishuRuntimeState(channel.id, {
      state: 'error',
      connected: false,
      lastError: err instanceof Error ? err.message : String(err),
    })
    console.error(`[channel][feishu] websocket start failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

function syncFeishuLongConnection(channel: ChannelRow): void {
  if (channel.type !== 'feishu') {
    stopFeishuLongConnection(channel.id)
    return
  }

  if (channel.status !== 'active') {
    stopFeishuLongConnection(channel.id)
    return
  }

  startFeishuLongConnection(channel)
}

export function bootstrapChannelConnections(): void {
  const activeRows = db
    .select()
    .from(channels)
    .where(eq(channels.status, 'active'))
    .all()

  for (const row of activeRows) {
    syncFeishuLongConnection(row)
  }
}

// ─── Channel CRUD ─────────────────────────────────────────────────────────────

type ChannelConnectionStats = {
  connectedChannels: number
  lastActiveAt: string
}

function buildConnectionStatsByChannel(workspaceId: string): Map<string, ChannelConnectionStats> {
  const stats = new Map<string, ChannelConnectionStats>()
  const senderSets = new Map<string, Set<string>>()
  const channelRows = db.select({ id: channels.id }).from(channels).where(eq(channels.workspaceId, workspaceId)).all()
  const channelIds = channelRows.map((row) => row.id)
  if (channelIds.length === 0) return stats

  const sessions = db
    .select()
    .from(channelSessions)
    .where(eq(channelSessions.workspaceId, workspaceId))
    .all()

  for (const session of sessions) {
    const key = session.channelId
    const current = stats.get(key) ?? { connectedChannels: 0, lastActiveAt: '' }
    const sender = (session.senderId ?? '').trim()
    if (sender) {
      const set = senderSets.get(key) ?? new Set<string>()
      if (!set.has(sender)) {
        set.add(sender)
        current.connectedChannels += 1
      }
      senderSets.set(key, set)
    }

    const currentAt = current.lastActiveAt ? Date.parse(current.lastActiveAt) : Number.NaN
    const nextAt = session.lastActiveAt ? Date.parse(session.lastActiveAt) : Number.NaN
    if (Number.isNaN(currentAt) || (!Number.isNaN(nextAt) && nextAt > currentAt)) {
      current.lastActiveAt = session.lastActiveAt ?? ''
    }
    stats.set(key, current)
  }

  const inboundMessages = db
    .select()
    .from(channelMessages)
    .where(and(inArray(channelMessages.channelId, channelIds), eq(channelMessages.direction, 'inbound')))
    .all()
  for (const message of inboundMessages) {
    const key = message.channelId
    const current = stats.get(key) ?? { connectedChannels: 0, lastActiveAt: '' }
    const sender = (message.sender ?? '').trim()
    if (sender) {
      const set = senderSets.get(key) ?? new Set<string>()
      if (!set.has(sender)) {
        set.add(sender)
        current.connectedChannels += 1
      }
      senderSets.set(key, set)
    }

    const currentAt = current.lastActiveAt ? Date.parse(current.lastActiveAt) : Number.NaN
    const nextAt = message.createdAt ? Date.parse(message.createdAt) : Number.NaN
    if (Number.isNaN(currentAt) || (!Number.isNaN(nextAt) && nextAt > currentAt)) {
      current.lastActiveAt = message.createdAt ?? current.lastActiveAt
    }
    stats.set(key, current)
  }

  return stats
}

function attachConnectionStats<
  T extends { id: string; workspaceId: string; type: string; status: string; configJson?: string | null },
>(
  channel: T,
  statsByChannel: Map<string, ChannelConnectionStats>,
): T & ChannelConnectionStats & ChannelRuntimeConnection {
  const stats = statsByChannel.get(channel.id)
  const runtimeConnection = getChannelRuntimeConnection(channel)
  return {
    ...channel,
    connectedChannels: stats?.connectedChannels ?? 0,
    lastActiveAt: stats?.lastActiveAt ?? '',
    ...runtimeConnection,
  }
}

export function listChannels(workspaceId: string) {
  const rows = db
    .select()
    .from(channels)
    .where(eq(channels.workspaceId, workspaceId))
    .all()
    .filter((row) => isSupportedChannelType(row.type))
  const statsByChannel = buildConnectionStatsByChannel(workspaceId)
  return rows.map((row) => attachConnectionStats(row, statsByChannel))
}

export function getChannel(channelId: string) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get()
  if (!ch) throw Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND' })
  if (!isSupportedChannelType(ch.type)) {
    throw Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND' })
  }
  const statsByChannel = buildConnectionStatsByChannel(ch.workspaceId)
  return attachConnectionStats(ch, statsByChannel)
}

export function createChannel(data: {
  workspaceId: string
  name: string
  type: string
  configJson?: string
}) {
  const channelType = data.type.trim().toLowerCase()
  assertSupportedChannelType(channelType)
  assertChannelPluginInstalled(data.workspaceId, channelType)
  const id = uuidv4()
  db.insert(channels).values({
    id,
    workspaceId: data.workspaceId,
    name: data.name,
    type: channelType,
    configJson: data.configJson ?? '{}',
  }).run()
  const created = db.select().from(channels).where(eq(channels.id, id)).get()!
  syncFeishuLongConnection(created)
  const statsByChannel = buildConnectionStatsByChannel(created.workspaceId)
  return attachConnectionStats(created, statsByChannel)
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

  const updated = db.select().from(channels).where(eq(channels.id, channelId)).get()!
  syncFeishuLongConnection(updated)
  const statsByChannel = buildConnectionStatsByChannel(updated.workspaceId)
  return attachConnectionStats(updated, statsByChannel)
}

export function deleteChannel(channelId: string) {
  const ch = db.select().from(channels).where(eq(channels.id, channelId)).get()
  if (!ch) throw Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND' })
  stopFeishuLongConnection(channelId)
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

  const channelConfig = parseChannelConfig(ch.configJson)
  const plugin = getPlugin(ch.type)

  const challenge = plugin.handleChallenge?.(body, channelConfig)
  if (challenge !== null && challenge !== undefined) {
    return { accepted: true, challenge, message: 'challenge' }
  }

  if (!plugin.verifyWebhook(body, headers, channelConfig)) {
    return { accepted: false, message: 'Invalid signature' }
  }

  const parsed = plugin.parseMessage(body)
  if (!parsed) {
    return { accepted: true, message: 'ignored' }
  }

  ingestParsedMessage(ch, parsed)
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

  const channelConfig = parseChannelConfig(ch.configJson)

  const plugin = getPlugin(ch.type)
  if (!plugin.sendMessage) {
    throw Object.assign(
      new Error(`Plugin ${ch.type} does not support sendMessage`),
      { code: 'UNIMPLEMENTED' }
    )
  }

  await plugin.sendMessage(data.chatId, data.text, channelConfig, data.threadId)

  db.insert(channelMessages).values({
    id: uuidv4(),
    channelId: data.channelId,
    direction: 'outbound',
    sender: 'agent',
    content: data.text,
    status: 'sent',
  }).run()
}
