# Go + TS 平台跨服务协议设计

## 1. 目的

这份文档定义的是最终要落到 `proto/` 的跨服务 contract，而不是具体代码实现。

原则只有一个：

- Go 负责平台与控制
- TS 负责对话与 provider/model

所以所有协议都要体现 owner，不能模糊。

## 2. 协议层分级

建议分成 3 层协议：

### 2.1 Public Edge API

用于前端与 Go Gateway 之间：

- REST/JSON
- WebSocket/SSE event stream
- 上传/下载接口
- operator action 接口

### 2.2 Internal Runtime RPC

用于 Go 与 TS 之间：

- Protobuf + Connect/gRPC
- 只承载 turn/runtime/session semantic contract
- 不暴露给浏览器

### 2.3 Event Bus Envelope

用于 Go/TS/worker/scheduler/delivery 之间的异步流：

- JetStream topics
- immutable event envelope
- sequence + correlation + causation

## 3. 核心对象

## 3.1 `TurnRequest`

语义：一条已经被 transport 正规化、但尚未进入 provider/model 执行面的 turn 请求。

建议字段：

- `request_id`
- `trace_id`
- `tenant_id`
- `workspace_id`
- `user_id`
- `session_id`
- `run_parent_id`
- `channel`
- `account_id`
- `thread_id`
- `source_message_id`
- `message_text`
- `attachments[]`
- `command_source`
- `delivery_context`
- `route_hints`
- `requested_agent_id`
- `requested_profile_id`
- `requested_model_alias`
- `priority`
- `deadline_ms`
- `idempotency_key`
- `metadata`

说明：

- `requested_profile_id` 和 `requested_model_alias` 只能是 hint
- Go 只负责填充和转发，TS 才负责解释
- `delivery_context` 是 Go 侧 canonical 路由对象，但 TS 可以读取它决定回复语义

## 3.2 `AttachmentRef`

建议字段：

- `attachment_id`
- `mime_type`
- `filename`
- `byte_size`
- `storage_uri`
- `preview_text?`
- `image_width?`
- `image_height?`
- `sha256?`

owner：

- Go 负责文件接收、存储和 URI 分配
- TS 负责读取并做 media understanding

## 3.3 `DeliveryContext`

语义：这次 turn 的 canonical outbound target context。

建议字段：

- `channel`
- `account_id`
- `to`
- `thread_id`
- `reply_to_message_id`
- `surface_kind`
- `supports_streaming`
- `supports_rich_blocks`
- `supports_tools_visibility`
- `origin_kind`

owner：Go。

TS 可以读取，但不能最终解释 `to/thread` 的 channel-native 语义。

## 3.4 `TurnEvent`

语义：TS 运行时发出的语义事件。

建议字段：

- `request_id`
- `run_id`
- `session_id`
- `seq`
- `event_type`
- `timestamp_ms`
- `payload`
- `usage_delta?`
- `tool_call_id?`
- `severity?`

建议 `event_type`：

- `accepted`
- `started`
- `assistant_delta`
- `assistant_block`
- `reasoning_summary`
- `tool_call_started`
- `tool_call_finished`
- `tool_call_failed`
- `warning`
- `needs_approval`
- `compacting`
- `usage`
- `aborted`
- `failed`
- `completed`

注意：

- 这是 semantic stream
- 不是 channel transport event
- 不是 frontend 事件最终形态

## 3.5 `TurnResult`

语义：一次 turn 的最终收口对象。

建议字段：

- `request_id`
- `run_id`
- `session_id`
- `status`
- `assistant_outputs[]`
- `tool_summary[]`
- `usage`
- `model_used`
- `provider_used`
- `session_patch`
- `delivery_plan`
- `transcript_mirror`
- `artifacts[]`
- `error?`

关键规则：

- `delivery_plan` 必须是 channel-agnostic
- `model_used/provider_used` 只做观测，不给 Go 做 provider 逻辑判断

## 3.6 `SessionDirectoryRecord`

语义：Go 侧拥有的 session 控制面对象。

建议字段：

- `session_id`
- `tenant_id`
- `workspace_id`
- `route_key`
- `last_channel`
- `last_account_id`
- `last_to`
- `last_thread_id`
- `delivery_context`
- `pinned_agent_id`
- `active_run_id`
- `lease_owner`
- `lease_expires_at_ms`
- `status`
- `message_count`
- `updated_at_ms`

owner：Go。

## 3.7 `SemanticSessionManifest`

语义：TS 侧会话语义状态的 manifest。

建议字段：

- `session_id`
- `transcript_uri`
- `summary_uri?`
- `transcript_version`
- `semantic_state_version`
- `active_model_alias?`
- `active_profile_id?`
- `compaction_epoch`
- `pending_tool_results_count`
- `last_turn_outcome`
- `updated_at_ms`

owner：TS。

## 3.8 `DeliveryRequest`

语义：Go delivery-engine 消费的最终发送请求。

建议字段：

- `delivery_id`
- `run_id`
- `session_id`
- `delivery_context`
- `outputs[]`
- `retry_policy`
- `mirror_policy`
- `trace_id`

owner：Go。

## 3.9 `NodeInvokeRequest` / `NodeInvokeResult`

语义：Go control plane 与 node plane 的控制协议。

建议字段：

- `node_id`
- `command`
- `params`
- `timeout_ms`
- `idempotency_key`
- `foreground_required`
- `request_id`

以及：

- `request_id`
- `node_id`
- `status`
- `result_payload`
- `error`
- `completed_at_ms`

owner：Go。

## 3.10 `CronJobRecord` / `CronTrigger`

语义：调度平面对象。

建议字段：

- `job_id`
- `tenant_id`
- `schedule`
- `payload_kind`
- `turn_template`
- `delivery_policy`
- `enabled`
- `last_run_at_ms`
- `next_run_at_ms`

`CronTrigger`：

- `job_id`
- `trigger_id`
- `scheduled_for_ms`
- `reason`
- `payload`

owner：Go。

## 4. RPC 面设计

## 4.1 Go -> TS Runtime RPC

建议服务：`TurnRuntimeService`

方法：

- `RunTurn(TurnRequest) returns (stream TurnEvent)`
- `RunTurnWithResult(TurnRequest) returns (stream TurnEventOrResult)`
- `AbortTurn(AbortTurnRequest)`
- `CompactSession(CompactSessionRequest)`
- `GetSessionRuntimeInfo(GetSessionRuntimeInfoRequest)`

说明：

- 推荐把最终结果也放进同一流里，避免双协议面
- 或者 `RunTurn` 只产 stream，最终结果通过 event bus 发布，这两种都可以，但必须固定一种

## 4.2 Go Platform Query API

这些是 Go 对前端公开的资源面：

- `Chat API`
- `Sessions API`
- `Channels API`
- `Scheduler API`
- `Monitoring API`
- `Settings API`
- `Plugins API`
- `Agents API`

这些不应该由 TS 直接暴露。

## 4.3 Service-to-Service Query RPC

如果保留 `service/`：

- `AuthService`
- `OrgService`
- `WorkspaceService`
- `SettingsService`
- `PluginCatalogService`

都应该是内部服务，而不是前端入口。

## 5. Event Bus 设计

建议 topic：

- `turn.requests`
- `turn.events`
- `turn.results`
- `turn.aborts`
- `delivery.requests`
- `delivery.events`
- `channel.inbound`
- `channel.state`
- `node.events`
- `cron.triggers`
- `platform.events`

统一 envelope 字段：

- `event_id`
- `trace_id`
- `correlation_id`
- `causation_id`
- `event_type`
- `producer`
- `tenant_id`
- `session_id?`
- `run_id?`
- `timestamp_ms`
- `payload`

## 6. 前后兼容规则

### 6.1 只允许追加字段

Protobuf/JSON 契约：

- 不允许重排含义
- 不允许复用废弃字段编号
- 只允许追加新字段
- 删除必须先 deprecate

### 6.2 明确版本号

建议每个主要 envelope 带：

- `schema_version`
- `producer_version`

### 6.3 错误对象统一

所有服务都必须返回统一错误：

- `code`
- `message`
- `retryable`
- `details[]`
- `trace_id`

## 7. 所有权矩阵

| 对象 | Owner | 只读方 |
| --- | --- | --- |
| ModelCatalog | TS | Go |
| AuthProfile | TS | Go |
| ProviderUsage | TS produce / Go store | Go + Frontend |
| DeliveryContext | Go | TS |
| SessionDirectoryRecord | Go | TS |
| SemanticSessionManifest | TS | Go |
| ChannelConnectionState | Go | Frontend |
| NodeConnectionState | Go | Frontend |
| DeliveryAttempt | Go | Frontend |
| TranscriptMirrorPayload | TS produce / Go send+store ack | Go |

## 8. 不可违反的 contract 原则

1. Go 不得要求 TS 暴露 provider SDK 级对象。
2. TS 不得要求 Go 理解 provider fallback 细节。
3. 前端不得要求直接订阅 TS runtime event stream。
4. channel target resolution 最终 contract 必须由 Go 完成。
5. `TurnResult` 必须是 send-agnostic，不得夹带 Slack/Telegram 私有发送操作。

## 9. 推荐落地顺序

在目标 backend 仓库里，建议先做：

1. `proto/` 定义冻结
2. `gateway/` 引用新 proto
3. `runtime/` 引用新 proto
4. `service/` 只保留必要的内部 proto
5. 再开始真实代码迁移

如果顺序反了，后面服务会边写边改协议，返工会非常严重。

## 10. TS Runtime 的 substrate 约束

本平台的内部协议设计，默认前提不是“TS 可以自由自研整套 runtime substrate”，而是：

- TS runtime 必须建立在 `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

之上。

这会影响 contract 设计的 3 个关键点：

### 10.1 `TurnRequest` 不应该逼 TS 重写 core loop

`TurnRequest` 的目标是喂给一个“基于上游 substrate 的 turn runtime”，而不是喂给一个完全自定义的本地 loop。

### 10.2 `TurnEvent` 需要能映射上游 runtime 事件

事件模型应该尽量贴近：

- loop lifecycle
- tool lifecycle
- assistant delta / block
- compaction / continuation
- usage / provider outcome

这样 TS 侧才是“适配上游运行时”，而不是“重新发明一套与上游脱节的事件语义”。

### 10.3 `SemanticSessionManifest` 不等于替代上游 SessionManager

`SemanticSessionManifest` 的作用是：

- 给平台定义 semantic ownership
- 给 Go 提供可观察的 manifest

它不应该被设计成一个迫使 TS 重写 `pi-coding-agent` session shell 的对象。
