/**
 * Multi-Agent Orchestrator
 * 入口文件
 */

// 导出核心类型
export * from './types';

// 导出通用 LLM 集成
export { ContextBuilder } from './integrations/llm';
export type {
  LLMClient,
  LLMMessage,
  LLMMessageRole,
  LLMRequestOptions,
  LLMResponse,
  Message,
  MessageRole,
  StreamCallback,
} from './integrations/llm';

// 导出 Codex/OpenAI-compatible 集成
export { CodexAPIClient } from './integrations/codex';
export type { CodexAPIConfig } from './integrations/codex';

// 导出 Claude 兼容集成
export { ClaudeAPIClient } from './integrations/claude';
export type { ClaudeAPIConfig, ClaudeAPIResponse } from './integrations/claude';
export { RetryStrategy, withRetry, isRetryableError, DEFAULT_RETRY_CONFIG } from './integrations/claude';
export type { RetryConfig } from './integrations/claude';

// 导出环境变量工厂
export { createAPIClientFromEnv } from './integrations/client-factory';
export type { AIProvider } from './integrations/client-factory';

// 导出 Telegram 集成
export * from './integrations/telegram';

// 导出 Harness 模块
export * from './harness';

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

export { WorkspaceExecutor } from './core/workspace-executor';
export type {
  WorkspaceExecutorConfig,
  WorkspaceExecutionResult,
  WorkspaceCommandResult,
  WorkspaceExecutionProgressEvent,
} from './core/workspace-executor';
