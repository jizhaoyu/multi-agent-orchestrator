import type {
  LLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  StreamCallback,
} from '@/integrations/llm';
import { createTraceId, TraceRecorder } from './trace-recorder';
import type {
  FailureClass,
  TraceEvent,
  VerificationResult,
  VerificationVerdict,
} from './types';

export interface PromptHookEvent {
  traceId: string;
  taskId?: string;
  role?: string;
  messages: LLMMessage[];
  options?: LLMRequestOptions;
}

export interface ToolHookEvent {
  traceId: string;
  taskId?: string;
  attemptId?: string;
  tool: string;
  command?: string;
  metadata?: Record<string, unknown>;
}

export interface VerifyHookEvent {
  traceId: string;
  taskId?: string;
  attemptId?: string;
  policyName?: string;
  result?: VerificationResult;
}

export interface TaskHookEvent {
  traceId: string;
  taskId?: string;
  attemptId?: string;
  verdict?: VerificationVerdict;
  failureClass?: FailureClass | null;
  message?: string;
}

export interface HarnessHooks {
  beforePrompt?: (event: PromptHookEvent) => void | Promise<void>;
  afterResponse?: (
    event: PromptHookEvent & { response: LLMResponse; durationMs: number }
  ) => void | Promise<void>;
  beforeTool?: (event: ToolHookEvent) => void | Promise<void>;
  afterTool?: (
    event: ToolHookEvent & {
      durationMs: number;
      ok?: boolean;
      stderr?: string;
    }
  ) => void | Promise<void>;
  beforeVerify?: (event: VerifyHookEvent) => void | Promise<void>;
  afterVerify?: (event: VerifyHookEvent) => void | Promise<void>;
  taskFailed?: (event: TaskHookEvent) => void | Promise<void>;
  taskCompleted?: (event: TaskHookEvent) => void | Promise<void>;
}

export interface InstrumentedLLMClientConfig {
  baseClient: LLMClient;
  traceRecorder?: TraceRecorder;
  hooks?: HarnessHooks;
  taskId?: string;
  role?: string;
}

export class InstrumentedLLMClient implements LLMClient<unknown> {
  private readonly baseClient: LLMClient;
  private readonly traceRecorder?: TraceRecorder;
  private readonly hooks?: HarnessHooks;
  private readonly taskId?: string;
  private readonly role?: string;

  constructor(config: InstrumentedLLMClientConfig) {
    this.baseClient = config.baseClient;
    this.traceRecorder = config.traceRecorder;
    this.hooks = config.hooks;
    this.taskId = config.taskId;
    this.role = config.role;
  }

  async sendMessage(
    messages: LLMMessage[],
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    const traceId = createTraceId('prompt');
    const event: PromptHookEvent = {
      traceId,
      taskId: this.taskId,
      role: this.role,
      messages,
      options,
    };
    await this.hooks?.beforePrompt?.(event);
    await this.record({
      trace_id: traceId,
      task_id: this.taskId,
      role: this.role,
      kind: 'before_prompt',
      message: `messages=${messages.length}`,
    });

    const startedAt = Date.now();
    const response = await this.baseClient.sendMessage(messages, options);
    const durationMs = Date.now() - startedAt;

    await this.hooks?.afterResponse?.({
      ...event,
      response,
      durationMs,
    });
    await this.record({
      trace_id: traceId,
      task_id: this.taskId,
      role: this.role,
      kind: 'after_response',
      duration_ms: durationMs,
      token_in: response.tokensUsed.input,
      token_out: response.tokensUsed.output,
      message: response.stopReason || 'stop',
      metadata: {
        model: response.model,
      },
    });

    return response;
  }

  async sendMessageStream(
    messages: LLMMessage[],
    onChunk: StreamCallback,
    options?: LLMRequestOptions
  ): Promise<LLMResponse> {
    return this.baseClient.sendMessageStream(messages, onChunk, options);
  }

  getConfig(): Readonly<unknown> {
    return this.baseClient.getConfig();
  }

  private async record(event: Omit<TraceEvent, 'timestamp'>): Promise<void> {
    if (!this.traceRecorder) {
      return;
    }

    await this.traceRecorder.record(event);
  }
}

export function createInstrumentedLLMClient(
  config: InstrumentedLLMClientConfig
): InstrumentedLLMClient {
  return new InstrumentedLLMClient(config);
}
