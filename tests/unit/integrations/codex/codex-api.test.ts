/**
 * Codex-compatible API 客户端单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAPIClient } from '@/integrations/codex/api-client';

describe('CodexAPIClient', () => {
  let client: CodexAPIClient;
  const originalFetch = global.fetch;

  beforeEach(() => {
    client = new CodexAPIClient({
      apiKey: 'test-api-key',
      baseUrl: 'https://example.com/v1/',
      model: 'test-model',
      maxTokens: 2048,
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
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

  it('should surface nested fetch failure details', async () => {
    const fetchError = new TypeError('fetch failed');
    Object.assign(fetchError, {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
        address: '127.0.0.1',
        port: 443,
      }),
    });

    global.fetch = vi.fn().mockRejectedValue(fetchError) as typeof fetch;

    await expect(
      client.sendMessage([{ role: 'user', content: 'hello' }])
    ).rejects.toThrow('fetch failed: ECONNREFUSED connect ECONNREFUSED 127.0.0.1:443 (127.0.0.1:443)');
  });

  it('should retry UND_ERR_SOCKET responses before failing', async () => {
    const socketError = new TypeError('fetch failed');
    Object.assign(socketError, {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET',
      }),
    });

    global.fetch = vi
      .fn()
      .mockRejectedValueOnce(socketError)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: 'retry success',
              },
            },
          ],
          model: 'test-model',
          usage: {
            prompt_tokens: 1,
            completion_tokens: 2,
            total_tokens: 3,
          },
        }),
      } as Response) as typeof fetch;

    const result = await client.sendMessage([{ role: 'user', content: 'hello' }]);

    expect(result.content).toBe('retry success');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
