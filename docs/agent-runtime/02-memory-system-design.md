# Agent 记忆系统设计

> 基于 Stanford Generative Agents、MemGPT/Letta、Graphiti、MemoryBank 等学术与工程成果
> 设计日期：2026-03-09

---

## 1. 设计目标

为 Agent 构建完整的认知记忆体系，覆盖 6 大记忆能力：

1. **反思与自我进化记忆** — Agent 主动对经验进行归纳和抽象
2. **虚拟内存管理** — 借鉴 OS 分页机制管理上下文窗口
3. **知识图谱动态演化** — 实体-关系图谱替代扁平向量检索
4. **遗忘与压缩** — 艾宾浩斯遗忘曲线 + 记忆巩固
5. **多 Agent 共享记忆** — 私有/共享/公共记忆池 + 权限
6. **主动记忆触发** — 上下文关联时自动注入，无需 Agent 显式检索

---

## 2. 记忆类型分层

```
┌─────────────────────────────────────────────┐
│           记忆认知金字塔                       │
│                                               │
│  ┌─────────────────────────────────────────┐ │
│  │  Meta-Reflection（元反思）               │ │
│  │  "我倾向于在认证问题上反复查阅文档"       │ │
│  └──────────────────┬──────────────────────┘ │
│  ┌──────────────────┴──────────────────────┐ │
│  │  Reflection（反思）                      │ │
│  │  "项目的认证系统是核心关注点"             │ │
│  └──────────────────┬──────────────────────┘ │
│  ┌──────────────────┴──────────────────────┐ │
│  │  Semantic（语义记忆）                    │ │
│  │  "JWT 令牌存储在 localStorage 和 cookie" │ │
│  └──────────────────┬──────────────────────┘ │
│  ┌──────────────────┴──────────────────────┐ │
│  │  Episodic（情景记忆）                    │ │
│  │  "用户在 3/9 要求我修复登录 bug"          │ │
│  └──────────────────┬──────────────────────┘ │
│  ┌──────────────────┴──────────────────────┐ │
│  │  Knowledge（知识库）                     │ │
│  │  上传的文档、手册、API 文档               │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

每层记忆都是系统的一等公民，统一参与检索、衰减和注入。

---

## 3. 能力一：反思与自我进化记忆

### 3.1 理论基础

参考 Stanford Generative Agents（2023）。Agent 不只"存"和"取"记忆，而是主动归纳抽象。

### 3.2 三因子检索评分

```
score = α_recency × recency + α_importance × importance + α_relevance × relevance
```

- **Recency（时近性）**：基于最后访问时间的指数衰减
- **Importance（重要性）**：写入时由 LLM 评定 1-10 分（"吃早餐" = 1，"系统架构决策" = 8）
- **Relevance（相关性）**：查询 embedding 与记忆 embedding 的余弦相似度

### 3.3 反思触发机制

**触发条件：** 近期未反思记忆的累计重要性分数超过阈值（建议阈值：150）

**反思流程：**

1. 取最近 100 条记忆，请 LLM 生成 3 个高阶问题
2. 对每个问题，用三因子评分检索相关记忆
3. 请 LLM 综合检索结果生成"反思"陈述
4. 反思陈述作为新记忆写回记忆流（可递归反思）

**反思频率：** 预计每天 2-3 次反思（参考论文数据）

### 3.4 数据结构

```
memory_entry:
  id, type = "reflection"
  content          — 反思文本
  source_ids[]     — 触发此反思的原始记忆 ID 列表
  depth            — 反思层级（0 = 原始观察，1 = 一阶反思，2 = 元反思）
  importance       — LLM 评定的重要性分数
  embedding        — 向量表示
```

---

## 4. 能力二：虚拟内存管理（MemGPT 式）

### 4.1 理论基础

参考 MemGPT（2023）。将 context window 视为 RAM，外部存储视为磁盘。Agent 拥有对自身记忆的元控制能力。

### 4.2 三层内存架构

```
┌─────────────────────────────────────────┐
│  Core Memory（核心记忆）— 常驻上下文      │
│  ├── Agent Persona Block（角色定义）     │
│  ├── User/Task Block（用户/任务画像）    │
│  └── Working Block（当前工作上下文）      │
│  大小限制：~2000 tokens                  │
│  特性：Agent 可自主编辑                   │
├─────────────────────────────────────────┤
│  Recall Memory（回忆记忆）— 对话历史      │
│  ├── 近期对话（FIFO 缓冲）              │
│  ├── 按文本/日期可搜索                   │
│  └── 溢出时自动摘要后归档                │
│  特性：context 满时自动 page-out         │
├─────────────────────────────────────────┤
│  Archival Memory（归档记忆）— 长期存储    │
│  ├── 所有历史记忆（向量可搜索）          │
│  ├── KB 文档块                          │
│  ├── 反思记忆                           │
│  └── 实体关系图谱                        │
│  特性：无容量上限，Agent 按需 page-in    │
└─────────────────────────────────────────┘
```

### 4.3 Agent 自管理工具

Agent 通过以下工具管理自身记忆（非外部调度）：

| 工具 | 作用 |
|------|------|
| `memory_core_read` | 读取 core memory 当前内容 |
| `memory_core_update` | 编辑 core memory 块 |
| `memory_archival_insert` | 将信息写入归档 |
| `memory_archival_search` | 语义检索归档记忆 |
| `memory_recall_search` | 搜索历史对话 |
| `memory_recall_search_date` | 按日期搜索对话 |

### 4.4 换页机制

- **Page-out：** 对话缓冲超出 context 限制时，最老消息被摘要后移至 Recall
- **Page-in：** Agent 通过 `memory_recall_search` 或 `memory_archival_search` 主动换入
- **Core 块固定：** Core Memory 始终在 context 中（类似 OS 的 pinned pages）

---

## 5. 能力三：知识图谱动态演化

### 5.1 理论基础

参考 Graphiti/Zep（2025）。记忆组织为动态演化的知识图谱，不做扁平向量检索。

### 5.2 三层子图

```
┌─ Episode 子图 ──────────────────────┐
│  原始事件/消息节点，带时间戳          │
│  双时序：事件时间 T + 入库时间 T'    │
└──────────────┬──────────────────────┘
               ↓ 实体提取
┌─ Entity 子图 ───────────────────────┐
│  实体节点（人、概念、API、文件等）    │
│  关系边（因果、时序、层级、引用）     │
│  每条边带时序有效性                   │
└──────────────┬──────────────────────┘
               ↓ 社区发现
┌─ Community 子图 ────────────────────┐
│  相关实体的高层分组                   │
│  如："认证子系统"包含 JWT、OAuth 等   │
└─────────────────────────────────────┘
```

### 5.3 实体提取管道

1. 处理当前消息 + 最近 N 条消息作为上下文
2. LLM 提取命名实体（使用 reflexion 技术减少幻觉）
3. 实体名 embedding 化（1024 维向量）
4. 余弦相似度搜索已有图节点（实体消歧/去重）
5. LLM 确认候选匹配是否为同一实体

### 5.4 时序有效性模型（4 时间戳）

```
每条事实/关系包含：
  t_valid      — 事实在现实中生效的时间
  t_invalid    — 事实在现实中失效的时间
  t'_created   — 事实进入系统的时间
  t'_expired   — 事实从系统中过期的时间
```

当新信息与已有事实矛盾时，旧事实被标记失效（不删除），新事实入库。保留完整历史。

### 5.5 混合检索

- **语义搜索**：embedding 相似度
- **关键词搜索**：BM25（FTS5）
- **图遍历**：从命中实体出发，沿关系边扩展 2-3 跳
- **融合策略**：Reciprocal Rank Fusion（RRF）合并三路结果

### 5.6 SQLite 中的图建模

```sql
-- 实体表
entities:
  id, name, type, description, embedding,
  source (kb | episode | reflection),
  created_at, updated_at

-- 关系表
relations:
  id, source_entity_id, target_entity_id,
  relation_type (causes | precedes | contains | references | ...),
  description, weight,
  t_valid, t_invalid, t_created, t_expired

-- 通过 recursive CTE 实现 2-3 跳遍历
WITH RECURSIVE hops AS (
  SELECT target_entity_id, 1 AS depth
  FROM relations WHERE source_entity_id = ?
  UNION ALL
  SELECT r.target_entity_id, h.depth + 1
  FROM relations r JOIN hops h ON r.source_entity_id = h.target_entity_id
  WHERE h.depth < 3
)
SELECT DISTINCT * FROM hops;
```

---

## 6. 能力四：遗忘与压缩

### 6.1 理论基础

参考 MemoryBank（AAAI 2024）+ Kore 项目。模拟艾宾浩斯遗忘曲线。

### 6.2 衰减公式

```
R = e^(-λ × age_days)

其中 λ = ln(2) / half_life_days
```

### 6.3 重要性分级半衰期

| 重要性等级 | 分数范围 | 半衰期 | 示例 |
|-----------|---------|--------|------|
| 临时 | 1-2 | 3 天 | 日常闲聊 |
| 普通 | 3-4 | 14 天 | 一般任务记录 |
| 重要 | 5-6 | 60 天 | 技术决策 |
| 关键 | 7-8 | 180 天 | 架构设计、安全策略 |
| 永久 | 9-10 | ∞ | 核心身份、不可变事实 |

### 6.4 间隔重复强化

每次检索/访问会增强记忆：

```
新半衰期 = 当前半衰期 × 1.15（+15%）
```

频繁访问的记忆半衰期持续增长，最终接近永久保留。

### 6.5 有效评分

检索时的最终评分：

```
effective_score = similarity × decay × importance_normalized
```

`decay < 0.05` 的记忆被过滤（视为已遗忘）。

### 6.6 记忆巩固

**触发条件：** 累计 token 达到 1,400 或每 8 轮对话

**巩固流程：**

1. 选取 top 18 高重要性记忆
2. LLM 生成压缩摘要
3. 摘要作为新的语义记忆写入
4. 原始情景记忆保留但衰减继续
5. 多条相似记忆可合并为一条精炼摘要

### 6.7 KB 块的特殊衰减策略

知识库文档块不按时间衰减，而按 **使用频率 + 任务相关性** 动态调整：

- 被引用过的 KB 块：半衰期延长
- 从未被访问的 KB 块：保持基础衰减
- 与当前 Agent 任务高度相关的 KB 块：衰减暂停

### 6.8 数据结构

```
memory_entry 附加字段:
  importance        — LLM 评定 1-10
  decay_score       — 当前衰减值（0-1）
  half_life_days    — 当前半衰期
  access_count      — 访问次数
  last_accessed_at  — 最后访问时间
  consolidated      — 是否已被巩固
```

---

## 7. 能力五：多 Agent 共享记忆

### 7.1 理论基础

参考 Collaborative Memory（2025）+ Microsoft Multi-Agent Reference Architecture。

### 7.2 双层记忆池

```
┌─ Workspace 共享记忆 ─────────────────┐
│  所有 Agent 可读                       │
│  ├── KB 文档块（天然共享）             │
│  ├── 共享语义记忆                      │
│  └── 团队反思                          │
│  写入需权限，读取按 ACL 过滤           │
├────────────────────────────────────────┤
│                                        │
│  ┌─ Agent A 私有 ─┐ ┌─ Agent B 私有 ─┐│
│  │ 对话历史        │ │ 对话历史        ││
│  │ 个人反思        │ │ 个人反思        ││
│  │ KB 使用模式     │ │ KB 使用模式     ││
│  │ Core Memory    │ │ Core Memory    ││
│  └────────────────┘ └────────────────┘│
└────────────────────────────────────────┘
```

### 7.3 可见性模型

| 可见性 | 含义 |
|--------|------|
| `private` | 仅创建者 Agent 可访问 |
| `shared` | 同 workspace 所有 Agent 可读 |
| `public` | 跨 workspace 可读（用于平台级知识） |

### 7.4 经验传播

当 Agent A 在特定领域积累了成功经验：

1. A 的相关私有记忆被标记为"可共享候选"
2. 巩固流程将成功模式提取为语义记忆
3. 提升为 `shared` 可见性
4. Agent B 在遇到类似任务时可检索到 A 的经验

### 7.5 数据结构

```
agent_memory_views:
  id, memory_entry_id, agent_id,
  visibility (private | shared | public),
  access_level (read | write | admin),
  created_by, shared_at
```

---

## 8. 能力六：主动记忆触发

### 8.1 理论基础

参考 Inner Thoughts（2025）。记忆系统主动推送，而非等待 Agent 查询。

### 8.2 触发策略

| 策略 | 机制 | 成本 |
|------|------|------|
| 实体触发 | 提取当前 turn 的实体，匹配图谱已有实体 | 低 |
| 语义阈值 | 当前上下文 embedding 与 top-K 记忆相似度超阈值 | 中 |
| 话题转移 | 检测到对话主题变化，主动检索新话题相关记忆 | 中 |
| 时间触发 | 基于时间的提醒（"你提到周四有截止日期"） | 低 |

### 8.3 注入评分

```
injection_score = w_recency × recency_decay
               + w_importance × importance
               + w_relevance × cosine_similarity
```

仅 `injection_score > threshold` 的记忆被注入上下文。

### 8.4 执行时机

每个用户 turn 到达时，在 LLM 调用前执行：

```
用户消息到达
  → 实体提取（轻量级）
  → 记忆检索（向量 + 图谱）
  → 注入评分过滤
  → 符合条件的记忆注入 system prompt 的 [Memory Context] 区域
  → LLM 调用
```

### 8.5 与 KB 的关联

主动注入不区分来源。当前对话提到某实体 → 图谱发现该实体在 KB 文档中有定义 → 自动注入 KB 相关块。Agent 无需显式调用 `search_knowledge`。

---

## 9. 开源库调研总结

### 9.1 可直接使用

| 库 | Stars | 用途 |
|----|-------|------|
| **sqlite-vec** | 7K+ | 向量 KNN 检索，better-sqlite3 原生集成 |
| **SQLite FTS5** | 内建 | BM25 全文检索 |

### 9.2 设计参考（Python-only，无法直接集成）

| 库 | Stars | 借鉴点 |
|----|-------|--------|
| **Mem0** | 49K+ | 记忆提取管道、LLM 提取 → 向量存储 → 检索流程 |
| **Graphiti** | 20K+ | 时序知识图谱、双时序模型、实体消歧 |
| **Letta/MemGPT** | 13K+ | 虚拟内存三层架构、Agent 自管理记忆工具 |
| **Cognee** | 7K+ | SQLite + LanceDB + 嵌入式图的无服务器架构 |
| **OpenMemory** | 3.5K+ | 自适应衰减引擎、分区认知模型 |
| **PowerMem** | — | 艾宾浩斯遗忘曲线 + 多 Agent 隔离 |

### 9.3 学术参考

| 论文/框架 | 借鉴点 |
|----------|--------|
| Stanford Generative Agents（2023） | 三因子检索、阈值触发反思、递归反思 |
| MemGPT（2023） | 虚拟内存分页、Agent 自管理工具 |
| Graphiti/Zep（2025） | 时序知识图谱、双时序有效性 |
| MemoryBank（AAAI 2024） | 遗忘曲线 + 间隔重复 |
| Inner Thoughts（2025） | 主动记忆注入、5 步触发周期 |
| Collaborative Memory（2025） | 双层记忆池、动态访问控制 |
| A-MEM（NeurIPS 2025） | Zettelkasten 式结构化笔记、链接更新 |
| SimpleMem（2026） | 递归记忆巩固、自适应查询感知检索 |
