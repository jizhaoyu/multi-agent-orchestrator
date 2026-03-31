/**
 * Codex/OpenAI-compatible API 客户端
 * 适配第三方兼容 chat/completions 协议的服务商
 */

import type {
  LLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  StreamCallback,
} from '@/integrations/llm';

export interface CodexAPIConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  maxRetries?: number;
  timeout?: number;
}

interface ChatCompletionChoice {
  finish_reason?: string | null;
  message?: {
    content?: string | null;
  };
}

interface ChatCompletionUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  model?: string;
  usage?: ChatCompletionUsage;
}

export class CodexAPIClient implements LLMClient<Required<CodexAPIConfig>> {
  private config: Required<CodexAPIConfig>;

  constructor(config: CodexAPIConfig) {
    this.config = {
      apiKey: config.apiKey,
      baseUrl: normalizeBaseUrl(config.baseUrl || 'https://api.openai.com/v1'),
      model: config.model || 'gpt-4.1',
      maxTokens: config.maxTokens || 16384,
      maxRetries: config.maxRetries || 3,
      timeout: config.timeout || 120000,
    };
  }

  async sendMessage(
    messages: LLMMessage[],
    options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    const response = await this.request(messages, options);
    const content = response.choices?.[0]?.message?.content?.trim() || '';
    const usage = response.usage || {};
    const input = usage.prompt_tokens || 0;
    const output = usage.completion_tokens || 0;

    return {
      content,
      tokensUsed: {
        input,
        output,
        total: usage.total_tokens || input + output,
      },
      model: response.model || this.config.model,
      stopReason: response.choices?.[0]?.finish_reason || null,
    };
  }

  async sendMessageStream(
    messages: LLMMessage[],
    onChunk: StreamCallback,
    options: LLMRequestOptions = {}
  ): Promise<LLMResponse> {
    // 第三方兼容接口对 SSE 支持差异很大，这里先保证兼容性。
    const response = await this.sendMessage(messages, options);
    if (response.content) {
      onChunk(response.content);
    }
    return response;
  }

  getConfig(): Readonly<Required<CodexAPIConfig>> {
    return { ...this.config };
  }

  private async request(
    messages: LLMMessage[],
    options: LLMRequestOptions
  ): Promise<ChatCompletionResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            model: this.config.model,
            messages: this.toProviderMessages(messages, options.system),
            max_tokens: options.maxOutputTokens || this.config.maxTokens,
            temperature: options.temperature,
            stream: false,
          }),
          signal: AbortSignal.timeout(this.config.timeout),
        });

        if (!response.ok) {
          throw await this.createHTTPError(response);
        }

        return (await response.json()) as ChatCompletionResponse;
      } catch (error) {
        lastError = this.handleError(error);

        if (attempt >= this.config.maxRetries || !isRetryableError(lastError)) {
          throw lastError;
        }

        await delay((attempt + 1) * 500);
      }
    }

    throw lastError || new Error('Unknown error occurred');
  }

  private toProviderMessages(
    messages: LLMMessage[],
    systemPrompt?: string
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const providerMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> =
      [];

    if (systemPrompt) {
      providerMessages.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    for (const message of messages) {
      if (message.role === 'system' || message.role === 'developer') {
        providerMessages.push({
          role: 'system',
          content: message.content,
        });
        continue;
      }

      providerMessages.push({
        role: message.role,
        content: message.content,
      });
    }

    return providerMessages;
  }

  private async createHTTPError(response: Response): Promise<Error> {
    const fallback = `Codex-compatible API Error: ${response.status} ${response.statusText}`;

    try {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      return new Error(payload.error?.message || fallback);
    } catch {
      return new Error(fallback);
    }
  }

  private handleError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('rate limit') ||
    message.includes('429') ||
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504') ||
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('socket hang up')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
