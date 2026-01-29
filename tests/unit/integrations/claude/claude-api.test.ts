/**
 * Claude API 客户端单元测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeAPIClient } from '@/integrations/claude/api-client';
import { ContextBuilder } from '@/integrations/claude/context-builder';
import { RetryStrategy, isRetryableError } from '@/integrations/claude/retry-strategy';

describe('ClaudeAPIClient', () => {
  let client: ClaudeAPIClient;

  beforeEach(() => {
    client = new ClaudeAPIClient({
      apiKey: 'test-api-key',
      model: 'claude-opus-4-5',
      maxTokens: 1000,
    });
  });

  it('should create client with correct config', () => {
    const config = client.getConfig();
    expect(config.apiKey).toBe('test-api-key');
    expect(config.model).toBe('claude-opus-4-5');
    expect(config.maxTokens).toBe(1000);
  });

  it('should use default values for optional config', () => {
    const defaultClient = new ClaudeAPIClient({
      apiKey: 'test-api-key',
    });
    const config = defaultClient.getConfig();
    expect(config.model).toBe('claude-opus-4-5');
    expect(config.maxTokens).toBe(200000);
    expect(config.maxRetries).toBe(3);
  });
});

describe('ContextBuilder', () => {
  it('should build simple context', () => {
    const builder = ContextBuilder.createSimple('Hello', 'You are a helpful assistant');
    const context = builder.build();

    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe('user');
    expect(context.messages[0]?.content).toBe('Hello');
    expect(context.system).toBe('You are a helpful assistant');
  });

  it('should add multiple messages', () => {
    const builder = new ContextBuilder();
    builder
      .addUserMessage('Hello')
      .addAssistantMessage('Hi there!')
      .addUserMessage('How are you?');

    const context = builder.build();
    expect(context.messages).toHaveLength(3);
    expect(context.messages[0]?.role).toBe('user');
    expect(context.messages[1]?.role).toBe('assistant');
    expect(context.messages[2]?.role).toBe('user');
  });

  it('should throw error if first message is not from user', () => {
    const builder = new ContextBuilder();
    builder.addAssistantMessage('Hello');

    expect(() => builder.build()).toThrow('First message must be from user');
  });

  it('should throw error if no messages', () => {
    const builder = new ContextBuilder();
    expect(() => builder.build()).toThrow('At least one message is required');
  });

  it('should clear messages', () => {
    const builder = new ContextBuilder();
    builder.addUserMessage('Hello').setSystemPrompt('Test');
    builder.clear();

    expect(builder.getMessageCount()).toBe(0);
    expect(builder.getSystemPrompt()).toBeNull();
  });
});

describe('RetryStrategy', () => {
  it('should succeed on first try', async () => {
    const strategy = new RetryStrategy({ maxRetries: 3 });
    const operation = vi.fn().mockResolvedValue('success');

    const result = await strategy.execute(operation);

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure', async () => {
    const strategy = new RetryStrategy({
      maxRetries: 2,
      initialDelay: 10,
      jitter: false,
    });

    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Fail 1'))
      .mockRejectedValueOnce(new Error('Fail 2'))
      .mockResolvedValue('success');

    const result = await strategy.execute(operation, isRetryableError);

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should throw after max retries', async () => {
    const strategy = new RetryStrategy({
      maxRetries: 2,
      initialDelay: 10,
    });

    const operation = vi.fn().mockRejectedValue(new Error('Always fail'));

    await expect(strategy.execute(operation, isRetryableError)).rejects.toThrow(
      'Operation failed after 2 retries'
    );

    expect(operation).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('should not retry if shouldRetry returns false', async () => {
    const strategy = new RetryStrategy({ maxRetries: 3 });
    const operation = vi.fn().mockRejectedValue(new Error('Non-retryable'));

    await expect(strategy.execute(operation, () => false)).rejects.toThrow('Non-retryable');

    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('isRetryableError', () => {
  it('should identify rate limit errors', () => {
    expect(isRetryableError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('should identify server errors', () => {
    expect(isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
    expect(isRetryableError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('should identify timeout errors', () => {
    expect(isRetryableError(new Error('Request timeout'))).toBe(true);
    expect(isRetryableError(new Error('Connection timed out'))).toBe(true);
  });

  it('should identify network errors', () => {
    expect(isRetryableError(new Error('Network error'))).toBe(true);
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
  });

  it('should not identify non-retryable errors', () => {
    expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    expect(isRetryableError(new Error('Bad request'))).toBe(false);
  });
});
