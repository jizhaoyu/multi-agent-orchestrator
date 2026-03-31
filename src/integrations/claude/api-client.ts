/**
 * Claude API 客户端
 * 封装 Anthropic SDK，提供统一的 API 调用接口
 */

import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParams } from '@anthropic-ai/sdk/resources/messages';
import type {
  LLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
  StreamCallback,
} from '@/integrations/llm';

/**
 * API 客户端配置
 */
export interface ClaudeAPIConfig {
  /** API Key */
  apiKey: string;

  /** 默认模型 */
  model?: string;

  /** 最大 Token 数 */
  maxTokens?: number;

  /** 重试次数 */
  maxRetries?: number;

  /** 超时时间（毫秒） */
  timeout?: number;
}

/**
 * API 响应
 */
export type ClaudeAPIResponse = LLMResponse;
export type { StreamCallback } from '@/integrations/llm';

type ClaudeRequestOptions = Partial<
  Omit<MessageCreateParams, 'messages' | 'model' | 'max_tokens' | 'stream'>
> &
  LLMRequestOptions;

/**
 * Claude API 客户端
 */
export class ClaudeAPIClient implements LLMClient<Required<ClaudeAPIConfig>> {
  private client: Anthropic;
  private config: Required<ClaudeAPIConfig>;

  constructor(config: ClaudeAPIConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model || 'claude-opus-4-5',
      maxTokens: config.maxTokens || 200000,
      maxRetries: config.maxRetries || 3,
      timeout: config.timeout || 120000,
    };

    this.client = new Anthropic({
      apiKey: this.config.apiKey,
      maxRetries: this.config.maxRetries,
      timeout: this.config.timeout,
    });
  }

  /**
   * 发送消息（非流式）
   */
  async sendMessage(
    messages: LLMMessage[],
    options: ClaudeRequestOptions = {}
  ): Promise<ClaudeAPIResponse> {
    try {
      const { maxOutputTokens, ...restOptions } = options;
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: maxOutputTokens || this.config.maxTokens,
        messages: this.toAnthropicMessages(messages),
        ...restOptions,
      });

      return {
        content: this.extractContent(response.content),
        tokensUsed: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          total: response.usage.input_tokens + response.usage.output_tokens,
        },
        model: response.model,
        stopReason: response.stop_reason,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * 发送消息（流式）
   */
  async sendMessageStream(
    messages: LLMMessage[],
    onChunk: StreamCallback,
    options: ClaudeRequestOptions = {}
  ): Promise<ClaudeAPIResponse> {
    try {
      const { maxOutputTokens, ...restOptions } = options;
      const stream = await this.client.messages.create({
        model: this.config.model,
        max_tokens: maxOutputTokens || this.config.maxTokens,
        messages: this.toAnthropicMessages(messages),
        stream: true,
        ...restOptions,
      });

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let model = '';
      let stopReason: string | null = null;

      for await (const event of stream) {
        if (event.type === 'message_start') {
          inputTokens = event.message.usage.input_tokens;
          model = event.message.model;
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            const chunk = event.delta.text;
            fullContent += chunk;
            onChunk(chunk);
          }
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage.output_tokens;
          stopReason = event.delta.stop_reason;
        }
      }

      return {
        content: fullContent,
        tokensUsed: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        },
        model,
        stopReason,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * 提取内容
   */
  private extractContent(content: Anthropic.Messages.ContentBlock[]): string {
    return content
      .filter((block) => block.type === 'text')
      .map((block) => (block as Anthropic.Messages.TextBlock).text)
      .join('');
  }

  private toAnthropicMessages(messages: LLMMessage[]): MessageCreateParams['messages'] {
    return messages.map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content:
        message.role === 'user' || message.role === 'assistant'
          ? message.content
          : `[${message.role.toUpperCase()}]\n${message.content}`,
    }));
  }

  /**
   * 错误处理
   */
  private handleError(error: unknown): Error {
    if (error instanceof Anthropic.APIError) {
      return new Error(`Claude API Error: ${error.message} (Status: ${error.status})`);
    }
    if (error instanceof Error) {
      return error;
    }
    return new Error('Unknown error occurred');
  }

  /**
   * 获取配置
   */
  getConfig(): Readonly<Required<ClaudeAPIConfig>> {
    return { ...this.config };
  }
}
