# Agent Runtime 完整架构设计

> 覆盖：Runtime Core / Orchestrator / Event Bus / Tool System / Prompt & Context / Provider Compatibility
> 设计日期：2026-03-09
> 关联文档：01-competitor-analysis.md / 02-memory-system-design.md / 03-knowledge-base-integration.md / 04-database-architecture.md

---

## 目录

1. [架构总览](#1-架构总览)
2. [Agent Runtime Core](#2-agent-runtime-core)
3. [Agent Orchestrator](#3-agent-orchestrator)
4. [Agent Event Bus](#4-agent-event-bus)
5. [Tool System](#5-tool-system)
6. [Prompt & Context Engine](#6-prompt--context-engine)
7. [Memory System Integration](#7-memory-system-integration)
8. [Provider Compatibility Layer](#8-provider-compatibility-layer)
9. [Sub-Agent System](#9-sub-agent-system)
10. [模块依赖图与目录结构](#10-模块依赖图与目录结构)

---

## 1. 架构总览

### 1.1 设计原则

- **完全自研核心循环**：不依赖外部 Agent 框架库，所有循环语义、会话状态、上下文管理自主可控
- **接口驱动**：每个模块对外暴露 TypeScript 接口，实现可替换
- **事件溯源**：所有 Agent 行为产生不可变事件流，per-run 单调序列号
- **统一认知**：KB 和记忆系统是同一认知层的不同知识源
- **渐进扩展**：SQLite 起步，接口不变可迁移到 PostgreSQL + 专业组件

### 1.2 请求全链路

```
Browser
  → POST /runtime/ws/:wsId/runs (创建 Run)
  → Go Gateway (:8080)
  → TS Runtime (:8082)
  → Orchestrator.enqueue(run)
  → RunExecutor.execute(run)
      → AgentSession.create(agent, context)
      → AgentLoop:
          → ContextEngine.assemble() — 组装上下文（core memory + 主动注入 + 历史）
          → ProviderAdapter.stream(messages, tools) — 调用 LLM
          → EventBus.emit(text-delta / tool-call / ...) — 实时事件
          → ToolRuntime.execute(toolCall) — 执行工具
          → ContextEngine.ingestToolResult(result) — 消化工具结果
          → 循环直到 LLM 停止或达到 maxTurns
      → ContextEngine.afterRun() — 记忆提取、反思检查、衰减更新
      → EventBus.emit(done)
  → SSE Stream GET /runtime/runs/:runId/stream
  → Browser
```

### 1.3 核心实体关系

```
Workspace
  ├── Agent (1:N)
  │   ├── AgentConfig (model, tools, sandbox, memory)
  │   ├── CoreMemoryBlocks (persona, user, task, working)
  │   └── PrivateMemory (episodes, reflections)
  ├── KnowledgeBase (1:N)
  │   └── DocumentChunks → 统一记忆层
  ├── SharedMemory (workspace 级共享记忆)
  └── EntityGraph (workspace 级知识图谱)

Session (会话)
  ├── Run (1:N 执行)
  │   ├── AgentTask (子 Agent 任务)
  │   └── EventStream (不可变事件序列)
  └── MessageHistory (消息历史)
```

---

## 2. Agent Runtime Core

### 2.1 AgentSession — 会话执行实体

AgentSession 是 Agent 执行的核心单元。它持有长生命周期状态，多个 Run 在同一 Session 上下文中执行。

```typescript
interface AgentSession {
  // 标识
  readonly id: string
  readonly agentId: string
  readonly workspaceId: string
  readonly sessionKey: string         // 结构化命名：agent:<agentId>:<scope>

  // 状态
  readonly status: SessionStatus      // 'idle' | 'running' | 'suspended' | 'closed'
  readonly currentRunId: string | null

  // 长期状态（跨 Run 存活）
  readonly coreMemory: CoreMemoryManager
  readonly messageHistory: MessageHistory
  readonly contextEngine: ContextEngine

  // 生命周期
  initialize(): Promise<void>         // 加载持久化状态、预热记忆
  suspend(): Promise<void>            // 挂起：序列化状态到存储
  resume(): Promise<void>             // 恢复：从存储反序列化
  close(): Promise<void>              // 关闭：最终状态持久化、资源释放

  // 执行
  executeRun(run: RunRequest): Promise<RunResult>
}

type SessionStatus = 'idle' | 'running' | 'suspended' | 'closed'
```

**Session 状态机：**

```
           initialize()
  [new] ──────────────→ [idle]
                          │
                executeRun()
                          ↓
                       [running] ←─── resume()
                          │               ↑
              run 完成     │               │
                          ↓               │
                        [idle] ───→ [suspended]
                          │         suspend()
                   close() │
                          ↓
                       [closed]
```

### 2.2 SessionManager — 会话持久化实体

```typescript
interface SessionManager {
  // 创建与获取
  create(params: CreateSessionParams): Promise<AgentSession>
  get(sessionId: string): Promise<AgentSession | null>
  getOrCreate(sessionKey: string, params: CreateSessionParams): Promise<AgentSession>

  // 持久化
  save(session: AgentSession): Promise<void>
  load(sessionId: string): Promise<SessionSnapshot | null>

  // 生命周期管理
  listActive(workspaceId: string): Promise<SessionSummary[]>
  cleanup(maxIdleMs: number): Promise<number>   // 清理超时 Session
  close(sessionId: string): Promise<void>
}

interface CreateSessionParams {
  agentId: string
  workspaceId: string
  sessionKey: string
  resumeFromMessageId?: string       // 从某条消息继续
  resumeFromRunId?: string           // 从某次 Run 继续
  resumeMode?: 'continue' | 'regenerate'
}
```

### 2.3 AgentLoop — 核心执行循环

```typescript
interface AgentLoop {
  execute(params: AgentLoopParams): AsyncGenerator<AgentEvent>
}

interface AgentLoopParams {
  session: AgentSession
  run: RunContext
  agent: AgentConfig
  tools: ResolvedTool[]
  providerAdapter: ProviderAdapter
  contextEngine: ContextEngine
  eventBus: EventBus
  abortSignal: AbortSignal
}
```

**循环伪代码：**

```
async function* agentLoop(params):
  turn = 0
  while turn < agent.maxTurns:
    // 1. 组装上下文
    messages = contextEngine.assemble({
      coreMemory: session.coreMemory.read(),
      injectedMemories: await memoryInjector.getRelevant(lastUserMessage),
      messageHistory: session.messageHistory.getRecent(tokenBudget),
      systemPrompt: promptBuilder.build(agent, tools, context),
    })

    // 2. 调用 LLM
    stream = providerAdapter.stream(messages, tools)

    // 3. 处理流式响应
    for await (chunk of stream):
      if chunk.type == 'text-delta':
        yield eventBus.emit({ type: 'text-delta', delta: chunk.text })

      if chunk.type == 'reasoning':
        yield eventBus.emit({ type: 'reasoning-delta', delta: chunk.text })

      if chunk.type == 'tool-call':
        yield eventBus.emit({ type: 'tool-call', toolName, args })

        // 4. 执行工具
        result = await toolRuntime.execute(chunk.toolCall, { session, run, abortSignal })
        yield eventBus.emit({ type: 'tool-result', toolCallId, result, status })

        // 5. 消化工具结果
        contextEngine.ingestToolResult(result)

      if chunk.type == 'stop':
        break

    // 6. 检查终止条件
    if no tool calls in this turn:
      break  // LLM 自然停止

    turn++

  // 7. Run 后处理
  await contextEngine.afterRun({
    extractMemories: true,
    checkReflection: true,
    updateDecay: true,
  })
```

### 2.4 RunContext — 短生命周期执行上下文

```typescript
interface RunContext {
  readonly id: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly coordinatorAgentId: string
  readonly userRequest: string
  readonly status: RunStatus
  readonly idempotencyKey?: string

  // Token 统计
  readonly usage: RunUsage

  // 子任务追踪
  readonly tasks: Map<string, AgentTask>

  // 时间控制
  readonly startedAt: Date
  readonly timeoutMs: number
  readonly abortController: AbortController
}

type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout'

interface RunUsage {
  coordinatorInputTokens: number
  coordinatorOutputTokens: number
  subAgentInputTokens: number
  subAgentOutputTokens: number
  totalTokens: number
}
```

---

## 3. Agent Orchestrator

### 3.1 职责

Orchestrator 管理 Run 的生命周期：排队、调度、超时、重试、模型轮换。

```typescript
interface Orchestrator {
  // 提交 Run
  enqueue(request: RunRequest): Promise<EnqueueResult>

  // 查询状态
  getRunStatus(runId: string): Promise<RunStatus>
  getQueueDepth(): number

  // 控制
  cancel(runId: string): Promise<void>
  shutdown(): Promise<void>
}

interface EnqueueResult {
  runId: string
  status: 'accepted' | 'queued' | 'rejected'
  position?: number          // 队列位置
  estimatedStartMs?: number  // 预计开始时间
}
```

### 3.2 Lane-based 执行队列

借鉴对标项目的 Lane 模式，按职责分道：

```typescript
enum ExecutionLane {
  Interactive = 'interactive',     // 用户交互 Run（最高优先级）
  Channel     = 'channel',         // 渠道消息触发的 Run
  Scheduled   = 'scheduled',       // 定时任务 Run
  Background  = 'background',      // 后台任务（记忆巩固、反思等）
}

interface LaneConfig {
  lane: ExecutionLane
  maxConcurrent: number           // 最大并发数
  priority: number                // 调度优先级（数字越小越高）
  timeoutMs: number               // 默认超时
  retryPolicy: RetryPolicy
}

// 默认配置
const DEFAULT_LANE_CONFIGS: LaneConfig[] = [
  { lane: 'interactive', maxConcurrent: 5,  priority: 0, timeoutMs: 300_000,  retryPolicy: { maxRetries: 2, backoffMs: 1000 } },
  { lane: 'channel',     maxConcurrent: 10, priority: 1, timeoutMs: 180_000,  retryPolicy: { maxRetries: 3, backoffMs: 2000 } },
  { lane: 'scheduled',   maxConcurrent: 3,  priority: 2, timeoutMs: 600_000,  retryPolicy: { maxRetries: 5, backoffMs: 5000 } },
  { lane: 'background',  maxConcurrent: 2,  priority: 3, timeoutMs: 120_000,  retryPolicy: { maxRetries: 1, backoffMs: 3000 } },
]
```

### 3.3 队列调度逻辑

```
每次有空位时:
  1. 按 priority 排序所有 Lane
  2. 对每个 Lane:
     if lane.running < lane.maxConcurrent && lane.queue.length > 0:
       task = lane.queue.dequeue()
       lane.running++
       execute(task).finally(() => lane.running--)
```

### 3.4 超时中止

```typescript
interface TimeoutPolicy {
  runTimeoutMs: number            // 单次 Run 总超时
  turnTimeoutMs: number           // 单轮 LLM 调用超时
  toolTimeoutMs: number           // 单次工具执行超时
  gracefulShutdownMs: number      // 优雅关闭等待时间
}
```

**超时链路：**

```
Run 开始
  → setTimeout(runTimeoutMs)
  → 每轮 LLM 调用有独立的 turnTimeoutMs
  → 每次工具执行有独立的 toolTimeoutMs
  → 任何级别超时 → AbortController.abort()
  → AgentLoop 检测 abortSignal → 优雅退出
  → EventBus.emit({ type: 'error', message: 'timeout' })
```

### 3.5 重试与回退

```typescript
interface RetryPolicy {
  maxRetries: number
  backoffMs: number               // 初始退避
  backoffMultiplier: number       // 退避倍数（默认 2）
  maxBackoffMs: number            // 最大退避
  retryableErrors: string[]       // 可重试的错误码
}

// 可重试错误
const RETRYABLE_ERRORS = [
  'RATE_LIMIT',                   // Provider 限流
  'SERVICE_UNAVAILABLE',          // Provider 暂不可用
  'TIMEOUT',                      // 调用超时
  'NETWORK_ERROR',                // 网络错误
]

// 不可重试错误
const NON_RETRYABLE_ERRORS = [
  'AUTH_FAILED',                  // 认证失败
  'CONTENT_FILTER',               // 内容过滤
  'INVALID_REQUEST',              // 请求格式错误
  'CONTEXT_LENGTH_EXCEEDED',      // 上下文超长
]
```

**重试流程：**

```
attempt = 0
while attempt <= maxRetries:
  try:
    result = await runWithProvider(currentProvider)
    return result
  catch error:
    if error.code not in RETRYABLE_ERRORS:
      throw error  // 不可重试，直接失败

    attempt++
    if attempt > maxRetries:
      // 尝试 fallback Provider
      nextProvider = providerRotator.next()
      if nextProvider:
        currentProvider = nextProvider
        attempt = 0  // 重置重试计数
        continue
      throw error  // 所有 Provider 耗尽

    await sleep(backoffMs * backoffMultiplier^attempt + jitter)
```

### 3.6 模型与认证轮换

```typescript
interface ProviderRotator {
  // 获取当前最佳 Provider
  current(): ProviderProfile

  // 轮换到下一个
  next(): ProviderProfile | null

  // 标记失败
  markFailure(providerId: string, reason: FailureReason): void

  // 标记成功（重置冷却）
  markSuccess(providerId: string): void

  // 检查冷却状态
  isInCooldown(providerId: string): boolean
}

interface ProviderProfile {
  id: string
  provider: string              // 'anthropic' | 'openai' | 'google' | ...
  model: string                 // 'claude-sonnet-4-6' | 'gpt-4o' | ...
  apiKey: string
  baseUrl?: string
  priority: number              // 用户配置的优先级
  cooldownUntil?: Date          // 冷却截止时间
  consecutiveFailures: number
}

type FailureReason = 'rate_limit' | 'auth' | 'billing' | 'timeout' | 'server_error'
```

**轮换策略：**

| 失败原因 | 冷却时间 | 动作 |
|---------|---------|------|
| rate_limit | 30s-60s | 轮换到下一个 Provider |
| auth | 永久（本次 Run） | 跳过此 Provider |
| billing | 永久（本次 Run） | 跳过此 Provider |
| timeout | 10s | 重试当前 Provider |
| server_error | 15s | 轮换到下一个 Provider |

### 3.7 会话级串行

同一 Session 的 Run 必须串行执行（防止状态冲突）：

```typescript
interface SessionLock {
  acquire(sessionId: string, timeoutMs: number): Promise<LockHandle>
  release(handle: LockHandle): void
}

// Orchestrator 在 execute 前获取锁
const lock = await sessionLock.acquire(run.sessionId, 5000)
try {
  await runExecutor.execute(run)
} finally {
  sessionLock.release(lock)
}
```

---

## 4. Agent Event Bus

### 4.1 事件类型系统

```typescript
// 所有事件的统一信封
interface AgentEvent {
  runId: string
  seq: number                     // per-run 严格单调递增
  stream: EventStream
  type: EventType
  ts: number                      // Unix 毫秒时间戳
  sessionKey?: string
  agentId?: string
  data: EventData
}

type EventStream = 'lifecycle' | 'assistant' | 'tool' | 'memory' | 'error'

type EventType =
  // Lifecycle
  | 'run-start' | 'run-end'
  | 'agent-start' | 'agent-end'
  | 'compaction-start' | 'compaction-end'
  // Assistant
  | 'message-start' | 'message-end'
  | 'text-delta'
  | 'reasoning-delta' | 'reasoning'
  // Tool
  | 'tool-call' | 'tool-result'
  | 'approval-request' | 'approval-response'
  // Sub-agent
  | 'agent-switch'
  | 'task-progress' | 'task-complete' | 'task-failed'
  // Memory（新增）
  | 'memory-injection'              // 主动注入记忆到上下文
  | 'memory-extracted'              // 从对话中提取了记忆
  | 'reflection-triggered'          // 反思被触发
  | 'entity-discovered'             // 发现新实体
  // Usage
  | 'usage'
  // Terminal
  | 'done' | 'error'
```

### 4.2 EventBus 接口

```typescript
interface EventBus {
  // 发射事件（返回分配的 seq）
  emit(runId: string, event: Omit<AgentEvent, 'seq' | 'ts'>): number

  // 订阅
  subscribe(runId: string, handler: EventHandler): Unsubscribe
  subscribeAll(handler: EventHandler): Unsubscribe

  // 游标查询（SSE 断点续传）
  replayFrom(runId: string, fromSeq: number): AsyncGenerator<AgentEvent>

  // Run 上下文
  registerRun(runId: string, context: RunMetadata): void
  unregisterRun(runId: string): void
}

type EventHandler = (event: AgentEvent) => void
type Unsubscribe = () => void
```

### 4.3 序列号保证

```typescript
class SequenceAllocator {
  private counters = new Map<string, number>()

  next(runId: string): number {
    const current = this.counters.get(runId) ?? 0
    const next = current + 1
    this.counters.set(runId, next)
    return next
  }

  reset(runId: string): void {
    this.counters.delete(runId)
  }
}
```

**保证：**
- 同一 runId 内 seq 严格单调递增，无间隙
- 不同 runId 的 seq 互相独立
- EventBus.emit() 是同步分配 seq，异步分发

### 4.4 事件缓冲与 SSE 分发

```typescript
interface RunEventBuffer {
  readonly runId: string
  readonly maxEvents: number        // 默认 10,000
  readonly retentionMs: number      // 默认 24h

  // 写入
  append(event: AgentEvent): void

  // 读取（SSE 分发用）
  getFrom(fromSeq: number): AgentEvent[]
  getAll(): AgentEvent[]

  // 订阅（新事件实时推送）
  subscribe(handler: EventHandler): Unsubscribe

  // 清理
  dispose(): void
}
```

**SSE 分发流程：**

```
Client GET /runtime/runs/:runId/stream?cursor=0
  → RunEventBuffer.getFrom(cursor)  // 回放已有事件
  → RunEventBuffer.subscribe()      // 订阅新事件
  → 持续推送直到 'done' 或 'error' 事件
  → 断线后 Client 带 cursor 重连，从断点继续
```

### 4.5 跨网关订阅分发

当 Runtime 运行在独立进程时，Gateway 需要订阅 Runtime 的事件：

```
Browser ←── SSE ──── Gateway (:8080) ←── HTTP Stream ──── Runtime (:8082)
                         │
                    EventRelay
                    (转发 + 缓冲)
```

Gateway 作为 SSE 代理，从 Runtime 的 HTTP Stream 读取事件，转发给 Browser。Gateway 可缓冲事件以支持 Client 断线重连。

---

## 5. Tool System

### 5.1 Tool Abstraction Layer

```typescript
// 工具定义（声明式）
interface ToolDefinition {
  name: string
  description: string
  category: ToolCategory
  riskLevel: RiskLevel

  // 参数 Schema（JSON Schema 或 TypeBox）
  parameters: TSchema

  // 行为标记
  requiresApproval?: boolean       // 需要用户审批
  ownerOnly?: boolean              // 仅 workspace owner 可用
  isLocal?: boolean                // 是否本地执行（vs 远程 API）
  timeout?: number                 // 执行超时 ms
}

type ToolCategory = 'file' | 'browser' | 'terminal' | 'system' | 'api' | 'memory' | 'agent' | 'knowledge' | 'plugin'
type RiskLevel = 'low' | 'medium' | 'high' | 'critical'

// 工具实现
interface AgentTool {
  definition: ToolDefinition

  // 执行
  execute(params: Record<string, unknown>, context: ToolContext): Promise<ToolResult>

  // 可选：参数预处理
  validateParams?(params: unknown): ValidationResult

  // 可选：结果后处理
  formatResult?(result: ToolResult): string
}

interface ToolContext {
  toolCallId: string
  runId: string
  sessionId: string
  agentId: string
  workspaceId: string
  abortSignal: AbortSignal
  eventBus: EventBus
}

interface ToolResult {
  status: 'success' | 'error'
  data: unknown
  error?: string
  metadata?: {
    durationMs: number
    tokensUsed?: number
  }
}
```

### 5.2 参数归一化层

所有工具参数经过统一的归一化处理：

```typescript
interface ParamNormalizer {
  // 类型安全的参数读取
  readString(params: Record<string, unknown>, key: string, required?: boolean): string | undefined
  readNumber(params: Record<string, unknown>, key: string, required?: boolean): number | undefined
  readBoolean(params: Record<string, unknown>, key: string): boolean
  readStringArray(params: Record<string, unknown>, key: string): string[]
  readObject<T>(params: Record<string, unknown>, key: string, schema: TSchema): T | undefined

  // 命名约定转换
  snakeToCamel(params: Record<string, unknown>): Record<string, unknown>
  camelToSnake(params: Record<string, unknown>): Record<string, unknown>
}
```

### 5.3 结果归一化层

```typescript
interface ResultNormalizer {
  // 统一结果格式
  normalize(raw: unknown): ToolResult

  // 截断过长结果
  truncate(result: ToolResult, maxTokens: number): ToolResult

  // 敏感信息脱敏
  redact(result: ToolResult, patterns: RegExp[]): ToolResult
}
```

### 5.4 异常标准化层

```typescript
// 所有工具错误统一为 ToolError
class ToolError extends Error {
  constructor(
    message: string,
    public readonly code: ToolErrorCode,
    public readonly toolName: string,
    public readonly recoverable: boolean = false,
  ) {
    super(message)
  }
}

type ToolErrorCode =
  | 'INVALID_PARAMS'           // 参数校验失败
  | 'PERMISSION_DENIED'        // 权限不足
  | 'NOT_FOUND'                // 资源未找到
  | 'TIMEOUT'                  // 执行超时
  | 'ABORTED'                  // 被中止
  | 'RATE_LIMIT'               // 限流
  | 'EXECUTION_ERROR'          // 执行异常
  | 'APPROVAL_REQUIRED'        // 需要审批
  | 'APPROVAL_REJECTED'        // 审批被拒绝
  | 'SANDBOX_VIOLATION'        // 沙箱越界
```

### 5.5 中止信号传播

```
Run AbortController
  └── Tool AbortController (per tool call)
       └── 传递给：
           ├── fetch() requests
           ├── child_process.spawn()
           ├── Sub-agent runs
           └── 任何异步操作

Run 被取消 → 所有进行中的工具调用同时收到 abort 信号
```

### 5.6 Tool Policy — 多层策略体系

```typescript
interface ToolPolicy {
  allow?: string[]               // 允许列表（glob 模式）
  deny?: string[]                // 拒绝列表（glob 模式，优先于 allow）
}

// 策略解析层级（按优先级从高到低）
interface ToolPolicyPipeline {
  resolve(context: PolicyContext): ResolvedToolPolicy

  // 各层策略源
  layers: [
    GlobalPolicy,                // 1. 全局默认策略
    AgentPolicy,                 // 2. Agent 级策略
    ProviderPolicy,              // 3. Provider 级策略（某些 Provider 不兼容某些工具）
    GroupPolicy,                 // 4. 群组/渠道策略
    SubAgentDepthPolicy,         // 5. 子 Agent 深度策略
    ChannelPolicy,               // 6. 消息渠道策略
  ]
}

interface PolicyContext {
  agentId: string
  providerId: string
  channelType?: string
  subAgentDepth: number
  sessionKey: string
}
```

**策略合并规则：**

```
1. 收集所有层的 allow/deny 列表
2. deny 做并集（任何层 deny 的都被拒绝）
3. allow 做交集（必须所有层都 allow 才放行）
4. deny 优先于 allow（如果同时匹配）
5. 未显式 allow 的工具默认允许（除非有 deny）
```

**子 Agent 深度策略（关键）：**

```typescript
function getSubAgentToolPolicy(depth: number, maxDepth: number): ToolPolicy {
  if (depth >= maxDepth) {
    // 叶子 Agent：禁止再派遣子 Agent
    return { deny: ['delegate_to_agent', 'sessions_spawn'] }
  }
  if (depth >= maxDepth - 1) {
    // 倒数第二层：仅允许派遣叶子 Agent
    return { deny: ['sessions_spawn'] }  // 允许 delegate 但不允许 spawn persistent session
  }
  return {}
}
```

### 5.7 Tool Registry

```typescript
interface ToolRegistry {
  // 注册
  register(tool: AgentTool): void
  registerBatch(tools: AgentTool[]): void

  // 查询
  get(name: string): AgentTool | undefined
  list(): AgentTool[]
  listByCategory(category: ToolCategory): AgentTool[]

  // 策略过滤
  resolve(policy: ResolvedToolPolicy): AgentTool[]

  // 插件工具
  loadPluginTools(plugins: PluginManifest[]): void
}
```

### 5.8 内建工具目录

| 类别 | 工具名 | 描述 | 风险级别 |
|------|--------|------|---------|
| **File** | `code_read` | 读取文件 | low |
| **File** | `code_write` | 写入文件 | medium |
| **File** | `code_edit` | 编辑文件 | medium |
| **Terminal** | `exec_command` | 执行命令 | high |
| **Terminal** | `exec_process` | 启动进程 | high |
| **Browser** | `browser_navigate` | 导航网页 | medium |
| **Browser** | `browser_action` | 浏览器操作 | medium |
| **Knowledge** | `search_knowledge` | 搜索知识库 | low |
| **Memory** | `memory_core_read` | 读取 core memory | low |
| **Memory** | `memory_core_update` | 编辑 core memory | low |
| **Memory** | `memory_archival_insert` | 写入归档记忆 | low |
| **Memory** | `memory_archival_search` | 搜索归档记忆 | low |
| **Memory** | `memory_recall_search` | 搜索对话历史 | low |
| **Agent** | `delegate_to_agent` | 委派子 Agent | medium |
| **API** | `web_search` | 网络搜索 | low |
| **API** | `web_fetch` | 抓取网页 | low |
| **Plugin** | `plugin_*` | 插件工具（动态） | 按插件定义 |

### 5.9 审批工作流

```typescript
interface ApprovalWorkflow {
  // 请求审批
  request(params: ApprovalRequest): Promise<string>    // 返回 approval ID

  // 等待审批结果
  waitForDecision(approvalId: string, timeoutMs: number): Promise<ApprovalDecision>

  // 用户响应
  approve(approvalId: string): Promise<void>
  reject(approvalId: string, reason?: string): Promise<void>
}

interface ApprovalRequest {
  runId: string
  toolCallId: string
  toolName: string
  params: Record<string, unknown>
  riskLevel: RiskLevel
  reason: string
  expiresAt: Date                 // 默认 15 分钟
}

type ApprovalDecision = 'approved' | 'rejected' | 'expired'
```

---

## 6. Prompt & Context Engine

### 6.1 ContextEngine 接口

```typescript
interface ContextEngine {
  // 生命周期
  initialize(session: AgentSession): Promise<void>

  // 每轮组装上下文
  assemble(params: AssembleParams): Promise<AssembledContext>

  // 消化工具结果
  ingestToolResult(result: ToolResult, toolCall: ToolCall): void

  // 每轮后处理
  afterTurn(turn: TurnSummary): Promise<void>

  // Run 结束后处理
  afterRun(params: AfterRunParams): Promise<void>

  // 压缩
  compact(reason: CompactionReason): Promise<CompactionResult>

  // 子 Agent 上下文
  prepareSubAgentContext(params: SubAgentSpawnParams): Promise<SubAgentContext>

  // 释放
  dispose(): Promise<void>
}

interface AssembleParams {
  tokenBudget: number              // 可用 token 数
  includeSystemPrompt: boolean
  includeCoreMemory: boolean
  includeInjectedMemories: boolean
  includeMessageHistory: boolean
}

interface AssembledContext {
  messages: Message[]
  totalTokens: number
  breakdown: {
    systemPrompt: number
    coreMemory: number
    injectedMemories: number
    messageHistory: number
    reserved: number               // 为输出保留的 token
  }
}
```

### 6.2 System Prompt 组装

```typescript
interface PromptBuilder {
  build(params: PromptBuildParams): string
}

interface PromptBuildParams {
  agent: AgentConfig
  tools: ResolvedTool[]
  coreMemory: CoreMemorySnapshot
  injectedMemories: InjectedMemory[]
  channelContext?: ChannelContext
  sandboxInfo?: SandboxInfo
}
```

**Prompt 结构（按顺序）：**

```
[System Identity]
  你是 {agent.name}，{agent.role}。
  {agent.systemPrompt}

[Core Memory]
  ## 核心记忆
  ### 角色定义
  {coreMemory.persona}
  ### 用户/任务画像
  {coreMemory.user}
  ### 当前工作上下文
  {coreMemory.working}

[Injected Memories]（主动注入，每轮动态变化）
  ## 相关记忆
  以下信息可能与当前对话相关：
  - {memory_1.content} (来源: {source}, 相关度: {score})
  - {memory_2.content}
  ...

[Knowledge Summary]（KB 高频引用摘要）
  ## 知识概要
  {coreMemory.knowledgeSummary}

[Tool Catalog]
  ## 可用工具
  {tools.map(t => t.definition).join('\n')}

[Memory Tools Guide]
  ## 记忆管理
  你可以使用 memory_* 工具管理自己的记忆。
  - 重要信息应存入 core memory
  - 长期知识存入 archival memory
  - 搜索历史对话使用 recall memory

[Channel Constraints]（可选）
  {channelSpecificHints}

[Current Date & Environment]
  当前日期：{date}
  运行环境：{sandboxInfo}
```

### 6.3 Token 预算分配策略

```typescript
interface TokenBudgetAllocator {
  allocate(totalBudget: number, params: AllocationParams): TokenAllocation
}

interface TokenAllocation {
  systemPrompt: number            // 固定部分
  coreMemory: number              // Core Memory 块
  injectedMemories: number        // 主动注入记忆
  messageHistory: number          // 对话历史
  outputReserved: number          // 为模型输出保留

  // 内部细分
  knowledgeInjection: number      // KB 注入份额（injectedMemories 的子集）
  memoryInjection: number         // 记忆注入份额
}
```

**分配策略（默认）：**

```
总预算 = 模型 contextWindow
outputReserved = max(4096, 总预算 × 15%)
可用 = 总预算 - outputReserved

systemPrompt = 实际计算（通常 1000-3000 tokens）
coreMemory = min(2000, 可用 × 10%)
injectedMemories = min(3000, 可用 × 15%)
messageHistory = 可用 - systemPrompt - coreMemory - injectedMemories
```

### 6.4 历史裁剪策略

```typescript
interface HistoryTrimmer {
  trim(messages: Message[], tokenBudget: number): Message[]
}
```

**裁剪规则：**

1. 始终保留第一条用户消息（任务起点）
2. 始终保留最近 2 轮对话
3. 从最旧的消息开始移除
4. 工具调用和结果作为一组移除（不拆散）
5. 移除的消息生成摘要，插入为 `[Earlier conversation summarized: ...]`

### 6.5 自动压缩

**触发条件：**

```typescript
function shouldCompact(context: ContextState): boolean {
  return (
    context.messageHistory.tokens > context.tokenBudget * 0.85 ||  // 历史占比过高
    context.turnCount >= 20 ||                                      // 轮次过多
    context.totalTokens > context.maxContextWindow * 0.90           // 接近 context 上限
  )
}
```

**压缩流程：**

```
1. 将消息历史分为两部分：要压缩的（旧）和要保留的（新）
2. 对旧消息调用 LLM 生成摘要（reasoning=high）
3. 摘要包含：
   - 活跃任务及状态
   - 最近用户请求和执行的动作
   - 关键决策和理由
   - 待办事项和开放问题
4. 用摘要消息替换旧消息
5. 记录压缩事件（compaction-start/end）
```

---

## 7. Memory System Integration

### 7.1 MemoryManager — 记忆系统入口

```typescript
interface MemoryManager {
  // 记忆写入
  ingest(entry: NewMemoryEntry): Promise<string>
  ingestBatch(entries: NewMemoryEntry[]): Promise<string[]>

  // 统一检索（跨所有源：KB + episode + reflection + semantic）
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>

  // Core Memory 管理
  getCoreMemory(agentId: string): Promise<CoreMemorySnapshot>
  updateCoreMemory(agentId: string, blockType: string, content: string): Promise<void>

  // 知识图谱
  extractEntities(text: string, source: EntitySource): Promise<Entity[]>
  queryGraph(entityId: string, maxHops: number): Promise<GraphResult>

  // 反思
  checkReflectionTrigger(agentId: string): Promise<boolean>
  executeReflection(agentId: string): Promise<ReflectionResult>

  // 遗忘曲线
  refreshAccess(memoryId: string, accessType: AccessType): Promise<void>
  batchDecayUpdate(): Promise<DecayUpdateResult>

  // 主动注入
  getRelevantInjections(context: InjectionContext): Promise<InjectedMemory[]>

  // 巩固
  consolidate(agentId: string): Promise<ConsolidationResult>
}
```

### 7.2 主动注入管道

```typescript
interface MemoryInjector {
  getRelevant(context: InjectionContext): Promise<InjectedMemory[]>
}

interface InjectionContext {
  currentMessage: string           // 当前用户消息
  recentMessages: Message[]        // 最近几轮对话
  agentId: string
  workspaceId: string
  tokenBudget: number              // 注入可用的 token 数
}

interface InjectedMemory {
  memoryId: string
  content: string
  source: string                   // 'knowledge' | 'episode' | 'reflection' | ...
  score: number                    // injection_score
  reason: string                   // 注入原因（如 "entity match: JWT"）
}
```

**注入流程（每个用户 turn 执行）：**

```
1. 实体提取：从当前消息提取实体关键词（轻量 LLM 调用或规则匹配）
2. 向量检索：当前消息 embedding → sqlite-vec KNN → top 20 候选
3. 图谱扩展：提取到的实体 → 图谱 2 跳遍历 → 关联记忆
4. FTS5 补充：关键词搜索 → 补充向量未覆盖的结果
5. 评分排序：injection_score = w_relevance × similarity + w_importance × importance + w_recency × decay
6. 阈值过滤：score > threshold 的记忆入选
7. Token 裁剪：按 score 降序，在 token 预算内截取
8. 注入：写入 AssembledContext.injectedMemories
```

### 7.3 Run 后处理管道

每次 Run 结束后执行：

```
afterRun():
  1. 记忆提取：从 Run 的对话中提取事实 → 写入 semantic memory
  2. 实体发现：从对话中提取实体 → 更新知识图谱
  3. KB 使用记录：记录本次 Run 引用了哪些 KB 块 → 更新访问日志
  4. 衰减刷新：被访问的记忆刷新 decay_score 和 half_life
  5. 反思检查：累计重要性 > 阈值？触发反思
  6. 巩固检查：总记忆量或 token 累计达标？触发巩固
  7. Core Memory 更新建议：LLM 判断是否需要更新 core memory
```

---

## 8. Provider Compatibility Layer

### 8.1 ProviderAdapter 接口

```typescript
interface ProviderAdapter {
  // 流式调用
  stream(params: StreamParams): AsyncGenerator<StreamChunk>

  // 非流式调用（用于记忆提取等内部调用）
  complete(params: CompleteParams): Promise<CompleteResult>

  // 嵌入
  embed(texts: string[], model?: string): Promise<Float32Array[]>

  // 能力查询
  capabilities(): ProviderCapabilities
}

interface StreamParams {
  messages: Message[]
  tools?: ToolDefinition[]
  model: string
  temperature?: number
  maxTokens?: number
  stopSequences?: string[]
  reasoning?: 'off' | 'low' | 'high'     // extended thinking
}

type StreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'stop'; reason: StopReason }
  | { type: 'error'; error: ProviderError }

interface ProviderCapabilities {
  streaming: boolean
  toolUse: boolean
  reasoning: boolean                     // extended thinking
  vision: boolean                        // 图像输入
  caching: boolean                       // prompt cache
  maxContextWindow: number
  maxOutputTokens: number
}
```

### 8.2 Provider 实现

```typescript
// 每个 Provider 实现 ProviderAdapter 接口

class AnthropicAdapter implements ProviderAdapter {
  // Claude 模型
  // 支持: streaming, tool_use, extended thinking, vision, prompt cache
  // 特殊处理: cache_control 标记, 系统提示词格式
}

class OpenAIAdapter implements ProviderAdapter {
  // GPT/o 系列模型
  // 支持: streaming (SSE + WebSocket), function_calling, vision
  // 特殊处理: function_call vs tool_choice 格式差异
}

class GoogleAdapter implements ProviderAdapter {
  // Gemini 模型
  // 支持: streaming, function_calling, vision
  // 特殊处理: turn 顺序修复（function_call 必须跟随 user turn）
  //          schema 限制（不支持 anyOf/oneOf）
}

class OpenAICompatibleAdapter implements ProviderAdapter {
  // 通用 OpenAI 兼容端点（xAI、DeepSeek、Qwen 等）
  // 通过 baseUrl 配置指向不同 Provider
}

class OllamaAdapter implements ProviderAdapter {
  // 本地 Ollama 模型
  // 支持: streaming
  // 特殊处理: 本地网络，无 API key
}
```

### 8.3 消息格式转换

```typescript
interface MessageConverter {
  // 统一内部格式 → Provider 特定格式
  toProviderFormat(messages: Message[], provider: string): ProviderMessage[]

  // Provider 特定格式 → 统一内部格式
  fromProviderFormat(messages: ProviderMessage[], provider: string): Message[]
}
```

**需要处理的差异：**

| 差异点 | Anthropic | OpenAI | Google |
|--------|-----------|--------|--------|
| 系统消息 | `system` 参数 | `role: system` | `systemInstruction` |
| 工具调用 | `tool_use` content block | `tool_calls` 字段 | `functionCall` part |
| 工具结果 | `tool_result` role | `tool` role | `functionResponse` part |
| 图像 | base64 in content block | base64 url in content | `inlineData` part |
| 思考 | `thinking` content block | N/A | N/A |

---

## 9. Sub-Agent System

### 9.1 委派机制

```typescript
interface SubAgentSpawner {
  // 委派任务给子 Agent
  delegate(params: DelegateParams): Promise<DelegateResult>

  // 查询子任务状态
  getTaskStatus(taskId: string): Promise<AgentTask>

  // 等待子任务完成
  waitForTask(taskId: string, timeoutMs: number): Promise<TaskResult>
}

interface DelegateParams {
  parentRunId: string
  parentAgentId: string
  targetAgentId: string
  instruction: string
  depth: number                    // 当前嵌套深度
  maxDepth: number                 // 最大嵌套深度（默认 3）
  mode: 'oneshot' | 'session'     // 一次性 vs 持久会话
  streamToParent: boolean          // 是否将输出流式回传给父级
  contextSlice?: Message[]         // 传递给子 Agent 的上下文片段
}

interface DelegateResult {
  taskId: string
  childRunId: string
  status: 'accepted' | 'rejected'
  rejectionReason?: string         // 如 "max_depth_exceeded"
}
```

### 9.2 子 Agent 上下文隔离

```
父 Agent 上下文:
  ├── Core Memory: 父级完整 core memory
  ├── History: 父级完整对话历史
  └── Tools: 父级完整工具集

子 Agent 上下文:
  ├── Core Memory: 子 Agent 自己的 core memory
  ├── History: 空（仅包含 instruction 作为首条消息）
  ├── Context Slice: 父级传递的上下文片段（可选）
  ├── Tools: 按深度策略过滤后的工具集
  └── Memory: 共享记忆可读，私有记忆独立
```

### 9.3 结果回传

子 Agent 完成后，结果通过 `tool-result` 事件回传给父 Agent：

```
父 Agent → delegate_to_agent(targetAgent, instruction)
  → EventBus.emit(agent-switch, { agentId: targetAgent })
  → 子 Agent 执行
    → EventBus.emit(task-progress, { taskId, progress })
    → EventBus.emit(text-delta, { delta }) // 如果 streamToParent
  → 子 Agent 完成
  → EventBus.emit(task-complete, { taskId, result })
  → 父 Agent 收到 tool-result：子 Agent 的执行摘要
  → 父 Agent 继续自己的循环
```

---

## 10. 模块依赖图与目录结构

### 10.1 模块依赖图

```
                    ┌───────────────┐
                    │   HTTP API    │
                    │  (Fastify)    │
                    └──────┬────────┘
                           │
                    ┌──────▼────────┐
                    │  Orchestrator │
                    │  (Queue/Lane) │
                    └──────┬────────┘
                           │
              ┌────────────▼────────────┐
              │      RunExecutor        │
              │  (Run 生命周期管理)      │
              └────────────┬────────────┘
                           │
         ┌─────────────────▼──────────────────┐
         │           AgentLoop                 │
         │  (LLM 调用 → 工具执行 → 循环)       │
         └──┬──────┬──────┬──────┬──────┬─────┘
            │      │      │      │      │
     ┌──────▼┐ ┌──▼────┐ │  ┌──▼────┐ │
     │Context│ │ Tool   │ │  │Provider│ │
     │Engine │ │Runtime │ │  │Adapter │ │
     └──┬────┘ └──┬────┘ │  └──┬────┘ │
        │         │      │     │      │
   ┌────▼───┐ ┌──▼───┐  │  ┌──▼───┐  │
   │ Memory │ │ Tool  │  │  │ LLM  │  │
   │Manager │ │Registry│ │  │ API  │  │
   └────┬───┘ └──────┘  │  └──────┘  │
        │               │            │
   ┌────▼──────────┐ ┌──▼──────┐  ┌──▼──────┐
   │  SQLite +     │ │ Event   │  │ Session  │
   │  sqlite-vec + │ │ Bus     │  │ Manager  │
   │  FTS5         │ └─────────┘  └──────────┘
   └───────────────┘
```

### 10.2 目录结构

```
runtime/src/
├── index.ts                          — 入口，Fastify 服务器 + 路由注册
│
├── core/                             — 核心抽象（接口定义）
│   ├── types.ts                      — 公共类型定义
│   ├── agent-session.ts              — AgentSession 接口
│   ├── session-manager.ts            — SessionManager 接口
│   ├── agent-loop.ts                 — AgentLoop 接口
│   ├── run-context.ts                — RunContext 接口
│   ├── context-engine.ts             — ContextEngine 接口
│   └── errors.ts                     — 统一错误类型
│
├── orchestrator/                     — 编排层
│   ├── orchestrator.ts               — Orchestrator 实现
│   ├── execution-lane.ts             — Lane-based 队列
│   ├── run-executor.ts               — Run 执行器
│   ├── session-lock.ts               — 会话级串行锁
│   ├── retry-policy.ts               — 重试与回退策略
│   ├── provider-rotator.ts           — 模型/认证轮换
│   └── timeout-controller.ts         — 超时控制
│
├── agent/                            — Agent 执行
│   ├── agent-loop.impl.ts            — AgentLoop 实现（核心循环）
│   ├── agent-session.impl.ts         — AgentSession 实现
│   ├── session-manager.impl.ts       — SessionManager 实现
│   ├── sub-agent-spawner.ts          — 子 Agent 派遣
│   └── message-history.ts            — 消息历史管理
│
├── events/                           — 事件总线
│   ├── event-bus.ts                  — EventBus 实现
│   ├── event-types.ts                — 事件类型定义
│   ├── sequence-allocator.ts         — 序列号分配器
│   ├── run-event-buffer.ts           — per-run 事件缓冲
│   └── sse-relay.ts                  — SSE 分发
│
├── tools/                            — 工具体系
│   ├── registry.ts                   — ToolRegistry 实现
│   ├── tool-runtime.ts               — 工具执行运行时
│   ├── policy-pipeline.ts            — 多层策略管道
│   ├── param-normalizer.ts           — 参数归一化
│   ├── result-normalizer.ts          — 结果归一化
│   ├── approval-workflow.ts          — 审批工作流
│   ├── builtin/                      — 内建工具
│   │   ├── code-read.ts
│   │   ├── code-write.ts
│   │   ├── code-edit.ts
│   │   ├── exec-command.ts
│   │   ├── web-search.ts
│   │   ├── web-fetch.ts
│   │   ├── search-knowledge.ts
│   │   ├── delegate-to-agent.ts
│   │   ├── memory-core.ts           — Core Memory 工具
│   │   ├── memory-archival.ts        — Archival Memory 工具
│   │   └── memory-recall.ts          — Recall Memory 工具
│   └── plugin-loader.ts             — 插件工具加载
│
├── context/                          — 上下文管理
│   ├── context-engine.impl.ts        — ContextEngine 实现
│   ├── prompt-builder.ts             — System Prompt 组装
│   ├── token-budget.ts               — Token 预算分配
│   ├── history-trimmer.ts            — 历史裁剪
│   ├── compactor.ts                  — 自动压缩
│   └── memory-injector.ts            — 主动记忆注入
│
├── memory/                           — 记忆系统
│   ├── memory-manager.ts             — MemoryManager 实现
│   ├── store/                        — 存储层
│   │   ├── interfaces.ts             — MemoryStore / VectorIndex / FullTextIndex / GraphStore 接口
│   │   ├── sqlite-memory-store.ts    — SQLite 实现
│   │   ├── sqlite-vector-index.ts    — sqlite-vec 实现
│   │   ├── sqlite-fts-index.ts       — FTS5 实现
│   │   └── sqlite-graph-store.ts     — Recursive CTE 图谱实现
│   ├── extraction/                   — 记忆提取
│   │   ├── memory-extractor.ts       — 从对话中提取记忆
│   │   └── entity-extractor.ts       — 实体提取
│   ├── retrieval/                    — 记忆检索
│   │   ├── hybrid-search.ts          — 混合检索（向量 + FTS5 + 图谱）
│   │   ├── scoring.ts                — 三因子评分
│   │   └── reranker.ts               — 可选重排序
│   ├── lifecycle/                    — 记忆生命周期
│   │   ├── decay-engine.ts           — 遗忘曲线引擎
│   │   ├── consolidator.ts           — 记忆巩固
│   │   ├── reflection-engine.ts      — 反思引擎
│   │   └── core-memory-manager.ts    — Core Memory 管理
│   └── shared/                       — 多 Agent 共享
│       ├── visibility-manager.ts     — 可见性管理
│       └── experience-propagator.ts  — 经验传播
│
├── providers/                        — LLM Provider 层
│   ├── adapter.ts                    — ProviderAdapter 接口
│   ├── anthropic.ts                  — Anthropic 实现
│   ├── openai.ts                     — OpenAI 实现
│   ├── google.ts                     — Google Gemini 实现
│   ├── openai-compatible.ts          — 通用 OpenAI 兼容实现
│   ├── ollama.ts                     — Ollama 实现
│   ├── message-converter.ts          — 消息格式转换
│   └── capability-detector.ts        — 能力检测
│
├── embedding/                        — 嵌入服务（KB + 记忆共享）
│   ├── embedding-service.ts          — 统一嵌入入口
│   ├── providers/                    — 嵌入 Provider
│   │   ├── openai-embeddings.ts
│   │   ├── voyage-embeddings.ts
│   │   ├── ollama-embeddings.ts
│   │   └── qwen-embeddings.ts
│   ├── batch-processor.ts            — 批量处理
│   └── cache.ts                      — 嵌入缓存
│
└── db/                               — 数据库
    ├── schema.ts                     — Drizzle Schema（记忆表）
    ├── migrations/                   — 迁移文件
    └── connection.ts                 — 连接管理（per-workspace）
```

### 10.3 模块职责边界

| 模块 | 职责 | 不负责 |
|------|------|--------|
| **core/** | 接口定义、类型约束 | 任何具体实现 |
| **orchestrator/** | Run 排队、调度、超时、重试 | Agent 循环逻辑 |
| **agent/** | 会话状态、循环执行 | 工具实现、记忆存储 |
| **events/** | 事件发射、缓冲、分发 | 业务逻辑 |
| **tools/** | 工具注册、策略过滤、执行 | LLM 调用 |
| **context/** | 上下文组装、Token 分配、压缩 | 记忆存储细节 |
| **memory/** | 记忆全生命周期 | Prompt 格式、SSE 格式 |
| **providers/** | LLM API 调用、格式转换 | 业务逻辑、工具执行 |
| **embedding/** | 嵌入 API 调用、缓存 | 记忆逻辑、KB 逻辑 |
| **db/** | Schema 定义、连接 | 业务查询（在各模块内） |
