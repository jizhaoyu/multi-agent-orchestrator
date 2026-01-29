/**
 * 状态管理器
 * 管理所有 Agent 的状态和心跳
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { IStateManager, IAgent, AgentStatus, AgentStats, AgentType } from '@/types';

/**
 * 状态管理器配置
 */
export interface StateManagerConfig {
  /** 数据库文件路径 */
  dbPath: string;

  /** 心跳超时时间（毫秒） */
  heartbeatTimeout?: number;
}

/**
 * 状态管理器
 */
export class StateManager implements IStateManager {
  private db: Database.Database;
  private config: Required<StateManagerConfig>;

  constructor(config: StateManagerConfig) {
    this.config = {
      dbPath: config.dbPath,
      heartbeatTimeout: config.heartbeatTimeout || 10 * 60 * 1000, // 10 分钟
    };

    // 初始化数据库
    this.db = new Database(this.config.dbPath);
    this.initDatabase();
  }

  /**
   * 注册 Agent
   */
  async registerAgent(agent: IAgent): Promise<void> {
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT INTO agents (id, type, status, current_task_id, last_heartbeat, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        agent.id,
        agent.type,
        agent.status,
        agent.currentTaskId,
        agent.lastHeartbeat.getTime(),
        now,
        now
      );

    // 初始化统计信息
    this.db
      .prepare(
        `
      INSERT INTO agent_stats (agent_id, tasks_completed, tasks_failed, total_tokens, avg_completion_time)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(
        agent.id,
        agent.stats.tasksCompleted,
        agent.stats.tasksFailed,
        agent.stats.totalTokens,
        agent.stats.avgCompletionTime
      );
  }

  /**
   * 更新状态
   */
  async updateStatus(
    agentId: string,
    status: AgentStatus,
    currentTaskId: string | null
  ): Promise<void> {
    const now = Date.now();

    this.db
      .prepare(
        `
      UPDATE agents
      SET status = ?, current_task_id = ?, updated_at = ?
      WHERE id = ?
    `
      )
      .run(status, currentTaskId, now, agentId);
  }

  /**
   * 更新心跳
   */
  async updateHeartbeat(agentId: string): Promise<void> {
    const now = Date.now();

    this.db
      .prepare(
        `
      UPDATE agents
      SET last_heartbeat = ?, updated_at = ?
      WHERE id = ?
    `
      )
      .run(now, now, agentId);
  }

  /**
   * 获取空闲 Worker
   */
  async getIdleWorkers(): Promise<IAgent[]> {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM agents
      WHERE type = 'worker' AND status = 'idle'
      ORDER BY last_heartbeat DESC
    `
      )
      .all() as any[];

    return rows.map((row) => this.rowToAgent(row));
  }

  /**
   * 获取统计信息
   */
  async getStats(agentId: string): Promise<AgentStats> {
    const row = this.db
      .prepare(
        `
      SELECT * FROM agent_stats
      WHERE agent_id = ?
    `
      )
      .get(agentId) as any;

    if (!row) {
      throw new Error(`Agent stats not found: ${agentId}`);
    }

    return {
      tasksCompleted: row.tasks_completed,
      tasksFailed: row.tasks_failed,
      totalTokens: row.total_tokens,
      avgCompletionTime: row.avg_completion_time,
    };
  }

  /**
   * 获取 Agent
   */
  async getAgent(agentId: string): Promise<IAgent | null> {
    const row = this.db
      .prepare(
        `
      SELECT * FROM agents
      WHERE id = ?
    `
      )
      .get(agentId) as any;

    if (!row) {
      return null;
    }

    return this.rowToAgent(row);
  }

  /**
   * 获取所有 Agent
   */
  async getAllAgents(): Promise<IAgent[]> {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM agents
      ORDER BY created_at ASC
    `
      )
      .all() as any[];

    return rows.map((row) => this.rowToAgent(row));
  }

  /**
   * 检查心跳超时
   */
  async checkHeartbeatTimeout(): Promise<string[]> {
    const now = Date.now();
    const timeout = now - this.config.heartbeatTimeout;

    const rows = this.db
      .prepare(
        `
      SELECT id FROM agents
      WHERE status = 'busy' AND last_heartbeat < ?
    `
      )
      .all(timeout) as any[];

    return rows.map((row) => row.id);
  }

  /**
   * 更新统计信息
   */
  async updateStats(agentId: string, stats: Partial<AgentStats>): Promise<void> {
    const updates: string[] = [];
    const values: any[] = [];

    if (stats.tasksCompleted !== undefined) {
      updates.push('tasks_completed = ?');
      values.push(stats.tasksCompleted);
    }
    if (stats.tasksFailed !== undefined) {
      updates.push('tasks_failed = ?');
      values.push(stats.tasksFailed);
    }
    if (stats.totalTokens !== undefined) {
      updates.push('total_tokens = ?');
      values.push(stats.totalTokens);
    }
    if (stats.avgCompletionTime !== undefined) {
      updates.push('avg_completion_time = ?');
      values.push(stats.avgCompletionTime);
    }

    if (updates.length === 0) {
      return;
    }

    values.push(agentId);

    this.db
      .prepare(
        `
      UPDATE agent_stats
      SET ${updates.join(', ')}
      WHERE agent_id = ?
    `
      )
      .run(...values);
  }

  /**
   * 删除 Agent
   */
  async deleteAgent(agentId: string): Promise<void> {
    this.db
      .prepare(
        `
      DELETE FROM agents
      WHERE id = ?
    `
      )
      .run(agentId);
  }

  /**
   * 关闭数据库
   */
  close(): void {
    this.db.close();
  }

  /**
   * 初始化数据库
   */
  private initDatabase(): void {
    // 读取 schema
    const schemaPath = path.join(__dirname, '../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // 执行 schema
    this.db.exec(schema);
  }

  /**
   * 将数据库行转换为 Agent 对象
   */
  private rowToAgent(row: any): IAgent {
    return {
      id: row.id,
      type: row.type as AgentType,
      status: row.status as AgentStatus,
      currentTaskId: row.current_task_id,
      lastHeartbeat: new Date(row.last_heartbeat),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };
  }
}
