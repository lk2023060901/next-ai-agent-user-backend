# 前端 API 对齐方案

## 1. 目标

前端已经实现，不应该为后端内部拆分承担复杂度。

因此目标很明确：

- 前端只连 Go 的统一入口
- 前端不感知 `runtime/` 与 `service/` 的存在
- Go 对前端暴露稳定的资源 API 和实时事件 API

## 2. 现有前端暴露出的 API 主题

从当前前端仓库结构看，Web 应用已经按主题拆了 API client：

- `agent-api`
- `auth-api`
- `billing-api`
- `channel-api`
- `dashboard-api`
- `knowledge-base-api`
- `memory-api`
- `monitoring-api`
- `org-api`
- `plugin-api`
- `pricing-api`
- `scheduler-api`
- `session-api`
- `settings-api`

这说明前端期望的不是“一个聊天专用接口”，而是一整套平台资源面。

## 3. 前端只连一个入口的理由

### 3.1 降低耦合

前端不应该知道：

- 哪个请求由 Go 处理
- 哪个请求由 TS runtime 处理
- 哪个请求最终转到 `service/`

### 3.2 统一鉴权

如果前端同时直连多个服务，就会出现：

- 多套 token/session
- 多套路由前缀
- 多套错误模型
- 多套实时流协议

### 3.3 统一事件模型

前端不只订阅 chat stream，还需要订阅：

- session status
- delivery status
- scheduler/job status
- channel status
- monitoring/health
- plugin / settings / org 变化

这必须由 Go 统一投影。

## 4. 推荐的前端公开面

## 4.1 HTTP 资源 API

建议按资源主题统一为：

- `/api/auth/*`
- `/api/orgs/*`
- `/api/workspaces/*`
- `/api/agents/*`
- `/api/sessions/*`
- `/api/runs/*`
- `/api/channels/*`
- `/api/plugins/*`
- `/api/scheduler/*`
- `/api/settings/*`
- `/api/monitoring/*`
- `/api/billing/*`

## 4.2 实时流 API

建议只有两条主流：

- `/ws/chat`
  - 聊天与 run 相关事件
- `/ws/platform`
  - channel/node/cron/monitoring/delivery/operator 相关事件

或者 SSE 版本：

- `/sse/chat`
- `/sse/platform`

## 4.3 上传 API

建议单独保留：

- `/api/uploads`

由 Go 负责接收、鉴权、存储和返回 `AttachmentRef`。

## 5. 前端主题到后端资源映射

| 前端主题 | Go 公开资源 | 内部 owner |
| --- | --- | --- |
| `agent-api` | `/api/agents` `/api/runs` | Go edge + TS runtime |
| `auth-api` | `/api/auth` | Go edge + optional internal `service/` |
| `channel-api` | `/api/channels` | Go |
| `dashboard-api` | `/api/dashboard` | Go 聚合 |
| `knowledge-base-api` | `/api/knowledge` | TS 或 internal service，经 Go 暴露 |
| `memory-api` | `/api/memory` | TS runtime，经 Go 暴露 |
| `monitoring-api` | `/api/monitoring` | Go |
| `org-api` | `/api/orgs` | Go edge + internal `service/` |
| `plugin-api` | `/api/plugins` | Go edge + internal registry |
| `scheduler-api` | `/api/scheduler` | Go |
| `session-api` | `/api/sessions` | Go + TS runtime |
| `settings-api` | `/api/settings` | Go edge + internal `service/` |

## 6. chat API 设计

### 6.1 发送消息

建议：

- `POST /api/sessions/{sessionId}/messages`

请求体：

- `text`
- `attachments[]`
- `agentId?`
- `profileId?`
- `modelAlias?`
- `idempotencyKey?`

响应：

- `accepted`
- `runId`
- `sessionId`
- `streamToken` 或 stream channel 信息

### 6.2 查看会话

建议：

- `GET /api/sessions`
- `GET /api/sessions/{sessionId}`
- `GET /api/sessions/{sessionId}/messages`
- `PATCH /api/sessions/{sessionId}`
- `DELETE /api/sessions/{sessionId}`

### 6.3 中止运行

建议：

- `POST /api/runs/{runId}:abort`

## 7. 事件投影规则

Go 需要把 TS semantic events 投影成前端消费对象。

### 7.1 前端 chat event

建议类型：

- `run.accepted`
- `run.started`
- `message.delta`
- `message.block`
- `tool.started`
- `tool.finished`
- `run.warning`
- `run.usage`
- `run.completed`
- `run.failed`
- `run.aborted`
- `delivery.sent`
- `delivery.failed`

### 7.2 platform event

建议类型：

- `channel.status.changed`
- `scheduler.job.updated`
- `scheduler.run.updated`
- `node.status.changed`
- `device.token.rotated`
- `monitoring.health.updated`
- `plugin.status.changed`
- `settings.updated`

## 8. 前端不应直接看到的东西

前端不应直接看到：

- provider auth profile 全貌
- provider fallback 内部轨迹
- raw tool result transcript repair 细节
- channel sender 内部 target resolution 细节
- node invoke 私有 payload
- queue / lease / route 冲突的内部栈信息

前端应该看到的是已投影后的资源状态和用户可消费事件。

## 9. 与当前前端实现对齐的建议

由于前端已经是一个多资源平台界面，而不是只聊会话，因此后端不应该把所有能力都塞进一个 `/chat` 接口里。

推荐：

- 保持当前前端的 API 主题划分
- 由 Go 在后端做聚合
- 前端 API client 名称不必大改
- 只把实际请求路径和返回对象改成新平台契约

## 10. 认证建议

推荐：

- 前端只维护一套用户态认证
- Go 验证前端 session/JWT
- Go 再按内部服务身份调用 `runtime/` 或 `service/`

不建议：

- 前端保存多个后端 token
- 前端对 `runtime/` 单独做 auth

## 11. 结论

前端对齐的关键不是“API 名字怎么起”，而是：

- 前端只看到一个平台入口
- 资源 API 和实时事件由 Go 统一投影
- TS 只做 runtime，不直接暴露给浏览器

这样前端才不会被后端内部拆分反向绑死。
