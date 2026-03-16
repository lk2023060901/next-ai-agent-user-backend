# 08. Execution Semantics

## Goal

统一 Agent Runtime、Chat UI、Channel Runtime 的串行执行语义，避免出现“前一节点已经失败，但后续节点仍继续执行”的不一致行为。

本文档定义的是运行时约束，不是交互建议。

## Core Rule

默认规则：

1. 当前节点失败，后续节点不得继续执行。
2. 允许重试时，只允许在当前节点内部重试。
3. 当前节点重试全部失败后，必须终止整条后续链路。
4. 不允许通过 fallback 跳到后续业务节点继续执行。

这里的“节点”包括但不限于：

- 前端消息持久化
- runtime run 创建
- orchestrator enqueue
- resume context 解析
- run cancel
- approval approve/reject
- channel reply send

## Allowed Retries

允许的重试必须满足两个条件：

1. 重试目标仍然是同一个节点。
2. 重试不会改变业务语义。

允许示例：

- 同一个 `resume` 请求重试 3 次
- 同一个 `channel send` HTTP 请求做指数退避
- 同一个模型节点内的 provider/network retry

不允许示例：

- `resume` 失败后，退化成重新拼 prompt 再发一个新 run
- `sendMessage` 失败后，仍继续创建 runtime run
- `stopStream` cancel 失败后，仍继续切 session 或删 session
- channel run 失败后，再额外发送一条 error reply 作为补偿链路

## State Rules

运行状态必须和错误类型一致：

- 用户取消或 `AbortError` -> `cancelled`
- 普通异常 -> `failed`
- 成功完成 -> `completed`

禁止把取消写成失败，也禁止把失败静默吞掉后继续推进后续节点。

## HTTP Contract Rules

关键入口必须返回可判定的明确状态，而不是模糊失败：

- approval 已过期 -> `410`
- approval 不存在 -> `404`
- run 不存在或已过期 -> `404`
- run 已终态，不能再 cancel -> `409`
- enqueue 被拒绝或执行失败 -> `503`

## Current Enforcement

截至当前实现，已经落地的约束包括：

- Chat 页 `sendMessage` 失败后，不再继续 `sendStream`
- Chat 页 `continue/regenerate` 只允许当前 resume 节点内重试，不再 fallback
- `stopStream` cancel 失败后，不再继续 session switch / delete / stop-follow-up
- `selectAgent` 在 stop 失败时不再提前切 coordinator
- runtime `create run` 在接口内同步确认 `enqueue`
- runtime `cancel` 先校验，再按正确顺序执行
- runtime `approval` 明确区分 `410 expired` 与 `404 missing`
- runtime `startRun/channel-run` 将 abort 归类为 `cancelled`
- channel run 失败后，不再继续发送补偿 error reply
- `AgentLoop` / `Coordinator` 的关键消息历史写入优先等待持久化完成
- `AgentSession` 在进入 `running` 前先完成 session 状态落库，失败即终止执行
- runtime shutdown 前会 flush `PersistentMessageHistory` 的 pending writes
- channel reply 只在当前 send 节点内做 exponential backoff retry
- post-run extraction/reflection/consolidation/compaction 失败会记录日志与 observability
- SSE buffer overflow 不再伪造业务事件，而是记录 runtime gap 元数据与日志

## Review Checklist

新增串行链路时，评审必须回答下面 5 个问题：

1. 这条链路的节点边界是什么？
2. 哪些失败允许重试？重试是否只发生在当前节点？
3. 当前节点失败后，是否还有任何后续动作在继续执行？
4. 返回给调用方的状态码/状态值是否足够区分失败原因？
5. 是否已经有自动化测试覆盖该决策？

只要第 3 个问题答案不是“没有”，实现就不符合本规范。
