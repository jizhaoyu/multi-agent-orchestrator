/**
 * Telegram Bot 集成
 * 提供 Telegram 群聊的可视化交互界面
 */

import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  IntegratedTaskFailureSummary,
  IntegratedTaskResultSummary,
  IntegratedTaskSummary,
  Orchestrator,
} from '@/core/orchestrator';
import type { Worker, WorkerProgressEvent } from '@/core/worker';
import type { ConversationTurn, TaskDifficulty, TaskExecutionPlan } from '@/types';

/**
 * Telegram Bot 配置
 */
export interface TelegramBotConfig {
  /** Bot Token */
  token: string;

  /** Orchestrator 实例 */
  orchestrator: Orchestrator;

  /** Worker 实例列表 */
  workers: Worker[];

  /** 群聊 ID */
  chatId?: string;

  /** HTTP 代理地址 */
  proxyUrl?: string;

  /** 默认工作区目录 */
  defaultWorkspaceRoot?: string;

  /** 可搜索的项目根目录列表，用于 /project 项目名 和 /projects */
  projectSearchRoots?: string[];

  /** 是否启用轮询 */
  polling?: boolean;

  /** 启动时是否跳过积压消息 */
  dropPendingUpdatesOnStart?: boolean;

  /** 执行消息可见性：silent 仅回执与最终结果，verbose 输出完整过程 */
  executionUpdatesMode?: 'silent' | 'verbose';
}

/**
 * 消息类型
 */
export type MessageType =
  | 'user_request'
  | 'task_assignment'
  | 'progress_update'
  | 'task_complete'
  | 'error_report'
  | 'question';

/**
 * Telegram 消息
 */
export interface TelegramMessage {
  type: MessageType;
  from: string;
  to?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface ChatExecutionState {
  taskId: string;
  description: string;
  workspaceRoot?: string;
  startedAt: string;
  cancelRequested: boolean;
}

interface TaskLifecycleLogEntry {
  timestamp: string;
  source: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Telegram Bot 集成
 */
export class TelegramBotIntegration extends EventEmitter {
  private bot: TelegramBot;
  private config: Omit<TelegramBotConfig, 'polling' | 'dropPendingUpdatesOnStart' | 'projectSearchRoots' | 'executionUpdatesMode'> & {
    polling: boolean;
    dropPendingUpdatesOnStart: boolean;
    projectSearchRoots: string[];
    executionUpdatesMode: 'silent' | 'verbose';
  };
  private isRunning = false;
  private readonly conversationHistory = new Map<string, ConversationTurn[]>();
  private readonly chatWorkspaceRoots = new Map<string, string>();
  private readonly chatExecutionStates = new Map<string, ChatExecutionState>();
  private readonly chatLifecycleLogs = new Map<string, TaskLifecycleLogEntry[]>();
  private readonly lastWorkerProgress = new Map<string, string>();
  private readonly attachedWorkerListeners = new Set<string>();
  private readonly maxConversationTurns = 8;
  private pollingConflictHandled = false;
  private readonly botCommands: TelegramBot.BotCommand[] = [
    {
      command: 'task',
      description: '提交明确开发任务',
    },
    {
      command: 'project',
      description: '切换或查看当前项目目录',
    },
    {
      command: 'projects',
      description: '列出可切换项目',
    },
    {
      command: 'pwd',
      description: '查看当前项目目录',
    },
    {
      command: 'queue',
      description: '查看当前任务队列',
    },
    {
      command: 'logs',
      description: '查看最近任务日志',
    },
    {
      command: 'cancel',
      description: '实时中断当前聊天任务',
    },
    {
      command: 'status',
      description: '查看当前项目与运行状态',
    },
    {
      command: 'workers',
      description: '查看小弟当前状态',
    },
    {
      command: 'reset',
      description: '清空当前聊天的项目与上下文',
    },
    {
      command: 'help',
      description: '查看命令帮助',
    },
  ];
  private readonly pollingOptions: TelegramBot.PollingOptions | null;
  private readonly messageListener = (msg: TelegramBot.Message): void => {
    void this.handleMessage(msg);
  };

  constructor(config: TelegramBotConfig) {
    super();

    this.config = {
      ...config,
      polling: config.polling ?? true,
      dropPendingUpdatesOnStart: config.dropPendingUpdatesOnStart ?? true,
      executionUpdatesMode: config.executionUpdatesMode ?? 'silent',
      projectSearchRoots: this.normalizeProjectSearchRoots(
        config.projectSearchRoots,
        config.defaultWorkspaceRoot
      ),
    };

    this.pollingOptions = this.config.polling
      ? {
          autoStart: false,
          interval: 1000,
          params: {
            timeout: 10,
          },
        }
      : null;

    this.bot = new TelegramBot(this.config.token, {
      polling: this.pollingOptions ?? false,
      request: this.config.proxyUrl
        ? ({
            proxy: this.config.proxyUrl,
          } as TelegramBot.ConstructorOptions['request'])
        : undefined,
    });

    this.bot.on('message', this.messageListener);
    this.setupEventListeners();
  }

  /**
   * 启动 Bot
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.pollingConflictHandled = false;

    try {
      await this.bot.setMyCommands(this.botCommands);
    } catch (error: unknown) {
      const details = this.describeError(error);
      console.error('telegram setMyCommands error', details);
    }

    if (this.config.polling) {
      if (this.config.dropPendingUpdatesOnStart) {
        try {
          await this.skipPendingUpdates();
        } catch (error: unknown) {
          if (this.isRunning) {
            const details = this.describeError(error);
            console.error('telegram pending updates sync error', details);
          }
        }
      }

      void this.bot.startPolling({ restart: true }).catch((error: unknown) => {
        if (!this.isRunning) {
          return;
        }

        const details = this.describeError(error);
        console.error('telegram polling startup error', details);
      });
    }

    this.emit('started');
  }

  /**
   * 停止 Bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.config.polling) {
      await this.bot.stopPolling({
        cancel: true,
        reason: 'Manual stop',
      });
    }

    this.emit('stopped');
  }

  private async skipPendingUpdates(): Promise<void> {
    if (!this.pollingOptions?.params) {
      return;
    }

    const pendingUpdates = await this.bot.getUpdates({
      offset: -1,
      limit: 1,
      timeout: 0,
    });
    const latestUpdate = pendingUpdates[pendingUpdates.length - 1];

    if (!latestUpdate) {
      return;
    }

    this.pollingOptions.params.offset = latestUpdate.update_id + 1;
  }

  /**
   * 发送消息
   */
  async sendMessage(chatId: string, message: TelegramMessage): Promise<void> {
    const formattedMessage = this.formatMessage(message);
    const sent = await this.safeBotSendMessage(chatId, formattedMessage);

    if (sent) {
      this.appendLifecycleLog(chatId, 'assistant', `${message.from}: ${message.content}`);
    }

    if (sent && message.type === 'question') {
      this.appendConversationTurn(chatId, {
        role: 'assistant',
        sender: message.from,
        content: message.content,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 发送任务分配消息
   */
  async sendTaskAssignment(
    chatId: string,
    workerId: string,
    taskDescription: string
  ): Promise<void> {
    const message = [
      `📌 已分配给 ${workerId}`,
      '',
      '任务',
      `- ${truncateMessage(taskDescription, 160)}`,
      '',
      '要求',
      '- 完成后返回简洁结果摘要',
    ].join('\n');

    await this.sendMessage(chatId, {
      type: 'task_assignment',
      from: workerId,
      content: message,
    });
  }

  /**
   * 发送进度更新
   */
  async sendProgressUpdate(
    chatId: string,
    workerId: string,
    progress: number,
    message: string
  ): Promise<void> {
    const progressBar = this.createProgressBar(progress);
    const text = [
      `🤖 ${workerId}`,
      '执行中',
      `- ${truncateMessage(message, 120)}`,
      '',
      '进度',
      `${progressBar} ${progress}%`,
    ].join('\n');

    await this.sendMessage(chatId, {
      type: 'progress_update',
      from: workerId,
      content: text,
    });
  }

  /**
   * 处理消息
   */
  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();
    const text = (msg.text || '').trim();

    if (!text) {
      return;
    }

    // 保存 chatId（如果未设置）
    if (!this.config.chatId) {
      this.config.chatId = chatId;
    }

    if (await this.handleCommand(chatId, text, msg)) {
      return;
    }

    if (await this.handleDirectConversation(chatId, text, msg)) {
      return;
    }

    // 解析 @mention
    const mention = this.parseMention(text);

    if (mention) {
      // 消息是给某个 Agent 的
      this.emit('message-to-agent', {
        agentId: mention.target,
        message: mention.content,
        chatId,
      });
    } else {
      await this.submitUserTask(chatId, text, msg);
    }
  }

  /**
   * 解析 @mention
   */
  private parseMention(text: string): { target: string; content: string } | null {
    const mentionRegex = /@(\w+)\s+(.*)/;
    const match = text.match(mentionRegex);

    if (match) {
      return {
        target: match[1] || '',
        content: match[2] || '',
      };
    }

    return null;
  }

  /**
   * 格式化消息
   */
  private formatMessage(message: TelegramMessage): string {
    const emoji = this.getEmojiForType(message.type);
    let text = `${emoji} ${message.from}\n\n${message.content}`;

    if (message.to) {
      text = `@${message.to}\n${text}`;
    }

    return text;
  }

  /**
   * 获取消息类型对应的 emoji
   */
  private getEmojiForType(type: MessageType): string {
    const emojiMap: Record<MessageType, string> = {
      user_request: '📥',
      task_assignment: '📤',
      progress_update: '📊',
      task_complete: '✅',
      error_report: '❌',
      question: '❓',
    };

    return emojiMap[type] || '💬';
  }

  /**
   * 创建进度条
   */
  private createProgressBar(progress: number): string {
    const total = 10;
    const filled = Math.floor((progress / 100) * total);
    const empty = total - filled;

    return '█'.repeat(filled) + '░'.repeat(empty);
  }

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    this.bot.on('polling_error', (error: unknown) => {
      if (!this.isRunning) {
        return;
      }

      const details = this.describeError(error);
      const hint = this.getPollingErrorHint(details);

      if (this.isConflictError(details)) {
        if (this.pollingConflictHandled) {
          return;
        }

        this.pollingConflictHandled = true;
        console.error('telegram polling error', hint ? { ...details, hint } : details);
        void this.stopPollingForConflict();
        return;
      }

      console.error('telegram polling error', hint ? { ...details, hint } : details);
    });

    this.bot.on('error', (error: unknown) => {
      const details = this.describeError(error);
      console.error('telegram bot error', details);
    });

    // 监听 Orchestrator 事件
    this.config.orchestrator.on('task-decomposed', async (task, subtasks) => {
      if (!this.shouldEmitIntermediateExecutionUpdates()) {
        return;
      }

      const chatId = this.resolveTaskChatId(task);
      if (chatId) {
        const plan = this.getTaskExecutionPlan(task);
        const maxConcurrentWorkers = this.resolveRecommendedWorkers(
          task,
          subtasks.length > 0 ? subtasks.length : 1
        );
        await this.sendWorkflowStageUpdate(chatId, '分配中', [
          subtasks.length > 0
            ? `已拆分出 ${subtasks.length} 个执行单元`
            : '未拆分出子任务，准备直接执行原始任务',
          plan ? `任务难度: ${this.formatDifficulty(plan.difficulty)}` : undefined,
          `调度小弟: ${maxConcurrentWorkers} 名`,
        ]);
      }
    });

    this.config.orchestrator.on('task-assigned', async (task, worker) => {
      if (!this.shouldEmitIntermediateExecutionUpdates()) {
        return;
      }

      const chatId = this.resolveTaskChatId(task);
      if (chatId) {
        await this.sendTaskAssignment(chatId, worker.id, task.description);
      }
    });

    this.config.orchestrator.on('worker-created', (worker) => {
      this.attachWorkerEventListeners(worker);
    });

    // 监听 Worker 事件
    for (const worker of this.config.workers) {
      this.attachWorkerEventListeners(worker);
    }
  }

  /**
   * 销毁 Bot
   */
  async destroy(): Promise<void> {
    await this.stop();
    this.bot.off('message', this.messageListener);
    this.removeAllListeners();
  }

  private async processUserRequest(
    chatId: string,
    task: Parameters<Orchestrator['decomposeTask']>[0]
  ): Promise<void> {
    const executionState = this.chatExecutionStates.get(chatId);

    try {
      const subtasks = await this.config.orchestrator.decomposeTask(task);
      if (executionState?.cancelRequested) {
        const cancelled = await this.config.orchestrator.cancelTaskTree(task.id, '任务已被 Telegram 用户取消');
        await this.sendCancellationSummary(chatId, task.id, cancelled);
        return;
      }

      const executableTasks = subtasks.length > 0 ? subtasks : [task];
      const maxConcurrentWorkers = this.resolveRecommendedWorkers(task, executableTasks.length);

      await this.config.orchestrator.assignTasks(executableTasks, {
        maxConcurrentWorkers,
        shouldContinue: () => !this.chatExecutionStates.get(chatId)?.cancelRequested,
      });

      if (this.chatExecutionStates.get(chatId)?.cancelRequested) {
        const cancelled = await this.config.orchestrator.cancelTaskTree(task.id, '任务已被 Telegram 用户取消');
        await this.sendCancellationSummary(chatId, task.id, cancelled);
        return;
      }

      const summary = await this.config.orchestrator.integrateResults(executableTasks);
      await this.sendOrchestratorSummaryMessages(chatId, summary);
    } catch (error) {
      this.emit('execution-error', {
        chatId,
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.sendMessage(chatId, {
        type: 'error_report',
        from: 'orchestrator',
        content: `❌ 执行失败: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      const currentExecution = this.chatExecutionStates.get(chatId);
      if (currentExecution?.taskId === task.id) {
        this.chatExecutionStates.delete(chatId);
      }
    }
  }

  private formatSummary(summary: unknown): string {
    const summaryRecord = this.normalizeIntegratedSummary(summary);
    if (!summaryRecord) {
      return '🎯 最终结论\n\n📌 结论\n- 任务已处理完成。';
    }

    const opinion = typeof summaryRecord.finalOpinion === 'string' && summaryRecord.finalOpinion.trim()
      ? normalizeFinalOpinionBlock(summaryRecord.finalOpinion)
      : this.buildExecutiveSummary(summaryRecord);

    return ['🎯 最终结论', '', opinion].join('\n');
  }

  private normalizeIntegratedSummary(summary: unknown): IntegratedTaskSummary | null {
    if (
      typeof summary !== 'object' ||
      summary === null ||
      !('totalTasks' in summary) ||
      !('completedTasks' in summary)
    ) {
      return null;
    }

    const summaryRecord = summary as {
      totalTasks: unknown;
      completedTasks: unknown;
      failedTasks?: unknown;
      finalOpinion?: unknown;
      results?: unknown;
      failures?: unknown;
    };
    const results = Array.isArray(summaryRecord.results)
      ? summaryRecord.results as IntegratedTaskResultSummary[]
      : [];
    const failures = Array.isArray(summaryRecord.failures)
      ? summaryRecord.failures as IntegratedTaskFailureSummary[]
      : [];

    return {
      totalTasks: normalizeSummaryCount(summaryRecord.totalTasks, results.length + failures.length),
      completedTasks: normalizeSummaryCount(summaryRecord.completedTasks, results.length),
      failedTasks: normalizeSummaryCount(summaryRecord.failedTasks, failures.length),
      finalOpinion:
        typeof summaryRecord.finalOpinion === 'string' ? summaryRecord.finalOpinion.trim() : undefined,
      results,
      failures,
    };
  }

  private buildExecutiveSummary(summary: IntegratedTaskSummary): string {
    const conciseSingleResult = this.getSingleResultOpinion(summary);
    if (conciseSingleResult) {
      return ['📌 结论', `- ${conciseSingleResult}`].join('\n');
    }

    const completedPoints = deduplicateStrings(
      summary.results.flatMap((item) => this.extractExecutivePointsFromResult(item.result, 1))
    ).slice(0, 3);
    const failurePoints = deduplicateStrings(
      summary.failures.flatMap((item) => this.extractExecutivePointsFromFailure(item, 1))
    ).slice(0, 2);

    if (completedPoints.length === 0 && failurePoints.length === 0) {
      return ['📌 结论', '- 暂时没有形成可靠结论。'].join('\n');
    }

    if (completedPoints.length === 0) {
      return [
        '📌 结论',
        `- 当前还不能给出可靠结论，主要问题是${joinAsChineseSeries(failurePoints)}。`,
        '',
        '💡 建议',
        `- 优先处理${joinAsChineseSeries(failurePoints)}。`,
      ].join('\n');
    }

    const sections = [
      '📌 结论',
      `- ${ensureSentenceEnding(completedPoints[0] || '已形成结论')}`,
    ];

    if (completedPoints.length > 1) {
      sections.push('', '📎 要点', ...completedPoints.slice(1).map((item) => `- ${ensureSentenceEnding(item)}`));
    }

    if (failurePoints.length > 0) {
      sections.push('', '⚠️ 风险', ...failurePoints.map((item) => `- ${ensureSentenceEnding(item)}`));
      sections.push('', '💡 建议', `- 优先处理${joinAsChineseSeries(failurePoints)}。`);
    }

    return sections.join('\n');
  }

  private getSingleResultOpinion(summary: IntegratedTaskSummary): string | null {
    if (summary.failedTasks > 0 || summary.results.length !== 1) {
      return null;
    }

    const detail = this.extractTaskResultDetail(summary.results[0]?.result);
    if (!detail) {
      return null;
    }

    const compact = collapseWhitespace(detail.summary);
    if (!compact || compact.length > 120) {
      return null;
    }

    return ensureSentenceEnding(stripOpinionPrefix(compact));
  }

  private extractExecutivePointsFromResult(result: unknown, maxItems: number): string[] {
    const detail = this.extractTaskResultDetail(result);
    if (!detail) {
      return [];
    }

    return extractHighlights(detail.summary, maxItems)
      .map((item) => stripOpinionPrefix(item))
      .map((item) => trimTrailingPunctuation(item))
      .filter(Boolean);
  }

  private extractExecutivePointsFromFailure(
    failure: IntegratedTaskFailureSummary,
    maxItems: number
  ): string[] {
    const detail = this.extractTaskResultDetail(failure.result);
    const detailPoints = detail
      ? extractHighlights(detail.summary, maxItems).map((item) => trimTrailingPunctuation(item))
      : [];

    return [
      trimTrailingPunctuation(stripOpinionPrefix(failure.error)),
      ...detailPoints,
    ].filter(Boolean);
  }

  private async sendTaskCompletionMessages(
    chatId: string,
    workerId: string,
    task: {
      description: string;
      context: Record<string, unknown>;
      result: unknown;
    }
  ): Promise<void> {
    await this.sendMessage(chatId, {
      type: 'task_complete',
      from: workerId,
      content: this.formatTaskCompletionContent(task),
    });

    const expandedContent = this.buildExpandedTaskCompletionContent(task);
    if (!expandedContent) {
      return;
    }

    await this.sendChunkedMessage(chatId, {
      type: 'task_complete',
      from: workerId,
      content: expandedContent,
    });
  }

  private async sendOrchestratorSummaryMessages(
    chatId: string,
    summary: unknown
  ): Promise<void> {
    const formattedContent = this.formatSummary(summary);

    await this.sendMessage(chatId, {
      type: 'task_complete',
      from: 'orchestrator',
      content: formattedContent,
    });

    this.emit('final-summary', {
      chatId,
      summary,
      content: formattedContent,
    });

    if (!this.shouldEmitIntermediateExecutionUpdates()) {
      return;
    }

    const expandedContents = this.buildExpandedSummaryContents(summary);
    for (const content of expandedContents) {
      await this.sendChunkedMessage(chatId, {
        type: 'task_complete',
        from: 'orchestrator',
        content,
      });
    }
  }

  private formatTaskCompletionContent(task: {
    description: string;
    context: Record<string, unknown>;
    result: unknown;
  }): string {
    const sections = [
      '✅ 任务完成',
      '',
      '📝 任务',
      `- ${truncateMessage(task.description, 120)}`,
    ];

    const workspaceRoot =
      typeof task.context.workspaceRoot === 'string' ? task.context.workspaceRoot : '';
    if (workspaceRoot) {
      sections.push('', '📁 项目目录', workspaceRoot);
    }

    const detail = this.formatTaskResultPreview(task.result, {
      maxHighlights: 3,
      includeFiles: true,
      includeVerification: true,
    });

    if (detail) {
      sections.push('', detail);
    }

    return sections.join('\n');
  }

  private buildExpandedTaskCompletionContent(task: {
    description: string;
    context: Record<string, unknown>;
    result: unknown;
  }): string | null {
    const detail = this.extractTaskResultDetail(task.result);
    if (!detail || !this.shouldSendExpandedResult(detail.summary)) {
      return null;
    }

    const sections = [
      '📖 完整结果',
      '',
      '📝 任务',
      `- ${task.description}`,
    ];

    const workspaceRoot =
      typeof task.context.workspaceRoot === 'string' ? task.context.workspaceRoot : '';
    if (workspaceRoot) {
      sections.push('', '📁 项目目录', workspaceRoot);
    }

    sections.push('', '🧾 结果全文', detail.summary);

    if (detail.changedFiles.length > 0) {
      sections.push('', '🛠️ 修改文件', ...detail.changedFiles.map((file) => `- ${file}`));
    }

    if (detail.verification.length > 0) {
      sections.push('', '✅ 验证', ...detail.verification.map((item) => `- ${item}`));
    }

    return sections.join('\n');
  }

  private formatTaskResultPreview(
    result: unknown,
    options: {
      maxHighlights: number;
      includeFiles: boolean;
      includeVerification: boolean;
    }
  ): string | null {
    const detail = this.extractTaskResultDetail(result);
    if (!detail) {
      return null;
    }

    const sections: string[] = [];
    const highlights = extractHighlights(detail.summary, options.maxHighlights);

    if (highlights.length > 0) {
      sections.push(
        '✨ 关键结果',
        ...highlights.map((item) => `- ${item}`)
      );
    }

    if (options.includeFiles && detail.changedFiles.length > 0) {
      sections.push(
        '',
        '🛠️ 修改文件',
        ...detail.changedFiles.slice(0, 4).map((file: string) => `- ${file}`)
      );
    }

    if (options.includeVerification && detail.verification.length > 0) {
      sections.push(
        '',
        '✅ 验证',
        ...detail.verification.slice(0, 3).map((item) => `- ${truncateMessage(item, 90)}`)
      );
    }

    return sections.join('\n').trim() || null;
  }

  private extractTaskResultDetail(result: unknown): {
    summary: string;
    changedFiles: string[];
    verification: string[];
  } | null {
    if (typeof result === 'string') {
      return {
        summary: autoFormatGeneratedText(result),
        changedFiles: [],
        verification: [],
      };
    }

    if (
      typeof result !== 'object' ||
      result === null ||
      !('mode' in result) ||
      (result as { mode?: unknown }).mode !== 'workspace'
    ) {
      return null;
    }

    const workspaceResult = result as {
      mode: unknown;
      summary?: unknown;
      changedFiles?: unknown;
      verification?: unknown;
    };
    const summary = typeof workspaceResult.summary === 'string'
      ? autoFormatGeneratedText(workspaceResult.summary)
      : '已完成本地工作区执行。';
    const changedFiles = Array.isArray(workspaceResult.changedFiles)
      ? (workspaceResult.changedFiles.filter(
          (file): file is string => typeof file === 'string'
        ))
      : [];
    const verification = Array.isArray(workspaceResult.verification)
      ? (workspaceResult.verification.filter(
          (item): item is string => typeof item === 'string'
        ))
      : [];

    return {
      summary,
      changedFiles,
      verification,
    };
  }

  private buildExpandedSummaryContents(summary: unknown): string[] {
    const summaryRecord = this.normalizeIntegratedSummary(summary);
    if (!summaryRecord) {
      return [];
    }

    const expandedResults = summaryRecord.results.flatMap((item, index) => {
      const detail = this.extractTaskResultDetail(item.result);

      if (!detail || !this.shouldSendExpandedResult(detail.summary)) {
        return [];
      }

      const sections = [
        `📖 任务 ${index + 1} 完整结果`,
        '',
        '📝 任务',
        `- ${item.description}`,
        '',
        '🧾 结果全文',
        detail.summary,
      ];

      if (detail.changedFiles.length > 0) {
        sections.push('', '🛠️ 修改文件', ...detail.changedFiles.map((file) => `- ${file}`));
      }

      if (detail.verification.length > 0) {
        sections.push('', '✅ 验证', ...detail.verification.map((itemText) => `- ${itemText}`));
      }

      return [sections.join('\n')];
    });

    const expandedFailures = summaryRecord.failures.flatMap((item, index) => {
      const detail = this.extractTaskResultDetail(item.result);

      if (!detail || !this.shouldSendExpandedResult(detail.summary)) {
        return [];
      }

      const sections = [
        `⚠️ 失败任务 ${index + 1} 详情`,
        '',
        '📝 任务',
        `- ${item.description}`,
        '',
        '❗ 错误',
        `- ${item.error}`,
        '',
        '🧾 结果全文',
        detail.summary,
      ];

      if (detail.changedFiles.length > 0) {
        sections.push('', '🛠️ 修改文件', ...detail.changedFiles.map((file) => `- ${file}`));
      }

      if (detail.verification.length > 0) {
        sections.push('', '✅ 验证', ...detail.verification.map((itemText) => `- ${itemText}`));
      }

      return [sections.join('\n')];
    });

    return [...expandedResults, ...expandedFailures];
  }

  private appendConversationTurn(chatId: string, turn: ConversationTurn): void {
    const turns = this.conversationHistory.get(chatId) || [];
    turns.push(turn);
    this.conversationHistory.set(chatId, turns.slice(-this.maxConversationTurns));
  }

  private getConversationHistory(chatId: string): ConversationTurn[] {
    const turns = this.conversationHistory.get(chatId) || [];
    return turns.map((turn) => ({ ...turn }));
  }

  private async handleCommand(
    chatId: string,
    text: string,
    msg: TelegramBot.Message
  ): Promise<boolean> {
    const command = this.parseCommand(text);

    if (!command) {
      return false;
    }

    if (command.name === 'task') {
      await this.handleTaskCommand(chatId, command.argument, msg);
      return true;
    }

    if (command.name === 'project') {
      await this.handleProjectCommand(chatId, command.argument);
      return true;
    }

    if (command.name === 'queue') {
      await this.handleQueueCommand(chatId, command.argument);
      return true;
    }

    if (command.name === 'logs') {
      await this.handleLogsCommand(chatId, command.argument);
      return true;
    }

    if (command.name === 'cancel') {
      await this.handleCancelCommand(chatId);
      return true;
    }

    if (command.name === 'projects') {
      await this.handleProjectsCommand(chatId);
      return true;
    }

    if (command.name === 'pwd') {
      await this.handlePwdCommand(chatId);
      return true;
    }

    if (command.name === 'status') {
      await this.handleStatusCommand(chatId);
      return true;
    }

    if (command.name === 'workers') {
      await this.handleWorkersCommand(chatId);
      return true;
    }

    if (command.name === 'reset') {
      await this.handleResetCommand(chatId);
      return true;
    }

    if (command.name === 'help' || command.name === 'start') {
      await this.handleHelpCommand(chatId);
      return true;
    }

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: `暂不支持命令 /${command.name}。\n\n${this.formatCommandHelp()}`,
    });
    return true;
  }

  private parseCommand(text: string): { name: string; argument: string } | null {
    if (!text.startsWith('/')) {
      return null;
    }

    const match = text.match(/^\/([^\s@]+)(?:@\S+)?(?:\s+([\s\S]+))?$/);
    if (!match?.[1]) {
      return null;
    }

    return {
      name: match[1].toLowerCase(),
      argument: (match[2] || '').trim(),
    };
  }

  private async handleTaskCommand(
    chatId: string,
    argument: string,
    msg: TelegramBot.Message
  ): Promise<void> {
    if (!argument) {
      await this.sendMessage(chatId, {
        type: 'question',
        from: 'orchestrator',
        content: [
          '用法',
          '/task <任务描述>',
          '',
          '示例',
          '- /task 检查 01md 文件并总结内容',
          '- /task 修复登录页样式并补一条验证命令',
        ].join('\n'),
      });
      return;
    }

    await this.submitUserTask(chatId, argument, msg);
  }

  private async handleQueueCommand(chatId: string, argument: string): Promise<void> {
    const limit = this.parsePositiveInteger(argument) || 5;
    const snapshot = await this.config.orchestrator.getQueueSnapshot(limit);
    const activeExecution = this.chatExecutionStates.get(chatId);

    const sections = [
      '任务队列',
      '',
      '概况',
      `- 总数: ${snapshot.stats.total}`,
      `- 待执行: ${snapshot.stats.pending}`,
      `- 运行中: ${snapshot.stats.running}`,
      `- 已完成: ${snapshot.stats.completed}`,
      `- 失败: ${snapshot.stats.failed}`,
    ];

    if (activeExecution) {
      sections.push(
        '',
        '当前聊天任务',
        `- ${truncateMessage(activeExecution.description, 80)}`,
        `- 任务 ID: ${activeExecution.taskId}`,
        `- 状态: ${activeExecution.cancelRequested ? '中断中' : '执行中'}`
      );
    }

    if (snapshot.runningTasks.length > 0) {
      sections.push(
        '',
        '运行中任务',
        ...snapshot.runningTasks.map((task) =>
          `- ${task.id}: ${truncateMessage(task.description, 72)}${task.assignedTo ? ` (${task.assignedTo})` : ''}`
        )
      );
    }

    if (snapshot.pendingTasks.length > 0) {
      sections.push(
        '',
        '待执行任务',
        ...snapshot.pendingTasks.map((task) =>
          `- ${task.id}: ${truncateMessage(task.description, 72)}`
        )
      );
    }

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: sections.join('\n'),
    });
  }

  private async handleLogsCommand(chatId: string, argument: string): Promise<void> {
    const limit = this.parsePositiveInteger(argument) || 12;
    const logs = this.getLifecycleLogs(chatId, limit);

    if (logs.length === 0) {
      await this.sendMessage(chatId, {
        type: 'question',
        from: 'orchestrator',
        content: '最近还没有可展示的任务日志。\n先发送 /task <任务描述> 或普通消息开始一轮任务。',
      });
      return;
    }

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: [
        `最近日志（近 ${logs.length} 条）`,
        '',
        ...logs.map((entry) => {
          const time = entry.timestamp.slice(11, 19);
          const label = entry.source === 'user' ? '用户' : entry.source === 'assistant' ? '系统' : '状态';
          return `[${time}] ${label}\n${truncateMessage(entry.content, 240)}`;
        }),
      ].join('\n\n'),
    });
  }

  private async handleCancelCommand(chatId: string): Promise<void> {
    const executionState = this.chatExecutionStates.get(chatId);

    if (!executionState) {
      await this.sendMessage(chatId, {
        type: 'question',
        from: 'orchestrator',
        content: '当前聊天没有正在处理的任务，无需取消。',
      });
      return;
    }

    if (executionState.cancelRequested) {
      await this.sendMessage(chatId, {
        type: 'question',
        from: 'orchestrator',
        content: `任务 ${executionState.taskId} 已经在取消中，请等待当前执行阶段结束。`,
      });
      return;
    }

    executionState.cancelRequested = true;

    const cancelled = await this.config.orchestrator.cancelTaskTree(
      executionState.taskId,
      '任务已被 Telegram 用户取消'
    );

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: [
        `已收到中断请求: ${executionState.taskId}`,
        '',
        `- 已取消待执行任务: ${cancelled.cancelledPendingCount}`,
        `- 运行中任务总数: ${cancelled.runningCount}`,
        `- 已发送中断信号: ${cancelled.interruptedRunningCount}`,
        '- 说明: 正在运行的小弟会尽快在当前可中断点停下，系统不会再继续调度新的任务。',
      ].join('\n'),
    });
  }

  private async handleProjectCommand(chatId: string, argument: string): Promise<void> {
    if (!argument) {
      const currentWorkspace = this.getWorkspaceRoot(chatId);
      await this.sendMessage(chatId, {
        type: 'question',
        from: 'orchestrator',
        content: currentWorkspace
          ? `当前项目目录\n${currentWorkspace}\n\n可发送 /projects 查看可切换项目。`
          : '当前还没有绑定项目目录。\n发送 /project <项目名或路径> 来切换项目，或发送 /projects 查看可切换项目。',
      });
      return;
    }

    const resolution = await this.resolveWorkspaceArgument(chatId, argument);
    if (!resolution.ok) {
      await this.sendMessage(chatId, {
        type: 'error_report',
        from: 'orchestrator',
        content: resolution.message,
      });
      return;
    }

    const resolvedWorkspace = resolution.workspaceRoot;

    try {
      const stats = await fs.stat(resolvedWorkspace);
      if (!stats.isDirectory()) {
        throw new Error('目标路径不是目录');
      }
    } catch (error) {
      await this.sendMessage(chatId, {
        type: 'error_report',
        from: 'orchestrator',
        content: `切换项目失败\n- 原因: ${error instanceof Error ? error.message : String(error)}\n- 路径: ${resolvedWorkspace}`,
      });
      return;
    }

    this.chatWorkspaceRoots.set(chatId, resolvedWorkspace);

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: [
        '已切换项目目录',
        resolvedWorkspace,
        '',
        resolution.matchType === 'project'
          ? `匹配方式: 项目名 ${resolution.matchedProjectName || path.basename(resolvedWorkspace)}`
          : '匹配方式: 路径',
        '',
        '之后这个聊天里的开发任务都会在这个目录执行。',
      ].join('\n'),
    });
  }

  private async handleProjectsCommand(chatId: string): Promise<void> {
    const projects = await this.discoverProjects();

    if (projects.length === 0) {
      await this.sendMessage(chatId, {
        type: 'question',
        from: 'orchestrator',
        content:
          '当前没有发现可切换项目。\n你可以直接发送 /project 绝对路径，或者在配置里补充 projectSearchRoots。',
      });
      return;
    }

    const currentWorkspace = this.getWorkspaceRoot(chatId);
    const lines = projects.slice(0, 20).map((project) => {
      const marker = currentWorkspace === project.workspaceRoot ? ' (当前)' : '';
      return `- ${project.name}${marker}\n  ${project.workspaceRoot}`;
    });

    if (projects.length > 20) {
      lines.push(`- 其余 ${projects.length - 20} 个项目已省略，请输入更具体的 /project 项目名`);
    }

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: [
        '可切换项目',
        '',
        ...lines,
        '',
        '用法',
        '- /project <项目名>',
        '- /project <绝对路径或相对路径>',
      ].join('\n'),
    });
  }

  private async handlePwdCommand(chatId: string): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot(chatId);

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: workspaceRoot
        ? `当前项目目录\n${workspaceRoot}`
        : '当前还没有绑定项目目录。\n发送 /project <项目名或路径> 来切换项目。',
    });
  }

  private async handleStatusCommand(chatId: string): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot(chatId);
    const conversationTurns = this.getConversationHistory(chatId);
    const workerStats = this.getWorkerStatusSummary();
    const activeExecution = this.chatExecutionStates.get(chatId);

    const sections = [
      '当前状态',
      '',
      '项目目录',
      workspaceRoot || '当前未绑定项目目录',
      '',
      '会话',
      `- 已记录上下文轮数: ${conversationTurns.length}`,
    ];

    if (activeExecution) {
      sections.push(
        '',
        '当前聊天任务',
        `- ${truncateMessage(activeExecution.description, 80)}`,
        `- 任务 ID: ${activeExecution.taskId}`,
        `- 状态: ${activeExecution.cancelRequested ? '中断中' : '执行中'}`
      );
    }

    sections.push(
      '',
      '小弟',
      `- 总数: ${workerStats.total}`,
      `- 空闲: ${workerStats.idle}`,
      `- 忙碌: ${workerStats.busy}`
    );

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: sections.join('\n'),
    });
  }

  private async handleWorkersCommand(chatId: string): Promise<void> {
    const workers = this.config.workers;
    const lines = workers.map((worker) => {
      const status = this.formatWorkerStatus(worker.status);
      const currentTask = worker.currentTaskId ? `，任务 ${worker.currentTaskId}` : '';
      return `- ${worker.id}: ${status}${currentTask}`;
    });

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: [
        '小弟状态',
        '',
        ...(lines.length > 0 ? lines : ['- 当前没有可用小弟']),
      ].join('\n'),
    });
  }

  private async handleResetCommand(chatId: string): Promise<void> {
    this.chatWorkspaceRoots.delete(chatId);
    this.chatExecutionStates.delete(chatId);
    this.chatLifecycleLogs.delete(chatId);
    this.conversationHistory.delete(chatId);
    this.clearChatWorkerProgress(chatId);

    const fallbackWorkspace = this.getWorkspaceRoot(chatId);
    const workspaceMessage = fallbackWorkspace
      ? `已恢复为默认项目目录\n${fallbackWorkspace}`
      : '当前聊天已清空项目绑定，需要重新发送 /project <路径>。';

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: `已重置当前聊天上下文\n\n${workspaceMessage}`,
    });
  }

  private async handleHelpCommand(chatId: string): Promise<void> {
    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: this.formatCommandHelp(),
    });
  }

  private async resolveWorkspaceArgument(
    chatId: string,
    argument: string
  ): Promise<
    | {
        ok: true;
        workspaceRoot: string;
        matchType: 'project' | 'path';
        matchedProjectName?: string;
      }
    | {
        ok: false;
        message: string;
      }
  > {
    const trimmed = argument.trim().replace(/^["']|["']$/g, '');
    if (path.isAbsolute(trimmed)) {
      return {
        ok: true,
        workspaceRoot: path.normalize(trimmed),
        matchType: 'path',
      };
    }

    if (!trimmed) {
      return {
        ok: false,
        message: '切换项目失败\n- 原因: 项目名或路径不能为空',
      };
    }

    if (!this.looksLikePathArgument(trimmed)) {
      const projectMatch = await this.matchProjectByName(trimmed);
      if (projectMatch.type === 'matched') {
        return {
          ok: true,
          workspaceRoot: projectMatch.project.workspaceRoot,
          matchType: 'project',
          matchedProjectName: projectMatch.project.name,
        };
      }

      if (projectMatch.type === 'ambiguous') {
        return {
          ok: false,
          message: [
            `切换项目失败`,
            `- 原因: 找到多个匹配项目 "${trimmed}"，请改用更完整的项目名或直接发送路径`,
            ...projectMatch.projects.map(
              (project) => `- ${project.name}: ${project.workspaceRoot}`
            ),
          ].join('\n'),
        };
      }
    }

    const basePath = this.getWorkspaceRoot(chatId) || this.config.defaultWorkspaceRoot || process.cwd();
    return {
      ok: true,
      workspaceRoot: path.resolve(basePath, trimmed),
      matchType: 'path',
    };
  }

  private getWorkspaceRoot(chatId: string): string | undefined {
    return this.chatWorkspaceRoots.get(chatId) || this.config.defaultWorkspaceRoot;
  }

  private async handleDirectConversation(
    chatId: string,
    userInput: string,
    msg: TelegramBot.Message
  ): Promise<boolean> {
    const reply = buildDirectConversationReply(userInput);
    if (!reply) {
      return false;
    }

    this.appendLifecycleLog(chatId, 'user', userInput);
    this.appendConversationTurn(chatId, {
      role: 'user',
      sender: this.getSenderName(msg),
      content: userInput,
      timestamp: this.getMessageTimestamp(msg),
    });

    this.appendLifecycleLog(chatId, 'assistant', reply);
    this.appendConversationTurn(chatId, {
      role: 'assistant',
      sender: 'orchestrator',
      content: reply,
      timestamp: new Date().toISOString(),
    });

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content: reply,
    });

    return true;
  }

  private async submitUserTask(
    chatId: string,
    userInput: string,
    msg: TelegramBot.Message
  ): Promise<void> {
    const normalizedInput = userInput.trim();
    if (!normalizedInput) {
      return;
    }

    const workspaceRoot = this.getWorkspaceRoot(chatId);

    this.appendLifecycleLog(chatId, 'user', normalizedInput);
    this.appendConversationTurn(chatId, {
      role: 'user',
      sender: this.getSenderName(msg),
      content: normalizedInput,
      timestamp: this.getMessageTimestamp(msg),
    });

    this.emit('user-message', {
      message: normalizedInput,
      chatId,
      userId: msg.from?.id,
    });

    try {
      const task = await this.config.orchestrator.receiveTask(normalizedInput, {
        chatId,
        userId: msg.from?.id,
        userName: this.getSenderName(msg),
        workspaceRoot,
        conversationHistory: this.getConversationHistory(chatId),
      });

      this.chatExecutionStates.set(chatId, {
        taskId: task.id,
        description: normalizedInput,
        workspaceRoot,
        startedAt: new Date().toISOString(),
        cancelRequested: false,
      });

      await this.sendMessage(chatId, {
        type: 'user_request',
        from: 'orchestrator',
        content: this.formatTaskAcceptedContent(task.id, normalizedInput, workspaceRoot),
      });

      if (this.shouldEmitIntermediateExecutionUpdates()) {
        await this.sendWorkflowStageUpdate(chatId, '分析中', [
          '正在评估任务难度和拆分方式',
          workspaceRoot ? `项目目录: ${workspaceRoot}` : '项目目录: 未绑定，使用默认工作区',
        ]);
      }

      void this.processUserRequest(chatId, task);
    } catch (error) {
      await this.sendMessage(chatId, {
        type: 'error_report',
        from: 'orchestrator',
        content: `❌ 错误: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private formatTaskAcceptedContent(
    taskId: string,
    userInput: string,
    workspaceRoot: string | undefined
  ): string {
    return [
      `📥 任务已接收: ${taskId}`,
      '',
      '📝 需求',
      `- ${truncateMessage(userInput, 120)}`,
      '',
      '📁 项目目录',
      workspaceRoot || '未绑定，使用默认工作区',
      '',
      '⏳ 状态',
      '- 已转为后台静默运行，过程消息默认省略',
      '- 如需实时打断，发送 /cancel',
    ].join('\n');
  }

  private async sendWorkflowStageUpdate(
    chatId: string,
    stage: string,
    lines: Array<string | undefined>
  ): Promise<void> {
    const contentLines = [stage, '', ...lines.filter((line): line is string => Boolean(line)).map((line) => `- ${line}`)];

    await this.sendMessage(chatId, {
      type: 'progress_update',
      from: 'orchestrator',
      content: contentLines.join('\n'),
    });
  }

  private async sendCancellationSummary(
    chatId: string,
    taskId: string,
    cancelled: {
      rootTaskFound: boolean;
      cancelledPendingCount: number;
      runningCount: number;
      interruptedRunningCount: number;
    }
  ): Promise<void> {
    const content = cancelled.rootTaskFound
      ? [
          `任务 ${taskId} 已停止继续调度`,
          '',
          `- 已取消待执行任务: ${cancelled.cancelledPendingCount}`,
          `- 运行中任务总数: ${cancelled.runningCount}`,
          `- 已发送中断信号: ${cancelled.interruptedRunningCount}`,
          '- 说明: 收到中断信号的小弟会尽快在当前可中断点停止，系统也不会再继续安排新的子任务。',
        ].join('\n')
      : `任务 ${taskId} 未找到，可能已经结束。`;

    await this.sendMessage(chatId, {
      type: 'question',
      from: 'orchestrator',
      content,
    });
  }

  private appendLifecycleLog(
    chatId: string,
    source: TaskLifecycleLogEntry['source'],
    content: string
  ): void {
    const existing = this.chatLifecycleLogs.get(chatId) || [];
    existing.push({
      timestamp: new Date().toISOString(),
      source,
      content,
    });
    this.chatLifecycleLogs.set(chatId, existing.slice(-MAX_CHAT_LOG_ENTRIES));
  }

  private getLifecycleLogs(chatId: string, limit: number): TaskLifecycleLogEntry[] {
    const logs = this.chatLifecycleLogs.get(chatId) || [];
    return logs.slice(-Math.max(1, limit));
  }

  private parsePositiveInteger(argument: string): number | null {
    if (!argument.trim()) {
      return null;
    }

    const parsed = Number(argument.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    return Math.floor(parsed);
  }

  private normalizeProjectSearchRoots(
    projectSearchRoots: string[] | undefined,
    defaultWorkspaceRoot: string | undefined
  ): string[] {
    const normalized = new Set<string>();

    if (defaultWorkspaceRoot) {
      normalized.add(path.resolve(path.dirname(defaultWorkspaceRoot)));
    }

    for (const root of projectSearchRoots || []) {
      if (!root.trim()) {
        continue;
      }

      normalized.add(path.resolve(root));
    }

    return Array.from(normalized);
  }

  private looksLikePathArgument(argument: string): boolean {
    return argument.startsWith('.') || /[\\/]/.test(argument);
  }

  private async discoverProjects(): Promise<Array<{ name: string; workspaceRoot: string }>> {
    const byPath = new Map<string, { name: string; workspaceRoot: string }>();
    const defaultWorkspaceRoot = this.config.defaultWorkspaceRoot;

    if (defaultWorkspaceRoot) {
      const normalizedWorkspaceRoot = path.resolve(defaultWorkspaceRoot);
      byPath.set(normalizedWorkspaceRoot, {
        name: path.basename(normalizedWorkspaceRoot),
        workspaceRoot: normalizedWorkspaceRoot,
      });
    }

    for (const searchRoot of this.config.projectSearchRoots) {
      try {
        const entries = await fs.readdir(searchRoot, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
          }

          const workspaceRoot = path.resolve(searchRoot, entry.name);
          byPath.set(workspaceRoot, {
            name: entry.name,
            workspaceRoot,
          });
        }
      } catch {
        // 忽略不存在或无权限的搜索目录，避免影响主流程
      }
    }

    return Array.from(byPath.values()).sort((left, right) => {
      const nameComparison = left.name.localeCompare(right.name, 'zh-CN');
      if (nameComparison !== 0) {
        return nameComparison;
      }

      return left.workspaceRoot.localeCompare(right.workspaceRoot, 'zh-CN');
    });
  }

  private async matchProjectByName(
    rawName: string
  ): Promise<
    | { type: 'matched'; project: { name: string; workspaceRoot: string } }
    | { type: 'ambiguous'; projects: Array<{ name: string; workspaceRoot: string }> }
    | { type: 'not_found' }
  > {
    const normalizedName = rawName.trim().toLowerCase();
    if (!normalizedName) {
      return { type: 'not_found' };
    }

    const projects = await this.discoverProjects();
    const exactMatches = projects.filter(
      (project) => project.name.trim().toLowerCase() === normalizedName
    );

    if (exactMatches.length === 1) {
      const [project] = exactMatches;
      if (!project) {
        return { type: 'not_found' };
      }

      return {
        type: 'matched',
        project,
      };
    }

    if (exactMatches.length > 1) {
      return {
        type: 'ambiguous',
        projects: exactMatches,
      };
    }

    const fuzzyMatches = projects.filter((project) =>
      project.name.trim().toLowerCase().includes(normalizedName)
    );

    if (fuzzyMatches.length === 1) {
      const [project] = fuzzyMatches;
      if (!project) {
        return { type: 'not_found' };
      }

      return {
        type: 'matched',
        project,
      };
    }

    if (fuzzyMatches.length > 1) {
      return {
        type: 'ambiguous',
        projects: fuzzyMatches.slice(0, 5),
      };
    }

    return { type: 'not_found' };
  }

  private getWorkerStatusSummary(): {
    total: number;
    idle: number;
    busy: number;
  } {
    const total = this.config.workers.length;
    const idle = this.config.workers.filter((worker) => worker.status === 'idle').length;
    const busy = this.config.workers.filter((worker) => worker.status === 'busy').length;

    return {
      total,
      idle,
      busy,
    };
  }

  private formatWorkerStatus(status: string | undefined): string {
    if (status === 'busy') {
      return '忙碌';
    }

    if (status === 'error') {
      return '异常';
    }

    return '空闲';
  }

  private shouldSendExpandedResult(summary: string): boolean {
    const normalized = summary.trim();
    return normalized.length > 180 || normalized.includes('\n');
  }

  private getSenderName(msg: TelegramBot.Message): string {
    const firstName = msg.from?.first_name?.trim();
    const lastName = msg.from?.last_name?.trim();
    const username = msg.from?.username?.trim();
    return [firstName, lastName].filter(Boolean).join(' ') || username || '用户';
  }

  private getMessageTimestamp(msg: TelegramBot.Message): string {
    if (!msg.date) {
      return new Date().toISOString();
    }

    return new Date(msg.date * 1000).toISOString();
  }

  private getTaskExecutionPlan(task: { context: Record<string, unknown> }): TaskExecutionPlan | null {
    const plan = task.context.executionPlan;

    if (typeof plan !== 'object' || plan === null) {
      return null;
    }

    const difficulty = (plan as { difficulty?: unknown }).difficulty;
    const recommendedWorkers = (plan as { recommendedWorkers?: unknown }).recommendedWorkers;
    const rationale = (plan as { rationale?: unknown }).rationale;

    if (
      (difficulty !== 'simple' && difficulty !== 'medium' && difficulty !== 'complex') ||
      typeof recommendedWorkers !== 'number' ||
      typeof rationale !== 'string'
    ) {
      return null;
    }

    return {
      difficulty,
      recommendedWorkers,
      rationale,
    };
  }

  private resolveRecommendedWorkers(
    task: { context: Record<string, unknown> },
    executableTaskCount: number
  ): number {
    const plan = this.getTaskExecutionPlan(task);

    if (!plan) {
      return Math.max(1, executableTaskCount);
    }

    return Math.max(1, Math.min(executableTaskCount, Math.floor(plan.recommendedWorkers)));
  }

  private formatDifficulty(difficulty: TaskDifficulty): string {
    if (difficulty === 'complex') {
      return '复杂';
    }

    if (difficulty === 'medium') {
      return '中等';
    }

    return '简单';
  }

  private describeError(error: unknown): {
    code?: string;
    message: string;
    cause?: string;
  } {
    if (error instanceof Error) {
      const errorWithCode = error as Error & { code?: string; cause?: unknown };
      return {
        code: errorWithCode.code,
        message: error.message,
        cause: this.describeCause(errorWithCode.cause),
      };
    }

    return {
      message: String(error),
    };
  }

  private describeCause(cause: unknown): string | undefined {
    if (cause instanceof Error) {
      return cause.message;
    }

    if (cause === undefined || cause === null) {
      return undefined;
    }

    return String(cause);
  }

  private shouldSendWorkerProgress(
    chatId: string,
    workerId: string,
    progress: number,
    message: string
  ): boolean {
    const key = `${chatId}:${workerId}`;
    const signature = `${progress}:${message.trim()}`;
    if (this.lastWorkerProgress.get(key) === signature) {
      return false;
    }

    this.lastWorkerProgress.set(key, signature);
    return true;
  }

  private clearWorkerProgress(chatId: string, workerId: string): void {
    this.lastWorkerProgress.delete(`${chatId}:${workerId}`);
  }

  private clearChatWorkerProgress(chatId: string): void {
    for (const key of this.lastWorkerProgress.keys()) {
      if (key.startsWith(`${chatId}:`)) {
        this.lastWorkerProgress.delete(key);
      }
    }
  }

  private resolveTaskChatId(task: { context: Record<string, unknown> } | null | undefined): string | undefined {
    const contextChatId = task?.context?.chatId;
    if (typeof contextChatId === 'string' && contextChatId.trim().length > 0) {
      return contextChatId.trim();
    }

    return this.config.chatId;
  }

  private resolveProgressChatId(event: WorkerProgressEvent): string | undefined {
    if (typeof event.chatId === 'string' && event.chatId.trim().length > 0) {
      return event.chatId.trim();
    }

    return this.config.chatId;
  }

  private attachWorkerEventListeners(worker: Worker): void {
    if (this.attachedWorkerListeners.has(worker.id)) {
      return;
    }

    this.attachedWorkerListeners.add(worker.id);

    worker.on('progress', async (event) => {
      if (!this.shouldEmitIntermediateExecutionUpdates()) {
        return;
      }

      const chatId = this.resolveProgressChatId(event);
      if (
        chatId &&
        event.progress >= 0 &&
        !(event.progress >= 100 && event.message === '任务完成') &&
        this.shouldSendWorkerProgress(chatId, worker.id, event.progress, event.message)
      ) {
        await this.sendProgressUpdate(
          chatId,
          worker.id,
          event.progress,
          event.message
        );
      }
    });

    worker.on('task-completed', async (task) => {
      if (!this.shouldEmitIntermediateExecutionUpdates()) {
        return;
      }

      const chatId = this.resolveTaskChatId(task);
      if (chatId) {
        this.clearWorkerProgress(chatId, worker.id);
        await this.sendTaskCompletionMessages(chatId, worker.id, task);
      }
    });

    worker.on('task-cancelled', async (task, error) => {
      if (!this.shouldEmitIntermediateExecutionUpdates()) {
        return;
      }

      const chatId = this.resolveTaskChatId(task);
      if (chatId) {
        this.clearWorkerProgress(chatId, worker.id);
        await this.sendMessage(chatId, {
          type: 'question',
          from: worker.id,
          content: `任务已中断: ${task.description}\n\n原因: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });

    worker.on('task-failed', async (task, error) => {
      if (!this.shouldEmitIntermediateExecutionUpdates()) {
        return;
      }

      const chatId = this.resolveTaskChatId(task);
      if (chatId) {
        this.clearWorkerProgress(chatId, worker.id);
        await this.sendMessage(chatId, {
          type: 'error_report',
          from: worker.id,
          content: `❌ 任务失败: ${task.description}\n\n错误: ${error}`,
        });
      }
    });
  }

  private shouldEmitIntermediateExecutionUpdates(): boolean {
    return this.config.executionUpdatesMode === 'verbose';
  }

  private formatCommandHelp(): string {
    return [
      '可用命令',
      '',
      '/task <任务描述>',
      '- 提交明确开发任务并进入执行流程',
      '',
      '/project <项目名或路径>',
      '- 切换当前聊天的项目目录',
      '',
      '/projects',
      '- 列出当前可切换项目',
      '',
      '/pwd',
      '- 查看当前项目目录',
      '',
      '/queue [数量]',
      '- 查看当前任务队列和运行中任务',
      '',
      '/logs [数量]',
      '- 查看最近任务日志',
      '',
      '/cancel',
      '- 实时中断当前聊天任务',
      '',
      '/status',
      '- 查看当前项目目录、上下文轮数和小弟运行状态',
      '',
      '/workers',
      '- 查看所有小弟当前是否空闲',
      '',
      '/reset',
      '- 清空当前聊天的项目绑定和上下文',
      '',
      '/help',
      '- 查看命令帮助',
    ].join('\n');
  }

  private getPollingErrorHint(details: {
    code?: string;
    message: string;
    cause?: string;
  }): string | undefined {
    const combined = buildTelegramErrorFingerprint(details);

    if (combined.includes('409 conflict') || combined.includes('terminated by other getupdates request')) {
      return '同一个 Telegram Bot Token 同时只能有一个 polling 实例在运行，请关闭其他进程后再重试。';
    }

    if (isRetryableTelegramNetworkFailure(details)) {
      return 'Telegram 连接被网络或代理中断了，优先检查 TELEGRAM_PROXY_URL、代理软件状态和当前网络，再等待自动重试。';
    }

    return undefined;
  }

  private isConflictError(details: {
    code?: string;
    message: string;
    cause?: string;
  }): boolean {
    const combined = `${details.code || ''} ${details.message} ${details.cause || ''}`.toLowerCase();
    return combined.includes('409 conflict') || combined.includes('terminated by other getupdates request');
  }

  private async stopPollingForConflict(): Promise<void> {
    try {
      await this.bot.stopPolling({
        cancel: true,
        reason: '409 conflict',
      });
    } catch {
      // 忽略 stopPolling 期间的二次错误，避免覆盖原始冲突原因
    }
  }

  private async safeBotSendMessage(chatId: string, text: string): Promise<boolean> {
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.bot.sendMessage(chatId, text);
        return true;
      } catch (error) {
        const details = this.describeError(error);
        const retryable = this.isRetryableTelegramNetworkError(error, details);

        if (!retryable || attempt >= maxAttempts) {
          console.error('telegram sendMessage error', {
            ...details,
            retryable,
            attempt,
          });
          return false;
        }

        console.error('telegram sendMessage retry', {
          ...details,
          attempt,
          nextRetryInMs: getTelegramRetryDelayMs(attempt),
        });
        await delay(getTelegramRetryDelayMs(attempt));
      }
    }

    return false;
  }

  private async sendChunkedMessage(chatId: string, message: TelegramMessage): Promise<void> {
    const chunks = splitTelegramMessageContent(message.content, TELEGRAM_MESSAGE_CONTENT_LIMIT);

    if (chunks.length <= 1) {
      await this.sendMessage(chatId, message);
      return;
    }

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      if (!chunk) {
        continue;
      }

      await this.sendMessage(chatId, {
        ...message,
        content: `完整结果 ${index + 1}/${chunks.length}\n\n${chunk}`,
      });
    }
  }

  private isRetryableTelegramNetworkError(
    error: unknown,
    details?: {
      code?: string;
      message: string;
      cause?: string;
    }
  ): boolean {
    return isRetryableTelegramNetworkFailure(details || this.describeError(error));
  }
}

function buildDirectConversationReply(input: string): string | null {
  const normalized = normalizeConversationInput(input);

  if (isGreetingMessage(normalized)) {
    return '你好，我在。直接发开发任务给我，或用 /help 查看命令。';
  }

  if (isThanksMessage(normalized)) {
    return '不客气，继续发任务就行。';
  }

  if (isAcknowledgementMessage(normalized)) {
    return '好，随时把任务发给我。';
  }

  return null;
}

function normalizeSummaryCount(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }

  return Math.max(0, fallback);
}

function deduplicateStrings(items: string[]): string[] {
  const unique: string[] = [];

  for (const item of items) {
    if (!item || unique.includes(item)) {
      continue;
    }
    unique.push(item);
  }

  return unique;
}

function normalizeFinalOpinionBlock(content: string): string {
  const lines = content
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return '📌 结论\n- 任务已处理完成。';
  }

  const sections: string[] = [];
  let hasHeading = false;

  for (const line of lines) {
    if (/^(📌|📎|💡|⚠️)\s*/u.test(line)) {
      if (sections.length > 0 && sections[sections.length - 1] !== '') {
        sections.push('');
      }
      sections.push(line.replace(/[:：]\s*$/u, ''));
      hasHeading = true;
      continue;
    }

    const cleaned = line
      .replace(/^[-*+•]\s*/u, '')
      .replace(/^\d+[.)、]\s*/u, '')
      .trim();

    if (!hasHeading) {
      sections.push('📌 结论');
      hasHeading = true;
    }

    sections.push(`- ${ensureSentenceEnding(stripOpinionPrefix(cleaned))}`);
  }

  return sections.join('\n');
}

function collapseWhitespace(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function stripOpinionPrefix(content: string): string {
  return content
    .replace(/^(🎯\s*)?最终意见[:：]\s*/u, '')
    .replace(/^(📌\s*)?(总结|结论|建议)[:：]\s*/u, '')
    .trim();
}

function trimTrailingPunctuation(content: string): string {
  return content.replace(/[。！？；;，,\s]+$/g, '').trim();
}

function ensureSentenceEnding(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return trimmed;
  }

  return /[。！？!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

function joinAsChineseSeries(items: string[]): string {
  if (items.length === 0) {
    return '';
  }

  if (items.length === 1) {
    return items[0] || '';
  }

  if (items.length === 2) {
    return `${items[0]}，以及${items[1]}`;
  }

  return `${items.slice(0, -1).join('，')}，以及${items[items.length - 1]}`;
}

function autoFormatGeneratedText(content: string): string {
  const normalized = content.replace(/\r/g, '').trim();
  if (!normalized) {
    return normalized;
  }

  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return normalized;
  }

  const title = shouldPreserveAsTitle(lines) ? lines[0] || '' : '';
  const bodyLines = title ? lines.slice(1) : lines;
  const body = bodyLines.join('\n').trim();

  if (!body) {
    return title || normalized;
  }

  const formattedBody = looksStructuredText(body)
    ? normalizeStructuredText(body)
    : formatProseText(body);

  if (!title) {
    return formattedBody;
  }

  return `${title}\n\n${formattedBody}`.trim();
}

function shouldPreserveAsTitle(lines: string[]): boolean {
  if (lines.length < 2) {
    return false;
  }

  const firstLine = lines[0] || '';
  const secondLine = lines[1] || '';

  return (
    firstLine.length > 0 &&
    firstLine.length <= 24 &&
    !/[。！？!?；;:：]/.test(firstLine) &&
    secondLine.length >= 20
  );
}

function looksStructuredText(content: string): boolean {
  if (content.includes('```')) {
    return true;
  }

  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const structuredLineCount = lines.filter((line) => (
    /^#{1,6}\s/.test(line) ||
    /^[-*+]\s/.test(line) ||
    /^\d+[.)、]\s/.test(line) ||
    /^>\s/.test(line) ||
    /^\|.*\|$/.test(line)
  )).length;

  if (structuredLineCount >= 2) {
    return true;
  }

  const shortLineCount = lines.filter((line) => line.length <= 20).length;
  return lines.length >= 4 && shortLineCount >= Math.ceil(lines.length * 0.6);
}

function normalizeStructuredText(content: string): string {
  if (content.includes('```')) {
    return content
      .split(/\n{2,}/)
      .map((block) => block
        .split('\n')
        .map((line) => line.trimEnd())
        .join('\n')
        .trim())
      .filter(Boolean)
      .join('\n\n');
  }

  const lines = content.replace(/\r/g, '').split('\n');
  const trimmedLines = lines.map((line) => line.trim()).filter(Boolean);
  const hasHeading = trimmedLines.some((line) => isStructuredHeadingLine(line));
  const normalizedLines: string[] = [];
  let overviewDecorated = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] !== '') {
        normalizedLines.push('');
      }
      continue;
    }

    if (isStructuredHeadingLine(line)) {
      if (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] !== '') {
        normalizedLines.push('');
      }
      normalizedLines.push(formatStructuredHeadingLine(line));
      continue;
    }

    if (!overviewDecorated && hasHeading && !isStructuredBulletLine(line)) {
      normalizedLines.push(`📌 ${line}`);
      overviewDecorated = true;
      continue;
    }

    if (isStructuredBulletLine(line)) {
      normalizedLines.push(formatStructuredBulletLine(line));
      continue;
    }

    normalizedLines.push(line);
  }

  return normalizedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatProseText(content: string): string {
  const compact = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([，。！？；：、])/g, '$1')
    .replace(/([“‘（【《])\s+/g, '$1')
    .replace(/\s+([”’）】》])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (compact.length <= 120) {
    return compact;
  }

  const sentences = splitIntoSentences(compact);
  if (sentences.length <= 1) {
    return wrapParagraphByLength(compact, 120).join('\n\n');
  }

  const paragraphs: string[] = [];
  let current = '';
  let sentenceCount = 0;

  for (const sentence of sentences) {
    const piece = sentence.trim();
    if (!piece) {
      continue;
    }

    current += piece;
    sentenceCount += 1;

    if (current.length >= 120 || sentenceCount >= 3) {
      paragraphs.push(current.trim());
      current = '';
      sentenceCount = 0;
    }
  }

  if (current) {
    paragraphs.push(current.trim());
  }

  return paragraphs.join('\n\n');
}

function splitIntoSentences(content: string): string[] {
  const matches = content.match(/[^。！？!?；;]+[。！？!?；;”’"]*|[^。！？!?；;]+$/g);
  return matches?.map((item) => item.trim()).filter(Boolean) || [content];
}

function wrapParagraphByLength(content: string, maxLength: number): string[] {
  const paragraphs: string[] = [];
  let remaining = content.trim();

  while (remaining.length > maxLength) {
    paragraphs.push(remaining.slice(0, maxLength).trim());
    remaining = remaining.slice(maxLength).trim();
  }

  if (remaining) {
    paragraphs.push(remaining);
  }

  return paragraphs;
}

function isStructuredHeadingLine(line: string): boolean {
  return (
    /^#{1,6}\s*/.test(line) ||
    /^\d+[.)、]\s*/.test(line) ||
    /^[一二三四五六七八九十]+[、.．]\s*/.test(line)
  );
}

function isStructuredBulletLine(line: string): boolean {
  return /^[-*+•]\s*/.test(line);
}

function formatStructuredHeadingLine(line: string): string {
  const cleaned = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^(\d+)[)）、.．]\s*/, '$1. ')
    .replace(/^([一二三四五六七八九十]+)[、.．]\s*/, '$1、')
    .trim();

  return `${pickHeadingEmoji(cleaned)} ${cleaned}`;
}

function formatStructuredBulletLine(line: string): string {
  const cleaned = line.replace(/^[-*+•]\s*/, '').trim();
  return `• ${cleaned}`;
}

function pickHeadingEmoji(text: string): string {
  const normalized = text.toLowerCase();

  if (/(架构|设计|结构|分层)/.test(normalized)) {
    return '🏗️';
  }

  if (/(功能|边界|模块|能力)/.test(normalized)) {
    return '⚙️';
  }

  if (/(流程|步骤|执行|运行|链路)/.test(normalized)) {
    return '🔄';
  }

  if (/(结果|结论|总结|概览|概括)/.test(normalized)) {
    return '📌';
  }

  if (/(风险|问题|异常|告警|失败)/.test(normalized)) {
    return '⚠️';
  }

  if (/(建议|优化|改进)/.test(normalized)) {
    return '💡';
  }

  if (/(测试|验证|检查)/.test(normalized)) {
    return '✅';
  }

  if (/(文件|目录|项目|资源)/.test(normalized)) {
    return '📁';
  }

  return '📍';
}

function getTelegramRetryDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function buildTelegramErrorFingerprint(details: {
  code?: string;
  message: string;
  cause?: string;
}): string {
  return `${details.code || ''} ${details.message} ${details.cause || ''}`.toLowerCase();
}

function isRetryableTelegramNetworkFailure(details: {
  code?: string;
  message: string;
  cause?: string;
}): boolean {
  const combined = buildTelegramErrorFingerprint(details);

  return (
    combined.includes('efatal') ||
    combined.includes('econnreset') ||
    combined.includes('socket disconnected') ||
    combined.includes('tls connection') ||
    combined.includes('etimedout') ||
    combined.includes('esockettimedout') ||
    combined.includes('eai_again') ||
    combined.includes('und_err_socket') ||
    combined.includes('other side closed') ||
    combined.includes('socket hang up') ||
    combined.includes('aggregateerror')
  );
}

function truncateMessage(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }

  return `${content.slice(0, maxLength)}...`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeConversationInput(content: string): string {
  return content
    .trim()
    .toLowerCase()
    .replace(/[!！?？~～,，。.\s]+/g, '');
}

function isGreetingMessage(content: string): boolean {
  return [
    '你好',
    '您好',
    'hi',
    'hello',
    'hey',
    '哈喽',
    '嗨',
    '在吗',
    '在不',
    '早上好',
    '中午好',
    '下午好',
    '晚上好',
  ].includes(content);
}

function isThanksMessage(content: string): boolean {
  return ['谢谢', '谢谢你', '感谢', '多谢', '谢了', 'thanks', 'thx'].includes(content);
}

function isAcknowledgementMessage(content: string): boolean {
  return ['好的', '好', '收到', '明白', 'ok', 'okay', '再见', '拜拜'].includes(content);
}

const TELEGRAM_MESSAGE_CONTENT_LIMIT = 3200;
const MAX_CHAT_LOG_ENTRIES = 60;

function splitTelegramMessageContent(content: string, maxLength: number): string[] {
  const normalized = content.trim();
  if (!normalized) {
    return [];
  }

  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const splitIndex =
      slice.lastIndexOf('\n\n') > maxLength * 0.4
        ? slice.lastIndexOf('\n\n')
        : slice.lastIndexOf('\n') > maxLength * 0.4
          ? slice.lastIndexOf('\n')
          : slice.lastIndexOf(' ') > maxLength * 0.4
            ? slice.lastIndexOf(' ')
            : maxLength;

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.filter(Boolean);
}

function extractHighlights(content: string, maxItems: number): string[] {
  const normalized = content
    .replace(/\r/g, '')
    .replace(/\n+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/(?:^|\s)\d+[)）.、:：]/g, '\n')
    .trim();

  const segments = normalized
    .split(/\n|[。！？；;]/)
    .map((part) =>
      part
        .replace(/^[-*•\s]+/, '')
        .replace(/^可向用户简要汇报为[:：]?\s*/, '')
        .trim()
    )
    .filter((part) => part.length >= 6);

  const unique: string[] = [];
  for (const segment of segments) {
    const compact = truncateMessage(segment, 88);
    if (!unique.includes(compact)) {
      unique.push(compact);
    }
    if (unique.length >= maxItems) {
      break;
    }
  }

  if (unique.length > 0) {
    return unique;
  }

  return normalized ? [truncateMessage(normalized, 88)] : [];
}
