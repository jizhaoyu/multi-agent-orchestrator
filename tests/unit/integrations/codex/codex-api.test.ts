/**
 * Codex-compatible API 客户端单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CodexAPIClient } from '@/integrations/codex/api-client';

describe('CodexAPIClient', () => {
  let client: CodexAPIClient;

  beforeEach(() => {
    client = new CodexAPIClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://example.com/v1/',
      model: 'test-model',
      maxTokens: 2048,
    });
  });

  it('should create client with normalized config', () => {
    const config = client.getConfig();
    expect(config.apiKey).toBe('test-api-key');
    expect(config.baseUrl).toBe('https://example.com/v1');
    expect(config.model).toBe('test-model');
    expect(config.maxTokens).toBe(2048);
  });

  it('should use default values for optional config', () => {
    const defaultClient = new CodexAPIClient({
      apiKey: 'test-api-key',
    });

    const config = defaultClient.getConfig();
    expect(config.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.model).toBe('gpt-4.1');
    expect(config.maxRetries).toBe(3);
  });
});
