/**
 * 任务管理器
 * 管理任务队列、任务树、依赖关系
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { ITaskManager, ITask, TaskStatus, TaskPriority } from '@/types';

/**
 * 任务管理器配置
 */
export interface TaskManagerConfig {
  /** 数据库文件路径 */
  dbPath: string;

  /** 最大任务深度 */
  maxDepth?: number;
}

/**
 * 任务管理器
 */
export class TaskManager implements ITaskManager {
  private db: Database.Database;
  private config: Required<TaskManagerConfig>;

  constructor(config: TaskManagerConfig) {
    this.config = {
      dbPath: config.dbPath,
      maxDepth: config.maxDepth || 3,
    };

    // 初始化数据库
    this.db = new Database(this.config.dbPath);
    this.initDatabase();
  }

  /**
   * 添加任务
   */
  async addTask(task: ITask): Promise<void> {
    // 检查任务深度
    if (task.depth > this.config.maxDepth) {
      throw new Error(`Task depth exceeds maximum: ${task.depth} > ${this.config.maxDepth}`);
    }

    // 检查循环依赖
    if (task.parentId) {
      const hasCycle = await this.checkCycle(task.id, task.parentId);
      if (hasCycle) {
        throw new Error(`Circular dependency detected: ${task.id} -> ${task.parentId}`);
      }
    }

    this.db
      .prepare(
        `
      INSERT INTO tasks (
        id, parent_id, assigned_to, status, priority, depth,
        description, context, result, error,
        created_at, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        task.id,
        task.parentId,
        task.assignedTo,
        task.status,
        task.priority,
        task.depth,
        task.description,
        JSON.stringify(task.context),
        task.result ? JSON.stringify(task.result) : null,
        task.error,
        task.createdAt.getTime(),
        task.startedAt?.getTime() || null,
        task.completedAt?.getTime() || null
      );
  }

  /**
   * 获取下一个任务（按优先级）
   */
  async getNextTask(): Promise<ITask | null> {
    const row = this.db
      .prepare(
        `
      SELECT * FROM tasks
      WHERE status = 'pending'
      ORDER BY
        CASE priority
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END,
        created_at ASC
      LIMIT 1
    `
      )
      .get() as any;

    if (!row) {
      return null;
    }

    // 检查依赖任务是否完成
    if (row.parent_id) {
      const parent = await this.getTask(row.parent_id);
      if (parent && parent.status !== 'completed') {
        // 父任务未完成，跳过
        return null;
      }
    }

    return this.rowToTask(row);
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    result?: unknown,
    error?: string
  ): Promise<void> {
    const updates: string[] = ['status = ?'];
    const values: any[] = [status];
    const now = Date.now();

    if (status === 'running') {
      updates.push('started_at = ?');
      values.push(now);
    } else if (status === 'completed' || status === 'failed') {
      updates.push('completed_at = ?');
      values.push(now);
    }

    if (result !== undefined) {
      updates.push('result = ?');
      values.push(JSON.stringify(result));
    }

    if (error !== undefined) {
      updates.push('error = ?');
      values.push(error);
    }

    values.push(taskId);

    this.db
      .prepare(
        `
      UPDATE tasks
      SET ${updates.join(', ')}
      WHERE id = ?
    `
      )
      .run(...values);
  }

  /**
   * 获取任务树
   */
  async getTaskTree(rootTaskId: string): Promise<ITask[]> {
    const tasks: ITask[] = [];
    const queue = [rootTaskId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const taskId = queue.shift()!;
      if (visited.has(taskId)) {
        continue;
      }
      visited.add(taskId);

      const task = await this.getTask(taskId);
      if (task) {
        tasks.push(task);

        // 查找子任务
        const children = this.db
          .prepare(
            `
          SELECT id FROM tasks
          WHERE parent_id = ?
        `
          )
          .all(taskId) as any[];

        children.forEach((child) => queue.push(child.id));
      }
    }

    return tasks;
  }

  /**
   * 获取所有运行中的任务
   */
  async getRunningTasks(): Promise<ITask[]> {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM tasks
      WHERE status = 'running'
      ORDER BY started_at ASC
    `
      )
      .all() as any[];

    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * 获取所有待执行任务
   */
  async getPendingTasks(limit?: number): Promise<ITask[]> {
    const query = `
      SELECT * FROM tasks
      WHERE status = 'pending'
      ORDER BY
        CASE priority
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END,
        created_at ASC
      ${typeof limit === 'number' && limit > 0 ? `LIMIT ${Math.floor(limit)}` : ''}
    `;

    const rows = this.db.prepare(query).all() as any[];
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * 获取任务
   */
  async getTask(taskId: string): Promise<ITask | null> {
    const row = this.db
      .prepare(
        `
      SELECT * FROM tasks
      WHERE id = ?
    `
      )
      .get(taskId) as any;

    if (!row) {
      return null;
    }

    return this.rowToTask(row);
  }

  /**
   * 获取 Agent 的任务
   */
  async getTasksByAgent(agentId: string): Promise<ITask[]> {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM tasks
      WHERE assigned_to = ?
      ORDER BY created_at DESC
    `
      )
      .all(agentId) as any[];

    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * 分配任务给 Agent
   */
  async assignTask(taskId: string, agentId: string): Promise<void> {
    this.db
      .prepare(
        `
      UPDATE tasks
      SET assigned_to = ?, status = 'running', started_at = ?
      WHERE id = ?
    `
      )
      .run(agentId, Date.now(), taskId);
  }

  /**
   * 获取可执行任务（所有依赖已满足）
   */
  async getExecutableTasks(): Promise<ITask[]> {
    const pendingRows = this.db
      .prepare(
        `
      SELECT * FROM tasks
      WHERE status = 'pending'
      ORDER BY
        CASE priority
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
        END,
        created_at ASC
    `
      )
      .all() as any[];

    const executable: ITask[] = [];

    for (const row of pendingRows) {
      if (row.parent_id) {
        const parent = await this.getTask(row.parent_id);
        if (!parent || parent.status !== 'completed') {
          continue; // 父任务未完成
        }
      }
      executable.push(this.rowToTask(row));
    }

    return executable;
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<void> {
    this.db
      .prepare(
        `
      DELETE FROM tasks
      WHERE id = ?
    `
      )
      .run(taskId);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  } {
    const row = this.db
      .prepare(
        `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM tasks
    `
      )
      .get() as any;

    return {
      total: row.total || 0,
      pending: row.pending || 0,
      running: row.running || 0,
      completed: row.completed || 0,
      failed: row.failed || 0,
    };
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
    const schemaPath = path.join(__dirname, '../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  /**
   * 检查循环依赖
   */
  private async checkCycle(taskId: string, parentId: string): Promise<boolean> {
    const visited = new Set<string>();
    let currentId = parentId;

    while (currentId) {
      if (currentId === taskId) {
        return true; // 检测到循环
      }

      if (visited.has(currentId)) {
        return true; // 检测到循环（非直接）
      }

      visited.add(currentId);

      const task = await this.getTask(currentId);
      currentId = task?.parentId || '';
    }

    return false;
  }

  /**
   * 将数据库行转换为任务对象
   */
  private rowToTask(row: any): ITask {
    return {
      id: row.id,
      parentId: row.parent_id,
      assignedTo: row.assigned_to,
      status: row.status as TaskStatus,
      priority: row.priority as TaskPriority,
      depth: row.depth,
      description: row.description,
      context: row.context ? JSON.parse(row.context) : {},
      result: row.result ? JSON.parse(row.result) : null,
      error: row.error,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    };
  }
}
