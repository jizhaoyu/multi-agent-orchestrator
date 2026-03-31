/**
 * 任务管理器
 * 管理任务队列、任务树、依赖关系
 */

import Database from 'better-sqlite3';
import type { ITaskManager, ITask, TaskStatus, TaskPriority } from '@/types';
import {
  buildTaskPriorityOrderSql,
  loadDatabaseSchema,
  parseJsonColumn,
} from '@/database/sqlite-utils';

/**
 * 任务管理器配置
 */
export interface TaskManagerConfig {
  /** 数据库文件路径 */
  dbPath: string;

  /** 最大任务深度 */
  maxDepth?: number;
}

interface TaskManagerStatements {
  insertTask: Database.Statement;
  selectNextExecutableTask: Database.Statement;
  selectTaskChildren: Database.Statement;
  selectRunningTasks: Database.Statement;
  selectPendingTasks: Database.Statement;
  selectPendingTasksWithLimit: Database.Statement;
  selectTaskById: Database.Statement;
  selectTasksByAgent: Database.Statement;
  assignTask: Database.Statement;
  selectExecutableTasks: Database.Statement;
  deleteTask: Database.Statement;
  selectStats: Database.Statement;
  resetTaskForRetry: Database.Statement;
}

/**
 * 任务管理器
 */
export class TaskManager implements ITaskManager {
  private db: Database.Database;
  private config: Required<TaskManagerConfig>;
  private readonly statements: TaskManagerStatements;
  private readonly insertTasksTransaction: (tasks: ITask[]) => void;

  constructor(config: TaskManagerConfig) {
    this.config = {
      dbPath: config.dbPath,
      maxDepth: config.maxDepth || 3,
    };

    this.db = new Database(this.config.dbPath);
    this.initDatabase();
    this.statements = this.prepareStatements();
    this.insertTasksTransaction = this.db.transaction((tasks: ITask[]) => {
      for (const task of tasks) {
        this.insertTaskRecord(task);
      }
    });
  }

  /**
   * 添加任务
   */
  async addTask(task: ITask): Promise<void> {
    await this.validateTask(task);
    this.insertTaskRecord(task);
  }

  async addTasks(tasks: ITask[]): Promise<void> {
    for (const task of tasks) {
      await this.validateTask(task);
    }

    this.insertTasksTransaction(tasks);
  }

  /**
   * 获取下一个任务（按优先级）
   */
  async getNextTask(): Promise<ITask | null> {
    const row = this.statements.selectNextExecutableTask.get() as any;

    if (!row) {
      return null;
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
    const values: unknown[] = [status];
    const now = Date.now();

    if (status === 'running') {
      updates.push('started_at = ?', 'completed_at = NULL');
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

        const children = this.statements.selectTaskChildren.all(taskId) as Array<{ id: string }>;
        children.forEach((child) => queue.push(child.id));
      }
    }

    return tasks;
  }

  /**
   * 获取所有运行中的任务
   */
  async getRunningTasks(): Promise<ITask[]> {
    const rows = this.statements.selectRunningTasks.all() as any[];
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * 获取所有待执行任务
   */
  async getPendingTasks(limit?: number): Promise<ITask[]> {
    const rows =
      typeof limit === 'number' && limit > 0
        ? (this.statements.selectPendingTasksWithLimit.all(Math.floor(limit)) as any[])
        : (this.statements.selectPendingTasks.all() as any[]);

    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * 获取任务
   */
  async getTask(taskId: string): Promise<ITask | null> {
    const row = this.statements.selectTaskById.get(taskId) as any;

    if (!row) {
      return null;
    }

    return this.rowToTask(row);
  }

  /**
   * 获取 Agent 的任务
   */
  async getTasksByAgent(agentId: string): Promise<ITask[]> {
    const rows = this.statements.selectTasksByAgent.all(agentId) as any[];
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * 分配任务给 Agent
   */
  async assignTask(taskId: string, agentId: string): Promise<void> {
    this.statements.assignTask.run(agentId, Date.now(), taskId);
  }

  /**
   * 获取可执行任务（所有依赖已满足）
   */
  async getExecutableTasks(): Promise<ITask[]> {
    const rows = this.statements.selectExecutableTasks.all() as any[];
    return rows.map((row) => this.rowToTask(row));
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<void> {
    this.statements.deleteTask.run(taskId);
  }

  async resetTaskForRetry(taskId: string): Promise<void> {
    this.statements.resetTaskForRetry.run(taskId);
  }

  getMaxDepth(): number {
    return this.config.maxDepth;
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
    const row = this.statements.selectStats.get() as any;

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
    this.db.exec(loadDatabaseSchema());
  }

  private prepareStatements(): TaskManagerStatements {
    const priorityOrder = buildTaskPriorityOrderSql('priority');
    const joinedPriorityOrder = buildTaskPriorityOrderSql('t.priority');

    return {
      insertTask: this.db.prepare(`
        INSERT INTO tasks (
          id, parent_id, assigned_to, status, priority, depth,
          description, context, result, error,
          created_at, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      selectNextExecutableTask: this.db.prepare(`
        SELECT t.*
        FROM tasks t
        LEFT JOIN tasks parent ON parent.id = t.parent_id
        WHERE t.status = 'pending'
          AND (t.parent_id IS NULL OR parent.status = 'completed')
        ORDER BY ${joinedPriorityOrder}, t.created_at ASC
        LIMIT 1
      `),
      selectTaskChildren: this.db.prepare(`
        SELECT id FROM tasks
        WHERE parent_id = ?
      `),
      selectRunningTasks: this.db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'running'
        ORDER BY started_at ASC
      `),
      selectPendingTasks: this.db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'pending'
        ORDER BY ${priorityOrder}, created_at ASC
      `),
      selectPendingTasksWithLimit: this.db.prepare(`
        SELECT * FROM tasks
        WHERE status = 'pending'
        ORDER BY ${priorityOrder}, created_at ASC
        LIMIT ?
      `),
      selectTaskById: this.db.prepare(`
        SELECT * FROM tasks
        WHERE id = ?
      `),
      selectTasksByAgent: this.db.prepare(`
        SELECT * FROM tasks
        WHERE assigned_to = ?
        ORDER BY created_at DESC
      `),
      assignTask: this.db.prepare(`
        UPDATE tasks
        SET assigned_to = ?, status = 'running', started_at = ?, completed_at = NULL
        WHERE id = ?
      `),
      selectExecutableTasks: this.db.prepare(`
        SELECT t.*
        FROM tasks t
        LEFT JOIN tasks parent ON parent.id = t.parent_id
        WHERE t.status = 'pending'
          AND (t.parent_id IS NULL OR parent.status = 'completed')
        ORDER BY ${joinedPriorityOrder}, t.created_at ASC
      `),
      deleteTask: this.db.prepare(`
        DELETE FROM tasks
        WHERE id = ?
      `),
      selectStats: this.db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM tasks
      `),
      resetTaskForRetry: this.db.prepare(`
        UPDATE tasks
        SET
          assigned_to = NULL,
          status = 'pending',
          result = NULL,
          error = NULL,
          started_at = NULL,
          completed_at = NULL
        WHERE id = ?
      `),
    };
  }

  /**
   * 检查循环依赖
   */
  private async checkCycle(taskId: string, parentId: string): Promise<boolean> {
    const visited = new Set<string>();
    let currentId = parentId;

    while (currentId) {
      if (currentId === taskId) {
        return true;
      }

      if (visited.has(currentId)) {
        return true;
      }

      visited.add(currentId);

      const task = await this.getTask(currentId);
      currentId = task?.parentId || '';
    }

    return false;
  }

  private async validateTask(task: ITask): Promise<void> {
    if (task.depth > this.config.maxDepth) {
      throw new Error(`Task depth exceeds maximum: ${task.depth} > ${this.config.maxDepth}`);
    }

    if (task.parentId) {
      const hasCycle = await this.checkCycle(task.id, task.parentId);
      if (hasCycle) {
        throw new Error(`Circular dependency detected: ${task.id} -> ${task.parentId}`);
      }
    }
  }

  private insertTaskRecord(task: ITask): void {
    this.statements.insertTask.run(
      task.id,
      task.parentId,
      task.assignedTo,
      task.status,
      task.priority,
      task.depth,
      task.description,
      JSON.stringify(task.context),
      task.result === null ? null : JSON.stringify(task.result),
      task.error,
      task.createdAt.getTime(),
      task.startedAt?.getTime() || null,
      task.completedAt?.getTime() || null
    );
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
      context: parseJsonColumn<Record<string, unknown>>(row.context, {}),
      result: parseJsonColumn<unknown | null>(row.result, null),
      error: row.error,
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    };
  }
}
