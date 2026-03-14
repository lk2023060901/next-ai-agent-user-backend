# 基于 `@mariozechner/pi-agent-core`、`@mariozechner/pi-ai`、`@mariozechner/pi-coding-agent` 的采纳策略

## 1. 目标

这份文档专门回答一个问题：

- 既然本次改造被要求必须基于这 3 个核心 npm 包实现，
- 那么当前 `next-ai-agent-user-backend/runtime/` 应该如何从“只接 `pi-ai` 的本地 runtime”回归到三层 substrate。

## 2. 当前状态

当前 backend 的 TS runtime 真实形态是：

- provider transport 复用了 `@mariozechner/pi-ai`
- 但 agent loop、session shell、message history、部分 orchestrator 是本地自研

最明显的证据是：

- `runtime/src/agent/agent-loop.impl.ts`
- `runtime/src/agent/agent-session.impl.ts`
- `runtime/src/core/agent-loop.ts`
- `runtime/src/core/agent-session.ts`

这类文件说明它当前不是“上游 substrate + 平台编排”，而是“`pi-ai` + custom local runtime”。

## 3. 目标状态

目标状态应拆成 3 层：

### 3.1 substrate 层

直接采用：

- `@mariozechner/pi-agent-core`
- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`

这层负责：

- core loop
- stream/function/tool event substrate
- provider transport grammar
- AgentSession / SessionManager / ModelRegistry / AuthStorage shell

### 3.2 platform runtime layer

在 substrate 之上建立平台编排层：

- reply-engine
- auth profile / fallback policy
- OpenClaw 风格 transcript hygiene
- semantic session ownership
- Go/TS contract adapter
- event projection
- memory/workflow/tool integration

### 3.3 platform edge layer

由 Go 提供：

- queue / routing / delivery / channel / control-plane

## 4. 三个包各自应该承担什么

## 4.1 `@mariozechner/pi-agent-core`

应作为：

- core agent loop substrate
- prompt / continue / steer / follow-up 的底层循环
- tool loop 和中断传播的最小运行时

这意味着当前本地的 `agent-loop.impl.ts` 不应该继续作为长期主实现。

## 4.2 `@mariozechner/pi-ai`

应继续作为：

- provider/model transport
- stream / completion substrate
- model lookup / provider capability 基础层

这一层当前已经在用，但还不够。

## 4.3 `@mariozechner/pi-coding-agent`

应作为：

- AgentSession / SessionManager / ModelRegistry / AuthStorage shell
- tool/resource/session 的本地壳层
- 上游 session persistence / extension command / queue / compaction 语义的基础层

这意味着当前本地的 `agent-session.impl.ts`、部分 `session-manager.impl.ts` 不应该继续作为长期主壳。

## 5. 当前本地实现应该怎么处理

不能简单删除，也不能继续当主实现。

建议分成 3 类：

### 5.1 应被上游直接替换的

- core loop
- AgentSession shell
- SessionManager 主壳
- 与上游完全重叠的 message history / run context 主体

### 5.2 应下沉为 adapter 的

- Go/TS contract bridge
- EventBus -> platform event stream adapter
- transcript blob / db adapter
- platform policy injection

### 5.3 应作为平台增量保留的

- auth profile 策略
- provider fallback 策略
- transcript hygiene
- delivery-plan shaping
- platform tool/runtime ownership 策略
- memory/workflow/plugin 增强层

## 6. 推荐实施顺序

### Step 1：引入依赖并冻结版本线

要求：

- 三个包必须进入 `runtime/package.json`
- 版本线必须保持同一兼容系
- 不允许 `pi-ai` 一路、另外两个包另一路

### Step 2：建立 substrate adapter 层

先不要直接大改业务逻辑，而是加一层目录，例如：

- `runtime/src/substrate/pi-agent-core/*`
- `runtime/src/substrate/pi-coding-agent/*`
- `runtime/src/substrate/pi-ai/*`

由这层负责：

- 封装上游对象
- 暴露平台所需的最小 adapter

### Step 3：把本地 `agent-loop` 降为 orchestrator adapter

目标不是保留它做核心 loop，而是：

- 让它从“主执行器”变成“平台编排器”
- 真正的 loop 应交给 `pi-agent-core`

### Step 4：把本地 `agent-session` / `session-manager` 降为 session adapter

目标不是保留本地 session shell，而是：

- 让 `pi-coding-agent` 成为主 shell
- 本地代码只负责额外 manifest、transcript ownership、blob/db 适配

### Step 5：重建事件和结果投影

基于上游 runtime 输出，重建：

- `TurnEvent`
- `TurnResult`
- frontend chat events
- Go delivery result envelope

## 7. 这会带来的直接收益

1. 运行语义与 OpenClaw 主分析对象重新对齐
2. 不再长期维护一套与上游逐渐漂移的本地 core runtime
3. 未来 platform 增量能明确建立在 substrate 之上，而不是和 substrate 混写
4. Go/TS 分层会更稳定，因为 TS 自己不再同时扮演 substrate author 和 platform author

## 8. 风险

### 8.1 行为差异风险

从 custom loop/session 壳切回上游 substrate 后，可能出现：

- tool loop 次序变化
- session history 语义差异
- usage / event emission 颗粒度变化
- compaction / queue / continuation 语义变化

### 8.2 平台增强层丢失风险

如果替换过猛，可能把本地已有的：

- auth profile policy
- retry / timeout policy
- memory 注入
- workflow glue
- audit/event projection

一起误删。

所以必须先分清：谁是 substrate，谁是 platform delta。

## 9. 和 Go/TS 大架构的关系

这份文档不会推翻既有结论：

- Go 仍然是平台壳
- TS 仍然是 reasoning core

它只是给 TS reasoning core 增加了一个更严格的实现前提：

- **TS reasoning core 必须建立在三层 `pi-mono` substrate 之上**

## 10. 最终结论

如果这次改造真的要“基于这 3 个核心 npm 实现”，那最先要做的不是直接拆服务，而是先完成这件事：

- 把当前 `runtime/` 从 `pi-ai + custom runtime`
- 调整为 `pi-agent-core + pi-ai + pi-coding-agent + platform orchestration`

只有在这个前提成立后，后续 Go 高并发平台壳与 TS 推理核的分治，才是稳的。
