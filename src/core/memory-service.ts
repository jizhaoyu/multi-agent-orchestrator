/**
 * 中央记忆服务
 * 提供配置和记忆的中央化管理，支持多进程并发读写
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import AsyncLock from 'async-lock';
import { LRUCache } from 'lru-cache';
import type { IMemoryService } from '@/types';

/**
 * 记忆服务配置
 */
export interface MemoryServiceConfig {
  /** 配置根目录 */
  configRoot: string;

  /** 缓存大小 */
  cacheSize?: number;

  /** 缓存 TTL（毫秒） */
  cacheTTL?: number;

  /** 是否启用文件监听 */
  enableWatch?: boolean;
}

/**
 * 中央记忆服务
 */
export class MemoryService extends EventEmitter implements IMemoryService {
  private config: Required<MemoryServiceConfig>;
  private cache: LRUCache<string, unknown>;
  private lock: AsyncLock;
  private watchers: Map<string, fs.FSWatcher>;

  constructor(config: MemoryServiceConfig) {
    super();

    this.config = {
      configRoot: config.configRoot,
      cacheSize: config.cacheSize || 100,
      cacheTTL: config.cacheTTL || 5 * 60 * 1000, // 5 分钟
      enableWatch: config.enableWatch ?? true,
    };

    // 初始化缓存
    this.cache = new LRUCache({
      max: this.config.cacheSize,
      ttl: this.config.cacheTTL,
    });

    // 初始化锁
    this.lock = new AsyncLock();

    // 初始化监听器
    this.watchers = new Map();
  }

  /**
   * 读取记忆
   */
  async read(relativePath: string): Promise<unknown> {
    // 检查缓存
    const cached = this.cache.get(relativePath);
    if (cached !== undefined) {
      return cached;
    }

    // 从文件读取
    return this.lock.acquire(relativePath, async () => {
      // 双重检查（可能在等待锁时已被其他进程缓存）
      const cachedAgain = this.cache.get(relativePath);
      if (cachedAgain !== undefined) {
        return cachedAgain;
      }

      const fullPath = this.resolvePath(relativePath);

      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        // 尝试解析 JSON
        let data: unknown;
        try {
          data = JSON.parse(content);
        } catch {
          // 如果不是 JSON，返回原始字符串
          data = content;
        }

        // 缓存
        this.cache.set(relativePath, data);

        // 启动文件监听
        if (this.config.enableWatch && !this.watchers.has(relativePath)) {
          this.watchFile(relativePath, fullPath);
        }

        return data;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`Memory file not found: ${relativePath}`);
        }
        throw error;
      }
    });
  }

  /**
   * 写入记忆
   */
  async write(relativePath: string, data: unknown): Promise<void> {
    return this.lock.acquire(relativePath, async () => {
      const fullPath = this.resolvePath(relativePath);

      // 确保目录存在
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      // 序列化数据
      let content: string;
      if (typeof data === 'string') {
        content = data;
      } else {
        content = JSON.stringify(data, null, 2);
      }

      // 写入文件
      await fs.writeFile(fullPath, content, 'utf-8');

      // 更新缓存
      this.cache.set(relativePath, data);

      // 触发变更事件
      this.emit('change', relativePath, data);
    });
  }

  /**
   * 订阅变更
   */
  subscribe(relativePath: string, callback: (data: unknown) => void): void {
    this.on(`change:${relativePath}`, callback);
  }

  /**
   * 取消订阅
   */
  unsubscribe(relativePath: string, callback: (data: unknown) => void): void {
    this.off(`change:${relativePath}`, callback);
  }

  /**
   * 清除缓存
   */
  clearCache(relativePath?: string): void {
    if (relativePath) {
      this.cache.delete(relativePath);
    } else {
      this.cache.clear();
    }
  }

  /**
   * 停止文件监听
   */
  async stopWatch(relativePath?: string): Promise<void> {
    if (relativePath) {
      const watcher = this.watchers.get(relativePath);
      if (watcher) {
        await watcher.close();
        this.watchers.delete(relativePath);
      }
    } else {
      // 停止所有监听
      for (const [path, watcher] of this.watchers) {
        await watcher.close();
        this.watchers.delete(path);
      }
    }
  }

  /**
   * 销毁服务
   */
  async destroy(): Promise<void> {
    await this.stopWatch();
    this.cache.clear();
    this.removeAllListeners();
  }

  /**
   * 解析完整路径
   */
  private resolvePath(relativePath: string): string {
    return path.join(this.config.configRoot, relativePath);
  }

  /**
   * 监听文件变更
   */
  private watchFile(relativePath: string, fullPath: string): void {
    try {
      const watcher = fs.watch(fullPath, async (eventType) => {
        if (eventType === 'change') {
          // 清除缓存
          this.cache.delete(relativePath);

          // 重新读取
          try {
            const data = await this.read(relativePath);
            this.emit(`change:${relativePath}`, data);
          } catch (error) {
            this.emit('error', error);
          }
        }
      });

      this.watchers.set(relativePath, watcher);
    } catch (error) {
      // 文件监听失败不应该影响正常功能
      this.emit('error', new Error(`Failed to watch file: ${relativePath}`));
    }
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): {
    size: number;
    max: number;
    hitRate: number;
  } {
    return {
      size: this.cache.size,
      max: this.config.cacheSize,
      hitRate: 0, // LRUCache 不提供命中率统计，需要自己实现
    };
  }
}
