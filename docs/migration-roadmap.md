# next-ai-agent-user-backend 改造路线图

## 1. 目标

这份路线图的目标是：

- 不改现有代码的前提下，先把实施顺序、阶段边界、验收口径和回滚点冻结下来
- 后续在 `next-ai-agent-user-backend` 开分支实施时，严格按阶段推进

## 2. 总策略

总体策略不是“大重写”，而是 4 个字：

- **包裹迁移**

也就是：

1. 先冻结协议和 owner
2. 再把现有 TS 推理链服务化
3. 再让 Go 变成唯一对外入口
4. 再逐步把 session router / delivery / channels / control-plane 迁到 Go

## 3. 分阶段路线

## Phase 0：文档与协议冻结

目标：开始写代码前，冻结架构合同。

涉及目录：

- `proto/`
- 设计文档目录

交付物：

- Go/TS owner 表
- `TurnRequest/TurnEvent/TurnResult` 草案
- session directory 与 semantic transcript 所有权定义
- frontend 单入口原则
- plugin Go/TS 分治原则

验收口径：

- 后续任何实现 PR 都能明确标注 owner
- 不存在边写边发明协议的情况

回滚点：

- 无需代码回滚，只修文档

## Phase 1：`runtime/` 服务化为 Turn Runtime

目标：把现有对话主链封装成稳定的内部服务，而不是让它散落在未来平台里。

涉及目录：

- `runtime/`
- `proto/agent_run.proto` 及相关 turn contracts

实施内容：

- 把现有 TS 主链抽成：
  - reply engine
  - agent runtime
  - provider runtime
  - semantic session runtime
- 提供内部 RPC：
  - `RunTurn`
  - `AbortTurn`
  - `CompactSession`
- 明确 TS 输出是 `TurnEvent` / `TurnResult`，而不是直接发送 channel 消息

验收口径：

- `runtime/` 可以单独起服务
- 不依赖 CLI 进程内直接调 agent
- provider/model 逻辑只在 `runtime/`

风险：

- transcript/state 仍可能临时依赖本地文件/单机存储

## Phase 2：`gateway/` 变成唯一公开入口

目标：前端只连 `gateway/`。

涉及目录：

- `gateway/`
- `proto/chat.proto`
- `proto/common.proto`
- 必要时 `service/` 的内部调用 contract

实施内容：

- 在 `gateway/` 暴露统一 HTTP/WS/SSE API
- `gateway/` 代理/聚合前端所需资源面
- 前端的聊天入口、session 面板、channel/status 面板全部只连 `gateway/`
- `runtime/` 退为内网服务
- `service/` 只保留内部 supporting API

验收口径：

- 前端不直连 `runtime/` 和 `service/`
- `gateway/` 能独立对外提供平台 API

风险：

- 如果 `gateway/` 只是简单转发，而不承担事件归一和权限，会沦为“薄反代”

## Phase 3：Go Session Router 和 Queue 接管热路径

目标：把 active run、session 并发、幂等、超时从 TS 挪到 Go。

涉及目录：

- `gateway/`
- `proto/agent_run.proto`
- 共享存储与消息总线接入

实施内容：

- 引入 `session router`
- 建立 per-session actor / lease
- 建立 `turn.requests` / `turn.events` / `turn.results` 队列
- 建立 idempotency key
- 建立 timeout / retry / abort sweep

验收口径：

- 同一 session 的 active run 只由 Go 判定
- TS 不再持有并发调度主权

风险：

- session ownership 切换时容易出现 duplicate run 或丢失 abort

## Phase 4：Delivery Plane 独立

目标：让 TS 不再直接承担最终 transport 发送。

涉及目录：

- `gateway/`
- `proto/chat.proto`
- `proto/channels.proto`

实施内容：

- 实现 Go delivery engine
- 定义 `DeliveryRequest`
- 实现 target resolution / retry / DLQ / sent receipt
- transcript mirror 从“直接写 transcript”改成“delivery ack 后确认写入”

验收口径：

- TS 只返回 final reply plan
- 最终消息发送只经 Go

风险：

- delivery plan 抽象不当，会让 TS 又偷偷携带 channel 私有语义

## Phase 5：Channel Runtime 迁入 Go

目标：把所有 transport runtime 挪入 Go。

建议顺序：

1. Slack
2. Telegram
3. Discord
4. WhatsApp Web
5. Signal
6. iMessage
7. runtime-heavy channel extensions

实施内容：

- 迁 ingress runtime
- 迁 outbound sender
- 迁 account/login/reconnect/status
- 把 native transport action 留在 Go
- 把对话级 command 判断留给 TS

验收口径：

- `runtime/` 不再维护 channel transport 长连接
- `gateway/` 成为唯一 channel runtime owner

风险：

- channel-specific native command 与对话级 command 边界处理不好会导致行为回归

## Phase 6：外围控制面迁入 Go

目标：把 OpenClaw 现有 Gateway operator/control-plane 真正做成 Go 平台壳。

涉及主题：

- nodes/devices
- browser/canvas
- pairing
- cron/wizard
- config/status/health/logs/usage
- approvals / operator scopes

验收口径：

- 这些控制面不再需要 TS 作为前台 owner
- `gateway/` 可以完整承担 operator surface

## Phase 7：`service/` 收缩与职责重定

目标：避免 `service/` 成为第二个中心。

实施内容：

- 清点 `service/` 当前所有公开面
- 把需要对前端公开的资源统一搬到 `gateway/`
- 把 `service/` 收缩为内部 supporting service
- 如果某些域适合 Go，可以并入 `gateway/`

验收口径：

- 前端仍然只连 `gateway/`
- `service/` 不再站在实时热路径中心

## Phase 8：Plugin 双 SDK 和长尾收口

目标：最终把扩展体系按 owner 分治。

实施内容：

- `plugin-sdk-go`
- `plugin-sdk-ts`
- channel/control plugins -> Go
- provider/memory/tool plugins -> TS
- manifest 升级和兼容策略

验收口径：

- 不再有一个插件同时掌管 transport 和 provider/model
- 平台 owner 规则可以被插件体系继承

## 4. 并行工作流

整个路线图需要至少 4 条并行工作流：

1. 协议与存储工作流
2. Go 平台壳工作流
3. TS turn runtime 工作流
4. channel / plugin 迁移工作流

这些工作流可以并行，但必须受 Phase 0 的协议冻结约束。

## 5. 每个阶段的 PR 粒度建议

不要按“功能名”切 PR，建议按“边界面”切：

- proto contract PR
- runtime boundary PR
- gateway public entry PR
- session router PR
- delivery plane PR
- 单 channel 迁移 PR
- 单 control-plane family PR
- plugin SDK PR

这样 review 才能看清 owner 是否越界。

## 6. 回滚策略

### 6.1 绝不能没有回滚就切流

每一阶段必须保留：

- feature flag
- dual path 或 shadow path
- event comparison
- run comparison
- delivery comparison

### 6.2 推荐的回滚方式

- Phase 1：runtime service 化失败，可回到进程内调用
- Phase 2：gateway 公开入口失败，可暂时让前端继续走旧入口
- Phase 3：session router 出错，可回退到单实例串行模式
- Phase 4：delivery plane 出错，可回退到旧 sender path
- Phase 5：单 channel 迁移失败，按 channel 粒度回退

## 7. 测试路线

### 7.1 合同测试

- proto compatibility test
- JSON/WS envelope compatibility test
- frontend contract smoke test

### 7.2 运行时测试

- single-session serialization
- duplicate request idempotency
- abort correctness
- retry correctness
- delivery retry / DLQ
- session ownership race

### 7.3 回归测试

- channel ingress regression
- native command regression
- session route regression
- transcript mirror regression
- plugin registration regression

## 8. 推荐的起步顺序

如果马上要开分支开始做，我建议真正的落地顺序是：

1. 先改 `proto/`
2. 再改 `runtime/` 的 turn-runtime 壳
3. 再改 `gateway/` 的 BFF/stream 壳
4. 再接 session router / queue
5. 最后再切 delivery 和 channels

不要先动 channel，也不要先大改 `service/`。

## 9. 里程碑定义

### Milestone A

- 协议冻结
- runtime turn service 可跑
- gateway 单入口可用

### Milestone B

- session router 生效
- event stream 稳定
- frontend 不再依赖旧后端路径

### Milestone C

- delivery plane 生效
- 首批 channel 完成迁移

### Milestone D

- nodes/browser/canvas/cron/operator control-plane 完整迁移

### Milestone E

- plugin 双 SDK 成型
- `service/` 收缩到内部 supporting role

## 10. 最终判断

这条路线的本质不是“服务拆多一点”，而是：

- 先冻结 owner
- 再把当前 OpenClaw 的厚单体运行语义拆成 Go 平台壳和 TS 推理核
- 最后在 `next-ai-agent-user-backend` 上形成真正可扩展的平台

## 11. 新增硬前提：Phase 1 之前必须先完成 substrate 对齐

由于这次改造被明确要求必须基于：

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

所以原路线图需要增加一个前置动作。

### Phase 0.5：`runtime/` substrate alignment

目标：先把当前 backend 里的 `runtime/` 从“只接 `pi-ai` 的本地自研 runtime”对齐到三层 npm substrate。

实施内容：

- 引入 `@mariozechner/pi-agent-core`
- 引入 `@mariozechner/pi-coding-agent`
- 识别当前本地自研 loop/session shell 中哪些能力应被上游替代
- 把必须保留的平台能力下沉为 adapter / policy / orchestration layer
- 建立与上游运行时一致的事件与 session 语义

验收口径：

- `runtime/` 的核心 loop substrate 不再以本地 `agent-loop.impl.ts` / `agent-session.impl.ts` 为主
- `runtime/` 可以明确说明：上游 substrate 在哪里，本地平台编排层在哪里

注意：

这一步不是可选优化，而是后续所有 Phase 的前提。
