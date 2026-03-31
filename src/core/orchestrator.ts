/**
 * Orchestrator（大哥）核心逻辑
 * 负责任务分解、分配、监控、质量把控、错误恢复
 */

import { EventEmitter } from 'events';
import type {
  IOrchestrator,
  ITask,
  IAgent,
  AgentStatus,
  AgentStats,
  TaskPriority,
  TaskDifficulty,
  TaskExecutionPlan,
  TaskAssignmentOptions,
  ConversationTurn,
} from '@/types';
import { ContextBuilder } from '@/integrations/llm';
import type { LLMClient, LLMMessage } from '@/integrations/llm';
import { StateManager } from './state-manager';
import { TaskManager } from './task-manager';
import { MemoryService } from './memory-service';
import { Worker } from './worker';
import { v4 as uuidv4 } from 'uuid';

/**
 * Orchestrator 配置
 */
export interface OrchestratorConfig {
  /** Orchestrator ID */
  id: string;

  /** AI 客户端 */
  apiClient: LLMClient;

  /** 状态管理器 */
  stateManager: StateManager;

  /** 任务管理器 */
  taskManager: TaskManager;

  /** 记忆服务 */
  memoryService: MemoryService;

  /** Worker 池 */
  workers: Worker[];

  /** 监控间隔（毫秒） */
  monitorInterval?: number;

  /** 系统 Prompt */
  systemPrompt?: string;
}

export interface IntegratedTaskResultSummary {
  taskId: string;
  description: string;
  result: unknown;
}

export interface IntegratedTaskFailureSummary {
  taskId: string;
  description: string;
  error: string;
  result: unknown | null;
}

export interface IntegratedTaskSummary {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  results: IntegratedTaskResultSummary[];
  failures: IntegratedTaskFailureSummary[];
  finalOpinion?: string;
}

/**
 * Orchestrator（大哥）
 */
export class Orchestrator extends EventEmitter implements IOrchestrator, IAgent {
  private config: Required<Omit<OrchestratorConfig, 'apiClient' | 'stateManager' | 'taskManager' | 'memoryService' | 'workers'>> & OrchestratorConfig;
  private monitorTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private readonly registrationPromise: Promise<void>;
  private registrationError: Error | null = null;

  // IAgent 接口实现
  id: string;
  type = 'orchestrator' as const;
  status: AgentStatus = 'idle';
  currentTaskId: string | null = null;
  lastHeartbeat: Date;
  stats: AgentStats;

  constructor(config: OrchestratorConfig) {
    super();

    this.id = config.id;
    this.config = {
      ...config,
      monitorInterval: config.monitorInterval || 60 * 1000, // 1 分钟
      systemPrompt: config.systemPrompt || getDefaultOrchestratorSystemPrompt(),
    };

    this.lastHeartbeat = new Date();
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      totalTokens: 0,
      avgCompletionTime: 0,
    };

    this.registrationPromise = this.register().catch((error: unknown) => {
      this.registrationError = error instanceof Error ? error : new Error(String(error));
      queueMicrotask(() => {
        if (this.registrationError) {
          this.emit('registration-error', this.registrationError);
        }
      });
    });
  }

  /**
   * 接收用户任务
   */
  async receiveTask(
    userInput: string,
    context: Record<string, unknown> = {}
  ): Promise<ITask> {
    await this.ensureRegistered();

    const task: ITask = {
      id: uuidv4(),
      parentId: null,
      assignedTo: null,
      status: 'pending',
      priority: 'high',
      depth: 0,
      description: userInput,
      context,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };

    await this.config.taskManager.addTask(task);

    this.emit('task-received', task);

    return task;
  }

  /**
   * 任务分解
   */
  async decomposeTask(task: ITask): Promise<ITask[]> {
    await this.ensureRegistered();

    this.status = 'busy';
    this.currentTaskId = task.id;

    await this.config.stateManager.updateStatus(this.id, 'busy', task.id);

    try {
      const maxConcurrentWorkers = Math.max(1, this.config.workers.length);

      // 构建上下文
      const context = await this.buildDecomposeContext(task, maxConcurrentWorkers);

      // 调用 AI API
      const response = await this.config.apiClient.sendMessage(context.messages, {
        system: context.system,
      });

      // 更新统计
      this.stats.totalTokens += response.tokensUsed.total;

      // 解析执行计划
      const planResult = this.parseExecutionPlan(response.content, task, maxConcurrentWorkers);
      const subtasks = planResult.subtasks;
      task.context = {
        ...task.context,
        executionPlan: planResult.plan,
      };

      await this.config.taskManager.addTasks(subtasks);

      this.emit('task-decomposed', task, subtasks);

      return subtasks;
    } finally {
      this.status = 'idle';
      this.currentTaskId = null;
      await this.config.stateManager.updateStatus(this.id, 'idle', null);
    }
  }

  /**
   * 任务分配
   */
  async assignTasks(
    tasks: ITask[],
    options: TaskAssignmentOptions = {}
  ): Promise<void> {
    await this.ensureRegistered();

    const pendingTasks = this.sortTasksByPriority(tasks);
    const maxConcurrentWorkers = this.normalizeWorkerCount(
      options.maxConcurrentWorkers,
      pendingTasks.length
    );

    while (pendingTasks.length > 0) {
      if (options.shouldContinue && !options.shouldContinue()) {
        break;
      }

      let idleWorkers = await this.getRegisteredIdleWorkers();

      if (idleWorkers.length === 0) {
        const newWorker = await this.createNewWorker();
        this.emit('worker-created', newWorker);
        idleWorkers = [newWorker];
      }

      const batchSize = Math.max(
        1,
        Math.min(pendingTasks.length, idleWorkers.length, maxConcurrentWorkers)
      );
      const batch = pendingTasks.splice(0, batchSize);

      if (options.shouldContinue && !options.shouldContinue()) {
        pendingTasks.unshift(...batch);
        break;
      }

      const executions = batch.map((task, index) => {
        const worker = idleWorkers[index];
        if (!worker) {
          return Promise.resolve();
        }

        return this.executeAssignedTask(task, worker);
      });

      await Promise.allSettled(executions);
    }
  }

  /**
   * 监控进度
   */
  async monitorProgress(): Promise<void> {
    await this.ensureRegistered();

    if (this.monitorTimer) {
      return; // 已经在监控中
    }

    this.monitorTimer = setInterval(async () => {
      try {
        // 检查心跳超时
        const timedOutAgents = await this.config.stateManager.checkHeartbeatTimeout();

        if (timedOutAgents.length > 0) {
          this.emit('heartbeat-timeout', timedOutAgents);

          // 处理超时的任务
          for (const agentId of timedOutAgents) {
            const tasks = await this.config.taskManager.getTasksByAgent(agentId);
            const runningTask = tasks.find((t) => t.status === 'running');

            if (runningTask) {
              await this.handleError(runningTask, new Error('Worker heartbeat timeout'));
            }
          }
        }

        // 生成进度报告
        const stats = this.config.taskManager.getStats();
        this.emit('progress-report', stats);
      } catch (error) {
        this.emit('monitor-error', error);
      }
    }, this.config.monitorInterval);

    this.isRunning = true;
  }

  /**
   * 质量把控
   */
  async reviewResults(task: ITask): Promise<boolean> {
    if (!task.result) {
      return false;
    }

    if (
      typeof task.result === 'object' &&
      task.result !== null &&
      'verdict' in task.result
    ) {
      return (task.result as { verdict?: string }).verdict === 'passed' ||
        (task.result as { verdict?: string }).verdict === 'skipped';
    }

    // 简单的质量检查：结果不为空
    // 实际应用中可以使用 AI API 进行更复杂的质量评估
    const resultStr = typeof task.result === 'string' ? task.result : JSON.stringify(task.result);

    if (resultStr.length < 10) {
      return false; // 结果太短，可能不完整
    }

    return true;
  }

  /**
   * 错误处理
   */
  async handleError(task: ITask, error: Error): Promise<void> {
    await this.ensureRegistered();
    this.emit('task-error', task, error);

    const worker = await this.getOrCreateIdleWorker();
    await this.prepareTaskForRetry(task);

    this.emit('task-reassigned', task, worker);
    await this.executeAssignedTask(task, worker);
  }

  /**
   * 结果整合
   */
  async integrateResults(tasks: ITask[]): Promise<IntegratedTaskSummary> {
    const results = tasks
      .filter((t) => t.status === 'completed' && t.result)
      .map((t) => ({
        taskId: t.id,
        description: t.description,
        result: t.result,
      }));
    const failures = tasks
      .filter((t) => t.status === 'failed')
      .map((t) => ({
        taskId: t.id,
        description: t.description,
        error: getTaskFailureMessage(t),
        result: t.result,
      }));
    const finalOpinion = await this.generateFinalOpinion(results, failures);

    return {
      totalTasks: tasks.length,
      completedTasks: results.length,
      failedTasks: failures.length,
      results,
      failures,
      finalOpinion,
    };
  }

  async getQueueSnapshot(limit = 6): Promise<{
    stats: {
      total: number;
      pending: number;
      running: number;
      completed: number;
      failed: number;
    };
    runningTasks: ITask[];
    pendingTasks: ITask[];
  }> {
    const normalizedLimit = Math.max(1, Math.floor(limit));

    return {
      stats: this.config.taskManager.getStats(),
      runningTasks: (await this.config.taskManager.getRunningTasks()).slice(0, normalizedLimit),
      pendingTasks: await this.config.taskManager.getPendingTasks(normalizedLimit),
    };
  }

  async cancelTaskTree(
    rootTaskId: string,
    reason = '任务已被用户取消'
  ): Promise<{
    rootTaskFound: boolean;
    cancelledPendingCount: number;
    runningCount: number;
    interruptedRunningCount: number;
  }> {
    const tasks = await this.config.taskManager.getTaskTree(rootTaskId);
    if (tasks.length === 0) {
      return {
        rootTaskFound: false,
        cancelledPendingCount: 0,
        runningCount: 0,
        interruptedRunningCount: 0,
      };
    }

    let cancelledPendingCount = 0;
    const runningTasks: ITask[] = [];

    for (const task of tasks) {
      if (task.status === 'pending') {
        await this.config.taskManager.updateTaskStatus(task.id, 'failed', null, reason);
        task.status = 'failed';
        task.error = reason;
        cancelledPendingCount++;
        continue;
      }

      if (task.status === 'running') {
        runningTasks.push(task);
      }
    }

    const interruptionResults = await Promise.all(
      runningTasks.map((task) => this.requestRunningTaskCancellation(task, reason))
    );
    const interruptedRunningCount = interruptionResults.filter(Boolean).length;

    return {
      rootTaskFound: true,
      cancelledPendingCount,
      runningCount: runningTasks.length,
      interruptedRunningCount,
    };
  }

  /**
   * 启动 Orchestrator
   */
  async start(): Promise<void> {
    await this.ensureRegistered();

    if (this.isRunning) {
      return;
    }

    // 启动监控
    await this.monitorProgress();

    this.emit('started');
  }

  /**
   * 停止 Orchestrator
   */
  async stop(): Promise<void> {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }

    this.isRunning = false;

    this.emit('stopped');
  }

  /**
   * 创建新 Worker
   */
  private async createNewWorker(): Promise<Worker> {
    const workerId = `worker-${this.config.workers.length + 1}`;

    const worker = new Worker({
      id: workerId,
      apiClient: this.config.apiClient,
      stateManager: this.config.stateManager,
      taskManager: this.config.taskManager,
      memoryService: this.config.memoryService,
    });

    this.config.workers.push(worker);

    return worker;
  }

  private async getOrCreateIdleWorker(): Promise<Worker> {
    const idleWorkers = await this.getRegisteredIdleWorkers();
    const worker = idleWorkers[0];
    if (worker) {
      return worker;
    }

    const newWorker = await this.createNewWorker();
    this.emit('worker-created', newWorker);
    return newWorker;
  }

  private async requestRunningTaskCancellation(task: ITask, reason: string): Promise<boolean> {
    const worker = this.config.workers.find((candidate) => candidate.currentTaskId === task.id);
    if (!worker) {
      return false;
    }

    return worker.cancelCurrentTask(reason);
  }

  /**
   * 注册到状态管理器
   */
  private async register(): Promise<void> {
    await this.config.stateManager.registerAgent(this);
  }

  private async ensureRegistered(): Promise<void> {
    await this.registrationPromise;
    if (this.registrationError) {
      throw this.registrationError;
    }
  }

  /**
   * 构建任务分解上下文
   */
  private async buildDecomposeContext(
    task: ITask,
    maxConcurrentWorkers: number
  ): Promise<{
    messages: LLMMessage[];
    system?: string;
  }> {
    const builder = new ContextBuilder();

    builder.setSystemPrompt(this.config.systemPrompt);

    let message = `请先结合用户最近的问答，再分析任务难度，并决定应该安排多少名小弟执行。\n\n`;
    message += `当前任务：\n${task.description}\n\n`;

    const conversationHistory = this.formatConversationHistory(task.context);
    if (conversationHistory) {
      message += `最近问答：\n${conversationHistory}\n\n`;
    }

    message += `当前最多可同时调用 ${maxConcurrentWorkers} 名小弟。\n\n`;
    message += `要求：\n`;
    message += `1. 先判断任务难度，只能是 simple、medium、complex 之一\n`;
    message += `2. 推荐小弟数必须是 1 到 ${maxConcurrentWorkers} 之间的整数\n`;
    message += `3. 简单任务尽量只安排 1 名小弟；复杂任务再增加人数\n`;
    message += `4. 子任务尽量与推荐小弟数匹配，并按优先级从高到低输出\n`;
    message += `5. 每个子任务应该独立、清晰、可执行\n`;
    message += `6. 使用以下格式输出，不要输出额外说明：\n\n`;
    message += `任务难度: [simple/medium/complex]\n`;
    message += `推荐小弟数: [数字]\n`;
    message += `分析依据: [一句话理由]\n\n`;
    message += `子任务 1: [标题]\n`;
    message += `描述: [详细描述]\n`;
    message += `优先级: [high/medium/low]\n\n`;
    message += `子任务 2: [标题]\n`;
    message += `描述: [详细描述]\n`;
    message += `优先级: [high/medium/low]\n\n`;

    builder.addUserMessage(message);

    return builder.build();
  }

  /**
   * 解析执行计划
   */
  private parseExecutionPlan(
    content: string,
    parentTask: ITask,
    maxConcurrentWorkers: number
  ): {
    plan: TaskExecutionPlan;
    subtasks: ITask[];
  } {
    const subtasks: ITask[] = [];
    const lines = content.split('\n');

    let difficulty = this.estimateTaskDifficulty(parentTask.description);
    let recommendedWorkers = 0;
    let rationale = '';
    let currentSubtask: Partial<ITask> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('任务难度:')) {
        const value = trimmed.substring(5).trim().toLowerCase();
        if (value === 'simple' || value === 'medium' || value === 'complex') {
          difficulty = value;
        }
      } else if (trimmed.startsWith('推荐小弟数:')) {
        const match = trimmed.match(/(\d+)/);
        if (match?.[1]) {
          recommendedWorkers = Number(match[1]);
        }
      } else if (trimmed.startsWith('分析依据:')) {
        rationale = trimmed.substring(5).trim();
      } else if (trimmed.startsWith('子任务')) {
        // 保存上一个子任务
        if (currentSubtask && currentSubtask.description) {
          subtasks.push(this.createSubtask(currentSubtask, parentTask));
        }

        // 开始新的子任务
        const title = trimmed.split(':')[1]?.trim() || '';
        currentSubtask = { description: title };
      } else if (trimmed.startsWith('描述:')) {
        if (currentSubtask) {
          currentSubtask.description = trimmed.substring(3).trim();
        }
      } else if (trimmed.startsWith('优先级:')) {
        if (currentSubtask) {
          const priority = trimmed.substring(4).trim().toLowerCase();
          currentSubtask.priority = (priority === 'high' || priority === 'medium' || priority === 'low'
            ? priority
            : 'medium') as TaskPriority;
        }
      }
    }

    // 保存最后一个子任务
    if (currentSubtask && currentSubtask.description) {
      subtasks.push(this.createSubtask(currentSubtask, parentTask));
    }

    if (subtasks.length === 0) {
      subtasks.push(
        this.createSubtask(
          {
            description: parentTask.description,
            priority: parentTask.priority,
          },
          parentTask
        )
      );
    }

    const normalizedWorkers = Math.min(
      subtasks.length,
      maxConcurrentWorkers,
      this.normalizeWorkerCount(
        recommendedWorkers || this.estimateWorkerCount(difficulty),
        maxConcurrentWorkers
      )
    );

    return {
      plan: {
        difficulty,
        recommendedWorkers: normalizedWorkers,
        rationale:
          rationale || `根据任务复杂度 ${difficulty}，建议安排 ${normalizedWorkers} 名小弟。`,
      },
      subtasks,
    };
  }

  /**
   * 创建子任务
   */
  private createSubtask(partial: Partial<ITask>, parentTask: ITask): ITask {
    return {
      id: uuidv4(),
      parentId: parentTask.id,
      assignedTo: null,
      status: 'pending',
      priority: partial.priority || 'medium',
      depth: parentTask.depth + 1,
      description: partial.description || '',
      context: parentTask.context,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };
  }

  /**
   * 销毁 Orchestrator
   */
  async destroy(): Promise<void> {
    await this.stop();
    this.removeAllListeners();
  }

  private sortTasksByPriority(tasks: ITask[]): ITask[] {
    return [...tasks].sort((a, b) => {
      const priorityA = a.priority === 'high' ? 3 : a.priority === 'medium' ? 2 : 1;
      const priorityB = b.priority === 'high' ? 3 : b.priority === 'medium' ? 2 : 1;
      return priorityB - priorityA;
    });
  }

  private async getRegisteredIdleWorkers(): Promise<Worker[]> {
    const idleWorkers = await this.config.stateManager.getIdleWorkers();

    return idleWorkers
      .map((idleWorker) => this.config.workers.find((worker) => worker.id === idleWorker.id))
      .filter((worker): worker is Worker => worker !== undefined);
  }

  private async executeAssignedTask(task: ITask, worker: Worker): Promise<void> {
    await this.config.taskManager.assignTask(task.id, worker.id);

    task.assignedTo = worker.id;
    task.status = 'running';
    task.startedAt = new Date();

    this.emit('task-assigned', task, worker);

    try {
      await worker.receiveTask(task);
      await worker.executeTask(task);
    } catch (error) {
      this.emit('task-error', task, error instanceof Error ? error : new Error(String(error)));
    } finally {
      await this.refreshTaskSnapshot(task);
    }
  }

  private async refreshTaskSnapshot(task: ITask): Promise<void> {
    const latestTask = await this.config.taskManager.getTask(task.id);

    if (!latestTask) {
      return;
    }

    Object.assign(task, latestTask);
  }

  private async prepareTaskForRetry(task: ITask): Promise<void> {
    await this.config.taskManager.resetTaskForRetry(task.id);

    task.assignedTo = null;
    task.status = 'pending';
    task.result = null;
    task.error = null;
    task.startedAt = null;
    task.completedAt = null;
  }

  private formatConversationHistory(context: Record<string, unknown>): string | null {
    const history = context.conversationHistory;

    if (!Array.isArray(history) || history.length === 0) {
      return null;
    }

    const turns = history
      .filter((turn): turn is ConversationTurn => {
        if (typeof turn !== 'object' || turn === null) {
          return false;
        }

        const role = (turn as { role?: unknown }).role;
        const content = (turn as { content?: unknown }).content;
        return (
          (role === 'user' || role === 'assistant') &&
          typeof content === 'string' &&
          content.trim().length > 0
        );
      })
      .slice(-8);

    if (turns.length === 0) {
      return null;
    }

    return turns
      .map((turn, index) => {
        const sender = turn.sender || (turn.role === 'assistant' ? '助手' : '用户');
        return `${index + 1}. ${sender}: ${turn.content}`;
      })
      .join('\n');
  }

  private estimateTaskDifficulty(description: string): TaskDifficulty {
    const complexitySignals = [
      /并且|同时|另外|分别|多个|多步/gi,
      /开发|实现|设计|重构|优化|排查|修复|部署|集成/gi,
      /前端|后端|数据库|接口|测试|文档|脚本|配置/gi,
    ];
    const signalCount = complexitySignals.reduce((count, pattern) => {
      return count + (description.match(pattern)?.length || 0);
    }, 0);

    if (description.length >= 120 || signalCount >= 4 || description.includes('\n')) {
      return 'complex';
    }

    if (description.length >= 40 || signalCount >= 2) {
      return 'medium';
    }

    return 'simple';
  }

  private estimateWorkerCount(difficulty: TaskDifficulty): number {
    if (difficulty === 'complex') {
      return 3;
    }

    if (difficulty === 'medium') {
      return 2;
    }

    return 1;
  }

  private normalizeWorkerCount(count: number | undefined, fallback = 1): number {
    if (typeof count !== 'number' || Number.isNaN(count) || !Number.isFinite(count)) {
      return Math.max(1, fallback);
    }

    return Math.max(1, Math.floor(count));
  }

  private async generateFinalOpinion(
    results: IntegratedTaskResultSummary[],
    failures: IntegratedTaskFailureSummary[]
  ): Promise<string | undefined> {
    if (results.length === 0 && failures.length === 0) {
      return undefined;
    }

    const prompt = buildFinalOpinionPrompt(results, failures);

    try {
      const response = await this.config.apiClient.sendMessage(
        [
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          system: '你负责把多个子任务结果压缩成给用户看的最终结论。输出要短、准、结构化，不要出现 task、worker、子任务、过程说明。',
          temperature: 0.2,
          maxOutputTokens: 260,
        }
      );

      const opinion = normalizeFinalOpinion(response.content);
      if (opinion) {
        return opinion;
      }
    } catch {
      // 总结失败时回退到启发式归纳，避免影响主流程
    }

    return buildFallbackFinalOpinion(results, failures);
  }
}

function getTaskFailureMessage(task: ITask): string {
  if (typeof task.error === 'string' && task.error.trim().length > 0) {
    return task.error.trim();
  }

  if (
    typeof task.result === 'object' &&
    task.result !== null &&
    'summary' in task.result &&
    typeof (task.result as { summary?: unknown }).summary === 'string'
  ) {
    return (task.result as { summary: string }).summary;
  }

  return '任务执行失败';
}

function buildFinalOpinionPrompt(
  results: IntegratedTaskResultSummary[],
  failures: IntegratedTaskFailureSummary[]
): string {
  const sections = [
    '请基于以下执行结果，输出给最终用户看的结构化结论。',
    '要求：',
    '1. 使用以下结构输出：',
    '📌 结论',
    '- 一句话总判断',
    '',
    '📎 要点',
    '- 2 到 4 条关键点',
    '',
    '💡 建议',
    '- 1 到 3 条下一步建议，没有可省略',
    '2. 只面向最终用户，不要提 task、worker、子任务、过程。',
    '3. 简洁直接，一语中的。',
  ];

  if (results.length > 0) {
    sections.push('', '已完成内容：');
    for (const item of results.slice(0, 6)) {
      sections.push(`- ${item.description}: ${serializeResultForFinalOpinion(item.result)}`);
    }
  }

  if (failures.length > 0) {
    sections.push('', '失败或阻塞：');
    for (const item of failures.slice(0, 4)) {
      sections.push(`- ${item.description}: ${item.error}; ${serializeResultForFinalOpinion(item.result)}`);
    }
  }

  return sections.join('\n');
}

function serializeResultForFinalOpinion(result: unknown): string {
  if (typeof result === 'string') {
    return collapseWhitespace(result).slice(0, 500);
  }

  if (
    typeof result === 'object' &&
    result !== null &&
    'summary' in result &&
    typeof (result as { summary?: unknown }).summary === 'string'
  ) {
    return collapseWhitespace((result as { summary: string }).summary).slice(0, 500);
  }

  return collapseWhitespace(JSON.stringify(result)).slice(0, 500);
}

function normalizeFinalOpinion(content: string): string | undefined {
  const normalized = content.replace(/\r/g, '').trim();
  if (!normalized) {
    return undefined;
  }

  const normalizedBlocks = normalized
    .replace(/([。；])\s*(\d+[.)、])/gu, '$1\n$2')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalizedBlocks.length === 0) {
    return undefined;
  }

  if (!normalizedBlocks.some((line) => isOpinionHeading(line))) {
    return buildStructuredOpinionFromPlainLines(normalizedBlocks);
  }

  const sections: string[] = [];
  let hasHeading = false;

  for (const line of normalizedBlocks) {
    if (isOpinionHeading(line)) {
      if (sections.length > 0 && sections[sections.length - 1] !== '') {
        sections.push('');
      }
      sections.push(formatOpinionHeading(line));
      hasHeading = true;
      continue;
    }

    const bullet = normalizeOpinionBullet(line);
    if (!hasHeading) {
      sections.push('📌 结论');
      hasHeading = true;
    }
    sections.push(bullet);
  }

  return sections.join('\n').trim();
}

function buildStructuredOpinionFromPlainLines(lines: string[]): string {
  const cleanedLines = lines
    .map((line) => line.replace(/^(\d+[.)、]|[-*+•])\s*/u, '').trim())
    .filter(Boolean);
  const conclusion = cleanedLines[0] || '已形成阶段性结论';
  const remaining = cleanedLines.slice(1);
  const risks = remaining.filter((line) => isRiskOpinionLine(line)).slice(0, 2);
  const advice = remaining.filter((line) => isAdviceOpinionLine(line)).slice(0, 2);
  const points = remaining
    .filter((line) => !risks.includes(line) && !advice.includes(line))
    .slice(0, 3);

  const sections = [
    '📌 结论',
    normalizeOpinionBullet(conclusion),
  ];

  if (points.length > 0) {
    sections.push('', '📎 要点', ...points.map((line) => normalizeOpinionBullet(line)));
  }

  if (risks.length > 0) {
    sections.push('', '⚠️ 风险', ...risks.map((line) => normalizeOpinionBullet(line)));
  }

  if (advice.length > 0) {
    sections.push('', '💡 建议', ...advice.map((line) => normalizeOpinionBullet(line)));
  }

  return sections.join('\n');
}

function buildFallbackFinalOpinion(
  results: IntegratedTaskResultSummary[],
  failures: IntegratedTaskFailureSummary[]
): string | undefined {
  const completed = results
    .map((item) => extractPrimarySentence(serializeResultForFinalOpinion(item.result)))
    .filter(Boolean)
    .slice(0, 2);
  const blocked = failures
    .map((item) => extractPrimarySentence(item.error))
    .filter(Boolean)
    .slice(0, 2);

  if (completed.length === 0 && blocked.length === 0) {
    return undefined;
  }

  const sections: string[] = [];

  if (completed.length === 0) {
    sections.push(
      '📌 结论',
      `- 当前还不能给出可靠结论，主要阻塞在${blocked.join('、')}。`
    );
    sections.push('', '💡 建议', `- 优先处理${blocked.join('、')}。`);
    return sections.join('\n');
  }

  sections.push('📌 结论', `- ${completed[0]}。`);

  const points = completed.slice(1);
  if (points.length > 0) {
    sections.push('', '📎 要点', ...points.map((item) => `- ${item}。`));
  }

  if (blocked.length > 0) {
    sections.push('', '⚠️ 风险', ...blocked.map((item) => `- ${item}。`));
    sections.push('', '💡 建议', `- 优先处理${blocked.join('、')}。`);
  }

  return sections.join('\n');
}

function extractPrimarySentence(content: string): string {
  const normalized = collapseWhitespace(content);
  const match = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/u);
  return match?.[0]?.trim().replace(/[。！？!?；;]+$/u, '') || normalized;
}

function collapseWhitespace(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function isOpinionHeading(line: string): boolean {
  return /^(📌|📎|💡|⚠️)?\s*(结论|要点|重点|建议|风险|问题|总结|总判断)/u.test(line);
}

function isRiskOpinionLine(line: string): boolean {
  return /(风险|问题|阻塞|失败|瓶颈|异常|隐患|不足)/u.test(line);
}

function isAdviceOpinionLine(line: string): boolean {
  return /(建议|优先|下一步|可以|应当|推荐|需要)/u.test(line);
}

function formatOpinionHeading(line: string): string {
  const cleaned = line.replace(/[:：]\s*$/u, '').replace(/^(📌|📎|💡|⚠️)\s*/u, '').trim();

  if (cleaned.includes('建议')) {
    return '💡 建议';
  }

  if (cleaned.includes('风险') || cleaned.includes('问题')) {
    return '⚠️ 风险';
  }

  if (cleaned.includes('要点') || cleaned.includes('重点')) {
    return '📎 要点';
  }

  return '📌 结论';
}

function normalizeOpinionBullet(line: string): string {
  const cleaned = line
    .replace(/^[-*+•]\s*/u, '')
    .replace(/^\d+[.)、]\s*/u, '')
    .trim();

  const withEnding = /[。！？!?]$/u.test(cleaned) ? cleaned : `${cleaned}。`;
  return `- ${withEnding}`;
}

/**
 * 获取默认 Orchestrator 系统提示词
 */
function getDefaultOrchestratorSystemPrompt(): string {
  return `你是一个 Codex 风格 AI 团队的总指挥（大哥），负责协调多个小弟完成用户的任务。

## 你的职责

1. **理解用户需求**：分析用户的请求，分解成可执行的子任务
2. **任务分配**：先判断任务难度和用户最近问答，再决定安排多少名小弟执行
3. **进度监控**：跟踪所有小弟的工作进度
4. **质量把控**：检查小弟的工作成果
5. **错误处理**：当小弟遇到问题时，重新分配任务或创建新小弟

## 任务分解原则

1. **独立性**：子任务之间尽量独立，可并行执行
2. **粒度**：每个子任务 15-30 分钟完成
3. **清晰性**：任务描述清晰，包含完整上下文
4. **可验证**：每个子任务有明确的完成标准
5. **人数合理**：简单任务至少安排 1 名小弟，复杂任务再增加人数

## 可用资源

- 所有 Codex 的配置和记忆
- 所有 Skills、Agents、MCP
- 可以创建新的小弟（如果需要）

## 重要规则

- 优先分配给空闲的小弟
- 任务描述要清晰具体
- 必要时可以要求小弟调用特定的 Skill
- 如果不确定，可以 @老大 询问
- 小弟完成任务后，要检查成果并汇报给老大`;
}
