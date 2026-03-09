# 对标项目架构分析

> 分析对象：pi-agent-core / pi-coding-agent 生态（对标项目核心依赖）
> 分析日期：2026-03-09

---

## 1. 整体架构

对标项目采用 **外部核心 + 自研外壳** 的架构模式：

- **pi-agent-core**：Agent 循环语义与事件语义基础库，提供 `AgentTool` 接口定义
- **pi-coding-agent**：编码 Agent 专用库，提供 `AgentSession` 状态机、`SessionManager` 持久化、`StreamFn` 流式回调
- **pi-ai**：LLM Provider 抽象层，提供 `stream()` 函数和多模型适配

对标项目自身代码围绕这三个外部库构建工具体系、策略管道、事件总线和记忆模块。

### 核心依赖关系

```
对标项目自研代码
├── @mariozechner/pi-agent-core    ← AgentTool 接口、工具定义
├── @mariozechner/pi-coding-agent  ← AgentSession、SessionManager、compaction
└── @mariozechner/pi-ai            ← StreamFn、Provider 抽象
```

**关键判断：** 对标项目的 Agent 核心循环（LLM 调用 → 工具执行 → 消息处理）不可控，由外部库决定。这限制了其在循环内部插入自定义逻辑（如主动记忆注入、上下文动态裁剪）的能力。

---

## 2. Agent 运行时

### 2.1 执行入口

- 入口函数：`runEmbeddedPiAgent()`
- 核心循环委托给 `createAgentSession()` + `SessionManager`（来自 pi-coding-agent）
- 重试机制：基于 Auth Profile 数量动态计算重试次数（24 + 8 × profileCount，范围 32-160 次）
- 退避策略：指数退避 + 抖动（250ms → 1.5s）

### 2.2 会话模型

**Session Key 格式：** `agent:<agentId>:<rest>`
- 变体：`subagent:*`、`acp:*`、`cron:*`
- 深度追踪：`.getSubagentDepth()` 统计 `:subagent:` 嵌套层数
- 持久化：JSONL 文件存储在 `~/.对标项目/agents/<agentId>/sessions/`

**会话生命周期：**

```
创建（Session Key 命名）
  → 状态持久化（JSONL 文件）
  → 生命周期事件发射（emitAgentEvent + 序列号）
  → 终止（手动关闭或超时清理）
```

### 2.3 事件总线

**事件载荷结构：**

```typescript
type AgentEventPayload = {
  runId: string
  seq: number           // 每个 runId 单调递增
  stream: "lifecycle" | "tool" | "assistant" | "error"
  ts: number
  data: Record<string, unknown>
  sessionKey?: string
}
```

**事件流分类：**

| 流 | 事件类型 |
|----|---------|
| lifecycle | agent_start, agent_end, auto_compaction_start/end |
| assistant | message_start, message_update, message_end |
| tool | tool_execution_start/update/end |
| error | 带分类的失败消息 |

**实现机制：**
- 全局监听器集合：`Set<(evt: AgentEventPayload) => void>`
- Per-run 上下文注册：`Map<string, AgentRunContext>`
- 严格单调序列号：`Map<string, number>`（per runId）

---

## 3. 工具体系

### 3.1 工具分类

| 类别 | 工具 |
|------|------|
| Files | read, write, edit, apply_patch |
| Runtime | exec, process |
| Web | web_search, web_fetch |
| Memory | memory_search, memory_get |
| Sessions | sessions_spawn, sessions_list, sessions_history, sessions_send |
| Agents | subagent 派遣 |
| Media | 图像处理 |

### 3.2 工具执行管道

```
Tool 输入
  → 策略过滤（applyToolPolicyPipeline）
  → Hook 拦截（wrapToolWithBeforeToolCallHook）
  → 参数归一化（snake_case ↔ camelCase）
  → 工作区守卫（wrapToolWorkspaceRootGuard）
  → 中止信号（wrapToolWithAbortSignal）
  → execute(params, ctx)
```

### 3.3 策略层级

策略解析按优先级叠加（deny 优先于 allow）：

1. **全局默认**：`agents.defaults.tools`
2. **Agent 级**：`agents.list[].tools`
3. **Session 级**：per-session model/tool 覆盖
4. **群组策略**：群组聊天 vs 私聊不同规则
5. **子 Agent 策略**：深度限制
6. **消息渠道策略**：语音频道禁用 TTS
7. **模型 Provider 策略**：xAI 禁用 web_search（与原生冲突）

**工具组：**
- `group:core` — 全部内置工具
- `group:plugins` — 动态插件工具
- `group:<pluginId>` — 按插件分组

---

## 4. 编排层

### 4.1 Lane-based 命令队列

```typescript
// 按职责分道，可配并发数
CommandLane.Main     // 串行执行
CommandLane.Cron     // Cron 任务
CommandLane.Auth     // Auth 探测
CommandLane.Session  // 会话操作
```

- 每个 Lane 独立的并发控制（`maxConcurrent`）
- Promise-based 入队/出队，错误传播
- 2s 等待警告，队列深度追踪
- 反压机制

### 4.2 并发控制

- Session 写锁：`acquireSessionWriteLock()`
- 锁持有时间从超时计算
- 防止 Session 状态的并发变更

### 4.3 Auth Profile 轮换

```
resolveAuthProfileOrder()
  → 按最近使用排序
  → markAuthProfileFailure()（记录失败原因码）
  → isProfileInCooldown()（退避机制）
  → resolveProfilesUnavailableReason()（分类：auth/billing/rate_limit）
```

---

## 5. Provider 兼容层

### 5.1 支持的 Provider

| Provider | 特性 |
|----------|------|
| Anthropic | extended thinking, streaming, cache 管理 |
| OpenAI | WebSocket streaming, function calling |
| Google Gemini | turn 顺序修复（function call 必须跟随 user turn） |
| Ollama | 本地模型 |
| AWS Bedrock | 隐式 Provider 解析 |
| xAI/Grok | Provider 特定工具过滤 |
| GitHub Copilot | Token 刷新机制 |

### 5.2 模型能力检测

- `supportsModelTools()` — 是否支持 tool_use/function_calls
- `isReasoningTagProvider()` — 是否支持 extended thinking
- `isCacheTtlEligibleProvider()` — 是否支持 prompt cache

---

## 6. 子 Agent 体系

### 6.1 派遣机制

```typescript
type SpawnAcpParams = {
  task: string              // 初始任务
  agentId?: string          // 目标 Agent
  mode?: "run" | "session"  // 一次性 vs 持久
  thread?: boolean          // 绑定父线程
  sandbox?: "inherit" | "require"
  streamTo?: "parent"       // 流式输出回传父级
}
```

**Session Key 格式：** `subagent:<depth>:<parentSessionKey>:<childSessionId>`

### 6.2 流式回传

- 异步流转发：子 Agent → 父 Session
- 日志捕获：`streamLogPath`
- 实时事件中继

---

## 7. 系统提示词组装

**组件（按顺序）：**

1. Agent 身份信息
2. 模型能力声明
3. 工具目录
4. 渠道约束
5. Bootstrap 文件（可选上下文注入）
6. 模型别名（fallback 列表）
7. 渠道自定义系统消息
8. 工具提示（Slack reactions、Discord embeds 等）
9. Skills 提示词
10. 沙箱信息
11. TTS 提示
12. Heartbeat 模板

**历史管理：**
- `limitHistoryTurns()` — 上下文窗口感知截断
- `getDmHistoryLimitFromSessionKey()` — 渠道特定限制
- `sanitizeSessionHistory()` — Google 特定 turn 顺序修复
- `pruneProcessedHistoryImages()` — 清理已下载图片

---

## 8. 配置体系

### 8.1 Agent 配置

```typescript
{
  id: string
  name?: string
  default?: boolean
  workspace?: string           // Agent 工作目录
  agentDir?: string            // Agent 定义目录
  model?: string | {
    primary: string
    fallbacks?: string[]
  }
  tools?: { allow?: string[]; deny?: string[] }
  skills?: string[]
  memorySearch?: boolean
  heartbeat?: { interval: number }
  identity?: { displayName: string }
  sandbox?: { runtime: "inherit" | "require" }
  subagents?: { maxDepth: number }
}
```

### 8.2 运行时覆盖

- Per-session 模型覆盖（Session 元数据存储）
- Per-message 工具策略（工具解析时应用）
- Skill 过滤器（环境变量覆盖）

---

## 9. 值得借鉴的模式

| 模式 | 描述 | 借鉴价值 |
|------|------|---------|
| Lane-based 命令队列 | 按职责分道、可配并发数 | ✅ 编排层核心模式 |
| Per-run 单调序列号 | 严格递增的事件序列号 | ✅ 事件有序性保证 |
| 多层策略管道 | Global → Agent → Session → Group → Subagent → Provider | ✅ 工具策略体系 |
| Auth Profile 轮换 | 多认证档位 + 冷却 + 退避 | ✅ 高可用模型调用 |
| ContextEngine 接口 | bootstrap → ingest → assemble → compact 生命周期 | ✅ 上下文管理抽象 |
| Fallback 包装器 | 多后端自动降级 | ✅ 记忆检索容错 |
| Session Key 命名规范 | `agent:<id>:<scope>` 结构化命名 | ✅ 会话路由 |

## 10. 需要超越的局限

| 局限 | 描述 | 我们的方案 |
|------|------|----------|
| 核心循环外部依赖 | AgentSession/SessionManager 来自 pi-coding-agent，不可控 | 完全自研 Agent 核心循环 |
| 记忆系统覆盖度低 | 6 大能力仅覆盖 ~15%（衰减 + 混合检索） | 全部 6 大能力自研 |
| 无主动记忆注入 | Agent 必须显式调用 memory_search | 自动触发 + 工具双通道 |
| 无知识图谱 | 纯文本 chunk + 相似度 | 实体-关系图谱 + 时序有效性 |
| Per-agent 记忆隔离 | 子 Agent 仅通过 parent→child 传递 | 私有 + 共享记忆池 + ACL |
| 无虚拟内存 | 静态 compaction，无动态换入换出 | MemGPT 式 core/archival/recall |
