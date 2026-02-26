# Channel Core Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 打通 Webhook → Agent Dispatch → Feishu Reply 完整链路，仅支持飞书，接口设计对其他渠道可扩展。

**Architecture:** 入站消息经 `handleWebhook` 完成 session 绑定后，fire-and-forget（发后不等）调用 Runtime (:8082)；Runtime 处理完成后调用 `POST /channels/:channelId/send` 把回复推回飞书。`ChannelPlugin` 接口新增可选 `sendMessage()` 方法，飞书实现，其他插件无需修改。

**Tech Stack:** TypeScript (tsx), Drizzle ORM (SQLite), @larksuiteoapi/node-sdk, Go chi, protobuf/gRPC

---

## Task 1: 给 ChannelPlugin 接口加 `sendMessage`，飞书实现

**Files:**
- Modify: `service/src/modules/channel/plugins/types.ts`
- Modify: `service/src/modules/channel/plugins/feishu.ts`

**Step 1: 在 `types.ts` 的 `ChannelPlugin` 接口末尾加 `sendMessage`**

在 `testConnection` 后追加（用 `?` 表示可选，其他插件无需改动）：

```typescript
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
```

**Step 2: 在 `feishu.ts` 的 `feishuPlugin` 对象末尾实现 `sendMessage`**

```typescript
async sendMessage(chatId, text, config, _threadId): Promise<void> {
  const { appId, appSecret } = config
  if (!appId || !appSecret) throw new Error('缺少 appId / appSecret')
  const client = getLarkClient(appId, appSecret)
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    },
  })
},
```

**Step 3: 验证 TypeScript 编译**

```bash
cd service && npx tsc --noEmit
```

期望：无报错

**Step 4: Commit**

```bash
git add service/src/modules/channel/plugins/types.ts \
        service/src/modules/channel/plugins/feishu.ts
git commit -m "feat(channel): add sendMessage to ChannelPlugin interface, implement for feishu"
```

---

## Task 2: 新增 `channel_sessions` 表

**Files:**
- Modify: `service/src/db/schema.ts`（在 `routingRules` 表后新增）

**Step 1: 在 `schema.ts` 的 Channels 区块末尾（`routingRules` 定义后）新增**

```typescript
export const channelSessions = sqliteTable("channel_sessions", {
  id: text("id").primaryKey(),
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id").notNull(),
  senderId: text("sender_id").notNull(),    // 平台用户 ID（飞书 open_id）
  chatId: text("chat_id").notNull(),        // 平台会话 ID（用于回复）
  agentId: text("agent_id"),               // 由路由规则决定
  lastActiveAt: text("last_active_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  ...timestamps,
});
```

**Step 2: 生成 migration**

```bash
cd service && npm run db:generate
```

期望：`drizzle/` 目录生成新 SQL 文件，包含 `CREATE TABLE channel_sessions`

**Step 3: 执行 migration**

```bash
npm run db:migrate
```

期望：`Migrations applied.`

**Step 4: 验证编译**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add service/src/db/schema.ts drizzle/
git commit -m "feat(channel): add channel_sessions table for conversation binding"
```

---

## Task 3: `handleWebhook` 完成 session 绑定 + dispatch

**Files:**
- Modify: `service/src/config.ts`（加 runtimeAddr）
- Modify: `service/src/modules/channel/channel.service.ts`（替换 TODO）

**Step 1: 在 `config.ts` 末尾追加 `runtimeAddr`**

```typescript
runtimeAddr: process.env.RUNTIME_ADDR ?? "http://localhost:8082",
```

**Step 2: 在 `channel.service.ts` 顶部补充 import**

```typescript
import { channelSessions } from '../../db/schema'
import { config } from '../../config'
```

**Step 3: 替换 TODO 注释（约 line 155–158）**

找到：
```typescript
  // TODO: dispatch to Agent runtime when integrated
  console.log(`Webhook received for channel ${channelId}, matched rule: ${matchedRule?.id ?? 'none'}`)

  return { accepted: true, message: 'ok' }
```

替换为：
```typescript
  if (matchedRule?.targetAgentId) {
    const agentId = matchedRule.targetAgentId

    // Upsert channel session (key: channelId + chatId + senderId)
    let session = db.select().from(channelSessions)
      .where(eq(channelSessions.channelId, channelId))
      .all()
      .find((s) => s.senderId === parsed.sender && s.chatId === (parsed.chatId ?? ''))

    if (!session) {
      const sid = uuidv4()
      db.insert(channelSessions).values({
        id: sid,
        channelId,
        workspaceId: ch.workspaceId,
        senderId: parsed.sender,
        chatId: parsed.chatId ?? '',
        agentId,
        lastActiveAt: new Date().toISOString(),
      }).run()
      session = db.select().from(channelSessions).where(eq(channelSessions.id, sid)).get()!
    } else {
      db.update(channelSessions)
        .set({ lastActiveAt: new Date().toISOString() })
        .where(eq(channelSessions.id, session.id)).run()
    }

    // Fire-and-forget：发给 runtime，不等结果，立刻返回 200 给飞书
    fetch(`${config.runtimeAddr}/channel-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        channelId,
        agentId,
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
```

**Step 4: 编译确认**

```bash
npx tsc --noEmit
```

**Step 5: Commit**

```bash
git add service/src/modules/channel/channel.service.ts service/src/config.ts
git commit -m "feat(channel): bind channel sessions and fire-and-forget dispatch to runtime on webhook"
```

---

## Task 4: 新增 `SendChannelMessage` RPC + Gateway 端点

Runtime 处理完成后，通过这个接口把 Agent 回复推回飞书。

**Files:**
- Modify: `proto/channels.proto`
- Run: `bash scripts/gen-proto.sh`
- Modify: `service/src/modules/channel/channel.service.ts`（加 `sendChannelMessage` 函数）
- Modify: `service/src/grpc/server.ts`（注册 handler，补 import）
- Modify: `gateway/internal/handler/channels.go`（加 HTTP handler）
- Modify: `gateway/cmd/gateway/main.go`（注册路由）

**Step 1: 在 `proto/channels.proto` 追加 RPC 和消息**

在 `rpc TestConnection` 后追加 RPC：
```protobuf
  // Agent 回复推回渠道
  rpc SendChannelMessage(SendChannelMessageRequest) returns (common.Empty);
```

在文件末尾追加消息定义：
```protobuf
message SendChannelMessageRequest {
  string channel_id = 1;
  string chat_id = 2;
  string text = 3;
  string thread_id = 4;
  common.UserContext user_context = 5;
}
```

**Step 2: 重新生成 proto**

```bash
cd /Volumes/data/liukai/next-ai-agent/next-ai-agent-user-backend && bash scripts/gen-proto.sh
```

期望：`Done.`

**Step 3: 在 `channel.service.ts` 末尾新增 `sendChannelMessage` 函数**

```typescript
export async function sendChannelMessage(data: {
  channelId: string
  chatId: string
  text: string
  threadId?: string
}): Promise<void> {
  const ch = db.select().from(channels).where(eq(channels.id, data.channelId)).get()
  if (!ch) throw Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND' })

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
```

**Step 4: 在 `service/src/grpc/server.ts` 补 import + 注册 handler**

顶部 import 改为：
```typescript
import {
  listChannels, getChannel, createChannel, updateChannel, deleteChannel,
  listRoutingRules, createRoutingRule, updateRoutingRule, deleteRoutingRule,
  handleWebhook, listChannelMessages, sendChannelMessage,
} from "../modules/channel/channel.service";
```

在 `testConnection` handler 后追加：
```typescript
async sendChannelMessage(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
  try {
    await sendChannelMessage({
      channelId: call.request.channelId,
      chatId: call.request.chatId,
      text: call.request.text,
      threadId: call.request.threadId || undefined,
    })
    callback(null, {})
  } catch (err) { handleError(callback, err) }
},
```

**Step 5: 在 `gateway/internal/handler/channels.go` 末尾添加 handler**

```go
func (h *ChannelsHandler) SendChannelMessage(w http.ResponseWriter, r *http.Request) {
	var body channelspb.SendChannelMessageRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body"); return
	}
	body.ChannelId = chi.URLParam(r, "channelId")
	body.UserContext = h.userCtx(r)
	_, err := h.clients.Channels.SendChannelMessage(r.Context(), &body)
	if err != nil { writeGRPCError(w, err); return }
	w.WriteHeader(http.StatusNoContent)
}
```

**Step 6: 在 `gateway/cmd/gateway/main.go` 注册路由**

在 `r.Delete("/channels/{channelId}"` 行后追加：
```go
r.Post("/channels/{channelId}/send", channelsHandler.SendChannelMessage)
```

**Step 7: 编译验证**

```bash
cd /Volumes/data/liukai/next-ai-agent/next-ai-agent-user-backend/service && npx tsc --noEmit && echo "TS OK"
cd /Volumes/data/liukai/next-ai-agent/next-ai-agent-user-backend/gateway && go build ./... && echo "Go OK"
```

期望：`TS OK` 和 `Go OK`

**Step 8: Commit**

```bash
git add proto/channels.proto \
        gateway/internal/pb/channels/ \
        service/src/generated/ \
        service/src/modules/channel/channel.service.ts \
        service/src/grpc/server.ts \
        gateway/internal/handler/channels.go \
        gateway/cmd/gateway/main.go
git commit -m "feat(channel): add SendChannelMessage RPC + POST /channels/:id/send endpoint"
```

---

## Task 5: 前端路由规则编辑器 — 动态加载 Agent 列表

**Files:**
- Modify: `next-ai-agent-user-frontend/apps/web/components/features/channels/routing-rules-editor.tsx`

**Step 1: 找到当前硬编码的 agent options**

```bash
grep -n "agent-1\|AGENT_OPTIONS\|agentOptions\|targetAgentId" \
  apps/web/components/features/channels/routing-rules-editor.tsx
```

**Step 2: 在组件顶部引入 `useAgents` 和 `useWorkspace`**

```typescript
import { useAgents } from '@/hooks/use-agents'
import { useWorkspace } from '@/lib/context/workspace-context'
```

**Step 3: 在组件函数内查询 agents**

```typescript
const workspace = useWorkspace()
const { data: agents = [] } = useAgents(workspace.id)
```

**Step 4: 把硬编码 options 替换为动态数据**

将 targetAgentId 的 Select options 从静态数组改为：
```typescript
agents.map((a) => ({ label: a.name, value: a.id }))
```

**Step 5: 验证**

```bash
cd next-ai-agent-user-frontend && pnpm typecheck
```

**Step 6: Commit**

```bash
git add apps/web/components/features/channels/routing-rules-editor.tsx
git commit -m "feat(channel): load agents dynamically in routing rules editor"
```

---

## 验收标准

1. `npx tsc --noEmit` 无报错
2. `go build ./...` 无报错
3. 飞书发消息 → DB `channel_messages` 有 inbound 记录 + `channel_sessions` 有 session 记录
4. 日志显示 `[channel] dispatch to runtime failed: connect ECONNREFUSED`（runtime 未运行时的预期行为）
5. `POST /channels/:id/send { "chatId": "...", "text": "你好" }` → 飞书收到消息
6. 路由规则编辑器 Agent 下拉显示真实 Agent 名称

---

## 备注

- Runtime (:8082) fire-and-forget，未运行只记录日志，不影响 webhook 响应
- 其余插件（Slack/Discord/Telegram/WebChat）无需实现 `sendMessage`，接口为可选方法
- 本计划不涉及媒体消息、健康监控、异步投递队列（后续 P2/P3）
