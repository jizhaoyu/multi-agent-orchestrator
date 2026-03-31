/**
 * 通用 LLM 类型定义
 */

export type LLMMessageRole = 'user' | 'assistant' | 'system' | 'developer';

export interface LLMMessage {
  role: LLMMessageRole;
  content: string;
}

export interface LLMRequestOptions {
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface LLMResponse {
  content: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  model: string;
  stopReason: string | null;
}

export type StreamCallback = (chunk: string) => void;

export interface LLMClient<TConfig = unknown> {
  sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  sendMessageStream(
    messages: LLMMessage[],
    onChunk: StreamCallback,
    options?: LLMRequestOptions
  ): Promise<LLMResponse>;
  getConfig(): Readonly<TConfig>;
}
