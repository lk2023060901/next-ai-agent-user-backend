# 知识库与记忆系统集成设计

> 知识库不是独立 RAG 管道，而是 Agent 认知体系的知识层
> 设计日期：2026-03-09

---

## 1. 设计原则

知识库（KB）和 Agent 记忆系统是 **统一认知架构** 的两个知识源，不是独立系统。

- KB 文档块与对话记忆、反思记忆统一参与检索和评分
- 实体从 KB 内容和对话内容中提取后共建知识图谱
- 6 大记忆能力统一作用于所有知识源

---

## 2. 统一认知架构

```
┌──────────────── Agent 认知架构 ─────────────────┐
│                                                   │
│  知识源（Sources）                                 │
│  ├── Knowledge（知识库文档）— 外部权威知识          │
│  ├── Episodic（情景记忆）— 交互经验                │
│  ├── Semantic（语义记忆）— 提取的事实               │
│  ├── Reflection（反思记忆）— 高阶认知              │
│  └── Procedural（程序记忆）— 行为模式              │
│                                                   │
│  统一检索层                                        │
│  ├── sqlite-vec 向量检索（所有源的 embedding）      │
│  ├── FTS5 全文检索（所有源的文本）                  │
│  ├── 知识图谱遍历（跨源实体关系）                   │
│  └── 混合评分（向量 + 关键词 + 衰减 + 图谱）       │
│                                                   │
│  Context Assembler（上下文组装器）                  │
│  └── Token 预算分配 → 注入 LLM                    │
└───────────────────────────────────────────────────┘
```

---

## 3. KB 与 6 大记忆能力的关联

### 3.1 知识图谱 × KB

KB 文档中提取的实体（人名、API 名、概念）成为图谱节点。

```
示例：
  KB 文档 "auth-guide.md" 包含 "JWT"、"OAuth2"、"refresh_token"
  → 提取 3 个实体节点
  → 建立关系：JWT --[implements]--> OAuth2
  → 对话中 Agent 遇到 "token 过期" 问题
  → 实体 "token" 匹配图谱中 "refresh_token"
  → 自动关联 KB 文档中的认证指南
```

**实体来源标记：**

| source | 含义 | 衰减策略 |
|--------|------|---------|
| `knowledge` | 来自 KB 文档 | 按使用频率衰减 |
| `episode` | 来自对话 | 按时间衰减 |
| `reflection` | 来自反思 | 半衰期更长 |

### 3.2 反思 × KB

Agent 可以对 KB 使用模式产生反思：

```
观察：Agent 在最近 10 次对话中，7 次搜索了 KB 中关于"认证流程"的文档
反思：「项目的认证系统是当前最核心的开发关注点，我应该将相关 KB 内容
      优先保持在 core memory 中」
```

反思结果可以：
- 调整 core memory 的内容优先级
- 优化 KB 检索的默认偏好
- 生成 Agent 对领域的高阶理解

### 3.3 虚拟内存 × KB

KB 块参与 MemGPT 式的内存管理：

```
Core Memory:
  ├── Agent Persona Block
  ├── 高频引用的 KB 关键摘要（固定驻留）
  └── Working Block

Archival Memory:
  ├── 全部 KB 文档块（按需换入）
  ├── 历史对话记忆
  └── 反思记忆
```

- 高频引用的 KB 块被提升到 core memory（摘要形式）
- 低频 KB 块在 archival 中按需通过工具检索
- Agent 可通过 `memory_core_update` 主动将重要 KB 知识固化为 core 内容

### 3.4 遗忘曲线 × KB

KB 块的衰减策略与对话记忆不同：

| 维度 | 对话记忆 | KB 块 |
|------|---------|-------|
| 衰减依据 | 时间 + 重要性 | 使用频率 + 任务相关性 |
| 初始半衰期 | 按重要性分级（3-180 天） | 无初始衰减（永不过期） |
| 访问强化 | +15% 半衰期 | +15% 相关性权重 |
| 遗忘含义 | 检索优先级降低 | 检索排名降低（但不删除） |

KB 块永不被真正"遗忘"（不从存储中移除），但长期未使用的块在检索中排名会降低。

### 3.5 多 Agent 共享 × KB

KB 天然是 workspace 级共享资源：

```
Workspace 共享层:
  ├── KB 文档块 — 所有 Agent 可检索
  ├── KB 实体图谱 — 所有 Agent 共建共享
  └── KB 使用统计 — 聚合所有 Agent 的访问模式

Agent 私有层:
  ├── 个人 KB 使用偏好 — "我偏好 auth-guide.md"
  ├── 个人 KB 引用历史 — 具体引用了哪些块
  └── 个人 KB 反思 — 对 KB 内容的理解
```

### 3.6 主动注入 × KB

KB 内容参与主动记忆注入：

```
用户消息："帮我实现用户登录功能"
  → 实体提取：["用户", "登录"]
  → 图谱查找：
      "登录" --[implements]--> "OAuth2" (来自 KB)
      "登录" --[requires]--> "JWT" (来自 KB)
      "登录" --[discussed_in]--> "3/5 对话" (来自对话记忆)
  → 注入评分过滤
  → 自动注入：
      - KB: auth-guide.md 中关于 OAuth2 流程的段落
      - KB: api-spec.md 中关于 /auth/login 端点的定义
      - 记忆: "上次讨论登录时决定使用 refresh_token 方案"
```

Agent 无需手动调用 `search_knowledge`，相关 KB 内容自动浮现。

---

## 4. 现有 KB 模块的升级路径

### 4.1 当前状态

| 组件 | 状态 |
|------|------|
| KB CRUD（创建/读取/更新/删除） | ✅ 完整 |
| 文档上传/分块/嵌入 | ✅ 可用 |
| 向量存储（JSON 数组） | ⚠️ 需升级为 sqlite-vec |
| 余弦相似度搜索 | ✅ 后端可用 |
| Runtime search_knowledge 工具 | ❌ 空桩 |
| Agent↔KB 关联 | ⚠️ 仅存关系，未注入运行时 |
| 实体提取 | ❌ 不存在 |
| 图谱集成 | ❌ 不存在 |
| FTS5 全文检索 | ❌ 不存在 |
| Reranker | ❌ 字段存在未实现 |

### 4.2 升级计划

**阶段 1：存储升级**
- `kbDocumentChunks.embeddingJson`（JSON 数组）→ sqlite-vec 虚拟表
- 添加 FTS5 索引覆盖 KB 块文本
- 统一向量索引：KB 块和记忆条目共用同一个 sqlite-vec 表

**阶段 2：检索统一**
- 统一检索接口：`source` 字段区分 KB/episode/reflection
- 混合评分：向量 + FTS5 + 衰减 + 图谱关联
- 连通 Runtime search_knowledge 工具

**阶段 3：图谱集成**
- KB 文档上传时自动提取实体
- 实体入图谱，与对话实体统一管理
- 主动注入管道覆盖 KB 源

---

## 5. 对标项目分析：Cherry Studio

Cherry Studio 的 KB 实现作为我们的对标参考：

| 特性 | Cherry Studio | 我们的目标 |
|------|-------------|----------|
| 向量存储 | LibSQL（SQLite 向量扩展） | sqlite-vec（同类方案） |
| RAG 框架 | EmbedJS（自定义 fork） | 自研（统一认知架构） |
| Embedding 支持 | OpenAI, Voyage, Ollama | OpenAI 兼容 + 更多 Provider |
| Reranker | Voyage, Jina, Bailian, TEI | Strategy 模式可插拔 |
| 文档预处理 | Doc2X, Mistral, Mineru, PaddleOCR | 同等支持 |
| 与记忆系统集成 | ❌ 无 | ✅ 统一认知架构 |
| 实体提取 | ❌ 无 | ✅ KB 实体入图谱 |
| 主动注入 | ❌ 无 | ✅ KB 内容自动浮现 |
| 文件类型 | PDF, DOCX, XLSX, PPTX, CSV, MD, HTML, JSON, EPUB | 同等支持 |
| 并发控制 | 30 并发 / 80MB 工作负载 | 类似限制策略 |

**核心差异：** Cherry Studio 的 KB 是独立 RAG 管道，与聊天系统通过 Tool 接口松耦合。我们的 KB 是认知架构的一部分，与记忆系统深度集成。

---

## 6. 嵌入管道共享

KB 和记忆系统共享同一个 Embedding Service：

```
┌─ Embedding Service ─────────────────────┐
│                                           │
│  Provider 适配层                          │
│  ├── OpenAI (text-embedding-3-small/large)│
│  ├── Voyage (voyage-3, voyage-code-3)     │
│  ├── Ollama (本地模型)                    │
│  ├── Qwen                                │
│  ├── Zhipu                               │
│  └── Custom (OpenAI 兼容端点)             │
│                                           │
│  批量处理                                  │
│  ├── 队列化请求                            │
│  ├── 批量大小：8-16 per batch             │
│  └── 超时：60s                            │
│                                           │
│  缓存层                                    │
│  ├── embedding_cache 表                   │
│  └── 按 (provider, model, content_hash)   │
│                                           │
│  调用方                                    │
│  ├── KB 文档上传 → 分块嵌入               │
│  ├── 记忆写入 → 记忆嵌入                  │
│  ├── 检索查询 → 查询嵌入                  │
│  └── 实体提取 → 实体名嵌入（消歧用）      │
└───────────────────────────────────────────┘
```

**约束：** 同一个 workspace 内，KB 和记忆必须使用相同的 embedding 模型和维度，以确保向量空间一致性。
