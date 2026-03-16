# Agent Runtime 未打通链路 — 实现计划

> 执行语义约束补充见 [08-execution-semantics.md](./08-execution-semantics.md)。所有新增链路默认遵守“当前节点失败即终止后续节点，仅允许节点内重试”。

> 2026-03-09 全面扫描后整理。按优先级分组，每组内按依赖顺序排列。
>
> 2026-03-16 更新：本计划中的条目已全部完成或确认无需修改。后续增量工作请参考 [07-deep-review-round2.md](./07-deep-review-round2.md) 的复核结论和 [08-execution-semantics.md](./08-execution-semantics.md) 的运行时约束。

---

## P0 Critical — 功能直接断裂

### C1. Approval 审批前端 → 后端打通
- **现状**: 前端 `ApprovalCard` 的 `handleApprove`/`handleReject` 只更新 Zustand store，从未调用后端 API
- **后果**: 高风险工具调用时 runtime `ApprovalGate` 永远等不到决策，run 必然超时
- **修复范围**:
  - `apps/web/src/app/(dashboard)/.../chat/page.tsx` — `handleApprove`/`handleReject` 中增加 `fetch POST /runtime/approvals/:approvalId/approve|reject`
  - 确认 approval 请求体格式与 `runtime/src/main.ts` 端点一致
  - 处理网络失败 / 已过期场景的 UI 反馈
- **工作量**: ~30 行前端代码
- **状态**: [x] 已完成 (2026-03-09) — handleApprove/handleReject 增加 fetch POST 调用，失败时 toast + 标记 expired

### C2. Model 选择覆盖传递
- **现状**: ~~前端 `selectedModelId` state 存在但从未传入 run 创建请求的 `modelId` 参数~~
- **实际情况**: 经代码审查，完整链路已打通：`handleSend(content, modelId)` → `effectiveModelId = modelId ?? selectedModelId` → `sendStream({modelId})` → POST body 包含 `modelId` → runtime 正确提取
- **状态**: [x] 无需修改 — 链路已完整

---

## P1 High — 设计完成但实现缺失

### H1. KB 向量存储迁移 (JSON → sqlite-vec)
- **现状**: service 层 KB `kbDocumentChunks` 表用 JSON 数组存 embedding；runtime 用 sqlite-vec
- **后果**: KB 和记忆系统两套独立向量存储，无法统一检索
- **决策**: ✅ 方案 B — KB 入库时同步写入 runtime per-workspace DB
- **修复范围**:
  - KB 上传/更新/删除时，service 通过 gRPC 或 HTTP 通知 runtime 同步数据
  - runtime 将 KB chunks 写入 `memory_entries`(source='knowledge') + `vec_embeddings` + `memory_fts`
  - 新增 runtime endpoint: `POST /runtime/ws/:wsId/kb/sync` (接收 KB chunk 批量同步)
  - service 层 KB 模块在 create/update/delete chunk 后调用 runtime sync
  - 好处：H2/H3/H4 自然打通，完全符合设计文档"统一认知架构"
- **状态**: [x] 已完成 (2026-03-10)

### H2. KB 接入 FTS5 全文索引
- **现状**: runtime 的 `memory_fts` 表只服务 episodic/semantic 记忆，KB 文档不参与全文检索
- **修复范围**:
  - KB 入库时同步写入 `memory_fts`（与 H1 统一处理）
  - 或在 `SqliteFtsIndex` 中增加 KB 文档索引路径
- **依赖**: H1（统一存储后才能统一索引）
- **状态**: [x] 已完成 (2026-03-10) — 随 H1 方案 B 自动打通

### H3. KB 实体抽取 → 知识图谱
- **现状**: 设计文档 `03-knowledge-base-integration.md` Phase 3，完全未实现
- **修复范围**:
  - KB 上传/更新时调用 `EntityExtractor.extract()` 抽取实体
  - 抽取结果写入 `entities` + `relations` 表（`source='knowledge'`）
  - 需要决定触发时机：上传时同步 or 后台异步
- **依赖**: H1（KB 数据在 runtime DB 中才能做实体抽取）
- **状态**: [x] 已完成 (2026-03-10)

### H4. search_knowledge 统一检索路径
- **现状**: `makeSearchKnowledgeTool()` 走 service 层独立搜索 API，未经 runtime 的 HybridSearch
- **后果**: KB 搜索不享受 vector + FTS + graph 融合检索、scoring、reranking
- **修复范围**:
  - 改造 `search-knowledge.ts`：直接调用 `memoryManager.search({ source: 'knowledge', ... })`
  - 或增加 `HybridSearch` 的 source 过滤参数
- **依赖**: H1 + H2（KB 数据须在 runtime 统一存储后才能走 HybridSearch）
- **状态**: [x] 已完成 (2026-03-10)

### H5. Scheduled/Background Lane → Cron 对接
- **现状**: Orchestrator 定义了 `scheduled`(max=3) / `background`(max=2) 车道，无调度器连接
- **后果**: service 层 Scheduler 模块（已有 CRUD）无法触发定时 agent 执行
- **修复范围**:
  - 新增 runtime HTTP endpoint: `POST /runtime/scheduled-run` （接受 schedulerId + cron context）
  - 或 service 层定时器直接调 `POST /runtime/ws/:wsId/runs` 并指定 `lane: 'scheduled'`
  - Gateway 增加 scheduler → runtime 的转发路由
  - 需要定义 cron 执行的鉴权方式（类似 `X-Runtime-Secret`）
- **状态**: [x] 已完成 (2026-03-10) — Service executeTask() → HTTP POST /runtime/scheduled-run → Orchestrator scheduled lane → Agent execution

### H6. Model-aware Context Window
- **现状**: `TokenBudgetAllocator` 硬编码 200K
- **后果**: GPT-4 (128K) 会被分配超出实际窗口的 budget；Gemini (1M) 浪费大量可用空间
- **修复范围**:
  - `context/token-budget.ts` — 从 `ProviderAdapter.capabilities()` 获取 `maxContextTokens`
  - `providers/capability-detector.ts` — 按 model ID 返回正确的 context window
  - `coordinator.ts` — 将 capabilities 传递给 ContextEngine
- **状态**: [x] 已完成 (2026-03-10)

### H7. Channel 约束注入
- **现状**: PromptBuilder 预留了 channel constraints section，但无实际解析逻辑
- **后果**: Slack/Discord/Web 不同 channel 共用相同 prompt，无法限制输出格式和长度
- **修复范围**:
  - 定义 ChannelConstraints 类型（maxTokens, format, mentions, attachments 等）
  - `prompt-builder.ts` — 读取 channel 配置并注入 constraints section
  - service 层 Channel 模块提供 constraints 查询接口
- **状态**: [x] 已完成 (2026-03-10)

---

## P2 Medium — 部分实现或存根

### M1. Provider Rotation 状态持久化
- **现状**: `ProviderRotator` 的故障标记（cooldown）仅存内存，重启即丢失
- **修复范围**:
  - 持久化到 runtime DB（新表 `provider_status`）或 session 级 JSON
  - 重启时加载最近 N 小时的故障记录
- **状态**: [x] 已完成 (2026-03-10)

### M2. Sub-Agent Context Slicing
- **现状**: `SubAgentSpawner` 的 `context_slice` 参数已定义但无调用方传入
- **修复范围**:
  - `delegate.ts` 工具参数增加可选 `contextSlice` 字段
  - LLM 可通过 tool_call 传递上下文片段给子 agent
  - `sub-agent-spawner.ts` 中将 slice 注入子 agent 的 system prompt
- **状态**: [x] 已完成 (2026-03-10) — delegate.ts contextSlice 参数 → executor.ts 注入子 agent system prompt

### M3. Message Converter Usage 数据补全
- **现状**: pi-ai 无 usage 数据时 `STUB_USAGE = {inputTokens: 0, outputTokens: 0}`
- **修复范围**:
  - 从 pi-ai 的 stream metadata 或 response headers 中提取 usage（如果支持）
  - 或在 coordinator 层通过 token counting (tiktoken) 估算
  - 影响 token 用量统计的准确性
- **状态**: [x] 已完成 (2026-03-10)

### M4. Reranker 配置与激活
- **现状**: `DefaultReranker` 需要外部 cross-encoder 模型，未配置时退化为 noop
- **修复范围**:
  - 增加环境变量 `RERANKER_MODEL` / `RERANKER_API_KEY` / `RERANKER_BASE_URL`
  - `bootstrap.ts` 中根据配置初始化 reranker 并注入 HybridSearch
  - 文档说明推荐的 reranker 模型（如 bge-reranker-v2-m3）
- **状态**: [x] 已完成 (2026-03-10)

---

## P3 Low — 前端展示层增强

### L1. Memory 可视化 UI
- **现状**: 后端 6 层记忆系统无任何前端展示
- **修复范围**:
  - 新增 runtime API: `GET /runtime/ws/:wsId/agents/:agentId/memory?type=...`（查询记忆条目）
  - 前端新增 Memory Panel 组件，按类型展示记忆（episodic/semantic/reflection/entity/core）
  - 集成到 agent 详情页或 chat 侧栏
- **状态**: [x] 已完成 (2026-03-10) — runtime GET endpoint 支持 type/limit/query 参数，返回 MemoryEntry + score + breakdown

### L2. KB 搜索结果结构化展示
- **现状**: `tool-result` 事件中 KB 结果显示为纯文本
- **修复范围**:
  - `search_knowledge` 工具返回结构化 JSON（含 documentName, chunkIndex, relevanceScore, highlight）
  - 前端 `ToolCallCard` 针对 `search_knowledge` 渲染引用卡片（来源文档、相关度分数）
- **状态**: [x] 已完成 (2026-03-10) — ToolCallCard 解析 search_knowledge JSON 结果，渲染 KBResultCard（文档名、分数、可展开内容）

### L3. Agent 状态面板连接真实数据
- **现状**: 使用硬编码 `MOCK_AGENTS`
- **修复范围**:
  - 前端调用 agent API 获取真实 agent 列表
  - 增加 runtime API: `GET /runtime/status`（返回 lane 占用、活跃 run 数、队列深度）
  - Agent 卡片显示在线/离线/忙碌状态
- **状态**: [x] 已完成 (2026-03-10) — MOCK_AGENTS 替换为 agentList props，从 SSE streaming state 推导实时状态，activities 从消息中提取

### L4. Context Injection 透明度
- **现状**: MemoryInjector 注入了哪些记忆到 prompt，前端完全不可见
- **修复范围**:
  - EventBus 增加 `memory-injected` 事件类型（含 injected memory IDs + scores）
  - 前端 Activity Panel 中渲染 "注入了 N 条相关记忆" 条目，可展开查看详情
  - `use-streaming-chat.ts` 增加对 `memory-injected` 事件的处理
- **状态**: [x] 已完成 (2026-03-10) — memory-injection 事件从 internal 提升为 SSE，coordinator 注入后 emit，前端渲染 activity card

---

## 归档说明

本计划保留作为实现归档，不再作为待办清单维护。

---

## 已确认打通的链路（无需修改）

- Gateway HTTP → gRPC → Service → SQLite ✅
- Gateway → Runtime proxy (`/runtime/*`) ✅
- Runtime SSE streaming → 前端 ReadableStream 消费 ✅
- AgentLoop → ContextEngine → PromptBuilder → LLM ✅
- Tool 执行 → EventBus → SSE → 前端展示 ✅
- Memory read path (core + injection → system prompt) ✅
- Memory write path (episodic extraction → store + embed + FTS) ✅
- Session history persistence (PersistentMessageHistory → SQLite) ✅
- History trimming + compaction ✅
- Plugin hot-load/sync ✅
- Channel run → orchestrator → reply to gateway ✅
- Resume from message/run (gRPC + 前端 retry logic) ✅
- Run cancel (前端 abort → runtime cancel endpoint) ✅
