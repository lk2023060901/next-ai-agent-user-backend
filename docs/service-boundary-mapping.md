# OpenClaw 拆解结果到 next-ai-agent-user-backend 的服务边界映射

## 1. 目的

这份文档解决的是一个非常具体的问题：

- 既然已经把 OpenClaw 拆到启动、Gateway、channel、agent、extension、外围控制面这个粒度，
- 那么这些能力在 `next-ai-agent-user-backend` 里到底应该落到 `gateway/`、`runtime/`、`service/`、`proto/` 的哪里。

这里不讨论“愿景”，只讨论 owner 和边界。

## 2. 顶层边界定义

### 2.1 `gateway/` 的最终职责

`gateway/` 应该成为唯一公开入口和高并发平台壳，负责：

- HTTP / WS / SSE 对外 API
- 前端统一 BFF
- session router
- per-session actor / lease / idempotency
- channel ingress runtime
- channel outbound delivery
- config/status/health/logs/usage/operator 面
- node/device/browser/canvas/pairing/control plane
- cron / wake / retry / timeout sweep

### 2.2 `runtime/` 的最终职责

`runtime/` 只负责用户对话到响应回复的语义执行：

- reply engine
- native conversation command
- directives
- message preparation
- agent runtime
- provider/model/auth/fallback
- transcript hygiene
- memory/workflow/tool orchestration
- semantic session state

### 2.3 `service/` 的最终职责

`service/` 不应该继续成为第二个公开网关。

它更合理的定位是过渡期内部 supporting service，例如：

- auth / org / workspace 元数据
- settings / policy / plugin catalog 查询
- billing / admin query / 报表
- 需要继续保留的内部业务服务

终态有两种可接受结果：

- 收缩为内部 supporting service
- 逐步并入 `gateway/`

但不可接受的结果是：

- 前端既连 `gateway/` 又连 `service/`
- `service/` 持有 provider/model 逻辑
- `service/` 持有 channel transport runtime

### 2.4 `proto/` 的最终职责

`proto/` 是跨服务协议唯一来源，负责：

- turn contracts
- session/run/delivery contracts
- platform control contracts
- channel/node/browser/canvas control envelopes
- error model

## 3. OpenClaw 顶层模块映射表

| OpenClaw 现有能力 | 代表模块 | 目标 owner | 目标仓库目录 | 迁移方式 |
| --- | --- | --- | --- | --- |
| CLI 启动与命令装配 | `src/entry.ts` `src/cli/*` | Go | `gateway/` | 不直接复刻 CLI；提炼成 operator API + admin CLI |
| Gateway 请求模型 / 事件模型 | `src/gateway/*` | Go | `gateway/` + `proto/` | 重做为公开入口和内部 event plane |
| Gateway 非聊天 method 家族 | `src/gateway/server-methods/*` | Go | `gateway/` + 部分 `service/` | operator/control-plane API |
| chat.send / agent / agent.wait | `src/gateway/server-methods/chat.ts` `agent.ts` | Go 请求入口 + TS 执行 | `gateway/` + `runtime/` + `proto/` | Go 接请求，TS 执行 turn |
| 共享 channel layer | `src/channels/*` | Go | `gateway/` | 拆出 transport/runtime 相关部分 |
| 内建 channel ingress/runtime/outbound | `src/telegram/*` `src/slack/*` `src/discord/*` 等 | Go | `gateway/` | 逐 channel 迁入 Go |
| auto-reply 语义 | `src/auto-reply/*` | TS | `runtime/` | 直接迁入 TS runtime 内核 |
| agent orchestrator | `src/commands/agent.ts` | TS | `runtime/` | 作为 turn-runtime 核心 |
| embedded / ACP / tool loop | `src/agents/*` | TS | `runtime/` | 保留为推理内核 |
| provider/model/auth/fallback | `src/providers/*` `src/agents/model-*` | TS | `runtime/` | TS 独占 |
| transcript / semantic session | `src/config/sessions/*` 中语义部分 | TS | `runtime/` + blob/db | 语义状态留 TS |
| session route / active run / lease | `src/routing/*` `gateway` 活跃 run 状态 | Go | `gateway/` + db/cache | 改为 Go actor/lease 模型 |
| delivery transport | `src/infra/outbound/*` | Go | `gateway/` | target resolve 和 send 迁 Go |
| memory / workflow / tool | `src/memory/*` 及 workflow 类扩展 | TS | `runtime/` | tool/runtime 一侧继续保留 |
| plugin registry / hook bus | `src/plugins/*` `src/hooks/*` | Go+TS 双治 | `gateway/` `runtime/` `service/` `proto/` | 拆成双 SDK |
| nodes/devices/browser/canvas/pairing | `src/gateway/node-*` `src/browser/*` `src/canvas-host/*` `src/pairing/*` | Go | `gateway/` | 整体迁 Go control plane |
| cron / wake / wizard / operator control | `src/cron/*` `server-methods/cron.ts` `wizard.ts` | Go | `gateway/` | 长生命周期调度迁 Go |
| usage / status / health / logs | `src/gateway/server-methods/health.ts` `usage.ts` `logs.ts` | Go | `gateway/` + 部分 `service/` | 平台观测与报表 |

## 4. 细粒度映射

### 4.1 Gateway 相关映射

`src/gateway/*` 不应该整体搬进一个 TS 服务，而应拆成 4 个部分：

1. `gateway edge`
   - `connect`
   - auth
   - request validation
   - public HTTP/WS

2. `session router`
   - `chat.send`
   - `agent`
   - `agent.wait`
   - active run registry
   - dedupe / idempotency

3. `platform control`
   - `config.*`
   - `status`
   - `health`
   - `logs.tail`
   - `channels.status`
   - `nodes.*`
   - `devices.*`
   - `browser.request`
   - `cron.*`
   - `wizard.*`

4. `event fanout`
   - `agent` events -> frontend events
   - platform events
   - node / cron / delivery events

### 4.2 Channel 相关映射

OpenClaw 里 channel 现状是“共享 layer + 每个 channel 厚 runtime 壳”，这非常适合迁到 Go。

因此：

- `Telegram`、`Slack`、`Discord`、`Signal`、`iMessage`、`WhatsApp Web`
- 以及所有 runtime-heavy channel extensions

都应该进入 `gateway/` 侧的 channel runtime 子域。

TS 只消费 channel-normalized input：

- `channel`
- `accountId`
- `threadId`
- `commandSource`
- `attachments`
- `deliveryContext`

### 4.3 Agent 相关映射

前面对主价值链的拆解已经足够清楚，所以这部分没有必要再拆给 Go：

- `auto-reply`
- `commands/agent.ts`
- `agents/*`
- `providers/*`
- transcript hygiene / fallback / compaction

都应该完整落在 `runtime/`。

### 4.4 Session 相关映射

要拆成两层：

Go 层：

- `session_directory`
- `routeKey`
- `deliveryContext`
- `activeRun`
- `lease`
- `lastChannel/lastAccount/thread`

TS 层：

- transcript
- summary snapshot
- tool result state
- compaction state
- provider-hygiened history

## 5. `service/` 在当前 backend 仓库里的位置

这是最容易模糊的点。

### 5.1 允许它做什么

在不推翻现有仓库的前提下，`service/` 可以保留这些内容：

- 用户、组织、工作区等元数据
- 插件清单、策略、设置查询
- 计费、报表、后台管理
- 与对话热路径弱耦合的业务服务

### 5.2 不允许它做什么

- 不允许前端直接把聊天请求打给 `service/`
- 不允许 `service/` 直接持有 provider/model runtime
- 不允许 `service/` 直接持有 channel runtime
- 不允许 `service/` 成为第二个 Gateway

### 5.3 中期策略

中期应该这样处理：

- `gateway/` 对前端统一公开
- `gateway/` 根据需要调用 `service/`
- `service/` 作为内部 supporting service 存活

## 6. `proto/` 的目录策略

当前 `proto/` 已有以下主题：

- `agent_run.proto`
- `chat.proto`
- `channels.proto`
- `scheduler.proto`
- `settings.proto`
- `tools.proto`
- `auth.proto`
- `workspace.proto`
- `org.proto`
- `common.proto`

建议终态改成 4 类：

1. public edge contracts
   - frontend-facing resource API DTO
2. turn runtime contracts
   - `TurnRequest/TurnEvent/TurnResult`
3. platform control contracts
   - node/device/browser/canvas/cron/config/status
4. shared foundations
   - ids, pagination, cursors, timestamps, errors

## 7. 目录级改造建议

### 7.1 `gateway/`

建议目录：

- `gateway/cmd/*`
- `gateway/internal/edge/*`
- `gateway/internal/router/*`
- `gateway/internal/channels/*`
- `gateway/internal/delivery/*`
- `gateway/internal/platform/*`
- `gateway/internal/scheduler/*`
- `gateway/internal/events/*`
- `gateway/internal/store/*`
- `gateway/internal/auth/*`

### 7.2 `runtime/`

建议目录：

- `runtime/src/turn-runtime/*`
- `runtime/src/reply-engine/*`
- `runtime/src/agent-runtime/*`
- `runtime/src/provider-runtime/*`
- `runtime/src/session-runtime/*`
- `runtime/src/memory-runtime/*`
- `runtime/src/workflow-runtime/*`
- `runtime/src/contracts/*`

### 7.3 `service/`

建议目录：

- `service/src/auth/*`
- `service/src/org/*`
- `service/src/workspace/*`
- `service/src/settings/*`
- `service/src/plugin-catalog/*`
- `service/src/billing/*`
- `service/src/monitoring/*`

## 8. 不允许跨越的边界

必须硬性禁止以下反模式：

1. `gateway/` 直接调用 provider SDK
2. `gateway/` 自己做 model fallback
3. `runtime/` 自己直连 channel 发送最终消息
4. `runtime/` 自己对前端暴露公开 API
5. `service/` 持有会话热路径的 active run 状态
6. `service/` 持有 channel runtime 或 provider runtime

## 9. 最终判断

如果按这份映射来做，后续在 `next-ai-agent-user-backend` 里真正需要实现的，不是“把 OpenClaw 拷进去”，而是：

- 在 `gateway/` 重建平台壳
- 在 `runtime/` 重建语义推理核
- 在 `proto/` 冻结跨服务契约
- 在 `service/` 收缩非热路径 supporting 域

这才是与前面对 OpenClaw 的拆解一致的落地方式。

## 10. `runtime/` 的基线不能是“只接 `pi-ai` 的自研 runtime”，而必须回到三层 npm substrate

这一点现在是本次改造的硬约束。

### 10.1 当前状态

当前目标 backend 仓库里：

- `runtime/package.json` 只声明了 `@mariozechner/pi-ai`
- `runtime/src/agent/agent-loop.impl.ts` 自己实现 loop
- `runtime/src/agent/agent-session.impl.ts` 自己实现 session shell

因此当前 `runtime/` 虽然是 TS，但它不是 OpenClaw 那种建立在三层上游 substrate 之上的 runtime。

### 10.2 目标状态

`runtime/` 最终应当分成两层：

第一层，上游 substrate 层

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

第二层，平台编排层

- reply-engine
- provider policy / auth profile / fallback
- semantic transcript ownership
- Go/TS contract adapter
- event projection
- tool / memory / workflow integration

### 10.3 映射修正

因此在本映射表里，凡是属于：

- agent loop
- AgentSession / SessionManager shell
- provider transport core

都不应该再被规划为“在 `runtime/` 里自研重写”，而应被规划为：

- 上游三层 npm substrate 的整合与适配

### 10.4 新的 owner 解释

`runtime/` 的 owner 仍然是 TS，但其 owner 含义应解释为：

- TS owns the reasoning plane
- not TS owns rewriting the entire substrate from scratch

也就是说，owner 是职责 owner，不是重写 owner。
