/**
 * 错误重试机制
 * 实现指数退避重试策略
 */

/**
 * 重试配置
 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number;

  /** 初始延迟（毫秒） */
  initialDelay: number;

  /** 最大延迟（毫秒） */
  maxDelay: number;

  /** 退避因子 */
  backoffFactor: number;

  /** 是否添加随机抖动 */
  jitter: boolean;
}

/**
 * 默认重试配置
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  jitter: true,
};

/**
 * 重试策略
 */
export class RetryStrategy {
  private config: RetryConfig;

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * 执行带重试的操作
   */
  async execute<T>(
    operation: () => Promise<T>,
    shouldRetry: (error: Error) => boolean = () => true
  ): Promise<T> {
    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= this.config.maxRetries) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 检查是否应该重试
        if (!shouldRetry(lastError)) {
          throw lastError;
        }

        // 如果已经达到最大重试次数，抛出错误
        if (attempt >= this.config.maxRetries) {
          throw new Error(
            `Operation failed after ${this.config.maxRetries} retries: ${lastError.message}`
          );
        }

        // 计算延迟时间
        const delay = this.calculateDelay(attempt);

        // 等待后重试
        await this.sleep(delay);

        attempt++;
      }
    }

    // 理论上不会到达这里，但为了类型安全
    throw lastError || new Error('Operation failed');
  }

  /**
   * 计算延迟时间（指数退避 + 可选抖动）
   */
  private calculateDelay(attempt: number): number {
    // 指数退避
    let delay = Math.min(
      this.config.initialDelay * Math.pow(this.config.backoffFactor, attempt),
      this.config.maxDelay
    );

    // 添加随机抖动（避免雷鸣群效应）
    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  /**
   * 睡眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 获取配置
   */
  getConfig(): Readonly<RetryConfig> {
    return { ...this.config };
  }
}

/**
 * 判断错误是否可重试
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // API 限流错误
  if (message.includes('rate limit') || message.includes('429')) {
    return true;
  }

  // 服务器错误
  if (message.includes('500') || message.includes('502') || message.includes('503')) {
    return true;
  }

  // 超时错误
  if (message.includes('timeout') || message.includes('timed out')) {
    return true;
  }

  // 网络错误
  if (
    message.includes('network') ||
    message.includes('econnreset') ||
    message.includes('econnrefused')
  ) {
    return true;
  }

  return false;
}

/**
 * 创建带重试的函数包装器
 */
export function withRetry<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  config?: Partial<RetryConfig>
): T {
  const strategy = new RetryStrategy(config);

  return ((...args: Parameters<T>) => {
    return strategy.execute(() => fn(...args), isRetryableError);
  }) as T;
}
