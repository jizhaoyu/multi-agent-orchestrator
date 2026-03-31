/**
 * 根据环境变量创建 API 客户端
 */

import { ClaudeAPIClient } from './claude';
import { CodexAPIClient } from './codex';
import type { LLMClient } from './llm';

export type AIProvider = 'codex' | 'claude';

export function createAPIClientFromEnv(defaultProvider: AIProvider = 'codex'): LLMClient {
  const provider = normalizeProvider(process.env.AI_PROVIDER || defaultProvider);

  if (provider === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('缺少 ANTHROPIC_API_KEY，无法初始化 Claude 客户端');
    }

    return new ClaudeAPIClient({
      apiKey,
      model: process.env.ANTHROPIC_MODEL || process.env.AI_MODEL,
      maxTokens: readNumber(process.env.MAX_OUTPUT_TOKENS),
      maxRetries: readNumber(process.env.MAX_RETRIES),
      timeout: readNumber(process.env.API_TIMEOUT_MS),
    });
  }

  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('缺少 AI_API_KEY，无法初始化 Codex-compatible 客户端');
  }

  return new CodexAPIClient({
    apiKey,
    baseUrl: process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL,
    model: process.env.AI_MODEL || process.env.OPENAI_MODEL,
    maxTokens: readNumber(process.env.MAX_OUTPUT_TOKENS),
    maxRetries: readNumber(process.env.MAX_RETRIES),
    timeout: readNumber(process.env.API_TIMEOUT_MS),
  });
}

function normalizeProvider(provider: string): AIProvider {
  return provider.toLowerCase() === 'claude' ? 'claude' : 'codex';
}

function readNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
