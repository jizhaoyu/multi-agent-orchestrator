/**
 * Orchestrator 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Orchestrator } from '@/core/orchestrator';
import { Worker } from '@/core/worker';
import { ClaudeAPIClient } from '@/integrations/claude';
import { StateManager } from '@/core/state-manager';
import { TaskManager } from '@/core/task-manager';
import { MemoryService } from '@/core/memory-service';
import type { ITask } from '@/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let stateManager: StateManager;
  let taskManager: TaskManager;
  let memoryService: MemoryService;
  let apiClient: ClaudeAPIClient;
  let workers: Worker[];
  let dbDir: string;

  beforeEach(async () => {
    // 创建临时目录
    dbDir = path.join(os.tmpdir(), `orchestrator-test-${Date.now()}`);
    await fs.promises.mkdir(dbDir, { recursive: true });

    // 初始化依赖
    stateManager = new StateManager({
      dbPath: path.join(dbDir, 'state.db'),
    });

    taskManager = new TaskManager({
      dbPath: path.join(dbDir, 'tasks.db'),
    });

    memoryService = new MemoryService({
      configRoot: path.join(dbDir, 'config'),
      enableWatch: false,
    });

    apiClient = new ClaudeAPIClient({
      apiKey: 'test-key',
    });

    // 创建 Workers
    workers = [];
    for (let i = 1; i <= 3; i++) {
      const worker = new Worker({
        id: `worker-${i}`,
        apiClient,
        stateManager,
        taskManager,
        memoryService,
      });
      workers.push(worker);
    }

    // 创建 Orchestrator
    orchestrator = new Orchestrator({
      id: 'orchestrator-1',
      apiClient,
      stateManager,
      taskManager,
      memoryService,
      workers,
    });
  });

  afterEach(async () => {
    await orchestrator.destroy();
    for (const worker of workers) {
      await worker.destroy();
    }
    stateManager.close();
    taskManager.close();
    await memoryService.destroy();

    // 清理临时目录
    await fs.promises.rm(dbDir, { recursive: true, force: true });
  });

  it('should initialize with correct properties', () => {
    expect(orchestrator.id).toBe('orchestrator-1');
    expect(orchestrator.type).toBe('orchestrator');
    expect(orchestrator.status).toBe('idle');
  });

  it('should receive task', async () => {
    const task = await orchestrator.receiveTask('Test task');

    expect(task.id).toBeDefined();
    expect(task.description).toBe('Test task');
    expect(task.status).toBe('pending');
  });

  it('should assign tasks to idle workers', async () => {
    const tasks: ITask[] = [
      {
        id: 'task-1',
        parentId: null,
        assignedTo: null,
        status: 'pending',
        priority: 'high',
        depth: 0,
        description: 'Task 1',
        context: {},
        result: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      },
      {
        id: 'task-2',
        parentId: null,
        assignedTo: null,
        status: 'pending',
        priority: 'medium',
        depth: 0,
        description: 'Task 2',
        context: {},
        result: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      },
    ];

    for (const task of tasks) {
      await taskManager.addTask(task);
    }

    const assignSpy = vi.fn();
    orchestrator.on('task-assigned', assignSpy);

    await orchestrator.assignTasks(tasks);

    expect(assignSpy).toHaveBeenCalled();
  });

  it('should emit no-idle-workers when no workers available', async () => {
    // 将所有 Worker 设置为 busy
    for (const worker of workers) {
      await stateManager.updateStatus(worker.id, 'busy', 'some-task');
    }

    const tasks: ITask[] = [
      {
        id: 'task-1',
        parentId: null,
        assignedTo: null,
        status: 'pending',
        priority: 'high',
        depth: 0,
        description: 'Task 1',
        context: {},
        result: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      },
    ];

    const noWorkersSpy = vi.fn();
    orchestrator.on('no-idle-workers', noWorkersSpy);

    await orchestrator.assignTasks(tasks);

    expect(noWorkersSpy).toHaveBeenCalledWith(tasks);
  });

  it('should review results', async () => {
    const task: ITask = {
      id: 'task-1',
      parentId: null,
      assignedTo: null,
      status: 'completed',
      priority: 'high',
      depth: 0,
      description: 'Task 1',
      context: {},
      result: 'This is a valid result with enough content',
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    const isValid = await orchestrator.reviewResults(task);
    expect(isValid).toBe(true);
  });

  it('should reject invalid results', async () => {
    const task: ITask = {
      id: 'task-1',
      parentId: null,
      assignedTo: null,
      status: 'completed',
      priority: 'high',
      depth: 0,
      description: 'Task 1',
      context: {},
      result: 'short', // 太短
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    const isValid = await orchestrator.reviewResults(task);
    expect(isValid).toBe(false);
  });

  it('should integrate results', async () => {
    const tasks: ITask[] = [
      {
        id: 'task-1',
        parentId: null,
        assignedTo: null,
        status: 'completed',
        priority: 'high',
        depth: 0,
        description: 'Task 1',
        context: {},
        result: 'Result 1',
        error: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      },
      {
        id: 'task-2',
        parentId: null,
        assignedTo: null,
        status: 'completed',
        priority: 'medium',
        depth: 0,
        description: 'Task 2',
        context: {},
        result: 'Result 2',
        error: null,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      },
    ];

    const integrated = await orchestrator.integrateResults(tasks);

    expect(integrated).toHaveProperty('totalTasks', 2);
    expect(integrated).toHaveProperty('completedTasks', 2);
  });

  it('should start and stop monitoring', async () => {
    await orchestrator.start();
    expect(orchestrator['isRunning']).toBe(true);
    expect(orchestrator['monitorTimer']).not.toBeNull();

    await orchestrator.stop();
    expect(orchestrator['isRunning']).toBe(false);
    expect(orchestrator['monitorTimer']).toBeNull();
  });

  it('should emit started and stopped events', async () => {
    const startSpy = vi.fn();
    const stopSpy = vi.fn();

    orchestrator.on('started', startSpy);
    orchestrator.on('stopped', stopSpy);

    await orchestrator.start();
    expect(startSpy).toHaveBeenCalled();

    await orchestrator.stop();
    expect(stopSpy).toHaveBeenCalled();
  });
});
