/**
 * Orchestrator 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Orchestrator } from '@/core/orchestrator';
import { Worker } from '@/core/worker';
import type { LLMClient, LLMResponse } from '@/integrations/llm';
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
  let apiClient: LLMClient;
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

    apiClient = createMockClient();

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

  it('should preserve task context from user conversation', async () => {
    const task = await orchestrator.receiveTask('继续优化登录流程', {
      conversationHistory: [
        {
          role: 'user',
          content: '先做登录页',
        },
        {
          role: 'user',
          content: '再补短信验证码',
        },
      ],
    });

    expect(task.context).toMatchObject({
      conversationHistory: [
        {
          role: 'user',
          content: '先做登录页',
        },
        {
          role: 'user',
          content: '再补短信验证码',
        },
      ],
    });
  });

  it('should analyze difficulty and recommend worker count from conversation context', async () => {
    vi.mocked(apiClient.sendMessage).mockResolvedValueOnce({
      content: `任务难度: complex
推荐小弟数: 3
分析依据: 涉及前后端和测试，需要多人并行。

子任务 1: 设计接口
描述: 设计登录接口和验证码校验规则
优先级: high

子任务 2: 实现前端
描述: 开发登录页和验证码交互
优先级: high

子任务 3: 编写测试
描述: 为登录流程补充接口与页面测试
优先级: medium`,
      tokensUsed: {
        input: 20,
        output: 40,
        total: 60,
      },
      model: 'mock-model',
      stopReason: 'stop',
    });

    const task = await orchestrator.receiveTask('帮我做一个完整的登录系统', {
      conversationHistory: [
        {
          role: 'user',
          content: '需要账号密码登录',
        },
        {
          role: 'user',
          content: '还要短信验证码和接口测试',
        },
      ],
    });

    const subtasks = await orchestrator.decomposeTask(task);
    const prompt = vi.mocked(apiClient.sendMessage).mock.calls.at(-1)?.[0]?.[0]?.content || '';

    expect(prompt).toContain('最近问答');
    expect(prompt).toContain('短信验证码');
    expect(subtasks).toHaveLength(3);
    expect(task.context).toMatchObject({
      executionPlan: {
        difficulty: 'complex',
        recommendedWorkers: 3,
      },
    });
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
    await expect(taskManager.getTask('task-1')).resolves.toMatchObject({
      status: 'completed',
      assignedTo: expect.stringMatching(/^worker-\d+$/),
    });
    await expect(taskManager.getTask('task-2')).resolves.toMatchObject({
      status: 'completed',
      assignedTo: expect.stringMatching(/^worker-\d+$/),
    });
  });

  it('should execute tasks in batches when there are more tasks than idle workers', async () => {
    const tasks: ITask[] = Array.from({ length: 5 }, (_, index) => ({
      id: `task-${index + 1}`,
      parentId: null,
      assignedTo: null,
      status: 'pending',
      priority: index === 0 ? 'high' : 'medium',
      depth: 0,
      description: `Task ${index + 1}`,
      context: {},
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    }));

    for (const task of tasks) {
      await taskManager.addTask(task);
    }

    await orchestrator.assignTasks(tasks);

    for (const task of tasks) {
      await expect(taskManager.getTask(task.id)).resolves.toMatchObject({
        status: 'completed',
      });
    }
  });

  it('should create a new worker when no idle workers are available', async () => {
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

    await taskManager.addTask(tasks[0]!);
    await orchestrator.assignTasks(tasks);

    expect(orchestrator['config'].workers).toHaveLength(4);
    await expect(taskManager.getTask('task-1')).resolves.toMatchObject({
      status: 'completed',
      assignedTo: 'worker-4',
    });
  });

  it('should interrupt running workers when cancelling a task tree', async () => {
    const task: ITask = {
      id: 'task-running',
      parentId: null,
      assignedTo: 'worker-1',
      status: 'pending',
      priority: 'high',
      depth: 0,
      description: 'Long running task',
      context: {},
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    await taskManager.addTask(task);

    const worker = workers[0];
    if (!worker) {
      throw new Error('worker-1 not found');
    }

    await worker.receiveTask(task);
    const cancelSpy = vi.spyOn(worker, 'cancelCurrentTask').mockResolvedValue(true);

    const result = await orchestrator.cancelTaskTree(task.id, '任务已被 Telegram 用户取消');

    expect(cancelSpy).toHaveBeenCalledWith('任务已被 Telegram 用户取消');
    expect(result).toMatchObject({
      rootTaskFound: true,
      cancelledPendingCount: 0,
      runningCount: 1,
      interruptedRunningCount: 1,
    });
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
      {
        id: 'task-3',
        parentId: null,
        assignedTo: null,
        status: 'failed',
        priority: 'medium',
        depth: 0,
        description: 'Task 3',
        context: {},
        result: {
          mode: 'workspace',
          summary: 'Verification failed',
        },
        error: 'Verification failed',
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
      },
    ];

    const integrated = await orchestrator.integrateResults(tasks);

    expect(integrated).toHaveProperty('totalTasks', 3);
    expect(integrated).toHaveProperty('completedTasks', 2);
    expect(integrated).toHaveProperty('failedTasks', 1);
    expect(integrated).toHaveProperty('failures');
    expect(integrated).toHaveProperty('finalOpinion', '📌 结论\n- Mock response。');
    expect((integrated as { failures: Array<{ error: string }> }).failures[0]?.error).toBe(
      'Verification failed'
    );
  });

  it('should reassign and execute a failed task during error handling', async () => {
    const task: ITask = {
      id: 'task-retry',
      parentId: null,
      assignedTo: 'worker-1',
      status: 'running',
      priority: 'high',
      depth: 0,
      description: 'Retry me',
      context: {},
      result: null,
      error: 'previous failure',
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: null,
    };

    await taskManager.addTask(task);

    await orchestrator.handleError(task, new Error('worker crashed'));

    await expect(taskManager.getTask(task.id)).resolves.toMatchObject({
      status: 'completed',
      assignedTo: expect.stringMatching(/^worker-\d+$/),
      error: null,
    });
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

function createMockClient(): LLMClient {
  const response: LLMResponse = {
    content: 'Mock response',
    tokensUsed: {
      input: 10,
      output: 20,
      total: 30,
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
