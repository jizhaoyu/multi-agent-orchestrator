/**
 * 状态管理器
 * 管理所有 Agent 的状态和心跳
 */

import Database from 'better-sqlite3';
import type { IStateManager, IAgent, AgentStatus, AgentStats, AgentType } from '@/types';
import { loadDatabaseSchema } from '@/database/sqlite-utils';

/**
 * 状态管理器配置
 */
export interface StateManagerConfig {
  /** 数据库文件路径 */
  dbPath: string;

  /** 心跳超时时间（毫秒） */
  heartbeatTimeout?: number;
}

interface StateManagerStatements {
  upsertAgent: Database.Statement;
  upsertAgentStats: Database.Statement;
  updateStatus: Database.Statement;
  updateHeartbeat: Database.Statement;
  selectIdleWorkers: Database.Statement;
  selectStatsByAgentId: Database.Statement;
  selectAgentById: Database.Statement;
  selectAllAgents: Database.Statement;
  selectHeartbeatTimeoutAgents: Database.Statement;
  deleteAgent: Database.Statement;
}

/**
 * 状态管理器
 */
export class StateManager implements IStateManager {
  private db: Database.Database;
  private config: Required<StateManagerConfig>;
  private readonly statements: StateManagerStatements;
  private readonly registerAgentTransaction: (agent: IAgent, now: number) => void;

  constructor(config: StateManagerConfig) {
    this.config = {
      dbPath: config.dbPath,
      heartbeatTimeout: config.heartbeatTimeout || 10 * 60 * 1000,
    };

    this.db = new Database(this.config.dbPath);
    this.initDatabase();
    this.statements = this.prepareStatements();
    this.registerAgentTransaction = this.db.transaction((agent: IAgent, now: number) => {
      this.statements.upsertAgent.run(
        agent.id,
        agent.type,
        agent.status,
        agent.currentTaskId,
        agent.lastHeartbeat.getTime(),
        now,
        now
      );
      this.statements.upsertAgentStats.run(
        agent.id,
        agent.stats.tasksCompleted,
        agent.stats.tasksFailed,
        agent.stats.totalTokens,
        agent.stats.avgCompletionTime
      );
    });
  }

  /**
   * 注册 Agent
   */
  async registerAgent(agent: IAgent): Promise<void> {
    this.registerAgentTransaction(agent, Date.now());
  }

  /**
   * 更新状态
   */
  async updateStatus(
    agentId: string,
    status: AgentStatus,
    currentTaskId: string | null
  ): Promise<void> {
    this.statements.updateStatus.run(status, currentTaskId, Date.now(), agentId);
  }

  /**
   * 更新心跳
   */
  async updateHeartbeat(agentId: string): Promise<void> {
    const now = Date.now();
    this.statements.updateHeartbeat.run(now, now, agentId);
  }

  /**
   * 获取空闲 Worker
   */
  async getIdleWorkers(): Promise<IAgent[]> {
    const rows = this.statements.selectIdleWorkers.all() as any[];
    return rows.map((row) => this.rowToAgent(row));
  }

  /**
   * 获取统计信息
   */
  async getStats(agentId: string): Promise<AgentStats> {
    const row = this.statements.selectStatsByAgentId.get(agentId) as any;

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
    const row = this.statements.selectAgentById.get(agentId) as any;

    if (!row) {
      return null;
    }

    return this.rowToAgent(row);
  }

  /**
   * 获取所有 Agent
   */
  async getAllAgents(): Promise<IAgent[]> {
    const rows = this.statements.selectAllAgents.all() as any[];
    return rows.map((row) => this.rowToAgent(row));
  }

  /**
   * 检查心跳超时
   */
  async checkHeartbeatTimeout(): Promise<string[]> {
    const timeout = Date.now() - this.config.heartbeatTimeout;
    const rows = this.statements.selectHeartbeatTimeoutAgents.all(timeout) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * 更新统计信息
   */
  async updateStats(agentId: string, stats: Partial<AgentStats>): Promise<void> {
    const updates: string[] = [];
    const values: unknown[] = [];

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
    this.statements.deleteAgent.run(agentId);
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
    this.db.exec(loadDatabaseSchema());
  }

  private prepareStatements(): StateManagerStatements {
    const agentProjection = `
      a.id,
      a.type,
      a.status,
      a.current_task_id,
      a.last_heartbeat,
      COALESCE(s.tasks_completed, 0) AS tasks_completed,
      COALESCE(s.tasks_failed, 0) AS tasks_failed,
      COALESCE(s.total_tokens, 0) AS total_tokens,
      COALESCE(s.avg_completion_time, 0) AS avg_completion_time
    `;

    return {
      upsertAgent: this.db.prepare(`
        INSERT INTO agents (id, type, status, current_task_id, last_heartbeat, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          type = excluded.type,
          status = excluded.status,
          current_task_id = excluded.current_task_id,
          last_heartbeat = excluded.last_heartbeat,
          updated_at = excluded.updated_at
      `),
      upsertAgentStats: this.db.prepare(`
        INSERT INTO agent_stats (
          agent_id,
          tasks_completed,
          tasks_failed,
          total_tokens,
          avg_completion_time
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          tasks_completed = excluded.tasks_completed,
          tasks_failed = excluded.tasks_failed,
          total_tokens = excluded.total_tokens,
          avg_completion_time = excluded.avg_completion_time
      `),
      updateStatus: this.db.prepare(`
        UPDATE agents
        SET status = ?, current_task_id = ?, updated_at = ?
        WHERE id = ?
      `),
      updateHeartbeat: this.db.prepare(`
        UPDATE agents
        SET last_heartbeat = ?, updated_at = ?
        WHERE id = ?
      `),
      selectIdleWorkers: this.db.prepare(`
        SELECT ${agentProjection}
        FROM agents a
        LEFT JOIN agent_stats s ON s.agent_id = a.id
        WHERE a.type = 'worker' AND a.status = 'idle'
        ORDER BY a.last_heartbeat DESC
      `),
      selectStatsByAgentId: this.db.prepare(`
        SELECT *
        FROM agent_stats
        WHERE agent_id = ?
      `),
      selectAgentById: this.db.prepare(`
        SELECT ${agentProjection}
        FROM agents a
        LEFT JOIN agent_stats s ON s.agent_id = a.id
        WHERE a.id = ?
      `),
      selectAllAgents: this.db.prepare(`
        SELECT ${agentProjection}
        FROM agents a
        LEFT JOIN agent_stats s ON s.agent_id = a.id
        ORDER BY a.created_at ASC
      `),
      selectHeartbeatTimeoutAgents: this.db.prepare(`
        SELECT id
        FROM agents
        WHERE status = 'busy' AND last_heartbeat < ?
      `),
      deleteAgent: this.db.prepare(`
        DELETE FROM agents
        WHERE id = ?
      `),
    };
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
        tasksCompleted: row.tasks_completed || 0,
        tasksFailed: row.tasks_failed || 0,
        totalTokens: row.total_tokens || 0,
        avgCompletionTime: row.avg_completion_time || 0,
      },
    };
  }
}
