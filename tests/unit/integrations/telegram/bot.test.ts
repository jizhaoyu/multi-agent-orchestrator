/**
 * Telegram Bot 集成单元测试
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Orchestrator } from '@/core/orchestrator';
import type { Worker } from '@/core/worker';
import {
  TelegramBotIntegration,
  type TelegramBotConfig,
} from '@/integrations/telegram/bot';

const telegramMockState = vi.hoisted(() => ({
  instances: [] as MockTelegramBotInstance[],
  pendingUpdates: [] as Array<{ update_id: number }>,
}));

const tempDirs: string[] = [];

type MockTelegramBotInstance = {
  options: { polling: { params?: { offset?: number } } | false };
  getUpdatesCalls: unknown[];
  startPollingCalls: unknown[];
  stopPollingCalls: unknown[];
  setMyCommandsCalls: unknown[];
  sendMessageCalls: Array<{
    chatId: string;
    text: string;
    options: unknown;
  }>;
};

vi.mock('node-telegram-bot-api', () => {
  const { EventEmitter: MockEmitter } = require('events') as typeof import('events');

  return {
    default: class MockTelegramBot extends MockEmitter {
      options: { polling: { params?: { offset?: number } } | false };
      getUpdatesCalls: unknown[] = [];
      startPollingCalls: unknown[] = [];
      stopPollingCalls: unknown[] = [];
      setMyCommandsCalls: unknown[] = [];
      sendMessageCalls: Array<{
        chatId: string;
        text: string;
        options: unknown;
      }> = [];

      constructor(_token: string, options: { polling: { params?: { offset?: number } } | false }) {
        super();
        this.options = options;
        telegramMockState.instances.push(this);
      }

      async getUpdates(options: unknown): Promise<Array<{ update_id: number }>> {
        this.getUpdatesCalls.push(options);
        return telegramMockState.pendingUpdates;
      }

      async startPolling(options: unknown): Promise<void> {
        this.startPollingCalls.push(options);
      }

      async stopPolling(options: unknown): Promise<void> {
        this.stopPollingCalls.push(options);
      }

      async setMyCommands(commands: unknown): Promise<boolean> {
        this.setMyCommandsCalls.push(commands);
        return true;
      }

      async sendMessage(chatId: string, text: string, options: unknown): Promise<void> {
        this.sendMessageCalls.push({
          chatId,
          text,
          options,
        });
      }
    },
  };
});

class MockOrchestrator extends EventEmitter {
  receiveTask = vi.fn(async (userInput: string, context?: Record<string, unknown>) => ({
    id: 'task-1',
    parentId: null,
    assignedTo: null,
    status: 'pending' as const,
    priority: 'high' as const,
    depth: 0,
    description: userInput,
    context: context || {},
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
  }));

  decomposeTask = vi.fn(async () => []);

  assignTasks = vi.fn(async () => {});

  integrateResults = vi.fn(async () => ({ totalTasks: 0, completedTasks: 0 }));

  getQueueSnapshot = vi.fn(async () => ({
    stats: {
      total: 0,
      pending: 0,
      running: 0,
      completed: 0,
      failed: 0,
    },
    runningTasks: [],
    pendingTasks: [],
  }));

  cancelTaskTree = vi.fn(async () => ({
    rootTaskFound: true,
    cancelledPendingCount: 0,
    runningCount: 0,
  }));
}

class MockWorker extends EventEmitter {
  status: 'idle' | 'busy' | 'error' = 'idle';
  currentTaskId: string | null = null;

  constructor(public readonly id: string) {
    super();
  }
}

describe('TelegramBotIntegration', () => {
  beforeEach(() => {
    telegramMockState.instances.length = 0;
    telegramMockState.pendingUpdates = [];
  });

  afterEach(async () => {
    telegramMockState.instances.length = 0;
    telegramMockState.pendingUpdates = [];
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it('should skip pending updates before polling starts', async () => {
    telegramMockState.pendingUpdates = [{ update_id: 42 }];

    const { integration } = createIntegration();
    await integration.start();

    const bot = telegramMockState.instances[0];

    expect(bot?.getUpdatesCalls).toEqual([
      {
        offset: -1,
        limit: 1,
        timeout: 0,
      },
    ]);
    expect(bot?.setMyCommandsCalls).toHaveLength(1);
    expect(bot?.setMyCommandsCalls[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: 'task' }),
        expect.objectContaining({ command: 'project' }),
        expect.objectContaining({ command: 'projects' }),
        expect.objectContaining({ command: 'pwd' }),
        expect.objectContaining({ command: 'queue' }),
        expect.objectContaining({ command: 'logs' }),
        expect.objectContaining({ command: 'cancel' }),
        expect.objectContaining({ command: 'status' }),
        expect.objectContaining({ command: 'workers' }),
        expect.objectContaining({ command: 'reset' }),
        expect.objectContaining({ command: 'help' }),
      ])
    );
    expect(bot?.options.polling).not.toBe(false);
    expect(bot?.options.polling && bot.options.polling.params?.offset).toBe(43);
    expect(bot?.startPollingCalls).toEqual([{ restart: true }]);

    await integration.destroy();
  });

  it('should allow disabling pending update skipping', async () => {
    telegramMockState.pendingUpdates = [{ update_id: 99 }];

    const { integration } = createIntegration({
      dropPendingUpdatesOnStart: false,
    });
    await integration.start();

    const bot = telegramMockState.instances[0];

    expect(bot?.getUpdatesCalls).toHaveLength(0);
    expect(bot?.options.polling).not.toBe(false);
    expect(bot?.options.polling && bot.options.polling.params?.offset).toBeUndefined();
    expect(bot?.startPollingCalls).toEqual([{ restart: true }]);

    await integration.destroy();
  });

  it('should switch workspace with /project and use it for following tasks', async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-project-switch-'));
    tempDirs.push(workspaceRoot);

    const { integration, orchestrator } = createIntegration({
      defaultWorkspaceRoot: path.dirname(workspaceRoot),
    });
    const bot = telegramMockState.instances[0];

    bot?.emit('message', createTelegramMessage(`/project ${workspaceRoot}`));
    await waitFor(() => (bot?.sendMessageCalls.length || 0) > 0);

    expect(orchestrator.receiveTask).not.toHaveBeenCalled();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain(workspaceRoot);

    bot?.emit('message', createTelegramMessage('帮我修复登录页样式'));
    await flushAsyncWork();

    expect(orchestrator.receiveTask).toHaveBeenCalledWith(
      '帮我修复登录页样式',
      expect.objectContaining({
        workspaceRoot,
      })
    );

    await integration.destroy();
  });

  it('should switch workspace by project name from configured search roots', async () => {
    const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-project-roots-'));
    const currentWorkspace = path.join(projectsRoot, 'multi-agent-orchestrator');
    const targetWorkspace = path.join(projectsRoot, '图书馆预约');
    await fs.mkdir(currentWorkspace, { recursive: true });
    await fs.mkdir(targetWorkspace, { recursive: true });
    tempDirs.push(projectsRoot);

    const { integration, orchestrator } = createIntegration({
      defaultWorkspaceRoot: currentWorkspace,
      projectSearchRoots: [projectsRoot],
    });
    const bot = telegramMockState.instances[0];

    bot?.emit('message', createTelegramMessage('/project 图书馆预约'));
    await waitFor(() => (bot?.sendMessageCalls.length || 0) > 0);

    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('匹配方式: 项目名 图书馆预约');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain(targetWorkspace);

    bot?.emit('message', createTelegramMessage('检查预约脚本'));
    await waitFor(() => orchestrator.receiveTask.mock.calls.length > 0);

    expect(orchestrator.receiveTask).toHaveBeenCalledWith(
      '检查预约脚本',
      expect.objectContaining({
        workspaceRoot: targetWorkspace,
      })
    );

    await integration.destroy();
  });

  it('should support /task command and send workflow stage updates', async () => {
    const workspaceRoot = 'D:/workspace/demo';
    const { integration, orchestrator } = createIntegration({
      defaultWorkspaceRoot: workspaceRoot,
    });
    const bot = telegramMockState.instances[0];

    orchestrator.decomposeTask = vi.fn(async (task) => {
      task.context = {
        ...task.context,
        executionPlan: {
          difficulty: 'complex',
          recommendedWorkers: 3,
          rationale: '拆分为实现和验证两个阶段',
        },
      };

      const subtasks = [
        {
          id: 'subtask-1',
          parentId: task.id,
          assignedTo: null,
          status: 'pending' as const,
          priority: 'high' as const,
          depth: 1,
          description: '修复登录接口并补测试',
          context: {
            workspaceRoot,
          },
          result: null,
          error: null,
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        },
      ];

      orchestrator.emit('task-decomposed', task, subtasks);
      return subtasks;
    });

    orchestrator.assignTasks = vi.fn(async () => {});
    orchestrator.integrateResults = vi.fn(async () => ({
      totalTasks: 1,
      completedTasks: 1,
      results: [],
    }));

    bot?.emit('message', createTelegramMessage('/task 修复登录接口并补测试'));
    await waitFor(() => orchestrator.integrateResults.mock.calls.length > 0, 500);

    const texts = bot?.sendMessageCalls.map((call) => call.text) || [];

    expect(orchestrator.receiveTask).toHaveBeenCalledWith(
      '修复登录接口并补测试',
      expect.objectContaining({
        workspaceRoot,
      })
    );
    expect(texts.some((text) => text.includes('任务已接收'))).toBe(true);
    expect(texts.some((text) => text.includes('分析中'))).toBe(true);
    expect(texts.some((text) => text.includes('分配中'))).toBe(true);
    expect(texts.some((text) => text.includes('任务难度: 复杂'))).toBe(true);
    expect(texts.some((text) => text.includes('调度小弟: 1 名'))).toBe(true);
    expect(texts.some((text) => text.includes('任务流程已结束'))).toBe(true);

    await integration.destroy();
  });

  it('should format completion output as compact sections and skip duplicate 100 progress', async () => {
    const { integration, worker } = createIntegration({
      chatId: '1001',
    });
    const bot = telegramMockState.instances[0];

    worker.emit('progress', {
      taskId: 'task-1',
      progress: 100,
      message: '任务完成',
    });
    worker.emit('task-completed', {
      id: 'task-1',
      description: '检查当前项目目录并整理要点',
      context: {
        workspaceRoot: 'D:/workspace/demo',
      },
      result: {
        mode: 'workspace',
        summary:
          '这个项目是一个面向 Spring Boot + React/Next 的 Codex 实战知识库，不是代码应用项目，当前已收敛为 7 份主文档。',
        changedFiles: ['README.md'],
        verification: ['npm test'],
      },
    });
    await flushAsyncWork();

    expect(bot?.sendMessageCalls).toHaveLength(1);
    expect(bot?.sendMessageCalls[0]?.text).toContain('任务完成');
    expect(bot?.sendMessageCalls[0]?.text).toContain('关键结果');
    expect(bot?.sendMessageCalls[0]?.text).toContain('修改文件');
    expect(bot?.sendMessageCalls[0]?.text).toContain('验证');

    await integration.destroy();
  });

  it('should show worker execution steps and deduplicate repeated progress messages', async () => {
    const { integration, worker } = createIntegration({
      chatId: '1001',
    });
    const bot = telegramMockState.instances[0];

    worker.emit('progress', {
      taskId: 'task-1',
      progress: 20,
      message: '正在模糊查找文件: 01md',
    });
    worker.emit('progress', {
      taskId: 'task-1',
      progress: 20,
      message: '正在模糊查找文件: 01md',
    });
    worker.emit('progress', {
      taskId: 'task-1',
      progress: 45,
      message: '正在读取文件: docs/01-java-fullstack-mcp-review.md',
    });
    await flushAsyncWork();

    expect(bot?.sendMessageCalls).toHaveLength(2);
    expect(bot?.sendMessageCalls[0]?.text).toContain('执行中');
    expect(bot?.sendMessageCalls[0]?.text).toContain('正在模糊查找文件: 01md');
    expect(bot?.sendMessageCalls[1]?.text).toContain('正在读取文件');

    await integration.destroy();
  });

  it('should send full worker result in follow-up message when result is long', async () => {
    const { integration, worker } = createIntegration({
      chatId: '1001',
    });
    const bot = telegramMockState.instances[0];
    const longSummary = '这是完整结果。'.repeat(40);

    worker.emit('task-completed', {
      id: 'task-1',
      description: '输出长结果',
      context: {
        workspaceRoot: 'D:/workspace/demo',
      },
      result: {
        mode: 'workspace',
        summary: longSummary,
        changedFiles: ['README.md'],
        verification: ['npm test'],
      },
    });
    await flushAsyncWork();

    expect(bot?.sendMessageCalls.length).toBeGreaterThanOrEqual(2);
    expect(bot?.sendMessageCalls[0]?.text).toContain('任务完成');
    expect(bot?.sendMessageCalls[1]?.text).toContain('完整结果');
    expect(bot?.sendMessageCalls[1]?.text).toContain(longSummary.slice(0, 20));

    await integration.destroy();
  });

  it('should show queue snapshot and recent logs', async () => {
    const workspaceRoot = 'D:/workspace/demo';
    const { integration, orchestrator } = createIntegration({
      defaultWorkspaceRoot: workspaceRoot,
    });
    const bot = telegramMockState.instances[0];

    orchestrator.getQueueSnapshot = vi.fn(async () => ({
      stats: {
        total: 4,
        pending: 2,
        running: 1,
        completed: 1,
        failed: 0,
      },
      runningTasks: [
        {
          id: 'task-running',
          parentId: null,
          assignedTo: 'worker-1',
          status: 'running' as const,
          priority: 'high' as const,
          depth: 0,
          description: '修复支付接口',
          context: {},
          result: null,
          error: null,
          createdAt: new Date(),
          startedAt: new Date(),
          completedAt: null,
        },
      ],
      pendingTasks: [
        {
          id: 'task-pending',
          parentId: null,
          assignedTo: null,
          status: 'pending' as const,
          priority: 'medium' as const,
          depth: 0,
          description: '补充接口测试',
          context: {},
          result: null,
          error: null,
          createdAt: new Date(),
          startedAt: null,
          completedAt: null,
        },
      ],
    }));

    bot?.emit('message', createTelegramMessage('/task 修复支付接口并补测试'));
    await waitFor(() => bot?.sendMessageCalls.some((call) => call.text.includes('分析中')) || false, 500);

    bot?.emit('message', createTelegramMessage('/queue'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('任务队列');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('task-running');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('task-pending');

    bot?.emit('message', createTelegramMessage('/logs 5'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('最近日志');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('修复支付接口并补测试');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('分析中');

    await integration.destroy();
  });

  it('should soft-cancel current chat task', async () => {
    const workspaceRoot = 'D:/workspace/demo';
    const { integration, orchestrator } = createIntegration({
      defaultWorkspaceRoot: workspaceRoot,
    });
    const bot = telegramMockState.instances[0];

    let releaseDecompose: (() => void) | null = null;
    orchestrator.decomposeTask = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseDecompose = () => resolve([]);
        })
    );

    bot?.emit('message', createTelegramMessage('/task 修复登录接口'));
    await waitFor(() => orchestrator.receiveTask.mock.calls.length > 0, 500);
    await waitFor(() => orchestrator.decomposeTask.mock.calls.length > 0 && Boolean(releaseDecompose), 500);

    bot?.emit('message', createTelegramMessage('/cancel'));
    await waitFor(() => orchestrator.cancelTaskTree.mock.calls.length > 0, 500);

    releaseDecompose?.();
    await waitFor(
      () => bot?.sendMessageCalls.some((call) => call.text.includes('已停止继续调度')) || false,
      500
    );

    const texts = bot?.sendMessageCalls.map((call) => call.text) || [];
    expect(texts.some((text) => text.includes('已收到取消请求'))).toBe(true);
    expect(texts.some((text) => text.includes('已停止继续调度'))).toBe(true);
    expect(orchestrator.cancelTaskTree).toHaveBeenCalledTimes(2);

    await integration.destroy();
  });

  it('should support help, projects, pwd, queue, logs, cancel, status, workers and reset commands', async () => {
    const projectsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'telegram-command-workspace-'));
    const workspaceRoot = path.join(projectsRoot, 'multi-agent-orchestrator');
    const secondWorkspace = path.join(projectsRoot, '图书馆预约');
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.mkdir(secondWorkspace, { recursive: true });
    tempDirs.push(projectsRoot);

    const { integration, worker } = createIntegration({
      defaultWorkspaceRoot: workspaceRoot,
      projectSearchRoots: [projectsRoot],
    });
    const bot = telegramMockState.instances[0];

    worker.status = 'busy';
    worker.currentTaskId = 'task-42';

    bot?.emit('message', createTelegramMessage('/help'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('/status');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('/task');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('/projects');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('/pwd');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('/queue');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('/logs');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('/cancel');

    bot?.emit('message', createTelegramMessage('/projects'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('可切换项目');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('图书馆预约');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain(workspaceRoot);

    bot?.emit('message', createTelegramMessage('/pwd'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('当前项目目录');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain(workspaceRoot);

    bot?.emit('message', createTelegramMessage('/status'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('当前状态');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain(workspaceRoot);

    bot?.emit('message', createTelegramMessage('/workers'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('worker-1: 忙碌');
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('task-42');

    bot?.emit('message', createTelegramMessage('/reset'));
    await flushAsyncWork();
    expect(bot?.sendMessageCalls.at(-1)?.text).toContain('已重置当前聊天上下文');

    await integration.destroy();
  });

  it('should retry sendMessage on retryable network errors', async () => {
    const { integration } = createIntegration();
    const bot = telegramMockState.instances[0];

    const networkError = Object.assign(
      new Error('EFATAL: Error: Client network socket disconnected before secure TLS connection was established'),
      {
        code: 'EFATAL',
        cause: new Error('Client network socket disconnected before secure TLS connection was established'),
      }
    );

    const originalSendMessage = bot?.sendMessage.bind(bot);
    const flakySendMessage = vi
      .fn()
      .mockRejectedValueOnce(networkError)
      .mockImplementation(async (...args: [string, string, unknown]) => {
        if (!originalSendMessage) {
          return;
        }

        return originalSendMessage(...args);
      });

    if (bot) {
      bot.sendMessage = flakySendMessage as typeof bot.sendMessage;
    }

    await integration.sendMessage('1001', {
      type: 'question',
      from: 'orchestrator',
      content: 'retry me',
    });

    expect(flakySendMessage).toHaveBeenCalledTimes(2);

    await integration.destroy();
  });

  it('should send full orchestrator summary details in follow-up message when result is long', async () => {
    const { integration, orchestrator } = createIntegration();
    const bot = telegramMockState.instances[0];
    const longSummary = '这里是完整任务总结。'.repeat(40);

    orchestrator.integrateResults = vi.fn(async () => ({
      totalTasks: 1,
      completedTasks: 1,
      results: [
        {
          taskId: 'task-1',
          description: '检查 01 文档并输出总结',
          result: {
            mode: 'workspace',
            summary: longSummary,
            changedFiles: [],
            verification: [],
          },
        },
      ],
    }));

    bot?.emit('message', createTelegramMessage('检查01文档并输出总结'));
    await flushAsyncWork();
    await flushAsyncWork();

    expect(bot?.sendMessageCalls.some((call) => call.text.includes('任务流程已结束'))).toBe(true);
    expect(bot?.sendMessageCalls.some((call) => call.text.includes('任务 1 完整结果'))).toBe(true);
    expect(bot?.sendMessageCalls.some((call) => call.text.includes(longSummary.slice(0, 20)))).toBe(true);

    await integration.destroy();
  });
});

function createIntegration(
  overrides: Partial<TelegramBotConfig> = {}
): {
  integration: TelegramBotIntegration;
  orchestrator: MockOrchestrator;
  worker: MockWorker;
} {
  const orchestrator = new MockOrchestrator();
  const worker = new MockWorker('worker-1');
  const integration = new TelegramBotIntegration({
    token: 'test-token',
    orchestrator: orchestrator as unknown as Orchestrator,
    workers: [worker as unknown as Worker],
    ...overrides,
  });

  return {
    integration,
    orchestrator,
    worker,
  };
}

function createTelegramMessage(text: string): {
  chat: { id: number };
  text: string;
  from: { id: number; first_name: string };
  date: number;
} {
  return {
    chat: { id: 1001 },
    text,
    from: {
      id: 2002,
      first_name: 'Tester',
    },
    date: Math.floor(Date.now() / 1000),
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 200
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) {
      return;
    }

    await flushAsyncWork();
  }

  throw new Error(`Timed out after ${timeoutMs}ms while waiting for async work`);
}
