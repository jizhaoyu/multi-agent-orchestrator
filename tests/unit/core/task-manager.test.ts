/**
 * 任务管理器单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskManager } from '@/core/task-manager';
import type { ITask, TaskPriority } from '@/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('TaskManager', () => {
  let manager: TaskManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `task-manager-test-${Date.now()}.db`);
    manager = new TaskManager({ dbPath });
  });

  afterEach(() => {
    manager.close();
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it('should add task', async () => {
    const task: ITask = {
      id: 'task-1',
      parentId: null,
      assignedTo: null,
      status: 'pending',
      priority: 'high',
      depth: 0,
      description: 'Test task',
      context: {},
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    await manager.addTask(task);

    const retrieved = await manager.getTask('task-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('task-1');
    expect(retrieved?.description).toBe('Test task');
  });

  it('should get next task by priority', async () => {
    await manager.addTask(createTask('task-1', 'low'));
    await manager.addTask(createTask('task-2', 'high'));
    await manager.addTask(createTask('task-3', 'medium'));

    const next = await manager.getNextTask();
    expect(next?.id).toBe('task-2'); // high priority
  });

  it('should skip blocked pending tasks when selecting the next task', async () => {
    const parent = createTask('parent', 'high');
    parent.status = 'running';
    await manager.addTask(parent);
    await manager.addTask(createTask('blocked-child', 'high', 'parent'));
    await manager.addTask(createTask('ready-task', 'medium'));

    const next = await manager.getNextTask();
    expect(next?.id).toBe('ready-task');
  });

  it('should update task status', async () => {
    const task = createTask('task-1', 'high');
    await manager.addTask(task);

    await manager.updateTaskStatus('task-1', 'running');

    const updated = await manager.getTask('task-1');
    expect(updated?.status).toBe('running');
    expect(updated?.startedAt).not.toBeNull();
  });

  it('should get task tree', async () => {
    await manager.addTask(createTask('parent', 'high'));
    await manager.addTask(createTask('child-1', 'medium', 'parent'));
    await manager.addTask(createTask('child-2', 'low', 'parent'));
    await manager.addTask(createTask('grandchild', 'high', 'child-1'));

    const tree = await manager.getTaskTree('parent');
    expect(tree).toHaveLength(4); // parent + 2 children + 1 grandchild
  });

  it('should detect circular dependencies', async () => {
    await manager.addTask(createTask('task-1', 'high'));
    await manager.addTask(createTask('task-2', 'high', 'task-1'));

    const circularTask = createTask('task-3', 'high', 'task-2');
    circularTask.id = 'task-1'; // 创建循环: task-3 -> task-2 -> task-1 (但 task-3 的 ID 是 task-1)

    await expect(manager.addTask(circularTask)).rejects.toThrow('Circular dependency');
  });

  it('should enforce max depth', async () => {
    const task = createTask('deep-task', 'high');
    task.depth = 5; // 超过默认 maxDepth 3

    await expect(manager.addTask(task)).rejects.toThrow('Task depth exceeds maximum');
  });

  it('should get executable tasks', async () => {
    await manager.addTask(createTask('parent', 'high'));
    await manager.addTask(createTask('child', 'high', 'parent'));

    const executable = await manager.getExecutableTasks();

    // 只有父任务是可执行的（因为父任务未完成）
    expect(executable).toHaveLength(1);
    expect(executable[0]?.id).toBe('parent');
  });

  it('should get tasks by agent', async () => {
    await manager.addTask(createTask('task-1', 'high'));
    const task2 = createTask('task-2', 'medium');
    task2.assignedTo = 'worker-1';
    await manager.addTask(task2);

    const agentTasks = await manager.getTasksByAgent('worker-1');
    expect(agentTasks).toHaveLength(1);
    expect(agentTasks[0]?.id).toBe('task-2');
  });

  it('should assign task to agent', async () => {
    await manager.addTask(createTask('task-1', 'high'));
    await manager.assignTask('task-1', 'worker-1');

    const task = await manager.getTask('task-1');
    expect(task?.assignedTo).toBe('worker-1');
    expect(task?.status).toBe('running');
  });

  it('should reset a task for retry', async () => {
    const task = createTask('task-retry', 'high');
    task.status = 'failed';
    task.assignedTo = 'worker-1';
    task.result = { summary: 'failed before retry' };
    task.error = 'boom';
    task.startedAt = new Date();
    task.completedAt = new Date();
    await manager.addTask(task);

    await manager.resetTaskForRetry(task.id);

    await expect(manager.getTask(task.id)).resolves.toMatchObject({
      status: 'pending',
      assignedTo: null,
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
  });

  it('should get stats', async () => {
    await manager.addTask(createTask('task-1', 'high'));

    const task2 = createTask('task-2', 'medium');
    task2.status = 'running';
    await manager.addTask(task2);

    const task3 = createTask('task-3', 'low');
    task3.status = 'completed';
    await manager.addTask(task3);

    const stats = manager.getStats();
    expect(stats.total).toBe(3);
    expect(stats.pending).toBe(1);
    expect(stats.running).toBe(1);
    expect(stats.completed).toBe(1);
  });

  it('should delete task', async () => {
    await manager.addTask(createTask('task-1', 'high'));
    await manager.deleteTask('task-1');

    const task = await manager.getTask('task-1');
    expect(task).toBeNull();
  });

  it('should get running tasks', async () => {
    const task1 = createTask('task-1', 'high');
    task1.status = 'running';
    await manager.addTask(task1);

    const task2 = createTask('task-2', 'medium');
    task2.status = 'running';
    await manager.addTask(task2);

    await manager.addTask(createTask('task-3', 'low'));

    const running = await manager.getRunningTasks();
    expect(running).toHaveLength(2);
  });
});

function createTask(
  id: string,
  priority: TaskPriority,
  parentId: string | null = null
): ITask {
  return {
    id,
    parentId,
    assignedTo: null,
    status: 'pending',
    priority,
    depth: 0,
    description: `Task ${id}`,
    context: {},
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
  };
}
