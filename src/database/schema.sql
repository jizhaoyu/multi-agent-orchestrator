-- Multi-Agent Orchestrator 数据库 Schema
-- SQLite 数据库表结构定义

-- Agent 状态表
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('orchestrator', 'worker')),
  status TEXT NOT NULL CHECK(status IN ('idle', 'busy', 'error')),
  current_task_id TEXT,
  last_heartbeat INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Agent 统计表
CREATE TABLE IF NOT EXISTS agent_stats (
  agent_id TEXT PRIMARY KEY,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  tasks_failed INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  avg_completion_time INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- 任务表
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  assigned_to TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed')),
  priority TEXT NOT NULL CHECK(priority IN ('high', 'medium', 'low')),
  depth INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  context TEXT, -- JSON
  result TEXT, -- JSON
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE,
  -- assigned_to 由 StateManager 在独立数据库中维护，不能在这里做跨库外键
  CHECK (assigned_to IS NULL OR length(assigned_to) > 0)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(type);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
