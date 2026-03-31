export type VerificationCheckKind =
  | 'lint'
  | 'typecheck'
  | 'unit'
  | 'integration'
  | 'build'
  | 'security'
  | 'contract'
  | 'custom';

export type VerificationVerdict = 'passed' | 'failed' | 'skipped';

export type FailureClass =
  | 'verification_missing'
  | 'invalid_verification_command'
  | 'permission_denied'
  | 'lint_failed'
  | 'typecheck_failed'
  | 'unit_failed'
  | 'integration_failed'
  | 'build_failed'
  | 'security_failed'
  | 'contract_failed'
  | 'command_failed'
  | 'unexpected_error';

export type PermissionProfile =
  | 'read_only'
  | 'dev_safe'
  | 'repo_write'
  | 'network_limited'
  | 'privileged_ops';

export interface VerificationCommand {
  id: string;
  label: string;
  command: string;
  kind: VerificationCheckKind;
  required?: boolean;
}

export interface VerificationPolicy {
  name: string;
  commands: VerificationCommand[];
  requireVerificationWhenFilesChange?: boolean;
  allowPassWithoutChanges?: boolean;
}

export interface CommandExecutionResult {
  command: string;
  exitCode: number | null;
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface VerificationCheckResult extends CommandExecutionResult {
  id: string;
  label: string;
  kind: VerificationCheckKind;
  required: boolean;
  verdict: VerificationVerdict;
  durationMs: number;
}

export interface VerificationResult {
  verdict: VerificationVerdict;
  checks: VerificationCheckResult[];
  failureClass: FailureClass | null;
  summary: string;
  revisionPrompt: string | null;
  executedCommands: string[];
}

export type TraceEventKind =
  | 'before_prompt'
  | 'after_response'
  | 'before_tool'
  | 'after_tool'
  | 'before_verify'
  | 'after_verify'
  | 'task_failed'
  | 'task_completed';

export interface TraceEvent {
  trace_id: string;
  task_id?: string;
  attempt_id?: string;
  role?: string;
  tool?: string;
  kind: TraceEventKind;
  duration_ms?: number;
  token_in?: number;
  token_out?: number;
  verdict?: VerificationVerdict;
  failure_class?: FailureClass | null;
  message?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface FailureRecord {
  taskType: string;
  trigger: string;
  errorOutput: string;
  rootCause: string;
  repairStrategy: string;
  harnessFix: string;
  reproCheck: string;
  timestamp: string;
  traceId?: string;
  attemptId?: string;
}

export interface BenchmarkScoreDimension {
  id: string;
  label: string;
  weight: number;
}

export interface BenchmarkCase {
  id: string;
  taskPrompt: string;
  repoFixture: string;
  expectedChecks: string[];
  hardFailConditions: string[];
  scoreDimensions: BenchmarkScoreDimension[];
}
