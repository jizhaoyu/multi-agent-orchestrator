/**
 * Feishu Bot 集成
 * 提供飞书事件订阅接入和结果回传
 */

import { EventEmitter } from 'events';
import * as http from 'http';
import type {
  IntegratedTaskFailureSummary,
  IntegratedTaskResultSummary,
  IntegratedTaskSummary,
  Orchestrator,
} from '@/core/orchestrator';
import type { Worker, WorkerProgressEvent } from '@/core/worker';
import type { ConversationTurn } from '@/types';

export type FeishuReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'union_id' | 'email';

export interface FeishuBotConfig {
  appId?: string;
  appSecret?: string;
  webhookUrl?: string;
  orchestrator: Orchestrator;
  workers: Worker[];
  host?: string;
  port?: number;
  eventPath?: string;
  verificationToken?: string;
  defaultChatId?: string;
  defaultWorkspaceRoot?: string;
  executionUpdatesMode?: 'silent' | 'verbose';
  defaultReceiveIdType?: FeishuReceiveIdType;
}

interface FeishuAccessTokenState {
  token: string;
  expiresAt: number;
}

interface FeishuMessageEvent {
  chatId: string;
  text: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
}

interface ChatExecutionState {
  taskId: string;
  description: string;
  workspaceRoot?: string;
  startedAt: string;
  cancelRequested: boolean;
}

interface InternalFeishuBotConfig {
  appId?: string;
  appSecret?: string;
  webhookUrl?: string;
  orchestrator: Orchestrator;
  workers: Worker[];
  host: string;
  port: number;
  eventPath: string;
  verificationToken?: string;
  defaultChatId?: string;
  defaultWorkspaceRoot?: string;
  executionUpdatesMode: 'silent' | 'verbose';
  defaultReceiveIdType: FeishuReceiveIdType;
}

const DEFAULT_EVENT_PATH = '/feishu/events';
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8788;
const MAX_TEXT_MESSAGE_LENGTH = 1800;
const MAX_CONVERSATION_TURNS = 8;

export class FeishuBotIntegration extends EventEmitter {
  private readonly config: InternalFeishuBotConfig;
  private server: http.Server | null = null;
  private isRunning = false;
  private accessTokenState: FeishuAccessTokenState | null = null;
  private readonly chatExecutionStates = new Map<string, ChatExecutionState>();
  private readonly conversationHistory = new Map<string, ConversationTurn[]>();
  private readonly attachedWorkerListeners = new Set<string>();

  constructor(config: FeishuBotConfig) {
    super();

    this.config = {
      ...config,
      host: config.host || DEFAULT_HOST,
      port: config.port ?? DEFAULT_PORT,
      eventPath: normalizeEventPath(config.eventPath),
      executionUpdatesMode: config.executionUpdatesMode || 'silent',
      defaultReceiveIdType: config.defaultReceiveIdType || 'chat_id',
    };

    this.setupEventListeners();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.server = http.createServer((request, response) => {
      void this.handleHttpRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(this.config.port, this.config.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    this.emit('started', {
      host: this.config.host,
      port: this.getListeningPort(),
      path: this.config.eventPath,
    });
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      this.server = null;
    }

    this.emit('stopped');
  }

  async destroy(): Promise<void> {
    await this.stop();
    this.removeAllListeners();
  }

  async sendNotification(message: string, chatId?: string): Promise<void> {
    const target = chatId || this.config.defaultChatId || 'webhook';
    await this.sendTextMessage(target, message);
  }

  private setupEventListeners(): void {
    this.config.orchestrator.on('worker-created', (worker) => {
      this.attachWorkerEventListeners(worker);
    });

    for (const worker of this.config.workers) {
      this.attachWorkerEventListeners(worker);
    }
  }

  private attachWorkerEventListeners(worker: Worker): void {
    if (this.attachedWorkerListeners.has(worker.id)) {
      return;
    }

    this.attachedWorkerListeners.add(worker.id);

    worker.on('progress', async (event) => {
      if (this.config.executionUpdatesMode !== 'verbose' || event.progress < 0) {
        return;
      }

      const chatId = this.resolveProgressChatId(event);
      if (!chatId) {
        return;
      }

      await this.sendTextMessage(
        chatId,
        [`🤖 ${worker.id}`, `进度: ${event.progress}%`, event.message].join('\n')
      );
    });
  }

  private async handleHttpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    if (request.method !== 'POST' || request.url !== this.config.eventPath) {
      this.respondJson(response, 404, {
        code: 404,
        msg: 'Not Found',
      });
      return;
    }

    try {
      const payload = await this.readJsonBody(request);

      if (this.isChallengePayload(payload)) {
        if (!this.isValidVerificationToken(payload.token)) {
          this.respondJson(response, 403, {
            code: 403,
            msg: 'Invalid token',
          });
          return;
        }

        this.respondJson(response, 200, {
          challenge: payload.challenge,
        });
        return;
      }

      const messageEvent = this.extractMessageEvent(payload);
      if (!messageEvent) {
        this.respondJson(response, 200, {
          code: 0,
        });
        return;
      }

      await this.handleIncomingMessage(messageEvent);

      this.respondJson(response, 200, {
        code: 0,
      });
    } catch (error) {
      this.emit('error', error);
      this.respondJson(response, 500, {
        code: 500,
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleIncomingMessage(event: FeishuMessageEvent): Promise<void> {
    const normalizedText = event.text.trim();
    if (!normalizedText) {
      return;
    }

    this.appendConversationTurn(event.chatId, {
      role: 'user',
      sender: event.senderName || '飞书用户',
      content: normalizedText,
      timestamp: new Date().toISOString(),
    });

    this.emit('user-message', {
      chatId: event.chatId,
      message: normalizedText,
      userId: event.senderId,
    });

    const command = this.parseCommand(normalizedText);
    if (command) {
      await this.handleCommand(event.chatId, command.name, command.argument);
      return;
    }

    await this.submitUserTask(event.chatId, normalizedText, event);
  }

  private async handleCommand(
    chatId: string,
    name: string,
    argument: string
  ): Promise<void> {
    if (name === 'help' || name === 'start') {
      await this.sendTextMessage(chatId, this.formatCommandHelp());
      return;
    }

    if (name === 'task') {
      if (!argument) {
        await this.sendTextMessage(chatId, '用法\n/task <任务描述>');
        return;
      }
      await this.submitUserTask(chatId, argument, {
        chatId,
        text: argument,
      });
      return;
    }

    if (name === 'cancel') {
      await this.handleCancelCommand(chatId);
      return;
    }

    if (name === 'status') {
      await this.handleStatusCommand(chatId);
      return;
    }

    if (name === 'workers') {
      await this.handleWorkersCommand(chatId);
      return;
    }

    await this.sendTextMessage(chatId, `暂不支持命令 /${name}\n\n${this.formatCommandHelp()}`);
  }

  private async submitUserTask(
    chatId: string,
    userInput: string,
    event: FeishuMessageEvent
  ): Promise<void> {
    if (this.chatExecutionStates.get(chatId) && !this.chatExecutionStates.get(chatId)?.cancelRequested) {
      await this.sendTextMessage(
        chatId,
        '当前聊天已有任务在运行中。\n如需停止当前任务，请先发送 /cancel。'
      );
      return;
    }

    const workspaceRoot = this.config.defaultWorkspaceRoot;
    const task = await this.config.orchestrator.receiveTask(userInput, {
      chatId,
      userId: event.senderId,
      userName: event.senderName,
      workspaceRoot,
      conversationHistory: this.getConversationHistory(chatId),
      source: 'feishu',
    });

    this.chatExecutionStates.set(chatId, {
      taskId: task.id,
      description: userInput,
      workspaceRoot,
      startedAt: new Date().toISOString(),
      cancelRequested: false,
    });

    await this.sendTextMessage(
      chatId,
      [
        `📥 任务已接收: ${task.id}`,
        '',
        '⏳ 状态',
        '- 已转为后台静默运行',
        '- 如需实时打断，发送 /cancel',
      ].join('\n')
    );

    void this.processUserRequest(chatId, task);
  }

  private async processUserRequest(
    chatId: string,
    task: Parameters<Orchestrator['decomposeTask']>[0]
  ): Promise<void> {
    try {
      const subtasks = await this.config.orchestrator.decomposeTask(task);
      if (this.chatExecutionStates.get(chatId)?.cancelRequested) {
        await this.sendCancellationSummary(chatId, task.id);
        return;
      }

      const executableTasks = subtasks.length > 0 ? subtasks : [task];
      const executionPlan = task.context.executionPlan;
      const maxConcurrentWorkers = extractRecommendedWorkers(executionPlan, executableTasks.length);

      await this.config.orchestrator.assignTasks(executableTasks, {
        maxConcurrentWorkers,
        shouldContinue: () => !this.chatExecutionStates.get(chatId)?.cancelRequested,
      });

      if (this.chatExecutionStates.get(chatId)?.cancelRequested) {
        await this.sendCancellationSummary(chatId, task.id);
        return;
      }

      const summary = await this.config.orchestrator.integrateResults(executableTasks);
      await this.sendTextMessage(chatId, formatSummary(summary));
    } catch (error) {
      await this.sendTextMessage(
        chatId,
        `❌ 执行失败\n${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      const current = this.chatExecutionStates.get(chatId);
      if (current?.taskId === task.id) {
        this.chatExecutionStates.delete(chatId);
      }
    }
  }

  private async handleCancelCommand(chatId: string): Promise<void> {
    const execution = this.chatExecutionStates.get(chatId);
    if (!execution) {
      await this.sendTextMessage(chatId, '当前聊天没有正在处理的任务。');
      return;
    }

    if (execution.cancelRequested) {
      await this.sendTextMessage(chatId, `任务 ${execution.taskId} 已经在取消中。`);
      return;
    }

    execution.cancelRequested = true;
    const cancelled = await this.config.orchestrator.cancelTaskTree(
      execution.taskId,
      '任务已被 Feishu 用户取消'
    );

    await this.sendTextMessage(
      chatId,
      [
        `已收到中断请求: ${execution.taskId}`,
        `- 已取消待执行任务: ${cancelled.cancelledPendingCount}`,
        `- 运行中任务总数: ${cancelled.runningCount}`,
        `- 已发送中断信号: ${cancelled.interruptedRunningCount}`,
      ].join('\n')
    );
  }

  private async handleStatusCommand(chatId: string): Promise<void> {
    const execution = this.chatExecutionStates.get(chatId);
    const workers = this.config.workers;
    const idleCount = workers.filter((worker) => worker.status === 'idle').length;
    const busyCount = workers.filter((worker) => worker.status === 'busy').length;

    await this.sendTextMessage(
      chatId,
      [
        '当前状态',
        '',
        `- 当前运行任务: ${execution ? execution.taskId : '无'}`,
        `- 已绑定工作区: ${this.config.defaultWorkspaceRoot || '未配置'}`,
        `- 上下文轮数: ${this.getConversationHistory(chatId).length}`,
        `- 空闲小弟: ${idleCount}`,
        `- 忙碌小弟: ${busyCount}`,
      ].join('\n')
    );
  }

  private async handleWorkersCommand(chatId: string): Promise<void> {
    const lines = this.config.workers.map((worker) => {
      const state = worker.status === 'busy' ? `忙碌 (${worker.currentTaskId || 'unknown'})` : '空闲';
      return `- ${worker.id}: ${state}`;
    });

    await this.sendTextMessage(chatId, ['小弟状态', '', ...lines].join('\n'));
  }

  private async sendCancellationSummary(chatId: string, taskId: string): Promise<void> {
    const cancelled = await this.config.orchestrator.cancelTaskTree(
      taskId,
      '任务已被 Feishu 用户取消'
    );

    await this.sendTextMessage(
      chatId,
      cancelled.rootTaskFound
        ? [
            `任务 ${taskId} 已停止继续调度`,
            `- 已取消待执行任务: ${cancelled.cancelledPendingCount}`,
            `- 运行中任务总数: ${cancelled.runningCount}`,
            `- 已发送中断信号: ${cancelled.interruptedRunningCount}`,
          ].join('\n')
        : `任务 ${taskId} 未找到，可能已经结束。`
    );
  }

  private parseCommand(text: string): { name: string; argument: string } | null {
    if (!text.startsWith('/')) {
      return null;
    }

    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!match?.[1]) {
      return null;
    }

    return {
      name: match[1].toLowerCase(),
      argument: (match[2] || '').trim(),
    };
  }

  private formatCommandHelp(): string {
    return [
      '可用命令',
      '',
      '/task <任务描述>',
      '- 提交任务',
      '',
      '/cancel',
      '- 实时中断当前聊天任务',
      '',
      '/status',
      '- 查看当前运行状态',
      '',
      '/workers',
      '- 查看所有小弟状态',
      '',
      '/help',
      '- 查看帮助',
    ].join('\n');
  }

  private resolveProgressChatId(event: WorkerProgressEvent): string | undefined {
    if (typeof event.chatId === 'string' && event.chatId.trim().length > 0) {
      return event.chatId.trim();
    }

    return this.config.defaultChatId;
  }

  private appendConversationTurn(chatId: string, turn: ConversationTurn): void {
    const history = this.conversationHistory.get(chatId) || [];
    history.push(turn);
    this.conversationHistory.set(chatId, history.slice(-MAX_CONVERSATION_TURNS));
  }

  private getConversationHistory(chatId: string): ConversationTurn[] {
    const history = this.conversationHistory.get(chatId) || [];
    return history.map((item) => ({ ...item }));
  }

  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    const chunks = splitTextMessage(text, MAX_TEXT_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.sendFeishuMessage(chatId, chunk);
    }
  }

  private async sendFeishuMessage(receiveId: string, text: string): Promise<void> {
    if (this.config.webhookUrl) {
      const webhookResponse = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          msg_type: 'text',
          content: {
            text,
          },
        }),
      });

      const webhookPayload = (await webhookResponse.json()) as {
        code?: number;
        msg?: string;
      };

      if (!webhookResponse.ok || webhookPayload.code) {
        throw new Error(
          `Feishu webhook send failed: ${webhookPayload.msg || webhookResponse.statusText}`
        );
      }
      return;
    }

    const accessToken = await this.getTenantAccessToken();
    const response = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${this.config.defaultReceiveIdType}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({
            text,
          }),
        }),
      }
    );

    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
    };

    if (!response.ok || payload.code) {
      throw new Error(`Feishu sendMessage failed: ${payload.msg || response.statusText}`);
    }
  }

  private async getTenantAccessToken(): Promise<string> {
    if (!this.config.appId || !this.config.appSecret) {
      throw new Error('Feishu appId/appSecret 未配置，且当前也没有可用的 webhookUrl');
    }

    const now = Date.now();
    if (this.accessTokenState && this.accessTokenState.expiresAt > now + 60_000) {
      return this.accessTokenState.token;
    }

    const response = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      }
    );

    const payload = (await response.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };

    if (!response.ok || payload.code || !payload.tenant_access_token) {
      throw new Error(`Feishu access token request failed: ${payload.msg || response.statusText}`);
    }

    this.accessTokenState = {
      token: payload.tenant_access_token,
      expiresAt: now + Math.max((payload.expire || 7200) - 120, 60) * 1000,
    };

    return this.accessTokenState.token;
  }

  private isChallengePayload(
    payload: unknown
  ): payload is { challenge: string; token?: string } {
    return (
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { challenge?: unknown }).challenge === 'string'
    );
  }

  private isValidVerificationToken(token: string | undefined): boolean {
    if (!this.config.verificationToken) {
      return true;
    }

    return token === this.config.verificationToken;
  }

  private extractMessageEvent(payload: unknown): FeishuMessageEvent | null {
    if (typeof payload !== 'object' || payload === null) {
      return null;
    }

    const eventEnvelope = payload as {
      header?: { event_type?: string };
      event?: {
        sender?: {
          sender_type?: string;
          sender_id?: {
            open_id?: string;
            union_id?: string;
            user_id?: string;
          };
        };
        message?: {
          chat_id?: string;
          message_id?: string;
          message_type?: string;
          content?: string;
        };
      };
    };

    if (
      eventEnvelope.header?.event_type !== 'im.message.receive_v1' ||
      eventEnvelope.event?.message?.message_type !== 'text'
    ) {
      return null;
    }

    if (eventEnvelope.event.sender?.sender_type && eventEnvelope.event.sender.sender_type !== 'user') {
      return null;
    }

    const chatId = eventEnvelope.event.message.chat_id;
    if (!chatId) {
      return null;
    }

    const content = eventEnvelope.event.message.content;
    const text = extractTextFromMessageContent(content);
    if (!text) {
      return null;
    }

    return {
      chatId,
      text,
      messageId: eventEnvelope.event.message.message_id,
      senderId:
        eventEnvelope.event.sender?.sender_id?.user_id ||
        eventEnvelope.event.sender?.sender_id?.open_id ||
        eventEnvelope.event.sender?.sender_id?.union_id,
    };
  }

  private async readJsonBody(request: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString('utf-8').trim();
    if (!rawBody) {
      return {};
    }

    return JSON.parse(rawBody) as unknown;
  }

  private respondJson(
    response: http.ServerResponse,
    statusCode: number,
    payload: unknown
  ): void {
    response.statusCode = statusCode;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(payload));
  }

  private getListeningPort(): number {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      return this.config.port;
    }

    return address.port;
  }
}

function normalizeEventPath(value: string | undefined): string {
  if (!value) {
    return DEFAULT_EVENT_PATH;
  }

  return value.startsWith('/') ? value : `/${value}`;
}

function extractTextFromMessageContent(content: string | undefined): string | null {
  if (!content) {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
      return parsed.text.trim();
    }
  } catch {
    return content.trim() || null;
  }

  return null;
}

function extractRecommendedWorkers(
  executionPlan: unknown,
  fallback: number
): number {
  if (
    typeof executionPlan === 'object' &&
    executionPlan !== null &&
    typeof (executionPlan as { recommendedWorkers?: unknown }).recommendedWorkers === 'number'
  ) {
    return Math.max(
      1,
      Math.floor((executionPlan as { recommendedWorkers: number }).recommendedWorkers)
    );
  }

  return Math.max(1, fallback);
}

function splitTextMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const parts: string[] = [];
  let remaining = content.trim();

  while (remaining.length > maxLength) {
    const candidate = remaining.slice(0, maxLength);
    const splitAt = Math.max(candidate.lastIndexOf('\n'), candidate.lastIndexOf('。'));
    const index = splitAt > Math.floor(maxLength * 0.6) ? splitAt + 1 : maxLength;
    parts.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}

function formatSummary(summary: unknown): string {
  const normalized = normalizeIntegratedSummary(summary);
  if (!normalized) {
    return '🎯 最终结论\n\n📌 结论\n- 任务已处理完成。';
  }

  if (typeof normalized.finalOpinion === 'string' && normalized.finalOpinion.trim().length > 0) {
    return `🎯 最终结论\n\n${normalized.finalOpinion.trim()}`;
  }

  const sections = ['🎯 最终结论', '', '📌 结论'];
  if (normalized.results.length > 0) {
    sections.push(`- 已完成 ${normalized.results.length} 项关键处理。`);
  } else if (normalized.failures.length > 0) {
    sections.push('- 当前未形成可交付结果。');
  } else {
    sections.push('- 任务已处理完成。');
  }

  if (normalized.results.length > 0) {
    sections.push(
      '',
      '📎 要点',
      ...normalized.results.slice(0, 3).map((item) => `- ${summarizeResult(item)}`)
    );
  }

  if (normalized.failures.length > 0) {
    sections.push(
      '',
      '⚠️ 风险',
      ...normalized.failures.slice(0, 2).map((item) => `- ${item.error}`)
    );
  }

  return sections.join('\n');
}

function normalizeIntegratedSummary(summary: unknown): IntegratedTaskSummary | null {
  if (typeof summary !== 'object' || summary === null) {
    return null;
  }

  const summaryRecord = summary as {
    totalTasks?: unknown;
    completedTasks?: unknown;
    failedTasks?: unknown;
    results?: unknown;
    failures?: unknown;
    finalOpinion?: unknown;
  };

  if (!Array.isArray(summaryRecord.results) || !Array.isArray(summaryRecord.failures)) {
    return null;
  }

  return {
    totalTasks:
      typeof summaryRecord.totalTasks === 'number' ? summaryRecord.totalTasks : summaryRecord.results.length + summaryRecord.failures.length,
    completedTasks:
      typeof summaryRecord.completedTasks === 'number' ? summaryRecord.completedTasks : summaryRecord.results.length,
    failedTasks:
      typeof summaryRecord.failedTasks === 'number' ? summaryRecord.failedTasks : summaryRecord.failures.length,
    results: summaryRecord.results.filter(isResultSummary),
    failures: summaryRecord.failures.filter(isFailureSummary),
    finalOpinion:
      typeof summaryRecord.finalOpinion === 'string' ? summaryRecord.finalOpinion : undefined,
  };
}

function isResultSummary(value: unknown): value is IntegratedTaskResultSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { taskId?: unknown }).taskId === 'string' &&
    typeof (value as { description?: unknown }).description === 'string'
  );
}

function isFailureSummary(value: unknown): value is IntegratedTaskFailureSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { taskId?: unknown }).taskId === 'string' &&
    typeof (value as { description?: unknown }).description === 'string' &&
    typeof (value as { error?: unknown }).error === 'string'
  );
}

function summarizeResult(item: IntegratedTaskResultSummary): string {
  if (typeof item.result === 'string') {
    return item.result.trim().slice(0, 120);
  }

  if (
    typeof item.result === 'object' &&
    item.result !== null &&
    typeof (item.result as { summary?: unknown }).summary === 'string'
  ) {
    return (item.result as { summary: string }).summary.trim().slice(0, 120);
  }

  return item.description;
}
