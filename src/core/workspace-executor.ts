/**
 * 本地工作区执行器
 * 让 Worker 可以在真实工作区内读取文件、写入文件并运行命令
 */

import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import type { ITask } from '@/types';
import type { LLMClient } from '@/integrations/llm';
import {
  assertCommandAllowed,
  type FailureClass,
  FailureMemoryStore,
  type HarnessHooks,
  type PermissionProfile,
  createTraceId,
  type TraceRecorder,
  VerificationEngine,
  type VerificationCheckResult,
  type VerificationPolicy,
  type VerificationResult,
} from '@/harness';

const exec = promisify(execCallback);

export interface WorkspaceExecutorConfig {
  /** 工作区根目录 */
  workspaceRoot: string;

  /** AI 客户端 */
  apiClient: LLMClient;

  /** 最大行动轮数 */
  maxIterations?: number;

  /** 命令超时时间（毫秒） */
  commandTimeoutMs?: number;

  /** 单次最多读取文件数 */
  maxReadFilesPerStep?: number;

  /** 单文件最大读取字符数 */
  maxFileReadChars?: number;

  /** 目录树最大节点数 */
  maxTreeEntries?: number;

  /** 忽略目录 */
  excludedDirectories?: string[];

  /** 验证策略 */
  verificationPolicy?: VerificationPolicy;

  /** 命令权限档位 */
  permissionProfile?: PermissionProfile;

  /** Trace 记录器 */
  traceRecorder?: TraceRecorder;

  /** 生命周期 Hooks */
  hooks?: HarnessHooks;

  /** 是否记录失败目录 */
  recordFailuresToCatalog?: boolean;

  /** 失败目录路径 */
  failureCatalogPath?: string;

  /** 过程进度回调 */
  onProgress?: (event: WorkspaceExecutionProgressEvent) => void | Promise<void>;
}

export interface WorkspaceCommandResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface WorkspaceExecutionResult {
  mode: 'workspace';
  traceId: string;
  attemptId: string | null;
  summary: string;
  changedFiles: string[];
  verification: string[];
  checks: VerificationCheckResult[];
  verdict: VerificationResult['verdict'];
  failureClass: FailureClass | null;
  revisionPrompt: string | null;
  notes: string[];
  commandResults: WorkspaceCommandResult[];
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}

export interface WorkspaceExecutionProgressEvent {
  progress: number;
  message: string;
  step: number;
  actionType: PlannerAction['type'] | 'setup' | 'finish';
}

type PlannerAction =
  | {
      type: 'read_files';
      reason?: string;
      files: string[];
    }
  | {
      type: 'find_files';
      reason?: string;
      query: string;
      limit?: number;
    }
  | {
      type: 'write_files';
      reason?: string;
      writes: Array<{
        path: string;
        content: string;
      }>;
    }
  | {
      type: 'run_command';
      reason?: string;
      command: string;
    }
  | {
      type: 'finish';
      reason?: string;
      summary: string;
      changedFiles?: string[];
      verification?: string[];
      notes?: string[];
    };

interface ExecutionState {
  traceId: string;
  taskId: string;
  observations: string[];
  inspectedFiles: Map<string, string>;
  changedFiles: Set<string>;
  commandResults: WorkspaceCommandResult[];
  verification: VerificationResult | null;
  lastRevisionPrompt: string | null;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
}

export class WorkspaceExecutor {
  private config: WorkspaceExecutorConfig & {
    maxIterations: number;
    commandTimeoutMs: number;
    maxReadFilesPerStep: number;
    maxFileReadChars: number;
    maxTreeEntries: number;
    excludedDirectories: string[];
    permissionProfile: PermissionProfile;
    recordFailuresToCatalog: boolean;
    failureCatalogPath: string;
  };
  private readonly verificationEngine: VerificationEngine;
  private readonly failureMemory: FailureMemoryStore | null;

  constructor(config: WorkspaceExecutorConfig) {
    const workspaceHarnessConfig = loadWorkspaceHarnessConfig(config.workspaceRoot);
    this.config = {
      ...config,
      maxIterations: config.maxIterations ?? 6,
      commandTimeoutMs: config.commandTimeoutMs ?? 120000,
      maxReadFilesPerStep: config.maxReadFilesPerStep ?? 4,
      maxFileReadChars: config.maxFileReadChars ?? 20000,
      maxTreeEntries: config.maxTreeEntries ?? 200,
      excludedDirectories: config.excludedDirectories ?? [
        '.git',
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.next',
      ],
      verificationPolicy: config.verificationPolicy ?? workspaceHarnessConfig.verificationPolicy,
      permissionProfile:
        config.permissionProfile ??
        workspaceHarnessConfig.permissionProfile ??
        'dev_safe',
      traceRecorder: config.traceRecorder,
      hooks: config.hooks,
      recordFailuresToCatalog: config.recordFailuresToCatalog ?? true,
      failureCatalogPath: config.failureCatalogPath ?? 'docs/failure-catalog.md',
    };

    this.failureMemory = this.config.recordFailuresToCatalog
      ? new FailureMemoryStore({
          workspaceRoot: this.config.workspaceRoot,
          relativePath: this.config.failureCatalogPath,
        })
      : null;
    this.verificationEngine = new VerificationEngine({
      workspaceRoot: this.config.workspaceRoot,
      runCommand: async (command) => this.executeCommand(command),
      permissionProfile: this.config.permissionProfile,
      policy: this.config.verificationPolicy,
      traceRecorder: this.config.traceRecorder,
      hooks: this.config.hooks,
      failureMemory: this.failureMemory || undefined,
    });
  }

  async executeTask(task: ITask): Promise<WorkspaceExecutionResult> {
    const state: ExecutionState = {
      traceId: createTraceId('task'),
      taskId: task.id,
      observations: [],
      inspectedFiles: new Map<string, string>(),
      changedFiles: new Set<string>(),
      commandResults: [],
      verification: null,
      lastRevisionPrompt: null,
      tokenUsage: {
        input: 0,
        output: 0,
        total: 0,
      },
    };

    state.observations.push(`工作区根目录: ${this.config.workspaceRoot}`);
    state.observations.push(`目录结构:\n${await this.buildWorkspaceTree()}`);
    await this.reportProgress({
      progress: 5,
      message: `已加载项目目录 ${path.basename(this.config.workspaceRoot) || this.config.workspaceRoot}`,
      step: 0,
      actionType: 'setup',
    });

    const gitStatus = await this.tryGetGitStatus();
    if (gitStatus) {
      state.observations.push(`Git 状态:\n${gitStatus}`);
    }

    const recentFailures = await this.failureMemory?.getRecentSummaries(2);
    if (recentFailures && recentFailures.length > 0) {
      state.observations.push(`最近失败记忆:\n${recentFailures.join('\n\n')}`);
    }

    for (let step = 1; step <= this.config.maxIterations; step++) {
      await this.config.traceRecorder?.record({
        trace_id: state.traceId,
        task_id: task.id,
        attempt_id: `step-${step}`,
        kind: 'before_prompt',
        role: 'workspace-controller',
        message: `workspace-step-${step}`,
      });

      const promptStartedAt = Date.now();
      const response = await this.config.apiClient.sendMessage(
        [
          {
            role: 'user',
            content: this.buildActionPrompt(task, state, step),
          },
        ],
        {
          system: getWorkspaceControllerSystemPrompt(),
        }
      );
      await this.config.traceRecorder?.record({
        trace_id: state.traceId,
        task_id: task.id,
        attempt_id: `step-${step}`,
        kind: 'after_response',
        role: 'workspace-controller',
        duration_ms: Date.now() - promptStartedAt,
        token_in: response.tokensUsed.input,
        token_out: response.tokensUsed.output,
        message: response.stopReason || 'stop',
        metadata: {
          model: response.model,
        },
      });

      state.tokenUsage.input += response.tokensUsed.input;
      state.tokenUsage.output += response.tokensUsed.output;
      state.tokenUsage.total += response.tokensUsed.total;

      const action = this.parseAction(response.content);
      await this.reportProgress({
        progress: this.getActionProgress(step),
        message: this.describeAction(action),
        step,
        actionType: action.type,
      });

      if (action.type === 'read_files') {
        await this.handleReadFiles(action, state);
        continue;
      }

      if (action.type === 'find_files') {
        await this.handleFindFiles(action, state);
        continue;
      }

      if (action.type === 'write_files') {
        await this.handleWriteFiles(action, state);
        continue;
      }

      if (action.type === 'run_command') {
        await this.handleRunCommand(action, state);
        continue;
      }

      await this.reportProgress({
        progress: 95,
        message: '正在整理执行结果',
        step,
        actionType: 'finish',
      });
      const changedFiles = this.mergeChangedFiles(state, action.changedFiles);
      const attemptId = `finish-${step}`;
      const verification = await this.verificationEngine.verifyCompletion({
        task,
        changedFiles,
        verification: action.verification,
        summary: action.summary,
        notes: action.notes,
        attemptId,
      });
      state.verification = verification;
      state.lastRevisionPrompt = verification.revisionPrompt;
      state.commandResults.push(
        ...verification.checks.map((check) => ({
          command: check.command,
          exitCode: check.exitCode,
          ok: check.ok,
          stdout: check.stdout,
          stderr: check.stderr,
        }))
      );

      if (verification.verdict === 'failed') {
        state.observations.push(`Verifier verdict: failed\n${verification.summary}`);
        if (verification.revisionPrompt) {
          state.observations.push(verification.revisionPrompt);
        }

        await this.config.hooks?.taskFailed?.({
          traceId: state.traceId,
          taskId: task.id,
          attemptId,
          verdict: verification.verdict,
          failureClass: verification.failureClass,
          message: verification.summary,
        });
        await this.config.traceRecorder?.record({
          trace_id: state.traceId,
          task_id: task.id,
          attempt_id: attemptId,
          kind: 'task_failed',
          verdict: verification.verdict,
          failure_class: verification.failureClass,
          message: verification.summary,
        });

        if (step < this.config.maxIterations) {
          continue;
        }

        return {
          mode: 'workspace',
          traceId: state.traceId,
          attemptId,
          summary: action.summary || action.reason || verification.summary,
          changedFiles,
          verification: verification.executedCommands,
          checks: verification.checks,
          verdict: verification.verdict,
          failureClass: verification.failureClass,
          revisionPrompt: verification.revisionPrompt,
          notes: [...(action.notes || []), verification.summary],
          commandResults: state.commandResults,
          tokenUsage: state.tokenUsage,
        };
      }

      await this.config.hooks?.taskCompleted?.({
        traceId: state.traceId,
        taskId: task.id,
        attemptId,
        verdict: verification.verdict,
        failureClass: verification.failureClass,
        message: action.summary || action.reason || '任务执行完成。',
      });
      await this.config.traceRecorder?.record({
        trace_id: state.traceId,
        task_id: task.id,
        attempt_id: attemptId,
        kind: 'task_completed',
        verdict: verification.verdict,
        message: action.summary || action.reason || '任务执行完成。',
      });

      return {
        mode: 'workspace',
        traceId: state.traceId,
        attemptId,
        summary: action.summary || action.reason || '任务执行完成。',
        changedFiles,
        verification: verification.executedCommands,
        checks: verification.checks,
        verdict: verification.verdict,
        failureClass: verification.failureClass,
        revisionPrompt: verification.revisionPrompt,
        notes: action.notes || [],
        commandResults: state.commandResults,
        tokenUsage: state.tokenUsage,
      };
    }

    return {
      mode: 'workspace',
      traceId: state.traceId,
      attemptId: null,
      summary: '达到最大执行轮数，已停止自动执行。',
      changedFiles: [...state.changedFiles],
      verification: [],
      checks: state.verification?.checks || [],
      verdict: state.verification?.verdict || 'failed',
      failureClass: state.verification?.failureClass || 'unexpected_error',
      revisionPrompt: state.lastRevisionPrompt,
      notes: ['建议检查当前修改结果，并视情况继续执行。'],
      commandResults: state.commandResults,
      tokenUsage: state.tokenUsage,
    };
  }

  private buildActionPrompt(task: ITask, state: ExecutionState, step: number): string {
    const inspectedFiles = [...state.inspectedFiles.entries()]
      .map(([filePath, content]) => {
        return `文件: ${filePath}\n\`\`\`\n${content}\n\`\`\``;
      })
      .join('\n\n');
    const observations = state.observations.slice(-8).join('\n\n');

    return [
      `当前是第 ${step} 轮。`,
      `Trace ID: ${state.traceId}`,
      `目标任务: ${task.description}`,
      `任务上下文: ${JSON.stringify(task.context, null, 2)}`,
      observations ? `最近观察:\n${observations}` : '',
      inspectedFiles ? `已读取文件:\n${inspectedFiles}` : '',
      state.lastRevisionPrompt ? `上次修订指令:\n${state.lastRevisionPrompt}` : '',
      `请输出下一步 JSON 动作。`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private async handleReadFiles(
    action: Extract<PlannerAction, { type: 'read_files' }>,
    state: ExecutionState
  ): Promise<void> {
    const startedAt = Date.now();
    await this.recordBeforeTool(state, action.type, {
      files: action.files,
    });
    const files = action.files.slice(0, this.config.maxReadFilesPerStep);

    if (files.length === 0) {
      state.observations.push('read_files 动作未提供有效文件。');
      await this.recordAfterTool(state, action.type, startedAt, true, '未提供文件');
      return;
    }

    const contents = await Promise.all(
      files.map(async (filePath) => {
        try {
          const absolutePath = this.resolveWorkspacePath(filePath);
          const content = await fs.readFile(absolutePath, 'utf-8');
          return {
            path: this.normalizeRelativePath(filePath),
            content: truncateText(content, this.config.maxFileReadChars),
          };
        } catch (error) {
          return {
            path: this.normalizeRelativePath(filePath),
            content: `读取失败: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      })
    );

    for (const item of contents) {
      state.inspectedFiles.set(item.path, item.content);
    }

    state.observations.push(
      `已读取文件:\n${contents
        .map((item) => `${item.path}\n${item.content}`)
        .join('\n\n')}`
    );
    await this.recordAfterTool(state, action.type, startedAt, true, summarizeItems(files, 3));
  }

  private async handleFindFiles(
    action: Extract<PlannerAction, { type: 'find_files' }>,
    state: ExecutionState
  ): Promise<void> {
    const startedAt = Date.now();
    await this.recordBeforeTool(state, action.type, {
      query: action.query,
      limit: action.limit,
    });
    const query = action.query.trim();
    if (!query) {
      state.observations.push('find_files 动作未提供有效查询词。');
      await this.recordAfterTool(state, action.type, startedAt, true, '未提供查询词');
      return;
    }

    const limit = Math.max(1, Math.min(action.limit ?? 8, 20));
    const matches = await this.findFiles(query, limit);

    if (matches.length === 0) {
      state.observations.push(`模糊查找未命中文件: ${query}`);
      await this.recordAfterTool(state, action.type, startedAt, true, '无命中');
      return;
    }

    state.observations.push(
      `模糊查找结果 (${query}):\n${matches.map((filePath) => `- ${filePath}`).join('\n')}`
    );
    await this.recordAfterTool(state, action.type, startedAt, true, `${matches.length} 个命中`);
  }

  private async handleWriteFiles(
    action: Extract<PlannerAction, { type: 'write_files' }>,
    state: ExecutionState
  ): Promise<void> {
    const startedAt = Date.now();
    await this.recordBeforeTool(state, action.type, {
      files: action.writes.map((write) => write.path),
    });
    if (!Array.isArray(action.writes) || action.writes.length === 0) {
      state.observations.push('write_files 动作未提供有效写入内容。');
      await this.recordAfterTool(state, action.type, startedAt, true, '未提供写入内容');
      return;
    }

    const changedPaths: string[] = [];

    for (const write of action.writes) {
      const relativePath = this.normalizeRelativePath(write.path);
      const absolutePath = this.resolveWorkspacePath(relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, write.content, 'utf-8');

      changedPaths.push(relativePath);
      state.changedFiles.add(relativePath);
      state.inspectedFiles.set(relativePath, truncateText(write.content, this.config.maxFileReadChars));
    }

    state.observations.push(`已写入文件: ${changedPaths.join(', ')}`);
    await this.recordAfterTool(state, action.type, startedAt, true, summarizeItems(changedPaths, 3));
  }

  private async handleRunCommand(
    action: Extract<PlannerAction, { type: 'run_command' }>,
    state: ExecutionState
  ): Promise<void> {
    const command = action.command.trim();
    const startedAt = Date.now();
    await this.recordBeforeTool(state, action.type, {
      command,
    });
    this.validateCommand(command);

    const result = await this.executeCommand(command);
    state.commandResults.push(result);

    state.observations.push(
      [
        `命令: ${command}`,
        `退出码: ${result.exitCode ?? 'null'}`,
        result.stdout ? `stdout:\n${result.stdout}` : '',
        result.stderr ? `stderr:\n${result.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
    await this.recordAfterTool(
      state,
      action.type,
      startedAt,
      result.ok,
      result.ok ? '命令执行完成' : result.stderr || '命令执行失败',
      command
    );
  }

  private async executeCommand(command: string): Promise<WorkspaceCommandResult> {
    try {
      const output = await exec(command, {
        cwd: this.config.workspaceRoot,
        timeout: this.config.commandTimeoutMs,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          CI: process.env.CI || '1',
          FORCE_COLOR: '0',
        },
      });

      return {
        command,
        exitCode: 0,
        ok: true,
        stdout: truncateText(output.stdout || '', 12000),
        stderr: truncateText(output.stderr || '', 12000),
      };
    } catch (error) {
      const execError = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };

      return {
        command,
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        ok: false,
        stdout: truncateText(execError.stdout || '', 12000),
        stderr: truncateText(execError.stderr || execError.message, 12000),
      };
    }
  }

  private parseAction(content: string): PlannerAction {
    const candidates = extractJsonCandidates(content);
    const errors: string[] = [];

    for (const jsonText of candidates) {
      try {
        const parsed = JSON.parse(jsonText) as PlannerAction;

        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
          errors.push('缺少 type 字段');
          continue;
        }

        if (!isPlannerActionType(parsed.type)) {
          errors.push(`未知动作类型: ${String(parsed.type)}`);
          continue;
        }

        return parsed;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(
      `无效的执行动作响应: ${truncateText(content.replace(/\s+/g, ' ').trim(), 240)}; 解析错误: ${errors.join(
        ' | '
      )}`
    );
  }

  private async buildWorkspaceTree(): Promise<string> {
    const lines: string[] = [];
    let totalEntries = 0;

    const walk = async (currentPath: string, depth: number): Promise<void> => {
      if (totalEntries >= this.config.maxTreeEntries || depth > 3) {
        return;
      }

      const entries = await fs.readdir(currentPath, { withFileTypes: true });
      const sorted = entries
        .filter((entry) => !this.config.excludedDirectories.includes(entry.name))
        .sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) {
            return -1;
          }
          if (!a.isDirectory() && b.isDirectory()) {
            return 1;
          }
          return a.name.localeCompare(b.name);
        });

      for (const entry of sorted) {
        if (totalEntries >= this.config.maxTreeEntries) {
          lines.push(`${'  '.repeat(depth)}...`);
          return;
        }

        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(this.config.workspaceRoot, fullPath) || '.';
        lines.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '[D]' : '[F]'} ${relativePath}`);
        totalEntries++;

        if (entry.isDirectory()) {
          await walk(fullPath, depth + 1);
        }
      }
    };

    await walk(this.config.workspaceRoot, 0);

    return lines.join('\n');
  }

  private async tryGetGitStatus(): Promise<string | null> {
    try {
      const result = await exec('git status --short', {
        cwd: this.config.workspaceRoot,
        timeout: 15000,
        maxBuffer: 256 * 1024,
      });

      const status = result.stdout.trim();
      return status || null;
    } catch {
      return null;
    }
  }

  private resolveWorkspacePath(relativePath: string): string {
    const normalized = this.normalizeRelativePath(relativePath);
    const absolutePath = path.resolve(this.config.workspaceRoot, normalized);
    const rootPath = path.resolve(this.config.workspaceRoot);

    if (
      absolutePath !== rootPath &&
      !absolutePath.startsWith(`${rootPath}${path.sep}`)
    ) {
      throw new Error(`路径超出工作区范围: ${relativePath}`);
    }

    return absolutePath;
  }

  private normalizeRelativePath(filePath: string): string {
    return filePath.replace(/\\/g, '/').replace(/^\.\/+/, '');
  }

  private async findFiles(query: string, limit: number): Promise<string[]> {
    const matches: Array<{ filePath: string; score: number }> = [];
    let scannedEntries = 0;

    const walk = async (currentPath: string, depth: number): Promise<void> => {
      if (scannedEntries >= 5000 || depth > 8) {
        return;
      }

      let entries;
      try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      const sorted = entries
        .filter((entry) => !this.config.excludedDirectories.includes(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of sorted) {
        if (scannedEntries >= 5000) {
          return;
        }

        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          scannedEntries++;
          await walk(fullPath, depth + 1);
          continue;
        }

        if (!entry.isFile()) {
          continue;
        }

        scannedEntries++;
        const relativePath = this.normalizeRelativePath(
          path.relative(this.config.workspaceRoot, fullPath)
        );
        const score = scoreFileMatch(relativePath, query);
        if (score > 0) {
          matches.push({
            filePath: relativePath,
            score,
          });
        }
      }
    };

    await walk(this.config.workspaceRoot, 0);

    return matches
      .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
      .slice(0, limit)
      .map((item) => item.filePath);
  }

  private getActionProgress(step: number): number {
    const usableIterations = Math.max(1, this.config.maxIterations);
    return Math.min(90, 10 + Math.floor((step / usableIterations) * 70));
  }

  private describeAction(action: PlannerAction): string {
    switch (action.type) {
      case 'read_files':
        return `正在读取文件: ${summarizeItems(action.files, 3)}`;
      case 'find_files':
        return `正在模糊查找文件: ${action.query}`;
      case 'write_files':
        return `正在写入文件: ${summarizeItems(
          action.writes.map((item) => item.path),
          3
        )}`;
      case 'run_command':
        return `正在运行命令: ${truncateText(action.command, 80)}`;
      case 'finish':
        return '正在整理结果';
    }
  }

  private async reportProgress(event: WorkspaceExecutionProgressEvent): Promise<void> {
    if (!this.config.onProgress) {
      return;
    }

    await this.config.onProgress(event);
  }

  private async recordBeforeTool(
    state: ExecutionState,
    tool: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.config.hooks?.beforeTool?.({
      traceId: state.traceId,
      taskId: state.taskId,
      tool,
      metadata,
    });
    await this.config.traceRecorder?.record({
      trace_id: state.traceId,
      task_id: state.taskId,
      kind: 'before_tool',
      tool,
      metadata,
    });
  }

  private async recordAfterTool(
    state: ExecutionState,
    tool: string,
    startedAt: number,
    ok: boolean,
    message: string,
    command?: string
  ): Promise<void> {
    const durationMs = Date.now() - startedAt;
    await this.config.hooks?.afterTool?.({
      traceId: state.traceId,
      taskId: state.taskId,
      tool,
      command,
      durationMs,
      ok,
      stderr: ok ? undefined : message,
    });
    await this.config.traceRecorder?.record({
      trace_id: state.traceId,
      task_id: state.taskId,
      kind: 'after_tool',
      tool,
      duration_ms: durationMs,
      message,
      metadata: {
        ok,
        command,
      },
    });
  }

  private validateCommand(command: string): void {
    assertCommandAllowed(command, this.config.permissionProfile);
  }

  private mergeChangedFiles(state: ExecutionState, files?: string[]): string[] {
    const merged = new Set(state.changedFiles);
    for (const filePath of files || []) {
      merged.add(this.normalizeRelativePath(filePath));
    }
    return [...merged];
  }
}

function getWorkspaceControllerSystemPrompt(): string {
  return `你是一个在本地代码工作区内执行任务的开发代理。

你必须只输出一个 JSON 对象，不要输出 Markdown，不要输出解释。

可用动作:
1. read_files
{
  "type": "read_files",
  "reason": "为什么要读这些文件",
  "files": ["相对路径1", "相对路径2"]
}

2. find_files
{
  "type": "find_files",
  "reason": "为什么要查找文件",
  "query": "模糊文件名或关键词",
  "limit": 5
}

3. write_files
{
  "type": "write_files",
  "reason": "为什么要写这些文件",
  "writes": [
    {
      "path": "相对路径",
      "content": "文件完整内容"
    }
  ]
}

4. run_command
{
  "type": "run_command",
  "reason": "为什么要跑这个命令",
  "command": "非交互命令"
}

5. finish
{
  "type": "finish",
  "reason": "为什么可以结束",
  "summary": "对用户的简洁结果总结",
  "changedFiles": ["相对路径1"],
  "verification": ["已运行的验证命令"],
  "notes": ["剩余风险或说明"]
}

规则:
- 一次只输出一个动作
- 如果用户给的是模糊文件名、别名、缩写或只记得部分文件名，先用 find_files，再决定 read_files
- 优先先读文件，再写文件，再跑验证命令
- find_files 只负责找路径，不负责读取内容
- 写文件时必须给出完整文件内容
- 命令必须是非交互式的
- 命令必须落在 verify/test/lint/build/typecheck/read-only git 这类安全白名单内
- finish 不是最终完成信号，系统会自动运行 verifier；如果 verifier 失败，你需要根据失败反馈继续修订
- 不要使用破坏性命令
- 如果任务更适合给建议而不是改代码，可以直接 finish
- finish 时总结必须可直接发给最终用户`;
}

function loadWorkspaceHarnessConfig(
  workspaceRoot: string
): Partial<Pick<WorkspaceExecutorConfig, 'verificationPolicy' | 'permissionProfile'>> {
  const configPath = path.join(workspaceRoot, 'codex-harness.config.json');
  if (!fsSync.existsSync(configPath)) {
    return {};
  }

  try {
    const raw = fsSync.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<
      Pick<WorkspaceExecutorConfig, 'verificationPolicy' | 'permissionProfile'>
    >;
    return parsed;
  } catch {
    return {};
  }
}

function extractJsonCandidates(content: string): string[] {
  const candidates = new Set<string>();
  const trimmed = content.trim();

  if (trimmed) {
    candidates.add(trimmed);
  }

  const fenceMatches = content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
  for (const match of fenceMatches) {
    const fencedContent = match[1]?.trim();
    if (!fencedContent) {
      continue;
    }

    candidates.add(fencedContent);
    for (const jsonText of collectBalancedJsonObjects(fencedContent)) {
      candidates.add(jsonText);
    }
  }

  for (const jsonText of collectBalancedJsonObjects(content)) {
    candidates.add(jsonText);
  }

  return [...candidates];
}

function collectBalancedJsonObjects(content: string): string[] {
  const results: string[] = [];
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (!char) {
      continue;
    }

    if (startIndex === -1) {
      if (char === '{') {
        startIndex = index;
        depth = 1;
        inString = false;
        isEscaped = false;
      }
      continue;
    }

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }

      if (char === '\\') {
        isEscaped = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth++;
      continue;
    }

    if (char === '}') {
      depth--;
      if (depth === 0) {
        results.push(content.slice(startIndex, index + 1).trim());
        startIndex = -1;
      }
    }
  }

  return results;
}

function truncateText(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, maxChars)}\n...[truncated]`;
}

function isPlannerActionType(type: unknown): type is PlannerAction['type'] {
  return (
    type === 'read_files' ||
    type === 'find_files' ||
    type === 'write_files' ||
    type === 'run_command' ||
    type === 'finish'
  );
}

function summarizeItems(items: string[], limit: number): string {
  const visibleItems = items
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
  const extraCount = Math.max(0, items.length - visibleItems.length);

  if (visibleItems.length === 0) {
    return '无';
  }

  return extraCount > 0
    ? `${visibleItems.join(', ')} 等 ${items.length} 项`
    : visibleItems.join(', ');
}

function scoreFileMatch(relativePath: string, query: string): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return 0;
  }

  const basename = path.basename(relativePath);
  const basenameWithoutExt = basename.replace(/\.[^.]+$/, '');
  const normalizedPath = normalizeSearchText(relativePath);
  const normalizedBasename = normalizeSearchText(basename);
  const normalizedName = normalizeSearchText(basenameWithoutExt);

  if (!normalizedPath) {
    return 0;
  }

  if (normalizedBasename === normalizedQuery || normalizedName === normalizedQuery) {
    return 120;
  }

  if (normalizedBasename.startsWith(normalizedQuery) || normalizedName.startsWith(normalizedQuery)) {
    return 105;
  }

  if (normalizedBasename.includes(normalizedQuery) || normalizedName.includes(normalizedQuery)) {
    return 95;
  }

  if (normalizedPath.includes(normalizedQuery)) {
    return 80;
  }

  if (
    isSubsequence(normalizedQuery, normalizedBasename) ||
    isSubsequence(normalizedQuery, normalizedName)
  ) {
    return 70;
  }

  if (isSubsequence(normalizedQuery, normalizedPath)) {
    return 60;
  }

  return 0;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle || !haystack || needle.length > haystack.length) {
    return false;
  }

  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) {
      index++;
      if (index >= needle.length) {
        return true;
      }
    }
  }

  return false;
}
