import type { ITask } from '@/types';
import { assertCommandAllowed } from './permissions';
import type {
  CommandExecutionResult,
  FailureClass,
  FailureRecord,
  PermissionProfile,
  VerificationCheckResult,
  VerificationCommand,
  VerificationPolicy,
  VerificationResult,
} from './types';
import type { FailureMemoryStore } from './failure-memory';
import type { HarnessHooks } from './middleware';
import { createTraceId, TraceRecorder } from './trace-recorder';

export interface VerificationEngineConfig {
  workspaceRoot: string;
  runCommand: (command: string) => Promise<CommandExecutionResult>;
  permissionProfile?: PermissionProfile;
  policy?: VerificationPolicy;
  traceRecorder?: TraceRecorder;
  hooks?: HarnessHooks;
  failureMemory?: FailureMemoryStore;
}

export interface VerificationInput {
  task: ITask;
  changedFiles: string[];
  verification?: string[];
  summary?: string;
  notes?: string[];
  attemptId?: string;
}

export class VerificationEngine {
  private readonly config: VerificationEngineConfig;

  constructor(config: VerificationEngineConfig) {
    this.config = config;
  }

  async verifyCompletion(input: VerificationInput): Promise<VerificationResult> {
    const traceId = createTraceId('verify');
    const attemptId = input.attemptId;
    const policy = this.resolvePolicy(input.task);

    await this.config.hooks?.beforeVerify?.({
      traceId,
      taskId: input.task.id,
      attemptId,
      policyName: policy?.name,
    });
    await this.config.traceRecorder?.record({
      trace_id: traceId,
      task_id: input.task.id,
      attempt_id: attemptId,
      kind: 'before_verify',
      message: policy?.name || 'custom',
    });

    const commands = this.collectCommands(policy, input);
    if (commands.length === 0) {
      const result =
        input.changedFiles.length === 0 || policy?.allowPassWithoutChanges
          ? createPassingVerificationResult([], '未检测到需要额外验证的改动。')
          : createFailureVerificationResult(
              [],
              'verification_missing',
              '检测到文件改动，但没有配置验证命令，不能判定任务完成。',
              buildRevisionPrompt(
                'verification_missing',
                '先补齐 verify/lint/test/build/typecheck 命令，再继续收尾。'
              )
            );

      await this.finalizeVerification(traceId, input, result);
      return result;
    }

    const checks: VerificationCheckResult[] = [];

    for (const command of commands) {
      const startedAt = Date.now();
      try {
        assertCommandAllowed(command.command, this.config.permissionProfile);
      } catch (error) {
        const denial = createDeniedCheck(command, startedAt, error);
        checks.push(denial);
        const result = createFailureVerificationResult(
          checks,
          'permission_denied',
          `验证命令不在允许列表中: ${command.command}`,
          buildRevisionPrompt(
            'permission_denied',
            '改用 verify/lint/typecheck/build/test 这类白名单命令，避免自定义危险命令。'
          )
        );
        await this.finalizeVerification(traceId, input, result);
        return result;
      }

      const execution = await this.config.runCommand(command.command);
      const durationMs = Date.now() - startedAt;
      const verdict = execution.ok ? 'passed' : 'failed';
      const check: VerificationCheckResult = {
        ...execution,
        id: command.id,
        label: command.label,
        kind: command.kind,
        required: command.required ?? true,
        verdict,
        durationMs,
      };
      checks.push(check);

      if (!execution.ok && (command.required ?? true)) {
        const failureClass = classifyFailure(command);
        const result = createFailureVerificationResult(
          checks,
          failureClass,
          `验证失败: ${command.label}`,
          buildRevisionPrompt(
            failureClass,
            `根据失败输出修复问题，然后重新运行 ${command.command}。`
          )
        );
        await this.recordFailure(input, result, execution.stderr || execution.stdout, attemptId, traceId);
        await this.finalizeVerification(traceId, input, result);
        return result;
      }
    }

    const result = createPassingVerificationResult(
      checks,
      `验证通过: ${checks.map((check) => check.label).join(', ')}`
    );
    await this.finalizeVerification(traceId, input, result);
    return result;
  }

  private resolvePolicy(task: ITask): VerificationPolicy | undefined {
    const contextPolicy = task.context.verificationPolicy;
    if (isVerificationPolicy(contextPolicy)) {
      return contextPolicy;
    }

    return this.config.policy;
  }

  private collectCommands(
    policy: VerificationPolicy | undefined,
    input: VerificationInput
  ): VerificationCommand[] {
    if (policy?.commands.length) {
      return policy.commands;
    }

    const commands: Array<VerificationCommand | null> = (input.verification || [])
      .map((command, index) => {
        const trimmed = command.trim();
        if (!looksExecutableCommand(trimmed)) {
          return null;
        }

        return {
          id: `custom-${index + 1}`,
          label: `Custom check ${index + 1}`,
          command: trimmed,
          kind: 'custom' as const,
          required: true,
        };
      });

    return commands.filter(isVerificationCommand);
  }

  private async finalizeVerification(
    traceId: string,
    input: VerificationInput,
    result: VerificationResult
  ): Promise<void> {
    await this.config.traceRecorder?.record({
      trace_id: traceId,
      task_id: input.task.id,
      attempt_id: input.attemptId,
      kind: 'after_verify',
      verdict: result.verdict,
      failure_class: result.failureClass,
      message: result.summary,
      metadata: {
        checks: result.checks.map((check) => ({
          id: check.id,
          verdict: check.verdict,
          command: check.command,
        })),
      },
    });

    await this.config.hooks?.afterVerify?.({
      traceId,
      taskId: input.task.id,
      attemptId: input.attemptId,
      policyName: this.resolvePolicy(input.task)?.name,
      result,
    });
  }

  private async recordFailure(
    input: VerificationInput,
    result: VerificationResult,
    errorOutput: string,
    attemptId: string | undefined,
    traceId: string
  ): Promise<void> {
    if (!this.config.failureMemory || !result.failureClass) {
      return;
    }

    const record: FailureRecord = {
      taskType: inferTaskType(input.changedFiles),
      trigger: result.summary,
      errorOutput,
      rootCause: result.failureClass,
      repairStrategy: result.revisionPrompt || '根据 verifier 输出修复后重新验证。',
      harnessFix: suggestHarnessFix(result.failureClass),
      reproCheck: result.executedCommands[0] || '补齐 verify 命令',
      timestamp: new Date().toISOString(),
      traceId,
      attemptId,
    };

    await this.config.failureMemory.append(record);
  }
}

function createPassingVerificationResult(
  checks: VerificationCheckResult[],
  summary: string
): VerificationResult {
  return {
    verdict: checks.length === 0 ? 'skipped' : 'passed',
    checks,
    failureClass: null,
    summary,
    revisionPrompt: null,
    executedCommands: checks.map((check) => check.command),
  };
}

function createFailureVerificationResult(
  checks: VerificationCheckResult[],
  failureClass: FailureClass,
  summary: string,
  revisionPrompt: string
): VerificationResult {
  return {
    verdict: 'failed',
    checks,
    failureClass,
    summary,
    revisionPrompt,
    executedCommands: checks.map((check) => check.command),
  };
}

function createDeniedCheck(
  command: VerificationCommand,
  startedAt: number,
  error: unknown
): VerificationCheckResult {
  return {
    id: command.id,
    label: command.label,
    kind: command.kind,
    required: command.required ?? true,
    command: command.command,
    exitCode: null,
    ok: false,
    stdout: '',
    stderr: error instanceof Error ? error.message : String(error),
    verdict: 'failed',
    durationMs: Date.now() - startedAt,
  };
}

function classifyFailure(command: VerificationCommand): FailureClass {
  switch (command.kind) {
    case 'lint':
      return 'lint_failed';
    case 'typecheck':
      return 'typecheck_failed';
    case 'unit':
      return 'unit_failed';
    case 'integration':
      return 'integration_failed';
    case 'build':
      return 'build_failed';
    case 'security':
      return 'security_failed';
    case 'contract':
      return 'contract_failed';
    case 'custom':
      return 'command_failed';
  }
}

function buildRevisionPrompt(failureClass: FailureClass, nextStep: string): string {
  return [
    `Verifier verdict: failed`,
    `Failure class: ${failureClass}`,
    `Revision instruction: ${nextStep}`,
    `完成条件: verifier 必须通过，不能只给“任务完成”的口头结论。`,
  ].join('\n');
}

function suggestHarnessFix(failureClass: FailureClass): string {
  switch (failureClass) {
    case 'verification_missing':
      return '为项目补齐 verify 脚本和 VerificationPolicy。';
    case 'permission_denied':
      return '把危险命令迁移到受控工具或白名单 verify 命令。';
    default:
      return '把本次失败模式写入 runbook，并补 benchmark 防止回归。';
  }
}

function inferTaskType(changedFiles: string[]): string {
  return changedFiles.length > 0 ? 'code_change' : 'analysis_only';
}

function looksExecutableCommand(command: string): boolean {
  return /[A-Za-z]/.test(command) && !command.includes('读取成功');
}

function isVerificationCommand(
  command: VerificationCommand | null
): command is VerificationCommand {
  return Boolean(command);
}

function isVerificationPolicy(value: unknown): value is VerificationPolicy {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as VerificationPolicy;
  return typeof candidate.name === 'string' && Array.isArray(candidate.commands);
}
