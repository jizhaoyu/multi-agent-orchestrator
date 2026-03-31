/**
 * 核心类型定义
 * Multi-Agent Orchestrator 系统的核心接口和类型
 */

/**
 * Agent 类型
 */
export type AgentType = 'orchestrator' | 'worker';

/**
 * Agent 状态
 */
export type AgentStatus = 'idle' | 'busy' | 'error';

/**
 * 任务状态
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * 任务优先级
 */
export type TaskPriority = 'high' | 'medium' | 'low';

/**
 * 任务难度
 */
export type TaskDifficulty = 'simple' | 'medium' | 'complex';

/**
 * 对话上下文
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
  timestamp?: string;
}

/**
 * 任务执行计划
 */
export interface TaskExecutionPlan {
  difficulty: TaskDifficulty;
  recommendedWorkers: number;
  rationale: string;
}

/**
 * 任务分配配置
 */
export interface TaskAssignmentOptions {
  maxConcurrentWorkers?: number;
  shouldContinue?: () => boolean;
}

/**
 * Agent 接口
 */
export interface IAgent {
  /** Agent 唯一标识 */
  id: string;

  /** Agent 类型 */
  type: AgentType;

  /** Agent 状态 */
  status: AgentStatus;

  /** 当前执行的任务 ID */
  currentTaskId: string | null;

  /** 最后心跳时间 */
  lastHeartbeat: Date;

  /** 统计信息 */
  stats: AgentStats;
}

/**
 * Agent 统计信息
 */
export interface AgentStats {
  /** 完成的任务数 */
  tasksCompleted: number;

  /** 失败的任务数 */
  tasksFailed: number;

  /** 总 Token 消耗 */
  totalTokens: number;

  /** 平均完成时间（毫秒） */
  avgCompletionTime: number;
}

/**
 * 任务接口
 */
export interface ITask {
  /** 任务唯一标识 */
  id: string;

  /** 父任务 ID */
  parentId: string | null;

  /** 分配给的 Agent ID */
  assignedTo: string | null;

  /** 任务状态 */
  status: TaskStatus;

  /** 任务优先级 */
  priority: TaskPriority;

  /** 任务深度（防止无限递归） */
  depth: number;

  /** 任务描述 */
  description: string;

  /** 任务上下文 */
  context: Record<string, unknown>;

  /** 任务结果 */
  result: unknown | null;

  /** 错误信息 */
  error: string | null;

  /** 创建时间 */
  createdAt: Date;

  /** 开始时间 */
  startedAt: Date | null;

  /** 完成时间 */
  completedAt: Date | null;
}

/**
 * Orchestrator 接口
 */
export interface IOrchestrator {
  /** 接收用户任务 */
  receiveTask(userInput: string, context?: Record<string, unknown>): Promise<ITask>;

  /** 任务分解 */
  decomposeTask(task: ITask): Promise<ITask[]>;

  /** 任务分配 */
  assignTasks(tasks: ITask[], options?: TaskAssignmentOptions): Promise<void>;

  /** 监控进度 */
  monitorProgress(): Promise<void>;

  /** 质量把控 */
  reviewResults(task: ITask): Promise<boolean>;

  /** 错误处理 */
  handleError(task: ITask, error: Error): Promise<void>;

  /** 结果整合 */
  integrateResults(tasks: ITask[]): Promise<unknown>;
}

/**
 * Worker 接口
 */
export interface IWorker {
  /** 接收任务 */
  receiveTask(task: ITask): Promise<void>;

  /** 执行任务 */
  executeTask(task: ITask): Promise<unknown>;

  /** 发送心跳 */
  sendHeartbeat(): Promise<void>;

  /** 报告进度 */
  reportProgress(progress: number, message: string): Promise<void>;

  /** 请求帮助 */
  requestHelp(issue: string): Promise<void>;

  /** 分配子任务 */
  delegateSubtask(subtask: ITask): Promise<void>;
}

/**
 * Task Manager 接口
 */
export interface ITaskManager {
  /** 添加任务 */
  addTask(task: ITask): Promise<void>;

  /** 获取下一个任务 */
  getNextTask(): Promise<ITask | null>;

  /** 更新任务状态 */
  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    result?: unknown,
    error?: string
  ): Promise<void>;

  /** 获取任务树 */
  getTaskTree(rootTaskId: string): Promise<ITask[]>;

  /** 获取所有运行中的任务 */
  getRunningTasks(): Promise<ITask[]>;
}

/**
 * State Manager 接口
 */
export interface IStateManager {
  /** 注册 Agent */
  registerAgent(agent: IAgent): Promise<void>;

  /** 更新状态 */
  updateStatus(
    agentId: string,
    status: AgentStatus,
    currentTaskId: string | null
  ): Promise<void>;

  /** 更新心跳 */
  updateHeartbeat(agentId: string): Promise<void>;

  /** 获取空闲 Worker */
  getIdleWorkers(): Promise<IAgent[]>;

  /** 获取统计信息 */
  getStats(agentId: string): Promise<AgentStats>;
}

/**
 * Memory Service 接口
 */
export interface IMemoryService {
  /** 读取记忆 */
  read(path: string): Promise<unknown>;

  /** 写入记忆 */
  write(path: string, data: unknown): Promise<void>;

  /** 订阅变更 */
  subscribe(path: string, callback: (data: unknown) => void): void;

  /** 取消订阅 */
  unsubscribe(path: string, callback: (data: unknown) => void): void;
}
