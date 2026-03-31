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
import { ContextBuilder } from '@/integrations/llm';
import type { LLMClient, LLMMessage } from '@/integrations/llm';
import { StateManager } from './state-manager';
import { TaskManager } from './task-manager';
import { MemoryService } from './memory-service';
import type {
  HarnessHooks,
  PermissionProfile,
  TraceRecorder,
  VerificationPolicy,
} from '@/harness';
import {
  WorkspaceExecutor,
  type WorkspaceExecutionResult,
  type WorkspaceExecutionProgressEvent,
} from './workspace-executor';

/**
 * Worker 配置
 */
export interface WorkerConfig {
  /** Worker ID */
  id: string;

  /** AI 客户端 */
  apiClient: LLMClient;

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

  /** 指令文件搜索顺序 */
  instructionFiles?: string[];

  /** 最大上下文字符数 */
  maxInstructionContextChars?: number;

  /** 工作区根目录 */
  workspaceRoot?: string;

  /** 是否启用本地工作区执行 */
  enableWorkspaceExecution?: boolean;

  /** 本地执行最大轮数 */
  maxExecutionIterations?: number;

  /** 命令执行超时时间 */
  commandTimeoutMs?: number;

  /** 验证策略 */
  verificationPolicy?: VerificationPolicy;

  /** 命令权限档位 */
  permissionProfile?: PermissionProfile;

  /** Trace 记录器 */
  traceRecorder?: TraceRecorder;

  /** 生命周期 Hooks */
  hooks?: HarnessHooks;
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
  private config: WorkerConfig & {
    heartbeatInterval: number;
    systemPrompt: string;
    instructionFiles: string[];
    maxInstructionContextChars: number;
    workspaceRoot: string;
    enableWorkspaceExecution: boolean;
    maxExecutionIterations: number;
    commandTimeoutMs: number;
    permissionProfile: PermissionProfile;
  };
  private currentTask: ITask | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly workspaceExecutors = new Map<string, WorkspaceExecutor>();

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
      instructionFiles: config.instructionFiles || [
        'AGENTS.md',
        'codex-harness.config.json',
        'docs/agent-map.md',
        'docs/runbooks/verification.md',
        'docs/failure-catalog.md',
        'CODEX.md',
        'CLAUDE.md',
      ],
      maxInstructionContextChars: config.maxInstructionContextChars || 12000,
      workspaceRoot: config.workspaceRoot || '',
      enableWorkspaceExecution:
        config.enableWorkspaceExecution ?? Boolean(config.workspaceRoot),
      maxExecutionIterations: config.maxExecutionIterations || 6,
      commandTimeoutMs: config.commandTimeoutMs || 120000,
      verificationPolicy: config.verificationPolicy,
      permissionProfile: config.permissionProfile || 'dev_safe',
      traceRecorder: config.traceRecorder,
      hooks: config.hooks,
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
      const workspaceExecutor = this.getWorkspaceExecutor(task);
      const execution =
        workspaceExecutor
          ? {
              result: await workspaceExecutor.executeTask(task),
              tokenUsage: 0,
            }
          : await this.executeTextTask(task);
      const result = execution.result;

      task.result = result;
      task.status = 'completed';
      task.completedAt = new Date();

      // 更新统计
      this.stats.totalTokens += execution.tokenUsage || this.getResultTokenUsage(result);
      this.stats.tasksCompleted++;

      // 更新任务状态
      await this.config.taskManager.updateTaskStatus(
        task.id,
        'completed',
        result
      );

      // 更新状态
      const completionTime = Date.now() - startTime;
      this.stats.avgCompletionTime =
        (this.stats.avgCompletionTime * (this.stats.tasksCompleted - 1) + completionTime) /
        this.stats.tasksCompleted;

      await this.config.stateManager.updateStats(this.id, this.stats);

      // 报告完成
      this.emit('task-completed', task);
      this.emit('progress', {
        taskId: task.id,
        progress: 100,
        message: '任务完成',
      } as WorkerProgressEvent);

      return result;
    } catch (error) {
      this.stats.tasksFailed++;
      task.error = error instanceof Error ? error.message : String(error);
      task.status = 'failed';

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
    if (!targetWorker) {
      return;
    }

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
    messages: LLMMessage[];
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
      const instructionContext = await this.readInstructionContext();
      if (instructionContext) {
        message += `\n${instructionContext}\n`;
      }
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

  private async executeTextTask(task: ITask): Promise<{
    result: string;
    tokenUsage: number;
  }> {
    // 构建上下文
    const context = await this.buildContext(task);

    // 调用 AI API
    const response = await this.config.apiClient.sendMessage(context.messages, {
      system: context.system,
    });

    return {
      result: response.content,
      tokenUsage: response.tokensUsed.total,
    };
  }

  private getResultTokenUsage(result: string | WorkspaceExecutionResult): number {
    if (typeof result === 'string') {
      return 0;
    }

    return result.tokenUsage.total;
  }

  private getWorkspaceExecutor(task: ITask): WorkspaceExecutor | null {
    if (!this.config.enableWorkspaceExecution) {
      return null;
    }

    const workspaceRoot = this.resolveWorkspaceRoot(task);
    if (!workspaceRoot) {
      return null;
    }

    const cachedExecutor = this.workspaceExecutors.get(workspaceRoot);
    if (cachedExecutor) {
      return cachedExecutor;
    }

    const executor = new WorkspaceExecutor({
      workspaceRoot,
      apiClient: this.config.apiClient,
      maxIterations: this.config.maxExecutionIterations,
      commandTimeoutMs: this.config.commandTimeoutMs,
      verificationPolicy: this.config.verificationPolicy,
      permissionProfile: this.config.permissionProfile,
      traceRecorder: this.config.traceRecorder,
      hooks: this.config.hooks,
      onProgress: async (event: WorkspaceExecutionProgressEvent) => {
        await this.reportProgress(event.progress, event.message);
      },
    });
    this.workspaceExecutors.set(workspaceRoot, executor);
    return executor;
  }

  private resolveWorkspaceRoot(task: ITask): string | null {
    const contextWorkspaceRoot = task.context.workspaceRoot;
    if (typeof contextWorkspaceRoot === 'string' && contextWorkspaceRoot.trim().length > 0) {
      return contextWorkspaceRoot.trim();
    }

    return this.config.workspaceRoot || null;
  }

  private async readInstructionContext(): Promise<string | null> {
    const sections: string[] = [];
    let totalChars = 0;

    for (const relativePath of this.config.instructionFiles) {
      try {
        const data = await this.config.memoryService.read(relativePath);
        const content =
          typeof data === 'string' ? data : JSON.stringify(data, null, 2);
        const remaining = this.config.maxInstructionContextChars - totalChars;
        if (remaining <= 0) {
          break;
        }

        const clipped = content.length > remaining ? `${content.slice(0, remaining)}\n...[truncated]` : content;
        sections.push(`--- ${relativePath} ---\n${clipped}\n---`);
        totalChars += clipped.length;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('Memory file not found:')
        ) {
          continue;
        }
        throw error;
      }
    }

    if (sections.length === 0) {
      return null;
    }

    return sections.join('\n\n');
  }
}

/**
 * 获取默认 Worker 系统提示词
 */
function getDefaultWorkerSystemPrompt(): string {
  return `你是一个 Codex 风格 AI 团队的成员（小弟），拥有和大哥同等的能力和权限。

## 你的能力

- 所有 Codex 的工具、Skills、Agents、MCP
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
