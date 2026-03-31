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

  it('should reject subtask with depth >= 3', async () => {
    const subtask = createTask('subtask-1', 'medium', null);
    subtask.depth = 3;

    await expect(worker.delegateSubtask(subtask)).rejects.toThrow('任务深度超过限制');
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
