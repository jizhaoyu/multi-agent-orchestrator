/**
 * WorkspaceExecutor 单元测试
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { WorkspaceExecutor } from '@/core/workspace-executor';
import type { ITask } from '@/types';
import type { LLMClient, LLMResponse } from '@/integrations/llm';
import type { VerificationPolicy } from '@/harness';

const tempDirs: string[] = [];

describe('WorkspaceExecutor', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
    tempDirs.length = 0;
  });

  it('should read files, write files and run commands in workspace', async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.writeFile(path.join(workspaceRoot, 'README.md'), 'old content', 'utf-8');

    const executor = new WorkspaceExecutor({
      workspaceRoot,
      apiClient: createQueuedClient([
        {
          type: 'read_files',
          reason: 'inspect current content',
          files: ['README.md'],
        },
        {
          type: 'write_files',
          reason: 'apply requested change',
          writes: [
            {
              path: 'README.md',
              content: 'new content',
            },
          ],
        },
        {
          type: 'run_command',
          reason: 'verify node is available',
          command: 'node -e "console.log(\'verify-ok\')"',
        },
        {
          type: 'finish',
          reason: 'done',
          summary: 'README 已更新并完成验证。',
          changedFiles: ['README.md'],
          verification: ['node -e "console.log(\'verify-ok\')"'],
          notes: ['无额外风险'],
        },
      ]),
      maxIterations: 6,
      commandTimeoutMs: 30000,
    });

    const result = await executor.executeTask(createTask('更新 README'));

    await expect(fs.readFile(path.join(workspaceRoot, 'README.md'), 'utf-8')).resolves.toBe(
      'new content'
    );
    expect(result.summary).toBe('README 已更新并完成验证。');
    expect(result.changedFiles).toContain('README.md');
    expect(result.verdict).toBe('passed');
    expect(result.checks).toHaveLength(1);
    expect(result.verification).toEqual(['node -e "console.log(\'verify-ok\')"']);
    expect(result.commandResults).toHaveLength(2);
    expect(result.commandResults[0]).toMatchObject({
      ok: true,
      exitCode: 0,
    });
    expect(result.commandResults[0]?.stdout).toContain('verify-ok');
    expect(result.tokenUsage.total).toBe(12);
  });

  it('should capture failed commands and still allow finishing', async () => {
    const workspaceRoot = await createTempWorkspace();

    const executor = new WorkspaceExecutor({
      workspaceRoot,
      apiClient: createQueuedClient([
        {
          type: 'run_command',
          reason: 'run a failing command',
          command: 'node -e "process.exit(2)"',
        },
        {
          type: 'finish',
          reason: 'stop after observing failure',
          summary: '命令执行失败，未继续修改文件。',
          notes: ['需要人工检查失败原因'],
        },
      ]),
    });

    const result = await executor.executeTask(createTask('执行失败场景'));

    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0]).toMatchObject({
      ok: false,
      exitCode: 2,
    });
    expect(result.summary).toBe('命令执行失败，未继续修改文件。');
    expect(result.verdict).toBe('skipped');
  });

  it('should tolerate JSON wrapped with extra text and support fuzzy file lookup', async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.writeFile(
      path.join(workspaceRoot, '01-java-fullstack-mcp-review.md'),
      '这是 01 文档的内容',
      'utf-8'
    );

    const progressSpy = vi.fn();
    const apiClient = createQueuedClient([
      '好的，先找文件。\n```json\n{"type":"find_files","reason":"用户只记得 01md","query":"01md","limit":5}\n```\n然后继续。',
      {
        type: 'read_files',
        reason: '读取模糊查询结果中的目标文件',
        files: ['01-java-fullstack-mcp-review.md'],
      },
      {
        type: 'finish',
        reason: 'done',
        summary: '已找到并读取 01 文档。',
        verification: ['read_files 读取成功'],
      },
    ]);
    const executor = new WorkspaceExecutor({
      workspaceRoot,
      apiClient,
      onProgress: progressSpy,
    });

    const result = await executor.executeTask(createTask('检查01md文件,看看有什么内容'));
    const sendMessageMock = apiClient.sendMessage as ReturnType<typeof vi.fn>;

    expect(result.summary).toBe('已找到并读取 01 文档。');
    expect(progressSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'find_files',
        message: '正在模糊查找文件: 01md',
      })
    );
    expect(sendMessageMock).toHaveBeenCalledTimes(3);
    expect(
      String((sendMessageMock.mock.calls[1]?.[0] as Array<{ content?: string }>)[0]?.content || '')
    ).toContain('01-java-fullstack-mcp-review.md');
  });

  it('should force a revision loop when files changed without verification commands', async () => {
    const workspaceRoot = await createTempWorkspace();
    const apiClient = createQueuedClient([
      {
        type: 'write_files',
        reason: 'apply requested change',
        writes: [
          {
            path: 'README.md',
            content: 'updated via loop',
          },
        ],
      },
      {
        type: 'finish',
        reason: 'done',
        summary: '第一次尝试结束，但没有验证。',
      },
      {
        type: 'finish',
        reason: 'done after verifier feedback',
        summary: '补齐验证后完成。',
        verification: ['node -e "console.log(\'loop-verify\')"'],
      },
    ]);
    const executor = new WorkspaceExecutor({
      workspaceRoot,
      apiClient,
      maxIterations: 6,
    });

    const result = await executor.executeTask(createTask('修改 README 并通过验证'));
    const sendMessageMock = apiClient.sendMessage as ReturnType<typeof vi.fn>;

    expect(result.summary).toBe('补齐验证后完成。');
    expect(result.verdict).toBe('passed');
    expect(result.verification).toEqual(['node -e "console.log(\'loop-verify\')"']);
    expect(sendMessageMock).toHaveBeenCalledTimes(3);
    expect(
      String((sendMessageMock.mock.calls[2]?.[0] as Array<{ content?: string }>)[0]?.content || '')
    ).toContain('verification_missing');
  });

  it('should enforce verification policy commands instead of trusting finish metadata', async () => {
    const workspaceRoot = await createTempWorkspace();
    await fs.writeFile(path.join(workspaceRoot, 'README.md'), 'old content', 'utf-8');

    const verificationPolicy: VerificationPolicy = {
      name: 'repo-policy',
      commands: [
        {
          id: 'verify',
          label: 'Repo verify',
          command: 'node -e "console.log(\'policy-verify\')"',
          kind: 'build',
        },
      ],
    };

    const executor = new WorkspaceExecutor({
      workspaceRoot,
      verificationPolicy,
      apiClient: createQueuedClient([
        {
          type: 'write_files',
          reason: 'apply requested change',
          writes: [
            {
              path: 'README.md',
              content: 'policy content',
            },
          ],
        },
        {
          type: 'finish',
          reason: 'done',
          summary: '依赖策略验证而不是自报完成。',
          verification: ['node -e "console.log(\'ignored\')"'],
        },
      ]),
      maxIterations: 4,
    });

    const result = await executor.executeTask(createTask('更新 README'));

    expect(result.verdict).toBe('passed');
    expect(result.verification).toEqual(['node -e "console.log(\'policy-verify\')"']);
    expect(result.commandResults.at(-1)?.stdout).toContain('policy-verify');
  });

  it('should block commands outside the allowlist', async () => {
    const workspaceRoot = await createTempWorkspace();
    const executor = new WorkspaceExecutor({
      workspaceRoot,
      apiClient: createQueuedClient([
        {
          type: 'run_command',
          reason: 'try a forbidden command',
          command: 'npm install left-pad',
        },
      ]),
    });

    await expect(executor.executeTask(createTask('违规命令场景'))).rejects.toThrow(
      '命令被权限策略阻止'
    );
  });
});

function createQueuedClient(actions: Array<unknown | string>): LLMClient {
  const queue = [...actions];

  return {
    sendMessage: vi.fn(async (): Promise<LLMResponse> => {
      const next = queue.shift();
      if (!next) {
        throw new Error('No queued action available');
      }

      return {
        content: typeof next === 'string' ? next : JSON.stringify(next),
        tokensUsed: {
          input: 1,
          output: 2,
          total: 3,
        },
        model: 'mock-model',
        stopReason: 'stop',
      };
    }),
    sendMessageStream: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ provider: 'mock' }),
  };
}

function createTask(description: string): ITask {
  return {
    id: `task-${Date.now()}`,
    parentId: null,
    assignedTo: null,
    status: 'pending',
    priority: 'high',
    depth: 0,
    description,
    context: {},
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
  };
}

async function createTempWorkspace(): Promise<string> {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-executor-test-'));
  tempDirs.push(workspaceRoot);
  return workspaceRoot;
}
