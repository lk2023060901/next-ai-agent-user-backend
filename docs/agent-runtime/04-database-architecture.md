# 数据库架构与扩容策略

> 统一 SQLite 认知栈 + 渐进式迁移路径
> 设计日期：2026-03-09

---

## 1. 技术选型

### 1.1 最终方案：纯 SQLite 统一栈

| 组件 | 用途 | 来源 |
|------|------|------|
| **SQLite** (better-sqlite3) | 关系存储、图谱建模、元数据、ACL | 项目已有 |
| **Drizzle ORM** | Schema 定义、迁移、类型安全查询 | 项目已有 |
| **sqlite-vec** 扩展 | 向量 KNN 检索 | npm `sqlite-vec`，7K★，MIT |
| **FTS5** 模块 | BM25 全文检索 | SQLite 内建 |
| **LLM 调用** | 记忆提取、实体识别、重要性评分、反思生成 | 项目已有 Provider 层 |

### 1.2 选型理由

1. **事务一致性**：反思写入 + 图谱更新 + 衰减计算在同一 ACID 事务内完成
2. **零新增基础设施**：单文件数据库，不增加运维成本
3. **数据规模适配**：单 Agent 年累计 ~10K-60K 向量，远低于 SQLite 性能天花板
4. **跨源 JOIN**：KB 块、记忆条目、图谱节点自然关联，无需跨库查询
5. **接口驱动**：存储层按接口设计，未来可替换实现

### 1.3 淘汰的替代方案

| 方案 | 淘汰理由 |
|------|---------|
| SQLite + Kuzu（嵌入式图 DB） | 双数据库无法保证跨库事务原子性；Kuzu 已于 2025 年 10 月归档停止维护 |
| SQLite + Redis（热缓存） | 早期阶段过度设计；增加基础设施依赖 |
| SQLite + Neo4j | 需要独立服务器进程；Agent 记忆图谱规模不需要 |
| PostgreSQL + pgvector | 当前阶段 SQLite 足够；迁移到 PostgreSQL 是未来 Phase 2 选项 |

---

## 2. 性能基准与天花板

### 2.1 向量检索（sqlite-vec）

| 向量数量 | 维度 768 延迟 | 维度 1536 延迟 | 判断 |
|---------|-------------|--------------|------|
| 10K | < 10ms | < 15ms | ✅ 胜任 |
| 50K | < 40ms | < 75ms | ✅ 胜任 |
| 100K | ~75ms | ~105ms | ⚠️ 临界点 |
| 500K | ~400ms | ~500ms+ | ❌ 需要 ANN 索引 |
| 1M+ | 秒级 | 8.5s (3072d) | ❌ 必须迁移 |

**注意：** sqlite-vec 是暴力扫描（brute-force），无 ANN 索引。sqlite-vector（sqliteai 项目）带量化 + 预加载可达 100K 向量 < 4ms。vectorlite 支持 ANN 索引，比 sqlite-vec 快 6-30x。

### 2.2 全文检索（FTS5）

| 文档数量 | 查询延迟 | 索引大小 | 判断 |
|---------|---------|---------|------|
| 50K | < 1ms | ~26MB | ✅ |
| 500K | 个位数 ms | ~200MB | ✅ |
| 1M | 数十 ms | ~500MB | ⚠️ 临界点 |
| 6M+（带排序） | 20s+ | GB 级 | ❌ 需要 Meilisearch/ES |

### 2.3 图查询（Recursive CTE）

| 节点数量 | 2 跳延迟 | 3 跳延迟 | 判断 |
|---------|---------|---------|------|
| 1K | < 1ms | < 5ms | ✅ |
| 10K | ~10ms | ~100ms | ✅ |
| 50K | ~50ms | 秒级 | ⚠️ 临界点 |
| 100K+ | 秒级 | 不可用 | ❌ 需要图 DB |

**前提：** `source_entity_id` 和 `target_entity_id` 列必须建索引。

### 2.4 写入并发

| 场景 | 吞吐量 | 说明 |
|------|--------|------|
| 单写者 + WAL | ~72K writes/sec | SQLite 标准配置 |
| 批量插入 | ~500K rows/sec | 单事务 |
| 多进程并发写 | 1 个写者排队 | 数据库级锁 |
| 10+ 并发写连接 | 96.67% 错误率 | 不可接受 |

---

## 3. 实际数据量估算

### 3.1 单个 Agent

| 指标 | 日增量 | 月累计 | 年累计 |
|------|--------|--------|--------|
| 情景记忆 | 10-100 条 | 300-3K | 3.6K-36K |
| 语义记忆（提取） | 5-30 条 | 150-900 | 1.8K-10.8K |
| 反思记忆 | 2-10 条 | 60-300 | 720-3.6K |
| 图谱实体 | 5-50 个 | 150-1.5K | 1.8K-18K |
| 图谱关系 | 10-100 条 | 300-3K | 3.6K-36K |
| KB 文档块 | 按上传量 | 1K-10K | 相对稳定 |
| **向量总量** | — | ~5K-15K | **~10K-60K** |
| **图谱节点** | — | ~200-2K | **~2K-20K** |

**结论：单个 Agent 在 1-2 年内不会触及 SQLite 任何性能天花板。**

### 3.2 平台级（多租户）

| 规模阶段 | Agent 数 | 向量总量 | 图谱节点 | 架构 |
|---------|---------|---------|---------|------|
| 早期（百级用户） | ~100 | ~1M | ~100K | SQLite per-workspace |
| 中期（千级用户） | ~1K | ~10M | ~1M | **迁移分界线** |
| 规模化（万级用户） | ~10K | ~100M | ~10M | PostgreSQL + 专业组件 |

---

## 4. 存储架构设计

### 4.1 数据库文件策略

**推荐：per-workspace 独立数据库文件**

```
data/
├── app.db                          — 业务主库（用户、组织、workspace 等）
└── memory/
    ├── ws-{workspaceId-1}.db       — workspace 1 的认知数据库
    ├── ws-{workspaceId-2}.db       — workspace 2 的认知数据库
    └── ...
```

**理由：**
- 完美的数据隔离（workspace 间零泄露风险）
- 单库体积保持小巧（每个 workspace ~10MB-500MB）
- 可独立备份/迁移/删除
- 并发写入分散到不同文件（避免单文件写锁瓶颈）

### 4.2 统一 Schema

```sql
-- ═══════════════════════════════════════════
-- 统一记忆条目表（所有知识源的核心表）
-- ═══════════════════════════════════════════
CREATE TABLE memory_entries (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  agent_id        TEXT,                    -- NULL = workspace 共享
  session_id      TEXT,                    -- 关联的会话

  -- 记忆分类
  source          TEXT NOT NULL,           -- 'knowledge' | 'episode' | 'semantic' | 'reflection' | 'procedural'
  memory_type     TEXT NOT NULL,           -- 'core' | 'recall' | 'archival'（MemGPT 层级）
  depth           INTEGER DEFAULT 0,       -- 反思深度（0=原始，1=一阶反思，2+=元反思）

  -- 内容
  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,           -- 去重用

  -- 来源追溯
  source_ref_type TEXT,                    -- 'kb_chunk' | 'message' | 'tool_result' | 'reflection'
  source_ref_id   TEXT,                    -- 指向原始来源的 ID
  source_ids      TEXT,                    -- JSON array，触发此记忆的上游记忆 ID 列表

  -- 评分与衰减
  importance      REAL DEFAULT 5.0,        -- LLM 评定 1-10
  decay_score     REAL DEFAULT 1.0,        -- 当前衰减值（0-1）
  half_life_days  REAL DEFAULT 30.0,       -- 半衰期（天）
  access_count    INTEGER DEFAULT 0,
  last_accessed_at TEXT,

  -- 可见性
  visibility      TEXT DEFAULT 'private',  -- 'private' | 'shared' | 'public'
  created_by      TEXT,                    -- agent_id

  -- 元数据
  metadata_json   TEXT,                    -- 自定义元数据 JSON
  consolidated    INTEGER DEFAULT 0,       -- 是否已被巩固

  -- 时间戳
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════
-- 向量索引（sqlite-vec 虚拟表）
-- ═══════════════════════════════════════════
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  id              TEXT PRIMARY KEY,
  embedding       FLOAT[768]               -- 维度按 workspace 配置
);

-- ═══════════════════════════════════════════
-- 全文索引（FTS5）
-- ═══════════════════════════════════════════
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  id UNINDEXED,
  source UNINDEXED,
  agent_id UNINDEXED,
  tokenize='trigram'                       -- 支持 CJK
);

-- ═══════════════════════════════════════════
-- 知识图谱：实体表
-- ═══════════════════════════════════════════
CREATE TABLE entities (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,            -- 小写去空格，用于快速匹配
  type            TEXT NOT NULL,            -- 'person' | 'concept' | 'api' | 'file' | 'tool' | 'custom'
  description     TEXT,
  source          TEXT NOT NULL,            -- 'knowledge' | 'episode' | 'reflection'
  source_ref_id   TEXT,                     -- 来源记忆/KB 文档 ID
  mention_count   INTEGER DEFAULT 1,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 实体向量（用于消歧）
CREATE VIRTUAL TABLE entity_embeddings USING vec0(
  id              TEXT PRIMARY KEY,
  embedding       FLOAT[768]
);

-- ═══════════════════════════════════════════
-- 知识图谱：关系表
-- ═══════════════════════════════════════════
CREATE TABLE relations (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  source_entity_id    TEXT NOT NULL REFERENCES entities(id),
  target_entity_id    TEXT NOT NULL REFERENCES entities(id),
  relation_type       TEXT NOT NULL,        -- 'causes' | 'precedes' | 'contains' | 'references' | 'implements' | 'depends_on' | 'similar_to'
  description         TEXT,
  weight              REAL DEFAULT 1.0,

  -- 时序有效性（Graphiti 双时序模型）
  t_valid             TEXT,                 -- 事实生效时间
  t_invalid           TEXT,                 -- 事实失效时间
  t_created           TEXT NOT NULL DEFAULT (datetime('now')),
  t_expired           TEXT,                 -- 系统过期时间

  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_relations_source ON relations(source_entity_id);
CREATE INDEX idx_relations_target ON relations(target_entity_id);
CREATE INDEX idx_relations_type ON relations(relation_type);

-- ═══════════════════════════════════════════
-- MemGPT：Core Memory 块
-- ═══════════════════════════════════════════
CREATE TABLE core_memory_blocks (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  block_type      TEXT NOT NULL,            -- 'persona' | 'user' | 'task' | 'working' | 'knowledge_summary'
  content         TEXT NOT NULL,
  max_tokens      INTEGER DEFAULT 500,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════
-- 记忆访问日志（驱动遗忘曲线 + 间隔重复）
-- ═══════════════════════════════════════════
CREATE TABLE memory_access_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  agent_id        TEXT NOT NULL,
  access_type     TEXT NOT NULL,            -- 'search_hit' | 'injection' | 'tool_read' | 'reflection_source'
  context_snippet TEXT,                     -- 触发访问的上下文摘要

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_access_log_entry ON memory_access_log(memory_entry_id);
CREATE INDEX idx_access_log_agent ON memory_access_log(agent_id);

-- ═══════════════════════════════════════════
-- Agent 记忆视图（多 Agent 共享的 ACL）
-- ═══════════════════════════════════════════
CREATE TABLE agent_memory_views (
  id              TEXT PRIMARY KEY,
  memory_entry_id TEXT NOT NULL REFERENCES memory_entries(id),
  agent_id        TEXT NOT NULL,
  access_level    TEXT DEFAULT 'read',      -- 'read' | 'write' | 'admin'

  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════
-- 嵌入缓存（共享，避免重复嵌入）
-- ═══════════════════════════════════════════
CREATE TABLE embedding_cache (
  content_hash    TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  embedding       BLOB NOT NULL,            -- Float32Array 二进制
  dims            INTEGER NOT NULL,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (content_hash, provider, model)
);

-- ═══════════════════════════════════════════
-- 反思调度（追踪反思触发状态）
-- ═══════════════════════════════════════════
CREATE TABLE reflection_state (
  agent_id                TEXT PRIMARY KEY,
  cumulative_importance   REAL DEFAULT 0.0,  -- 未反思记忆的累计重要性
  last_reflection_at      TEXT,
  reflection_count        INTEGER DEFAULT 0,

  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.3 索引策略

```sql
-- 高频查询路径索引
CREATE INDEX idx_memory_source ON memory_entries(source);
CREATE INDEX idx_memory_agent ON memory_entries(agent_id);
CREATE INDEX idx_memory_type ON memory_entries(memory_type);
CREATE INDEX idx_memory_visibility ON memory_entries(visibility);
CREATE INDEX idx_memory_decay ON memory_entries(decay_score);
CREATE INDEX idx_memory_workspace ON memory_entries(workspace_id);
CREATE INDEX idx_memory_session ON memory_entries(session_id);

-- 复合索引（覆盖常见查询模式）
CREATE INDEX idx_memory_agent_source ON memory_entries(agent_id, source, visibility);
CREATE INDEX idx_memory_workspace_visibility ON memory_entries(workspace_id, visibility, source);

-- 实体索引
CREATE INDEX idx_entity_workspace ON entities(workspace_id);
CREATE INDEX idx_entity_name ON entities(name_normalized);
CREATE INDEX idx_entity_type ON entities(type);
CREATE INDEX idx_entity_source ON entities(source);
```

---

## 5. 存储层接口设计

所有记忆操作通过接口调用，SQLite 是第一个实现。迁移时仅替换实现。

```typescript
// 存储层核心接口（语言无关描述）

interface MemoryStore {
  // 写入
  insert(entry: MemoryEntry): Promise<string>
  update(id: string, patch: Partial<MemoryEntry>): Promise<void>
  delete(id: string): Promise<void>

  // 检索
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>
  getById(id: string): Promise<MemoryEntry | null>
  getByIds(ids: string[]): Promise<MemoryEntry[]>

  // 衰减
  refreshDecay(id: string): Promise<void>        // 访问后刷新
  batchUpdateDecay(): Promise<number>             // 批量衰减计算

  // 事务
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>
}

interface VectorIndex {
  insert(id: string, embedding: Float32Array): Promise<void>
  search(query: Float32Array, topK: number): Promise<VectorResult[]>
  delete(id: string): Promise<void>
}

interface FullTextIndex {
  insert(id: string, content: string, metadata: Record<string, string>): Promise<void>
  search(query: string, topK: number): Promise<TextResult[]>
  delete(id: string): Promise<void>
}

interface GraphStore {
  // 实体
  upsertEntity(entity: Entity): Promise<string>
  findSimilarEntities(embedding: Float32Array, threshold: number): Promise<Entity[]>

  // 关系
  addRelation(relation: Relation): Promise<string>
  invalidateRelation(id: string, t_invalid: Date): Promise<void>

  // 遍历
  traverse(entityId: string, maxHops: number, filters?: TraverseFilter): Promise<GraphPath[]>
}
```

---

## 6. 渐进式迁移策略

### 6.1 迁移触发指标

| 指标 | 阈值 | 迁移目标 |
|------|------|---------|
| 单库向量数 > 100K 且 p95 延迟 > 100ms | 向量检索瓶颈 | pgvector（HNSW 索引） |
| FTS5 排序查询 > 500ms | 全文检索瓶颈 | Meilisearch |
| 图遍历 3 跳 > 200ms | 图查询瓶颈 | Neo4j |
| 写入排队等待 > 50ms | 写入并发瓶颈 | PostgreSQL |
| 单库文件 > 1GB | 存储瓶颈 | 分库 或 PostgreSQL |

### 6.2 迁移路径

```
Phase 1: SQLite 统一栈（当前 → 千级用户）
─────────────────────────────────────────
SQLite + sqlite-vec + FTS5 + Recursive CTE
per-workspace 独立数据库文件
单进程 WAL 模式

     ↓ 触发指标命中

Phase 2: 增强 SQLite（千级用户 → 万级用户过渡期）
─────────────────────────────────────────
sqlite-vec → vectorlite（ANN 索引）或 sqlite-vector（量化）
保持 SQLite 作为主存储
添加读副本或 Turso（分布式 SQLite）

     ↓ 触发指标命中

Phase 3: 专业组件（万级用户）
─────────────────────────────────────────
存储层接口不变，替换实现：
├── pgvector 替代 sqlite-vec（1M+ 向量 ~2.4ms）
├── Meilisearch 替代 FTS5（亚毫秒全文检索）
├── Neo4j 替代 Recursive CTE（100K+ 节点图谱）
└── PostgreSQL 替代 SQLite 关系表（行级锁、连接池）
```

### 6.3 迁移不变量

**以下在任何 Phase 都不变：**

1. `MemoryStore` / `VectorIndex` / `FullTextIndex` / `GraphStore` 接口定义
2. 记忆条目的数据模型（`MemoryEntry` 结构）
3. 上层模块（Context Assembler、反思引擎、主动注入器）的代码
4. Agent 工具的调用方式
5. SSE 事件格式

---

## 7. 备选方案记录

### 7.1 被评估但未采用的数据库

| 数据库 | 评估结果 | 未采用原因 |
|--------|---------|----------|
| **Kuzu**（嵌入式图 DB） | Node.js 绑定可用，性能比 Neo4j 快 18x | 2025 年 10 月已归档，不再维护 |
| **LanceDB**（嵌入式向量 DB） | Cognee 项目使用 | 无成熟 Node.js SDK |
| **ChromaDB** | A-MEM 参考实现使用 | 需要独立服务器进程 |
| **Milvus** | 高性能向量检索 | 分布式架构，早期阶段过重 |
| **Qdrant** | 单机性能最优 | 需要 Rust 独立进程 |
| **Redis** | 亚毫秒缓存 | 增加基础设施，早期不需要 |
| **MongoDB** | 灵活文档模型 | 项目已选型 SQLite，无迁移理由 |

### 7.2 被评估的 SQLite 向量扩展

| 扩展 | Stars | 特性 | 选择 |
|------|-------|------|------|
| **sqlite-vec** | 7K+ | 暴力扫描，纯 C，零依赖 | ✅ Phase 1 首选 |
| **sqlite-vector**（sqliteai） | 较新 | 量化 + 预加载，100K 向量 < 4ms | Phase 2 候选 |
| **vectorlite** | 较新 | ANN 索引，比 sqlite-vec 快 6-30x | Phase 2 候选 |
| **sqlite-vss** | 1.5K+ | 已废弃，被 sqlite-vec 取代 | ❌ 废弃 |
