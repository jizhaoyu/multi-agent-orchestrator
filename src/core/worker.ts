/**
 * Worker（小弟）核心逻辑
 * 执行任务、发送心跳、报告进度、分配子任务
 */

import { EventEmitter } from 'events';
import type {
  IWorker,
  ITask,
  IAgent,
  AgentStatus,
  AgentStats,
} from '@/types';
import { ClaudeAPIClient, ContextBuilder } from '@/integrations/claude';
import { StateManager } from './state-manager';
import { TaskManager } from './task-manager';
import { MemoryService } from './memory-service';

/**
 * Worker 配置
 */
export interface WorkerConfig {
  /** Worker ID */
  id: string;

  /** Claude API 客户端 */
  apiClient: ClaudeAPIClient;

  /** 状态管理器 */
  stateManager: StateManager;

  /** 任务管理器 */
  taskManager: TaskManager;

  /** 记忆服务 */
  memoryService: MemoryService;

  /** 心跳间隔（毫秒） */
  heartbeatInterval?: number;

  /** 系统 Prompt */
  systemPrompt?: string;
}

/**
 * Worker 进度事件
 */
export interface WorkerProgressEvent {
  taskId: string;
  progress: number; // 0-100
  message: string;
}

/**
 * Worker（小弟）
 */
export class Worker extends EventEmitter implements IWorker, IAgent {
  private config: Required<Omit<WorkerConfig, 'apiClient' | 'stateManager' | 'taskManager' | 'memoryService'>> & WorkerConfig;
  private currentTask: ITask | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  // IAgent 接口实现
  id: string;
  type = 'worker' as const;
  status: AgentStatus = 'idle';
  currentTaskId: string | null = null;
  lastHeartbeat: Date;
  stats: AgentStats;

  constructor(config: WorkerConfig) {
    super();

    this.id = config.id;
    this.config = {
      ...config,
      heartbeatInterval: config.heartbeatInterval || 5 * 60 * 1000, // 5 分钟
      systemPrompt: config.systemPrompt || getDefaultWorkerSystemPrompt(),
    };

    this.lastHeartbeat = new Date();
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalTokens: 0,
      avgCompletionTime: 0,
    };

    // 注册到状态管理器
    this.register();
  }

  /**
   * 接收任务
   */
  async receiveTask(task: ITask): Promise<void> {
    this.currentTask = task;
    this.currentTaskId = task.id;
    this.status = 'busy';

    await this.config.stateManager.updateStatus(this.id, 'busy', task.id);
    await this.config.taskManager.updateTaskStatus(task.id, 'running');

    // 启动心跳
    this.startHeartbeat();

    this.emit('task-received', task);
  }

  /**
   * 执行任务
   */
  async executeTask(task: ITask): Promise<unknown> {
    if (!this.isRunning) {
      this.isRunning = true;
    }

    const startTime = Date.now();

    try {
      // 构建上下文
      const context = await this.buildContext(task);

      // 调用 Claude API
      const response = await this.config.apiClient.sendMessage(context.messages, {
        system: context.system,
      });

      // 更新统计
      this.stats.totalTokens += response.tokensUsed.total;
      this.stats.tasksCompleted++;

      // 报告完成
      this.emit('task-completed', task);
      this.emit('progress', {
        taskId: task.id,
        progress: 100,
        message: '任务完成',
      } as WorkerProgressEvent);

      // 更新任务状态
      await this.config.taskManager.updateTaskStatus(
        task.id,
        'completed',
        response.content
      );

      // 更新状态
      const completionTime = Date.now() - startTime;
      this.stats.avgCompletionTime =
        (this.stats.avgCompletionTime * (this.stats.tasksCompleted - 1) + completionTime) /
        this.stats.tasksCompleted;

      await this.config.stateManager.updateStats(this.id, this.stats);

      return response.content;
    } catch (error) {
      this.stats.tasksFailed++;

      await this.config.taskManager.updateTaskStatus(
        task.id,
        'failed',
        null,
        error instanceof Error ? error.message : String(error)
      );

      await this.config.stateManager.updateStats(this.id, this.stats);

      this.emit('task-failed', task, error);
      throw error;
    } finally {
      // 停止心跳
      this.stopHeartbeat();

      // 重置状态
      this.currentTask = null;
      this.currentTaskId = null;
      this.status = 'idle';

      await this.config.stateManager.updateStatus(this.id, 'idle', null);
    }
  }

  /**
   * 发送心跳
   */
  async sendHeartbeat(): Promise<void> {
    this.lastHeartbeat = new Date();
    await this.config.stateManager.updateHeartbeat(this.id);

    this.emit('heartbeat');
  }

  /**
   * 报告进度
   */
  async reportProgress(progress: number, message: string): Promise<void> {
    if (!this.currentTask) {
      return;
    }

    this.emit('progress', {
      taskId: this.currentTask.id,
      progress: Math.max(0, Math.min(100, progress)),
      message,
    } as WorkerProgressEvent);
  }

  /**
   * 请求帮助
   */
  async requestHelp(issue: string): Promise<void> {
    this.emit('help-requested', {
      workerId: this.id,
      taskId: this.currentTaskId,
      issue,
    });
  }

  /**
   * 分配子任务
   */
  async delegateSubtask(subtask: ITask): Promise<void> {
    // 检查任务深度
    if (subtask.depth >= 3) {
      throw new Error(`任务深度超过限制: ${subtask.depth} >= 3`);
    }

    // 获取空闲 Worker
    const idleWorkers = await this.config.stateManager.getIdleWorkers();

    // 过滤掉自己
    const availableWorkers = idleWorkers.filter((w) => w.id !== this.id);

    if (availableWorkers.length === 0) {
      // 没有空闲 Worker，自己执行
      this.emit('no-idle-workers', subtask);
      return;
    }

    // 选择一个 Worker（简单的轮询）
    const targetWorker = availableWorkers[0];

    // 分配任务
    await this.config.taskManager.assignTask(subtask.id, targetWorker.id);

    this.emit('subtask-delegated', {
      from: this.id,
      to: targetWorker.id,
      task: subtask,
    });
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();

      // 如果有当前任务，报告进度
      if (this.currentTask) {
        this.emit('progress', {
          taskId: this.currentTask.id,
          progress: -1, // -1 表示心跳，不更新进度
          message: '心跳',
        } as WorkerProgressEvent);
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * 注册到状态管理器
   */
  private async register(): Promise<void> {
    await this.config.stateManager.registerAgent(this);
  }

  /**
   * 构建上下文
   */
  private async buildContext(task: ITask): Promise<{
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    system?: string;
  }> {
    const builder = new ContextBuilder();

    // 设置系统提示词
    builder.setSystemPrompt(this.config.systemPrompt);

    // 添加任务描述
    let message = `请完成以下任务：\n\n${task.description}\n\n`;

    // 添加上下文信息
    if (Object.keys(task.context).length > 0) {
      message += `任务上下文：\n${JSON.stringify(task.context, null, 2)}\n\n`;
    }

    // 添加配置信息（从记忆服务读取）
    try {
      const claudeConfig = await this.config.memoryService.read('CLAUDE.md') as string;
      message += `\n--- 配置信息 ---\n${claudeConfig}\n---\n`;
    } catch {
      // 配置文件不存在，忽略
    }

    message += `\n请直接开始执行任务，不需要重复任务描述。如果需要分配子任务，请明确说明。`;

    builder.addUserMessage(message);

    return builder.build();
  }

  /**
   * 销毁 Worker
   */
  async destroy(): Promise<void> {
    this.stopHeartbeat();
    this.removeAllListeners();
  }
}

/**
 * 获取默认 Worker 系统提示词
 */
function getDefaultWorkerSystemPrompt(): string {
  return `你是一个 AI 团队的成员（小弟），拥有和大哥同等的能力和权限。

## 你的能力

- 所有 Claude Code 的工具、Skills、Agents、MCP
- 可以指挥其他空闲的小弟帮你完成子任务
- 可以自主决定任务的执行粒度
- 遇到问题可以 @大哥 或 @老大 求助

## 工作流程

1. **接收任务**：理解任务需求，制定执行计划
2. **执行任务**：调用必要的工具、Skills、MCP
3. **报告进度**：定期更新进度
4. **请求帮助**：遇到问题时及时请求
5. **完成任务**：明确说明"任务完成"

## 重要规则

- 优先指挥空闲的小弟
- 不能指挥大哥
- 遇到错误要及时报告
- 任务完成后要明确说明"任务完成"
- 任务深度不能超过 3 层`;
}
