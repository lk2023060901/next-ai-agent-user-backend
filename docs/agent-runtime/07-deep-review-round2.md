# 深度复盘 Round 2 — 端到端链路审计 (2026-03-10)

> Phase 1-5 全部完成后的第二轮深度扫描。从用户提问到响应回复追踪完整链路。
>
> 扫描结论的统一执行约束已整理到 [08-execution-semantics.md](./08-execution-semantics.md)。

---

## 🔴 CRITICAL — 会导致运行失败或数据损坏 (5 项)

### R1. Session Lock 被 timeout 击穿 — 同 session 可并发执行
- **位置**: `runtime/src/orchestrator/session-lock.ts:27-30`
- **复核结果**: 当前实现已改为 timeout 后拒绝新 waiter，而不是放行。并新增测试验证“超时拒绝但不击穿锁链”。
- **状态**: [x] 已完成 (2026-03-15)

### R2. delegate 工具 import 不存在的模块
- **位置**: `runtime/src/tools/delegate.ts:62`
- **复核结果**: 当前 `runtime/src/agent/executor.ts` 存在，且导出 `runExecutor`；`delegate.ts` 的动态 import 路径有效，此项为过时审计结论。
- **状态**: [x] 已确认无需修改 (2026-03-15)

### R3. KB sync 端点缺失 — service 从未通知 runtime
- **位置**: `service/src/modules/tools/tools.service.ts` (KB CRUD) + `runtime/src/main.ts` (无 /kb/sync)
- **问题**: Phase 2 实现了 runtime 端的 KB 存储能力，但 service 层 KB 增删改后**从未调用 runtime sync**。5 个 KB 操作均无 runtime 通知：createKnowledgeBase, updateKnowledgeBase, deleteKnowledgeBase, createKnowledgeBaseDocument, deleteKnowledgeBaseDocument
- **后果**: runtime 的 memory_entries/vec_embeddings/memory_fts 中 KB 数据永远是空的，Phase 2 (H1-H4) **实际未生效**
- **修复**:
  1. runtime 新增 `POST /runtime/ws/:wsId/kb/sync` 端点（接收 action: create|update|delete + chunks 数据）
  2. service 的 5 个 KB 操作后调用 runtime sync（类似 scheduler → /runtime/scheduled-run 的模式）
  3. Gateway 需转发或 service 直连 runtime（用 X-Runtime-Secret）
- **状态**: [x] 已完成 (2026-03-10) — runtime 已有 `/runtime/ws/:wsId/kb/sync`，service KB CRUD 后已调用 runtime sync

### R4. gRPC 调用无超时 — 可阻塞 runtime 进程
- **位置**: `runtime/src/main.ts:420,438` (getContinueContextByMessage/ByRun)
- **问题**: 这两个 gRPC 调用无 timeout 配置。如果 service 挂起或网络分区，runtime HTTP handler 线程永远阻塞
- **后果**: 积累足够多的阻塞请求后 runtime 不可用
- **修复**: 所有 gRPC client 调用统一加 deadline/timeout（建议 15s，与 GRPC_CALL_TIMEOUT_MS 一致）
- **状态**: [x] 已完成 (2026-03-15) — `runtime/src/grpc/client.ts` 统一通过 `deadline = Date.now() + GRPC_CALL_TIMEOUT_MS`

### R5. 前端 session 切换不中断活跃 stream
- **位置**: `frontend: page.tsx:725-770`
- **问题**: 用户切换/删除 session 时，currentRunId.current 仍指向旧 run 的 stream。消息事件到达后更新 store，可能写入已切换的新 session
- **后果**: 消息跑到错误会话，或已删除会话的消息无处安放
- **修复**: session 切换/删除时先 abort 当前 stream，等待 cancel 完成后再切换 activeSessionId
- **状态**: [x] 已完成 (2026-03-15) — session switch/delete/stop 先等待 cancel，失败则终止后续动作

---

## 🟠 HIGH — 功能不符合设计或关键体验问题 (10 项)

### H1. Token budget advisory 不强制执行
- **位置**: `runtime/src/context/context-engine.impl.ts`
- **问题**: assemble() 不校验最终 token 是否超窗口；estimateTokens() 用 char/4 偏差 20-40%
- **修复**: assemble() 返回前校验总 token ≤ model context window，超出时 aggressive trim
- **状态**: [x] 已完成 (2026-03-10) — `ContextEngine.assemble()` 已在返回前按 context window 再裁剪

### H2. Web search 结果绕过 token budget
- **位置**: `runtime/src/agent/coordinator.ts:367-374`
- **问题**: coordinator 在 ContextEngine.assemble() 之后手动追加 webSearchContext，不计入 budget
- **修复**: web search 纳入 ContextEngine.assemble() 的 budget 分配
- **状态**: [x] 已完成 (2026-03-10) — web search 已通过 `additionalSystemContext` 纳入 `ContextEngine.assemble()`

### H3. Gateway /runtime/* 全部在 JWT 保护组
- **位置**: `gateway/cmd/gateway/main.go:224`
- **问题**: approval/status 端点需要 JWT，但 scheduled/channel 等后台工作流只有 X-Runtime-Secret
- **修复**: 提取 /runtime/approvals 和 /runtime/status 到 public 组，用 X-Runtime-Secret 鉴权
- **状态**: [ ] 未修复

### H4. Orchestrator rejected runs 永不回收
- **位置**: `runtime/src/orchestrator/orchestrator.impl.ts:98-102`
- **问题**: this.runs Map 中 failed/rejected 的 TrackedRun 永远留存
- **修复**: 定期清理已完成/失败超过 N 分钟的 TrackedRun（与 RunStore cleanup 对齐）
- **状态**: [x] 已完成 (2026-03-10) — `DefaultOrchestrator` 已有定时 GC 清理 completed/failed/cancelled runs

### H5. Enqueue 失败不通知客户端
- **位置**: `runtime/src/main.ts:532-534`
- **复核结果**: 当前实现已改为在 HTTP 创建 run 阶段同步 `await orchestrator.enqueue(...)`；enqueue 失败直接返回 `503`，不再先返回 runId 再异步失败。
- **状态**: [x] 已完成 (2026-03-15)

### H6. Memory 检索失败静默跳过
- **位置**: `runtime/src/agent/coordinator.ts:291-327`
- **问题**: getCoreMemory()/getRelevantInjections() 异常被 catch 但不报告给用户
- **修复**: catch 后 emit warning 事件到 SSE，前端显示 "记忆系统暂时不可用"
- **状态**: [ ] 未修复

### H7. Fire-and-forget 消息持久化丢数据
- **位置**: `runtime/src/agent/persistent-message-history.ts:36-40`
- **问题**: append() 返回前持久化是异步 fire-and-forget，crash 丢数据
- **修复**: 关键路径改为 await 持久化；或用 WAL + checkpoint 保证 crash recovery
- **状态**: [ ] 未修复

### H8. 前端 MSW mock 不匹配真实端点
- **位置**: `frontend: mocks/handlers/sessions.ts`
- **问题**: mock 用 /api/sessions/:id/stream，真实是 /runtime/ws/:wsId/runs + /runtime/runs/:runId/stream
- **修复**: 更新 MSW handlers 匹配真实 runtime 端点格式
- **状态**: [x] 已完成 (2026-03-10)

### H9. 前端 Approval 倒计时纯客户端
- **位置**: `frontend: approval-card.tsx:27-49`
- **问题**: 依赖本地时钟，服务端过期后用户点击返回 410 但 UI 无对应处理
- **修复**: approve/reject API 返回 410 时 UI 标记为 expired + toast 提示
- **状态**: [x] 已完成 (2026-03-15) — approve/reject API 返回 `410` 时前端已 toast 并标记 expired

### H10. 前端 message ID 生成逻辑不可靠
- **位置**: `frontend: use-streaming-chat.ts:269-307`
- **问题**: messageSeq 按事件递增而非按消息递增；resume 匹配用内容比较不可靠
- **修复**: message ID 从 runtime 的 message-start 事件获取（backend 生成的持久化 ID），不在前端生成
- **状态**: [x] 已完成 (2026-03-15) — 优先使用 runtime `message-start` 的 `messageId`，本地生成只作为兜底

---

## 🟡 MEDIUM — 降级体验或技术债 (13 项)

### M1. Approval timeout 硬编码 5min
- **位置**: `runtime/src/tools/approval-gate.ts:22`
- **修复**: 从 agent config 或 tool policy 读取
- **状态**: [x] 已完成 (2026-03-10) — 已改为 `config.approvalTimeoutMs`

### M2. startCandidateOffset 显式 0 被覆盖为 1
- **位置**: `runtime/src/main.ts:469-474`
- **修复**: 区分 undefined 和 explicit 0
- **状态**: [x] 已完成 (2026-03-15)

### M3. Memory injection tokenBudget 硬编码 2000
- **位置**: `runtime/src/agent/coordinator.ts:307`
- **修复**: 从 TokenBudgetAllocator 动态获取
- **状态**: [x] 已完成 (2026-03-10)

### M4. closeRuntimeServices() 不等待 pending writes
- **位置**: `runtime/src/bootstrap.ts:51-56`
- **修复**: 增加 graceful shutdown，flush 所有 pending 写入后再关闭 DB
- **状态**: [ ] 未修复

### M5. Channel reply 无重试
- **位置**: `runtime/src/main.ts:683-719`
- **修复**: 失败时入队重试（最多 3 次 exponential backoff）
- **状态**: [x] 已完成 (2026-03-15) — 当前节点内 exponential backoff retry，失败后终止

### M6. Post-run extraction/reflection 失败全部静默
- **位置**: `runtime/src/agent/coordinator.ts:612-703`
- **修复**: 失败记录到 observability store + 日志
- **状态**: [ ] 未修复

### M7. 前端 tool-result 先于 tool-call 到达产生重复卡片
- **位置**: `frontend: use-streaming-chat.ts:465-549`
- **修复**: tool-result 到达时如已有 pending fallback tool，合并而非新增
- **状态**: [x] 已完成 (2026-03-15)

### M8. 前端 KB 搜索结果 JSON 解析脆弱
- **位置**: `frontend: tool-call-card.tsx:47-58`
- **修复**: 增加 schema 校验，不匹配时 graceful fallback + 日志
- **状态**: [ ] 未修复

### M9. code_read 工具无文件大小限制
- **位置**: `runtime/src/tools/code-read.ts`
- **修复**: 增加 maxFileSize 限制（如 10MB），超过时返回错误
- **状态**: [x] 已完成 (2026-03-10)

### M10. code_write 不解析 symlink 可能 sandbox 逃逸
- **位置**: `runtime/src/tools/code-write.ts:23`
- **修复**: 写入前 fs.realpathSync() 解析路径，再校验 sandbox 范围
- **状态**: [x] 已完成 (2026-03-10)

### M11. SSE event buffer 溢出静默丢弃
- **位置**: `runtime/src/sse/run-store.ts:260-262`
- **修复**: 溢出时 emit warning 事件，客户端知道有 gap
- **状态**: [ ] 未修复

### M12. 前端 reconnection 无 exponential backoff
- **位置**: `frontend: use-streaming-chat.ts:808`
- **修复**: 500ms → 1s → 2s → 4s with jitter
- **状态**: [ ] 未修复

### M13. tool-result status 类型不匹配
- **位置**: `frontend: types/api.ts` (required) vs runtime emitter (optional)
- **修复**: 前端类型标记为 optional
- **状态**: [ ] 未修复

---

## 推荐实施顺序

```
Phase 6A — Critical 修复 (2-3 天)
  R1 (session lock) → R2 (delegate import) → R3 (KB sync 端点) → R4 (gRPC timeout)

Phase 6B — 前端 Critical + High (1-2 天)
  R5 (stream abort on switch) → H8 (MSW mocks) → H9 (approval 410) → H10 (message ID)

Phase 6C — Runtime High (1-2 天)
  H1 (token enforce) → H2 (web search budget) → H3 (gateway auth scope) → H4 (run GC) → H5 (enqueue error) → H6 (memory warning) → H7 (persist await)

Phase 6D — Medium 批量修复 (2-3 天)
  M1-M13 按模块分批
```
