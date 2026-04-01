import { EventEmitter } from 'events';
import { createHmac } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITask } from '@/types';
import { FeishuBotIntegration } from '@/integrations/feishu';

describe('FeishuBotIntegration', () => {
  const nativeFetch = globalThis.fetch;
  let orchestrator: MockOrchestrator;
  let workers: MockWorker[];
  let integration: FeishuBotIntegration;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://127.0.0.1:')) {
        return nativeFetch(input, init);
      }
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return new Response(
          JSON.stringify({
            code: 0,
            tenant_access_token: 'tenant-token',
            expire: 7200,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }

      if (url.includes('/im/v1/messages')) {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }

      if (url === 'https://example.com/feishu-webhook') {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    orchestrator = new MockOrchestrator();
    workers = [new MockWorker('worker-1'), new MockWorker('worker-2')];
    integration = new FeishuBotIntegration({
      appId: 'cli_xxx',
      appSecret: 'secret_xxx',
      verificationToken: 'verify-token',
      port: 0,
      orchestrator: orchestrator as unknown as any,
      workers: workers as unknown as any,
    });

    await integration.start();
  });

  afterEach(async () => {
    await integration.destroy();
    vi.unstubAllGlobals();
  });

  it('should respond to Feishu challenge verification', async () => {
    const response = await postEvent(integration, {
      challenge: 'challenge-token',
      token: 'verify-token',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      challenge: 'challenge-token',
    });
    expect(countMessageRequests(fetchMock)).toBe(0);
  });

  it('should accept text messages and send final summary replies', async () => {
    const response = await postEvent(integration, createTextMessageEvent('写一份项目总结'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ code: 0 });

    await waitFor(() => orchestrator.receiveTaskMock.mock.calls.length > 0);
    expect(orchestrator.receiveTaskMock).toHaveBeenCalledWith(
      '写一份项目总结',
      expect.objectContaining({
        chatId: 'oc_chat_123',
        source: 'feishu',
      })
    );

    await waitFor(() => countMessageRequests(fetchMock) >= 2);
    expect(extractSentTexts(fetchMock)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('📥 任务已接收'),
        expect.stringContaining('🎯 最终结论'),
      ])
    );
  });

  it('should cancel the active chat task when receiving /cancel', async () => {
    integration['chatExecutionStates'].set('oc_chat_123', {
      taskId: 'task-running',
      description: '运行中的任务',
      startedAt: new Date().toISOString(),
      cancelRequested: false,
      workspaceRoot: undefined,
    });

    const response = await postEvent(integration, createTextMessageEvent('/cancel'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ code: 0 });
    await waitFor(() => orchestrator.cancelTaskTreeMock.mock.calls.length > 0);
    expect(orchestrator.cancelTaskTreeMock).toHaveBeenCalledWith(
      'task-running',
      '任务已被 Feishu 用户取消'
    );
    expect(extractSentTexts(fetchMock)).toEqual(
      expect.arrayContaining([expect.stringContaining('已收到中断请求: task-running')])
    );
  });

  it('should sign webhook payloads when webhook secret is configured', async () => {
    await integration.destroy();
    integration = new FeishuBotIntegration({
      webhookUrl: 'https://example.com/feishu-webhook',
      webhookSecret: 'webhook-secret',
      orchestrator: orchestrator as unknown as any,
      workers: workers as unknown as any,
    });

    await integration.sendNotification('测试推送');

    const webhookCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === 'https://example.com/feishu-webhook'
    );
    expect(webhookCall).toBeTruthy();

    const payload = JSON.parse(String((webhookCall?.[1] as RequestInit).body)) as {
      msg_type: string;
      content: { text: string };
      timestamp?: string;
      sign?: string;
    };

    expect(payload.msg_type).toBe('text');
    expect(payload.content.text).toBe('测试推送');
    expect(payload.timestamp).toMatch(/^\d+$/);
    expect(payload.sign).toBe(
      createHmac('sha256', `${payload.timestamp}\nwebhook-secret`).digest('base64')
    );
  });
});

class MockOrchestrator extends EventEmitter {
  receiveTaskMock = vi.fn(async (description: string, context: Record<string, unknown>) => ({
    id: 'task-root',
    parentId: null,
    assignedTo: null,
    status: 'pending',
    priority: 'high',
    depth: 0,
    description,
    context,
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
  } satisfies ITask));

  decomposeTaskMock = vi.fn(async (task: ITask) => {
    task.context = {
      ...task.context,
      executionPlan: {
        recommendedWorkers: 1,
      },
    };
    return [] as ITask[];
  });

  assignTasksMock = vi.fn(async (tasks: ITask[]) => {
    for (const task of tasks) {
      task.status = 'completed';
      task.result = '项目总结已生成';
    }
  });

  integrateResultsMock = vi.fn(async () => ({
    totalTasks: 1,
    completedTasks: 1,
    failedTasks: 0,
    results: [
      {
        taskId: 'task-root',
        description: '写一份项目总结',
        result: '项目总结已生成',
      },
    ],
    failures: [],
    finalOpinion: '📌 结论\n- 项目总结已生成。\n\n📎 要点\n- 内容已整理完毕。',
  }));

  cancelTaskTreeMock = vi.fn(async () => ({
    rootTaskFound: true,
    cancelledPendingCount: 1,
    runningCount: 1,
    interruptedRunningCount: 1,
  }));

  receiveTask(description: string, context: Record<string, unknown>): Promise<ITask> {
    return this.receiveTaskMock(description, context);
  }

  decomposeTask(task: ITask): Promise<ITask[]> {
    return this.decomposeTaskMock(task);
  }

  assignTasks(tasks: ITask[], options: { maxConcurrentWorkers?: number; shouldContinue?: () => boolean }): Promise<void> {
    void options;
    return this.assignTasksMock(tasks);
  }

  integrateResults(tasks: ITask[]): Promise<unknown> {
    void tasks;
    return this.integrateResultsMock();
  }

  cancelTaskTree(taskId: string, reason: string): Promise<{
    rootTaskFound: boolean;
    cancelledPendingCount: number;
    runningCount: number;
    interruptedRunningCount: number;
  }> {
    return this.cancelTaskTreeMock(taskId, reason);
  }
}

class MockWorker extends EventEmitter {
  constructor(
    public readonly id: string,
    public status: 'idle' | 'busy' = 'idle',
    public currentTaskId: string | null = null
  ) {
    super();
  }
}

function createTextMessageEvent(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_type: 'user',
        sender_id: {
          user_id: 'ou_user_1',
        },
      },
      message: {
        chat_id: 'oc_chat_123',
        message_id: 'om_message_1',
        message_type: 'text',
        content: JSON.stringify({
          text,
        }),
      },
    },
  };
}

async function postEvent(
  integration: FeishuBotIntegration,
  payload: Record<string, unknown>
): Promise<Response> {
  const port = getListeningPort(integration);
  return globalThis.fetch(`http://127.0.0.1:${port}/feishu/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function getListeningPort(integration: FeishuBotIntegration): number {
  const address = integration['server']?.address();
  if (!address || typeof address === 'string') {
    throw new Error('Feishu test server is not listening');
  }

  return address.port;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function countMessageRequests(fetchSpy: ReturnType<typeof vi.fn>): number {
  return fetchSpy.mock.calls.filter(([input]) => String(input).includes('/im/v1/messages')).length;
}

function extractSentTexts(fetchSpy: ReturnType<typeof vi.fn>): string[] {
  return fetchSpy.mock.calls
    .filter(([input]) => String(input).includes('/im/v1/messages'))
    .map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as {
        content: string;
      };
      return (JSON.parse(body.content) as { text: string }).text;
    });
}
