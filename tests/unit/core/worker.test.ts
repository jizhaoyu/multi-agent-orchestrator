/**
 * Worker 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Worker } from '@/core/worker';
import type { LLMClient, LLMResponse } from '@/integrations/llm';
import { StateManager } from '@/core/state-manager';
import { TaskManager } from '@/core/task-manager';
import { MemoryService } from '@/core/memory-service';
import type { ITask, TaskPriority } from '@/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Worker', () => {
  let worker: Worker;
  let stateManager: StateManager;
  let taskManager: TaskManager;
  let memoryService: MemoryService;
  let apiClient: LLMClient;
  let dbDir: string;

  beforeEach(async () => {
    // 创建临时目录
    dbDir = path.join(os.tmpdir(), `worker-test-${Date.now()}`);
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

    apiClient = createMockClient();

    // 创建 Worker
    worker = new Worker({
      id: 'worker-1',
      apiClient,
      stateManager,
      taskManager,
      memoryService,
      systemPrompt: 'You are a test worker.',
    });
  });

  afterEach(async () => {
    await worker.destroy();
    stateManager.close();
    taskManager.close();
    await memoryService.destroy();

    // 清理临时目录
    await fs.promises.rm(dbDir, { recursive: true, force: true });
  });

  it('should initialize with correct properties', () => {
    expect(worker.id).toBe('worker-1');
    expect(worker.type).toBe('worker');
    expect(worker.status).toBe('idle');
    expect(worker.currentTaskId).toBeNull();
  });

  it('should receive task', async () => {
    const task = createTask('task-1', 'high');
    await taskManager.addTask(task);

    await worker.receiveTask(task);

    expect(worker.currentTaskId).toBe('task-1');
    expect(worker.status).toBe('busy');
  });

  it('should send heartbeat', async () => {
    const beforeTime = worker.lastHeartbeat.getTime();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await worker.sendHeartbeat();

    const afterTime = worker.lastHeartbeat.getTime();
    expect(afterTime).toBeGreaterThan(beforeTime);
  });

  it('should report progress', async () => {
    const task = createTask('task-1', 'high');
    await worker.receiveTask(task);

    const progressSpy = vi.fn();
    worker.on('progress', progressSpy);

    await worker.reportProgress(50, 'Halfway done');

    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        progress: 50,
        message: 'Halfway done',
      })
    );
  });

  it('should emit help-requested event', async () => {
    const helpSpy = vi.fn();
    worker.on('help-requested', helpSpy);

    await worker.requestHelp('Need help with this task');

    expect(helpSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: 'worker-1',
        issue: 'Need help with this task',
      })
    );
  });

  it('should delegate subtask to idle worker', async () => {
    // 创建另一个 Worker
    const worker2 = new Worker({
      id: 'worker-2',
      apiClient,
      stateManager,
      taskManager,
      memoryService,
    });

    const task = createTask('task-1', 'high');
    await taskManager.addTask(task);

    const delegateSpy = vi.fn();
    worker.on('subtask-delegated', delegateSpy);

    const subtask = createTask('subtask-1', 'medium', null);
    subtask.depth = 1;
    await taskManager.addTask(subtask);

    await worker.delegateSubtask(subtask);

    expect(delegateSpy).toHaveBeenCalled();

    await worker2.destroy();
  });

  it('should reject subtasks that exceed the configured max depth', async () => {
    const subtask = createTask('subtask-1', 'medium', null);
    subtask.depth = 4;

    await expect(worker.delegateSubtask(subtask)).rejects.toThrow('任务深度超过限制');
  });

  it('should add a delegated subtask before assigning it', async () => {
    const worker2 = new Worker({
      id: 'worker-2',
      apiClient,
      stateManager,
      taskManager,
      memoryService,
    });

    const subtask = createTask('subtask-missing', 'medium', null);
    subtask.depth = 1;

    await worker.delegateSubtask(subtask);

    await expect(taskManager.getTask(subtask.id)).resolves.toMatchObject({
      id: 'subtask-missing',
      assignedTo: 'worker-2',
      status: 'running',
    });

    await worker2.destroy();
  });

  it('should start and stop heartbeat', async () => {
    const task = createTask('task-1', 'high');
    await taskManager.addTask(task);

    await worker.receiveTask(task);

    // 心跳定时器应该启动
    expect(worker['heartbeatTimer']).not.toBeNull();

    // 完成任务后心跳应该停止
    await worker.executeTask(task); // 这会停止心跳

    expect(worker['heartbeatTimer']).toBeNull();
  });

  it('should emit task-received event', async () => {
    const task = createTask('task-1', 'high');
    await taskManager.addTask(task);

    const spy = vi.fn();
    worker.on('task-received', spy);

    await worker.receiveTask(task);

    expect(spy).toHaveBeenCalledWith(task);
  });

  it('should destroy properly', async () => {
    await worker.receiveTask(createTask('task-1', 'high'));
    await worker.destroy();

    expect(worker['heartbeatTimer']).toBeNull();
    expect(worker.listenerCount('task-received')).toBe(0);
    expect(worker.listenerCount('progress')).toBe(0);
  });

  it('should cache merged instruction context across tasks', async () => {
    await fs.promises.mkdir(path.join(dbDir, 'config'), { recursive: true });
    await fs.promises.writeFile(
      path.join(dbDir, 'config', 'AGENTS.md'),
      '# test instructions',
      'utf-8'
    );

    const cachedWorker = new Worker({
      id: 'worker-cached-context',
      apiClient,
      stateManager,
      taskManager,
      memoryService,
      instructionFiles: ['AGENTS.md'],
    });

    const readSpy = vi.spyOn(memoryService, 'read');
    const task1 = createTask('task-context-1', 'high');
    const task2 = createTask('task-context-2', 'high');
    await taskManager.addTask(task1);
    await taskManager.addTask(task2);

    await cachedWorker.receiveTask(task1);
    await cachedWorker.executeTask(task1);
    await cachedWorker.receiveTask(task2);
    await cachedWorker.executeTask(task2);

    expect(readSpy).toHaveBeenCalledTimes(1);

    await cachedWorker.destroy();
  });

  it('should forward workspace execution progress events', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `worker-workspace-${Date.now()}`);
    await fs.promises.mkdir(workspaceRoot, { recursive: true });
    await fs.promises.writeFile(path.join(workspaceRoot, 'README.md'), 'hello', 'utf-8');

    const workspaceWorker = new Worker({
      id: 'worker-workspace',
      apiClient: createQueuedClient([
        {
          type: 'read_files',
          reason: 'inspect file',
          files: ['README.md'],
        },
        {
          type: 'finish',
          reason: 'done',
          summary: '完成读取',
        },
      ]),
      stateManager,
      taskManager,
      memoryService,
      workspaceRoot,
      enableWorkspaceExecution: true,
    });

    const task = createTask('task-workspace', 'high');
    task.context.workspaceRoot = workspaceRoot;
    await taskManager.addTask(task);
    await workspaceWorker.receiveTask(task);

    const progressSpy = vi.fn();
    workspaceWorker.on('progress', progressSpy);

    await workspaceWorker.executeTask(task);

    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-workspace',
        message: '正在读取文件: README.md',
      })
    );

    await workspaceWorker.destroy();
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should fail the task when workspace execution returns a failed verdict', async () => {
    const workspaceRoot = path.join(os.tmpdir(), `worker-workspace-failed-${Date.now()}`);
    await fs.promises.mkdir(workspaceRoot, { recursive: true });

    const workspaceWorker = new Worker({
      id: 'worker-workspace-failed',
      apiClient: createQueuedClient([
        {
          type: 'finish',
          reason: 'stop with a failing verifier',
          summary: '等待 verifier',
          verification: ['node -e "process.exit(1)"'],
        },
      ]),
      stateManager,
      taskManager,
      memoryService,
      workspaceRoot,
      enableWorkspaceExecution: true,
      maxExecutionIterations: 1,
    });

    const task = createTask('task-workspace-failed', 'high');
    task.context.workspaceRoot = workspaceRoot;
    await taskManager.addTask(task);
    await workspaceWorker.receiveTask(task);

    const failedSpy = vi.fn();
    const completedSpy = vi.fn();
    workspaceWorker.on('task-failed', failedSpy);
    workspaceWorker.on('task-completed', completedSpy);

    await expect(workspaceWorker.executeTask(task)).rejects.toThrow('验证失败: Custom check 1');
    await expect(taskManager.getTask(task.id)).resolves.toMatchObject({
      status: 'failed',
      error: '验证失败: Custom check 1',
      result: expect.objectContaining({
        verdict: 'failed',
      }),
    });
    expect(failedSpy).toHaveBeenCalled();
    expect(completedSpy).not.toHaveBeenCalled();

    await workspaceWorker.destroy();
    await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('should abort the active execution when cancelCurrentTask is called', async () => {
    const cancellableWorker = new Worker({
      id: 'worker-cancel',
      apiClient: createBlockingClient(),
      stateManager,
      taskManager,
      memoryService,
      systemPrompt: 'You are a test worker.',
    });

    const task = createTask('task-cancel', 'high');
    await taskManager.addTask(task);
    await cancellableWorker.receiveTask(task);

    const cancelledSpy = vi.fn();
    cancellableWorker.on('task-cancelled', cancelledSpy);

    const executionPromise = cancellableWorker.executeTask(task);
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      cancellableWorker.cancelCurrentTask('任务已被 Telegram 用户取消')
    ).resolves.toBe(true);
    await expect(executionPromise).rejects.toThrow('任务已被 Telegram 用户取消');
    await expect(taskManager.getTask(task.id)).resolves.toMatchObject({
      status: 'failed',
      error: '任务已被 Telegram 用户取消',
    });
    expect(cancelledSpy).toHaveBeenCalled();

    await cancellableWorker.destroy();
  });
});

function createMockClient(): LLMClient {
  const response: LLMResponse = {
    content: '任务完成',
    tokensUsed: {
      input: 8,
      output: 16,
      total: 24,
    },
    model: 'mock-model',
    stopReason: 'stop',
  };

  return {
    sendMessage: vi.fn().mockResolvedValue(response),
    sendMessageStream: vi.fn().mockImplementation(async (_messages, onChunk) => {
      onChunk(response.content);
      return response;
    }),
    getConfig: vi.fn().mockReturnValue({ provider: 'mock' }),
  };
}

function createQueuedClient(actions: unknown[]): LLMClient {
  const queue = [...actions];

  return {
    sendMessage: vi.fn(async (): Promise<LLMResponse> => {
      const next = queue.shift();
      if (!next) {
        throw new Error('No queued action available');
      }

      return {
        content: JSON.stringify(next),
        tokensUsed: {
          input: 1,
          output: 1,
          total: 2,
        },
        model: 'mock-model',
        stopReason: 'stop',
      };
    }),
    sendMessageStream: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ provider: 'mock' }),
  };
}

function createBlockingClient(): LLMClient {
  return {
    sendMessage: vi.fn(
      async () =>
        await new Promise<LLMResponse>(() => {
          // Wait until the worker aborts the current task.
        })
    ),
    sendMessageStream: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ provider: 'mock' }),
  };
}

function createTask(id: string, priority: TaskPriority, parentId: string | null = null): ITask {
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
