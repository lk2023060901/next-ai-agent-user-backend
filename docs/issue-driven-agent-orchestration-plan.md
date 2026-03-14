# 基于 Issue 的 Agent 编排与聊天落地方案

## 1. 目标

这份文档定义 `next-ai-agent-user-backend` 的新主业务链：

- Agent 不再围绕 `session/messages` 编排
- Agent 改为围绕 `issue` 编排
- 聊天不是第二套系统，而是 `issue` 的一个入口
- TS runtime 必须建立在 `pi-mono` 的 3 个核心包之上

目标是把当前后端收敛成一个统一模型：

- `Issue` = 工单 / 任务单 / 唯一任务实体
- `IssueComment` = 人与 Agent 的沟通记录
- `IssueRun` = 一次实际执行
- `Approval` = 工具审批 / 人工决策
- `ActivityEvent` = 时间线和监控投影

## 2. 当前状态

当前 `gateway/` 已经具备独立的 Issue 控制平面：

- `issues`
- `issue_comments`
- `issue_runs`
- `issue_run_events`
- `approvals`
- `activity_events`

当前 `runtime/` 还没有真正接入 `pi-mono` 的 Agent 执行主链。

现状是：

- `runtime/src/main.ts`
  - 只挂了 `workflow` 和 `issue-runs`
- `runtime/src/issue-runs/run-manager.ts`
  - 还是模拟执行器，按定时器发伪事件
- `runtime/src/workflow/executors/llm-call.ts`
  - 明确是 placeholder
- `runtime/src/workflow/executors/kb-search.ts`
  - 明确是 placeholder
- `runtime/src/workflow/executors/send-message.ts`
  - 明确是 placeholder

所以当前真正缺的不是“再发明一套业务模型”，而是：

- 用 `pi-agent-core` 跑真实 turn loop
- 用 `pi-ai` 跑真实 provider/model 调用
- 用第三个 `pi-*` 包承接 session/tool shell
- 把这套执行真正挂回 `IssueRun`

## 3. 硬约束

## 3.1 单一事实来源

不能同时维护两套任务真相：

- 一套是 `session/messages`
- 一套是 `issue/comments`

新版本必须坚持：

- `Issue` 是唯一任务实体
- 聊天页只是 `Issue` 的一种视图
- Agent 回复、工具调用、审批、执行记录，都围绕 `Issue`

## 3.2 Go / TS owner 固定

- Go = 控制平面 owner
- TS = 执行平面 owner

Go 负责：

- `Issue` 状态机
- 派单
- `IssueRun` 持久化
- 评论、审批、活动流
- 查询、权限、监控

TS 负责：

- turn loop
- provider/model 调用
- tool loop
- 流式事件
- 审批挂起与恢复
- 使用量上报

## 3.3 TS 不允许直接写业务主库

`runtime/` 不应自己写 `issues`、`issue_comments`、`issue_runs` 表。

正确边界是：

- TS 只执行
- TS 只暴露运行时接口和事件流
- Go 消费 TS 的运行时结果并落库

这样才能避免双写、状态漂移和恢复困难。

## 4. 两个入口，一个主链

## 4.1 显式建工单入口

用户在工单页直接创建 `Issue`：

1. 创建 `issue`
2. 填写标题、描述、assignee agent
3. 写入初始 `issue_comment`
4. Go 决定是否立即创建 `issue_run`

## 4.2 聊天入口自动建工单

聊天页也可以存在，但其本质是“工单入口”。

建议实现为：

1. 用户打开聊天页
2. 系统创建一个 `draft issue`
3. 第一条用户消息写成 `issue_comment`
4. 聊天窗口从头到尾绑定一个 `issueId`
5. 用户明确要求执行，或系统判定应执行时，创建 `issue_run`

这样：

- 显式建工单
- 聊天自动建工单

最终都会进入同一条链：

- `issue`
- `issue_comment`
- `issue_run`
- `issue_run_events`

## 4.3 `session/messages` 的处理方式

新功能不再以 `session/messages` 作为权威存储。

可接受的处理方式只有两种：

1. 直接废弃为历史兼容层
2. 保留为前端缓存或旧页面兼容层，但所有新交互最终都投影到 `Issue`

不允许继续让新 Agent 能力同时写两套主记录。

## 5. 目标业务模型

## 5.1 核心对象

- `Issue`
  - 唯一任务实体
- `IssueComment`
  - 人工输入、Agent 回复、系统评论
- `IssueRun`
  - 某个 Agent 对该 Issue 的一次执行
- `IssueRunEvent`
  - 运行中的流式事件
- `Approval`
  - 工具审批和人工决策对象
- `ActivityEvent`
  - 给 dashboard、timeline、monitoring 的投影

## 5.2 关键关系

- 一个 `Issue` 可以有多个 `IssueComment`
- 一个 `Issue` 可以有多个 `IssueRun`
- 同一时刻一个 `Issue` 只能有一个活跃 `IssueRun`
- 一个 `IssueRun` 可以产生多个 `IssueRunEvent`
- 一个 `Issue` 可以关联多个 `Approval`

## 5.3 执行位置

执行位置不是独立资源，而是 `IssueRun` 的执行上下文：

- `executionMode = cloud | local`
- `executorName`
- `executorHostname`
- `executorPlatform`

## 6. Go 侧职责

Go 控制平面已经具备大部分基础能力，后续只需要继续围绕 Issue 增量。

Go 必须继续 owner 的能力：

- `Issue` CRUD
- `IssueComment` CRUD
- `IssueRun` 创建、查询、状态映射
- `Approval` 创建、决策、关联
- `ActivityEvent` 写入
- dashboard / monitoring / timeline 查询
- `workspace` 范围校验
- 派单逻辑

Go 应额外补充的运行时适配能力：

- 提供 Issue 执行上下文给 TS
- 接收审批决议并把结果回推到 TS runtime
- 在聊天入口自动创建 `draft issue`

建议新增内部接口：

- `GET /api/internal/runtime/issues/{issueId}/context`
  - 返回 issue 标题、描述、祖先、最近 comments、agent 配置、KB 绑定、审批摘要
- `POST /api/internal/runtime/issue-runs/{runId}/usage`
  - TS 在 turn 结束后上报 usage

## 7. TS 侧目标架构

TS 侧不再做“聊天业务层”，而是做 `IssueRun` 执行器。

建议拆成这些模块：

- `IssueRunnerService`
  - 运行 `IssueRun`
- `IssueContextLoader`
  - 从 Go 拉取 Issue 执行上下文
- `PiAgentAdapter`
  - 封装 `pi-agent-core`
- `ProviderAdapter`
  - 封装 `pi-ai`
- `ToolAdapter`
  - 封装第三个 `pi-*` 包的 tool/session shell
- `ApprovalBridge`
  - 审批请求、暂停、恢复
- `EventProjector`
  - 把 turn/tool/approval 映射成统一 SSE 事件
- `UsageReporter`
  - 每次 turn 结束上报 Go

## 7.1 `pi-mono` 在这里的正确职责

- `@mariozechner/pi-agent-core`
  - owner turn loop、stream、tool loop、中断
- `@mariozechner/pi-ai`
  - owner provider/model transport
- 第三个 `pi-*` 包
  - owner tool/session shell

平台不应再自行实现一套长期维护的 core loop。

## 7.2 当前 `issue-runs` mock 的替代方式

当前 `runtime/src/issue-runs/run-manager.ts` 的模拟执行器要被替换成真实执行链：

1. 接受 `StartIssueRunRequest`
2. 拉取 issue 上下文
3. 构造 agent runtime
4. 运行 turn
5. 发出真实 SSE 事件
6. 支持审批挂起
7. 支持 abort
8. turn 完成后上报 usage

## 8. 统一事件模型

Issue 主链建议统一为以下运行时事件：

- `run.started`
- `agent.thinking`
- `text.delta`
- `message.completed`
- `tool.called`
- `tool.result`
- `approval.requested`
- `approval.resolved`
- `comment.created`
- `run.completed`
- `run.failed`
- `run.aborted`

说明：

- `text.delta`
  - 只用于前端流式展示
- `message.completed`
  - 表示一个完整回复完成
- `comment.created`
  - 表示需要落成持久化 `IssueComment`

Go 负责把这些事件投影到：

- `issue_run_events`
- `issue_comments`
- `activity_events`

## 9. 审批模型

审批必须挂到 `Issue`，不能做成运行时私有状态。

建议流程：

1. TS 在工具调用前判断需要审批
2. TS 发出 `approval.requested`
3. Go 创建 `approval`
4. Go 把 approval 关联到 `issue`
5. TS 进入 paused 状态
6. 用户在前端 approve/reject
7. 前端调 Go
8. Go 持久化决策，并调用 TS runtime 的恢复接口
9. TS 继续或终止执行

建议新增 runtime 接口：

- `POST /issue-runs/{runId}/approvals/{approvalRequestId}/resolve`

请求体：

- `decision = approve | reject`
- `note`

## 10. 聊天页与工单页的前端语义

虽然这份文档不要求改前端，但必须先冻结语义。

前端要这样理解：

- 聊天页 = `Issue` 的聊天视图
- 工单详情页 = `Issue` 的任务视图

它们读取的是同一份数据：

- comments
- run stream
- approvals
- activity timeline

不是两套后端。

## 11. 派单规则

派单一定放在 Go，不放在 TS。

Go 派单的输入：

- `issue.status`
- `assignee_agent_id`
- `executionMode`
- 当前是否已有活跃 `issue_run`
- 用户是否显式要求唤醒

Go 派单的输出：

- 创建 `issue_run`
- 调用 TS runtime 启动执行

TS 不负责决定“派给谁”，TS 只负责“把这单干完”。

## 12. 最小可落地实施顺序

## Phase 1：把 TS runtime 从 mock 变成真实 `IssueRun` 执行器

目标：

- 替换 `runtime/src/issue-runs/run-manager.ts` 中的模拟逻辑
- 接上 `pi-agent-core`
- 接上 `pi-ai`
- 保留现有 `/issue-runs` 路由形状

验收：

- `POST /issue-runs` 触发真实 turn
- `GET /issue-runs/:runId/events` 输出真实事件，而不是定时器假事件

## Phase 2：把聊天入口收敛到 `Issue`

目标：

- 增加“聊天自动建 `draft issue`”流程
- 第一条用户消息写入 `issue_comment`
- 聊天窗口绑定 `issueId`

验收：

- 聊天页和 issue 详情页能看到同一条评论和执行链

## Phase 3：完成审批闭环

目标：

- TS 发 `approval.requested`
- Go 持久化 `approval`
- TS 支持 pause / resolve / resume

验收：

- 一个需要审批的工具调用能完整暂停、批准、恢复

## Phase 4：知识库、用量、监控收口

目标：

- KB 检索接入真实 embedding / vector search
- 每次 turn 上报 usage 到 Go
- monitoring 统一以 `IssueRun` 为核心

验收：

- dashboard、monitoring、timeline 三者对同一条 run 的展示一致

## 13. 非目标

这份方案明确不做：

- 把 `workflow` 强行并进 `issue`
- 把执行位置做成独立业务资源
- 继续扩大 `session/messages` 的语义
- 让前端直连 TS runtime

## 14. 验收标准

达到以下标准，才算这套方案落地：

1. 用户可直接创建工单并驱动 Agent
2. 用户可通过聊天入口自动创建工单并驱动 Agent
3. 聊天页和 Issue 页读取的是同一份后端实体
4. TS runtime 基于 `pi-mono` 三包执行真实 turn
5. 工具审批能在 Issue 维度暂停和恢复
6. 所有执行记录都能回到 `IssueRun`、`IssueComment`、`ActivityEvent`
7. Go 仍然是唯一公开入口

## 15. 最终结论

新版本的核心不是“聊天系统驱动 Agent”，而是：

- **Issue 系统派单**
- **TS runtime 执行**
- **聊天只是 Issue 的入口和视图**

只要坚持这个边界：

- Go 不会失去控制平面 owner
- TS 不会再重复造业务模型
- 聊天、工单、审批、监控会自然收敛到一条主链
