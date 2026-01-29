/**
 * Telegram Bot 集成
 * 提供 Telegram 群聊的可视化交互界面
 */

import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import type { Orchestrator } from '@/core/orchestrator';
import type { Worker } from '@/core/worker';

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

  /** 是否启用轮询 */
  polling?: boolean;
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

/**
 * Telegram Bot 集成
 */
export class TelegramBotIntegration extends EventEmitter {
  private bot: TelegramBot;
  private config: Required<Omit<TelegramBotConfig, 'chatId'>> & { chatId?: string };
  private isRunning = false;

  constructor(config: TelegramBotConfig) {
    super();

    this.config = {
      ...config,
      polling: config.polling ?? true,
    };

    // 初始化 Bot
    this.bot = new TelegramBot(this.config.token, {
      polling: this.config.polling,
    });

    // 设置事件监听
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

    // 监听消息
    this.bot.on('message', async (msg) => {
      await this.handleMessage(msg);
    });

    this.emit('started');
  }

  /**
   * 停止 Bot
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    await this.bot.stopPolling();
    this.isRunning = false;

    this.emit('stopped');
  }

  /**
   * 发送消息
   */
  async sendMessage(chatId: string, message: TelegramMessage): Promise<void> {
    const formattedMessage = this.formatMessage(message);
    await this.bot.sendMessage(chatId, formattedMessage, {
      parse_mode: 'Markdown',
    });
  }

  /**
   * 发送任务分配消息
   */
  async sendTaskAssignment(
    chatId: string,
    workerId: string,
    taskDescription: string
  ): Promise<void> {
    const message = `@${workerId} 请帮我完成以下任务：\n\n【任务描述】\n${taskDescription}\n\n【预期输出】\n请完成任务并报告结果`;

    await this.bot.sendMessage(chatId, message, {
      parse_mode: 'Markdown',
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
    const text = `📊 ${workerId} 进度更新\n\n${progressBar} ${progress}%\n\n${message}`;

    await this.bot.sendMessage(chatId, text);
  }

  /**
   * 处理消息
   */
  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();
    const text = msg.text || '';

    // 保存 chatId（如果未设置）
    if (!this.config.chatId) {
      this.config.chatId = chatId;
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
      // 消息是给 Orchestrator 的
      this.emit('user-message', {
        message: text,
        chatId,
        userId: msg.from?.id,
      });

      // 自动处理用户请求
      try {
        const task = await this.config.orchestrator.receiveTask(text);
        await this.sendMessage(chatId, {
          type: 'user_request',
          from: 'orchestrator',
          content: `✅ 任务已接收: ${task.id}\n\n我会将任务分解并分配给小弟们执行。`,
        });
      } catch (error) {
        await this.sendMessage(chatId, {
          type: 'error_report',
          from: 'orchestrator',
          content: `❌ 错误: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
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
    let text = `${emoji} **${message.from}**\n\n${message.content}`;

    if (message.to) {
      text = `@${message.to}\n\n${text}`;
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
    // 监听 Orchestrator 事件
    this.config.orchestrator.on('task-decomposed', async (task, subtasks) => {
      if (this.config.chatId) {
        await this.sendMessage(this.config.chatId, {
          type: 'task_assignment',
          from: 'orchestrator',
          content: `🔨 任务已分解为 ${subtasks.length} 个子任务`,
        });
      }
    });

    this.config.orchestrator.on('task-assigned', async (task, worker) => {
      if (this.config.chatId) {
        await this.sendTaskAssignment(this.config.chatId, worker.id, task.description);
      }
    });

    // 监听 Worker 事件
    for (const worker of this.config.workers) {
      worker.on('progress', async (event) => {
        if (this.config.chatId && event.progress >= 0) {
          await this.sendProgressUpdate(
            this.config.chatId,
            worker.id,
            event.progress,
            event.message
          );
        }
      });

      worker.on('task-completed', async (task) => {
        if (this.config.chatId) {
          await this.sendMessage(this.config.chatId, {
            type: 'task_complete',
            from: worker.id,
            content: `✅ 任务完成: ${task.description}`,
          });
        }
      });

      worker.on('task-failed', async (task, error) => {
        if (this.config.chatId) {
          await this.sendMessage(this.config.chatId, {
            type: 'error_report',
            from: worker.id,
            content: `❌ 任务失败: ${task.description}\n\n错误: ${error}`,
          });
        }
      });
    }
  }

  /**
   * 销毁 Bot
   */
  async destroy(): Promise<void> {
    await this.stop();
    this.removeAllListeners();
  }
}
