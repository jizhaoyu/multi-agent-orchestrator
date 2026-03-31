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
import { isTaskCancelledError, toTaskCancelledError } from './task-cancelled-error';
import { WorkerInstructionContext } from './worker-instruction-context';

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
  chatId?: string;
}

class WorkspaceExecutionFailedError extends Error {
  constructor(
    message: string,
    public readonly result: WorkspaceExecutionResult
  ) {
    super(message);
    this.name = 'WorkspaceExecutionFailedError';
  }
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
  private currentExecutionController: AbortController | null = null;
  private readonly instructionContext: WorkerInstructionContext;
  private readonly registrationPromise: Promise<void>;
  private registrationError: Error | null = null;

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

    this.instructionContext = new WorkerInstructionContext({
      memoryService: this.config.memoryService,
      instructionFiles: this.config.instructionFiles,
      maxInstructionContextChars: this.config.maxInstructionContextChars,
    });
    this.registrationPromise = this.register().catch((error: unknown) => {
      const registrationError =
        error instanceof Error ? error : new Error(String(error));
      this.registrationError = registrationError;
      queueMicrotask(() => {
        this.emit('registration-error', registrationError);
      });
    });
  }

  /**
   * 接收任务
   */
  async receiveTask(task: ITask): Promise<void> {
    await this.ensureRegistered();

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
    await this.ensureRegistered();

    if (this.isRunning && this.currentTaskId !== task.id) {
      throw new Error(`Worker ${this.id} is already executing another task`);
    }
    this.isRunning = true;

    const startTime = Date.now();
    const executionController = new AbortController();
    this.currentExecutionController = executionController;

    try {
      const workspaceExecutor = this.getWorkspaceExecutor(task);
      const execution =
        workspaceExecutor
          ? {
              result: await workspaceExecutor.executeTask(task, executionController.signal),
              tokenUsage: 0,
            }
          : await this.executeTextTask(task, executionController.signal);
      const result = execution.result;

      if (this.isFailedWorkspaceExecutionResult(result)) {
        task.result = result;
        throw new WorkspaceExecutionFailedError(result.summary, result);
      }

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
        chatId: this.getTaskChatId(task),
      } as WorkerProgressEvent);

      return result;
    } catch (error) {
      if (isTaskCancelledError(error)) {
        const cancelledError = toTaskCancelledError(error);
        task.error = cancelledError.message;
        task.status = 'failed';

        await this.config.taskManager.updateTaskStatus(
          task.id,
          'failed',
          null,
          cancelledError.message
        );
        await this.config.stateManager.updateStats(this.id, this.stats);

        this.emit('task-cancelled', task, cancelledError);
        this.emit('progress', {
          taskId: task.id,
          progress: 100,
          message: '任务已中断',
          chatId: this.getTaskChatId(task),
        } as WorkerProgressEvent);
        throw cancelledError;
      }

      const taskError = error instanceof Error ? error : new Error(String(error));
      const failedWorkspaceResult =
        error instanceof WorkspaceExecutionFailedError ? error.result : undefined;
      this.stats.tasksFailed++;
      task.result = failedWorkspaceResult || null;
      task.error = taskError.message;
      task.status = 'failed';

      await this.config.taskManager.updateTaskStatus(
        task.id,
        'failed',
        failedWorkspaceResult,
        taskError.message
      );

      await this.config.stateManager.updateStats(this.id, this.stats);

      this.emit('task-failed', task, taskError);
      throw taskError;
    } finally {
      // 停止心跳
      this.stopHeartbeat();

      // 重置状态
      this.currentTask = null;
      this.currentTaskId = null;
      this.status = 'idle';
      this.isRunning = false;
      if (this.currentExecutionController === executionController) {
        this.currentExecutionController = null;
      }

      await this.config.stateManager.updateStatus(this.id, 'idle', null);
    }
  }

  async cancelCurrentTask(reason = '任务已被取消'): Promise<boolean> {
    if (!this.currentExecutionController || this.currentExecutionController.signal.aborted) {
      return false;
    }

    this.currentExecutionController.abort(toTaskCancelledError(reason));
    return true;
  }

  /**
   * 发送心跳
   */
  async sendHeartbeat(): Promise<void> {
    await this.ensureRegistered();
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
      chatId: this.getTaskChatId(this.currentTask),
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
    await this.ensureRegistered();

    const maxDepth = this.config.taskManager.getMaxDepth();
    if (subtask.depth > maxDepth) {
      throw new Error(`任务深度超过限制: ${subtask.depth} > ${maxDepth}`);
    }

    const existingTask = await this.config.taskManager.getTask(subtask.id);
    if (!existingTask) {
      await this.config.taskManager.addTask(subtask);
    }
    const taskToAssign = existingTask || subtask;

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
    await this.config.taskManager.assignTask(taskToAssign.id, targetWorker.id);

    this.emit('subtask-delegated', {
      from: this.id,
      to: targetWorker.id,
      task: taskToAssign,
    });
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      void this.runHeartbeatTick();
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
      const instructionContext = await this.instructionContext.read();
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
    this.instructionContext.destroy();
    this.removeAllListeners();
  }

  private async executeTextTask(task: ITask, signal: AbortSignal): Promise<{
    result: string;
    tokenUsage: number;
  }> {
    // 构建上下文
    const context = await this.buildContext(task);

    // 调用 AI API
    const response = await this.withCancellation(
      this.config.apiClient.sendMessage(context.messages, {
        system: context.system,
      }),
      signal
    );

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

  private getTaskChatId(task: ITask | null): string | undefined {
    if (!task) {
      return undefined;
    }

    const contextChatId = task.context.chatId;
    if (typeof contextChatId !== 'string' || contextChatId.trim().length === 0) {
      return undefined;
    }

    return contextChatId.trim();
  }

  private isFailedWorkspaceExecutionResult(
    result: unknown
  ): result is WorkspaceExecutionResult & { verdict: 'failed' } {
    if (typeof result !== 'object' || result === null) {
      return false;
    }

    return (
      'mode' in result &&
      (result as { mode?: unknown }).mode === 'workspace' &&
      'verdict' in result &&
      (result as { verdict?: unknown }).verdict === 'failed'
    );
  }

  private async ensureRegistered(): Promise<void> {
    await this.registrationPromise;
    if (this.registrationError) {
      throw this.registrationError;
    }
  }

  private async runHeartbeatTick(): Promise<void> {
    try {
      await this.sendHeartbeat();

      if (this.currentTask) {
        this.emit('progress', {
          taskId: this.currentTask.id,
          progress: -1,
          message: '心跳',
          chatId: this.getTaskChatId(this.currentTask),
        } as WorkerProgressEvent);
      }
    } catch (error) {
      this.emit('heartbeat-error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async withCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      throw toTaskCancelledError(signal.reason);
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        reject(toTaskCancelledError(signal.reason));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
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
