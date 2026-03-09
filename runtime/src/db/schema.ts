// ─── SQLite Schema (raw SQL) ────────────────────────────────────────────────
//
// Executed once on database initialization. Idempotent (IF NOT EXISTS).
// Design doc: 04-database-architecture.md §4.2
//
// All workspaces share a single SQLite file, isolated by workspace_id columns.

export const SCHEMA_SQL = `
-- ═══════════════════════════════════════════
-- 统一记忆条目表
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memory_entries (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  agent_id        TEXT,
  session_id      TEXT,

  -- 记忆分类
  type            TEXT NOT NULL,
  depth           INTEGER DEFAULT 0,

  -- 内容
  content         TEXT NOT NULL,

  -- 评分与衰减
  importance      REAL DEFAULT 5.0,
  decay_score     REAL DEFAULT 1.0,
  half_life_days  REAL DEFAULT 30.0,
  access_count    INTEGER DEFAULT 0,
  last_accessed_at INTEGER,

  -- 来源追溯
  source_ids      TEXT,

  -- 可见性
  visibility      TEXT DEFAULT 'private',
  created_by      TEXT,

  -- 生命周期
  consolidated    INTEGER DEFAULT 0,

  -- 时间戳 (Unix ms)
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- 高频查询索引
CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_workspace ON memory_entries(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type);
CREATE INDEX IF NOT EXISTS idx_memory_visibility ON memory_entries(visibility);
CREATE INDEX IF NOT EXISTS idx_memory_decay ON memory_entries(decay_score);
CREATE INDEX IF NOT EXISTS idx_memory_agent_type ON memory_entries(agent_id, type, visibility);
CREATE INDEX IF NOT EXISTS idx_memory_workspace_vis ON memory_entries(workspace_id, visibility, type);
CREATE INDEX IF NOT EXISTS idx_memory_last_access ON memory_entries(last_accessed_at);

-- ═══════════════════════════════════════════
-- 全文索引（FTS5）
-- ═══════════════════════════════════════════
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  id UNINDEXED,
  tokenize='trigram'
);

-- ═══════════════════════════════════════════
-- 知识图谱：实体表
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entities (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  name_normalized TEXT NOT NULL,
  type            TEXT NOT NULL,
  description     TEXT,
  source          TEXT NOT NULL,
  mention_count   INTEGER DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_workspace ON entities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_entity_name ON entities(name_normalized);
CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(type);

-- ═══════════════════════════════════════════
-- 知识图谱：关系表
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS relations (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  source_entity_id    TEXT NOT NULL REFERENCES entities(id),
  target_entity_id    TEXT NOT NULL REFERENCES entities(id),
  relation_type       TEXT NOT NULL,
  description         TEXT,
  weight              REAL DEFAULT 1.0,
  t_valid             INTEGER,
  t_invalid           INTEGER,
  t_created           INTEGER NOT NULL,
  t_expired           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_entity_id);

-- ═══════════════════════════════════════════
-- 实体-记忆关联表
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memory_entity_links (
  memory_id   TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity_id)
);

-- ═══════════════════════════════════════════
-- Core Memory 块
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS core_memory_blocks (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  block_type  TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(agent_id, workspace_id, block_type)
);

-- ═══════════════════════════════════════════
-- 嵌入缓存
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash  TEXT NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  embedding     BLOB NOT NULL,
  dims          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (content_hash, provider, model)
);

-- ═══════════════════════════════════════════
-- 反思调度状态
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reflection_state (
  agent_id              TEXT NOT NULL,
  workspace_id          TEXT NOT NULL,
  cumulative_importance REAL DEFAULT 0.0,
  last_reflection_at    INTEGER,
  reflection_count      INTEGER DEFAULT 0,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (agent_id, workspace_id)
);

-- ═══════════════════════════════════════════
-- 记忆访问日志
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS memory_access_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_entry_id TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  access_type     TEXT NOT NULL,
  context_snippet TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_log_entry ON memory_access_log(memory_entry_id);
CREATE INDEX IF NOT EXISTS idx_access_log_agent ON memory_access_log(agent_id);

-- ═══════════════════════════════════════════
-- Agent 记忆视图（多 Agent 共享 ACL）
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agent_memory_views (
  id              TEXT PRIMARY KEY,
  memory_entry_id TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  access_level    TEXT DEFAULT 'read',
  created_at      INTEGER NOT NULL,
  UNIQUE(memory_entry_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_views_agent ON agent_memory_views(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_views_memory ON agent_memory_views(memory_entry_id);

-- ═══════════════════════════════════════════
-- 可观测性：LLM 用量记录
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS usage_records (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  parent_run_id   TEXT,
  session_id      TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  scope           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  input_tokens    INTEGER NOT NULL,
  output_tokens   INTEGER NOT NULL,
  total_tokens    INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_workspace ON usage_records(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_records(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_records(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_records(provider, created_at);

-- ═══════════════════════════════════════════
-- 可观测性：Run 级别聚合指标
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS run_metrics (
  run_id                    TEXT PRIMARY KEY,
  session_id                TEXT NOT NULL,
  workspace_id              TEXT NOT NULL,
  agent_id                  TEXT NOT NULL,
  provider                  TEXT NOT NULL,
  model                     TEXT NOT NULL,
  status                    TEXT NOT NULL,
  turns_used                INTEGER NOT NULL,
  coordinator_input_tokens  INTEGER NOT NULL,
  coordinator_output_tokens INTEGER NOT NULL,
  sub_agent_input_tokens    INTEGER NOT NULL,
  sub_agent_output_tokens   INTEGER NOT NULL,
  total_tokens              INTEGER NOT NULL,
  tool_call_count           INTEGER NOT NULL,
  sub_agent_count           INTEGER NOT NULL,
  duration_ms               INTEGER NOT NULL,
  started_at                INTEGER NOT NULL,
  completed_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_metrics_workspace ON run_metrics(workspace_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_run_metrics_agent ON run_metrics(agent_id, completed_at);

-- ═══════════════════════════════════════════
-- 可观测性：工具执行指标
-- ═══════════════════════════════════════════
CREATE TABLE IF NOT EXISTS tool_metrics (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  status          TEXT NOT NULL,
  duration_ms     INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_metrics_run ON tool_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_tool_metrics_workspace ON tool_metrics(workspace_id, created_at);
`;

/**
 * Create the sqlite-vec virtual table for memory embeddings.
 * Must be called AFTER loading the vec0 extension.
 * Dimensions are workspace-configured (from embedding model settings).
 */
export function vecTableSQL(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[${dimensions}]
);`;
}

/**
 * Create the sqlite-vec virtual table for entity embeddings (disambiguation).
 */
export function entityVecTableSQL(dimensions: number): string {
  return `CREATE VIRTUAL TABLE IF NOT EXISTS entity_embeddings USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[${dimensions}]
);`;
}
