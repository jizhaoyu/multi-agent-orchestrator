import { describe, expect, it, vi } from 'vitest';
import type { LLMClient, LLMResponse } from '@/integrations/llm';
import {
  createInstrumentedLLMClient,
  TraceRecorder,
  VerificationEngine,
} from '@/harness';
import type { ITask } from '@/types';

describe('Harness middleware', () => {
  it('should record prompt lifecycle events', async () => {
    const recorder = new TraceRecorder();
    const baseClient = createMockClient();
    const client = createInstrumentedLLMClient({
      baseClient,
      traceRecorder: recorder,
      taskId: 'task-1',
      role: 'generator',
    });

    await client.sendMessage([{ role: 'user', content: 'hello' }], {
      system: 'system prompt',
    });

    expect(recorder.getEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_id: 'task-1',
          kind: 'before_prompt',
          role: 'generator',
        }),
        expect.objectContaining({
          task_id: 'task-1',
          kind: 'after_response',
          role: 'generator',
          token_in: 5,
          token_out: 7,
        }),
      ])
    );
  });

  it('should classify verification failures and generate revision prompts', async () => {
    const engine = new VerificationEngine({
      workspaceRoot: process.cwd(),
      runCommand: vi.fn().mockResolvedValue({
        command: 'npm run test',
        ok: false,
        exitCode: 1,
        stdout: '',
        stderr: 'test failed',
      }),
      policy: {
        name: 'repo-policy',
        commands: [
          {
            id: 'unit',
            label: 'Unit tests',
            command: 'npm run test',
            kind: 'unit',
          },
        ],
      },
    });

    const result = await engine.verifyCompletion({
      task: createTask(),
      changedFiles: ['src/index.ts'],
      attemptId: 'attempt-1',
    });

    expect(result.verdict).toBe('failed');
    expect(result.failureClass).toBe('unit_failed');
    expect(result.revisionPrompt).toContain('npm run test');
  });
});

function createMockClient(): LLMClient {
  const response: LLMResponse = {
    content: 'done',
    tokensUsed: {
      input: 5,
      output: 7,
      total: 12,
    },
    model: 'mock-model',
    stopReason: 'stop',
  };

  return {
    sendMessage: vi.fn().mockResolvedValue(response),
    sendMessageStream: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ provider: 'mock' }),
  };
}

function createTask(): ITask {
  return {
    id: 'task-1',
    parentId: null,
    assignedTo: null,
    status: 'pending',
    priority: 'high',
    depth: 0,
    description: 'Task 1',
    context: {},
    result: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
  };
}
