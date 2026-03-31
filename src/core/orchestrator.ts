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

/**
 * Orchestrator（大哥）
 */
export class Orchestrator extends EventEmitter implements IOrchestrator, IAgent {
  private config: Required<Omit<OrchestratorConfig, 'apiClient' | 'stateManager' | 'taskManager' | 'memoryService' | 'workers'>> & OrchestratorConfig;
  private monitorTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

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

    // 注册到状态管理器
    this.register();
  }

  /**
   * 接收用户任务
   */
  async receiveTask(
    userInput: string,
    context: Record<string, unknown> = {}
  ): Promise<ITask> {
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

      // 添加子任务到任务管理器
      for (const subtask of subtasks) {
        await this.config.taskManager.addTask(subtask);
      }

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
    this.emit('task-error', task, error);

    // 获取空闲 Worker
    const idleWorkers = await this.config.stateManager.getIdleWorkers();

    if (idleWorkers.length > 0) {
      // 重新分配给空闲 Worker
      const worker = idleWorkers[0];
      if (!worker) return;

      await this.config.taskManager.updateTaskStatus(task.id, 'pending');
      await this.config.taskManager.assignTask(task.id, worker.id);

      this.emit('task-reassigned', task, worker);
    } else {
      // 没有空闲 Worker，创建新的
      const newWorker = await this.createNewWorker();

      await this.config.taskManager.updateTaskStatus(task.id, 'pending');
      await this.config.taskManager.assignTask(task.id, newWorker.id);

      this.emit('worker-created', newWorker);
      this.emit('task-reassigned', task, newWorker);
    }
  }

  /**
   * 结果整合
   */
  async integrateResults(tasks: ITask[]): Promise<unknown> {
    const results = tasks
      .filter((t) => t.status === 'completed' && t.result)
      .map((t) => ({
        taskId: t.id,
        description: t.description,
        result: t.result,
      }));

    return {
      totalTasks: tasks.length,
      completedTasks: results.length,
      results,
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
  }> {
    const tasks = await this.config.taskManager.getTaskTree(rootTaskId);
    if (tasks.length === 0) {
      return {
        rootTaskFound: false,
        cancelledPendingCount: 0,
        runningCount: 0,
      };
    }

    let cancelledPendingCount = 0;
    let runningCount = 0;

    for (const task of tasks) {
      if (task.status === 'pending') {
        await this.config.taskManager.updateTaskStatus(task.id, 'failed', null, reason);
        task.status = 'failed';
        task.error = reason;
        cancelledPendingCount++;
        continue;
      }

      if (task.status === 'running') {
        runningCount++;
      }
    }

    return {
      rootTaskFound: true,
      cancelledPendingCount,
      runningCount,
    };
  }

  /**
   * 启动 Orchestrator
   */
  async start(): Promise<void> {
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

  /**
   * 注册到状态管理器
   */
  private async register(): Promise<void> {
    await this.config.stateManager.registerAgent(this);
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
