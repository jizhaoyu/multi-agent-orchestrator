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
} from '@/types';
import { ClaudeAPIClient, ContextBuilder } from '@/integrations/claude';
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

  /** Claude API 客户端 */
  apiClient: ClaudeAPIClient;

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
  async receiveTask(userInput: string): Promise<ITask> {
    const task: ITask = {
      id: uuidv4(),
      parentId: null,
      assignedTo: null,
      status: 'pending',
      priority: 'high',
      depth: 0,
      description: userInput,
      context: {},
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
      // 构建上下文
      const context = await this.buildDecomposeContext(task);

      // 调用 Claude API
      const response = await this.config.apiClient.sendMessage(context.messages, {
        system: context.system,
      });

      // 更新统计
      this.stats.totalTokens += response.tokensUsed.total;

      // 解析子任务
      const subtasks = this.parseSubtasks(response.content, task);

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
  async assignTasks(tasks: ITask[]): Promise<void> {
    // 获取空闲 Worker
    const idleWorkers = await this.config.stateManager.getIdleWorkers();

    if (idleWorkers.length === 0) {
      this.emit('no-idle-workers', tasks);
      return;
    }

    // 按优先级排序任务
    const sortedTasks = [...tasks].sort((a, b) => {
      const priorityA = a.priority === 'high' ? 3 : a.priority === 'medium' ? 2 : 1;
      const priorityB = b.priority === 'high' ? 3 : b.priority === 'medium' ? 2 : 1;
      return priorityB - priorityA;
    });

    // 分配任务
    let workerIndex = 0;
    for (const task of sortedTasks) {
      if (workerIndex >= idleWorkers.length) {
        break; // 没有更多空闲 Worker
      }

      const worker = idleWorkers[workerIndex];
      if (!worker) continue;

      await this.config.taskManager.assignTask(task.id, worker.id);

      this.emit('task-assigned', task, worker);

      workerIndex++;
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
        // 检查运行中的任务
        const runningTasks = await this.config.taskManager.getRunningTasks();

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

    // 简单的质量检查：结果不为空
    // 实际应用中可以使用 Claude API 进行更复杂的质量评估
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
  private async buildDecomposeContext(task: ITask): Promise<{
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    system?: string;
  }> {
    const builder = new ContextBuilder();

    builder.setSystemPrompt(this.config.systemPrompt);

    let message = `请将以下任务分解为可并行执行的子任务：\n\n${task.description}\n\n`;

    message += `要求：\n`;
    message += `1. 每个子任务应该独立且可并行执行\n`;
    message += `2. 子任务粒度适中（15-30 分钟完成）\n`;
    message += `3. 子任务描述清晰，包含完整上下文\n`;
    message += `4. 使用以下格式输出：\n\n`;
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
   * 解析子任务
   */
  private parseSubtasks(content: string, parentTask: ITask): ITask[] {
    const subtasks: ITask[] = [];
    const lines = content.split('\n');

    let currentSubtask: Partial<ITask> | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.startsWith('子任务')) {
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

    return subtasks;
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
}

/**
 * 获取默认 Orchestrator 系统提示词
 */
function getDefaultOrchestratorSystemPrompt(): string {
  return `你是一个 AI 团队的总指挥（大哥），负责协调多个小弟完成用户的任务。

## 你的职责

1. **理解用户需求**：分析用户的请求，分解成可执行的子任务
2. **任务分配**：将子任务分配给空闲的小弟
3. **进度监控**：跟踪所有小弟的工作进度
4. **质量把控**：检查小弟的工作成果
5. **错误处理**：当小弟遇到问题时，重新分配任务或创建新小弟

## 任务分解原则

1. **独立性**：子任务之间尽量独立，可并行执行
2. **粒度**：每个子任务 15-30 分钟完成
3. **清晰性**：任务描述清晰，包含完整上下文
4. **可验证**：每个子任务有明确的完成标准

## 可用资源

- 所有 Claude Code 的配置和记忆
- 所有 Skills、Agents、MCP
- 可以创建新的小弟（如果需要）

## 重要规则

- 优先分配给空闲的小弟
- 任务描述要清晰具体
- 必要时可以要求小弟调用特定的 Skill
- 如果不确定，可以 @老大 询问
- 小弟完成任务后，要检查成果并汇报给老大`;
}
