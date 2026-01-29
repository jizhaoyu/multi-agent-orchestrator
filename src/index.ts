/**
 * Multi-Agent Orchestrator
 * 入口文件
 */

// 导出核心类型
export * from './types';

// 导出 Claude 集成
export * from './integrations/claude';

// 导出核心模块
export { MemoryService } from './core/memory-service';
export type { MemoryServiceConfig } from './core/memory-service';

export { StateManager } from './core/state-manager';
export type { StateManagerConfig } from './core/state-manager';

export { TaskManager } from './core/task-manager';
export type { TaskManagerConfig } from './core/task-manager';

export { Worker } from './core/worker';
export type { WorkerConfig, WorkerProgressEvent } from './core/worker';

export { Orchestrator } from './core/orchestrator';
export type { OrchestratorConfig } from './core/orchestrator';
