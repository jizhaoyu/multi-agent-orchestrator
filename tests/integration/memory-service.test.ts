/**
 * 记忆服务集成测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryService } from '@/core/memory-service';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('MemoryService Integration Tests', () => {
  let service: MemoryService;
  let testDir: string;

  beforeEach(async () => {
    // 创建临时测试目录
    testDir = path.join(os.tmpdir(), `memory-service-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    service = new MemoryService({
      configRoot: testDir,
      cacheSize: 10,
      cacheTTL: 1000,
      enableWatch: false, // 测试时禁用文件监听
    });
  });

  afterEach(async () => {
    await service.destroy();
    // 清理测试目录
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should write and read data', async () => {
    const data = { message: 'Hello, World!' };
    await service.write('test.json', data);

    const result = await service.read('test.json');
    expect(result).toEqual(data);
  });

  it('should cache data', async () => {
    const data = { message: 'Cached' };
    await service.write('cached.json', data);

    // 第一次读取（从文件）
    const result1 = await service.read('cached.json');
    expect(result1).toEqual(data);

    // 第二次读取（从缓存）
    const result2 = await service.read('cached.json');
    expect(result2).toEqual(data);

    const stats = service.getCacheStats();
    expect(stats.size).toBeGreaterThan(0);
  });

  it('should handle concurrent writes', async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      service.write('concurrent.json', { count: i })
    );

    await Promise.all(writes);

    const result = await service.read('concurrent.json');
    expect(result).toHaveProperty('count');
  });

  it('should handle nested paths', async () => {
    const data = { nested: true };
    await service.write('dir1/dir2/nested.json', data);

    const result = await service.read('dir1/dir2/nested.json');
    expect(result).toEqual(data);
  });

  it('should throw error for non-existent file', async () => {
    await expect(service.read('non-existent.json')).rejects.toThrow(
      'Memory file not found'
    );
  });

  it('should clear cache', async () => {
    await service.write('test.json', { data: 'test' });
    await service.read('test.json');

    service.clearCache('test.json');

    const stats = service.getCacheStats();
    expect(stats.size).toBe(0);
  });

  it('should handle string data', async () => {
    const data = 'Plain text content';
    await service.write('text.txt', data);

    const result = await service.read('text.txt');
    expect(result).toBe(data);
  });

  it('should emit change events', async () => {
    let changeEmitted = false;
    let changedData: unknown = null;

    service.subscribe('test.json', (data) => {
      changeEmitted = true;
      changedData = data;
    });

    const data = { changed: true };
    await service.write('test.json', data);

    expect(changeEmitted).toBe(true);
    expect(changedData).toEqual(data);
  });

  it('should unsubscribe from changes', async () => {
    let callCount = 0;
    const callback = () => {
      callCount++;
    };

    service.subscribe('test.json', callback);
    await service.write('test.json', { data: 1 });

    service.unsubscribe('test.json', callback);
    await service.write('test.json', { data: 2 });

    expect(callCount).toBe(1);
  });
});
