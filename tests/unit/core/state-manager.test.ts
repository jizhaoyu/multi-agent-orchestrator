/**
 * 状态管理器单元测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from '@/core/state-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { IAgent } from '@/types';

describe('StateManager', () => {
  let manager: StateManager;
  let dbPath: string;

  beforeEach(() => {
    // 创建临时数据库
    dbPath = path.join(os.tmpdir(), `state-manager-test-${Date.now()}.db`);
    manager = new StateManager({ dbPath });
  });

  afterEach(() => {
    manager.close();
    // 删除临时数据库
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  it('should register agent', async () => {
    const agent: IAgent = {
      id: 'agent-1',
      type: 'worker',
      status: 'idle',
      currentTaskId: null,
      lastHeartbeat: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    await manager.registerAgent(agent);

    const retrieved = await manager.getAgent('agent-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('agent-1');
    expect(retrieved?.type).toBe('worker');
    expect(retrieved?.status).toBe('idle');
  });

  it('should update agent status', async () => {
    const agent: IAgent = {
      id: 'agent-2',
      type: 'worker',
      status: 'idle',
      currentTaskId: null,
      lastHeartbeat: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    await manager.registerAgent(agent);
    await manager.updateStatus('agent-2', 'busy', 'task-1');

    const retrieved = await manager.getAgent('agent-2');
    expect(retrieved?.status).toBe('busy');
    expect(retrieved?.currentTaskId).toBe('task-1');
  });

  it('should update heartbeat', async () => {
    const agent: IAgent = {
      id: 'agent-3',
      type: 'worker',
      status: 'idle',
      currentTaskId: null,
      lastHeartbeat: new Date(Date.now() - 60000), // 1 分钟前
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    await manager.registerAgent(agent);

    const before = await manager.getAgent('agent-3');
    const beforeTime = before?.lastHeartbeat.getTime() || 0;

    await manager.updateHeartbeat('agent-3');

    const after = await manager.getAgent('agent-3');
    const afterTime = after?.lastHeartbeat.getTime() || 0;

    expect(afterTime).toBeGreaterThan(beforeTime);
  });

  it('should get idle workers', async () => {
    const worker1: IAgent = {
      id: 'worker-1',
      type: 'worker',
      status: 'idle',
      currentTaskId: null,
      lastHeartbeat: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    const worker2: IAgent = {
      id: 'worker-2',
      type: 'worker',
      status: 'busy',
      currentTaskId: 'task-1',
      lastHeartbeat: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    await manager.registerAgent(worker1);
    await manager.registerAgent(worker2);

    const idleWorkers = await manager.getIdleWorkers();
    expect(idleWorkers).toHaveLength(1);
    expect(idleWorkers[0]?.id).toBe('worker-1');
  });

  it('should get agent stats', async () => {
    const agent: IAgent = {
      id: 'agent-4',
      type: 'worker',
      status: 'idle',
      currentTaskId: null,
      lastHeartbeat: new Date(),
      stats: {
        tasksCompleted: 5,
        tasksFailed: 1,
        totalTokens: 1000,
        avgCompletionTime: 5000,
      },
    };

    await manager.registerAgent(agent);

    const stats = await manager.getStats('agent-4');
    expect(stats.tasksCompleted).toBe(5);
    expect(stats.tasksFailed).toBe(1);
    expect(stats.totalTokens).toBe(1000);
    expect(stats.avgCompletionTime).toBe(5000);
  });

  it('should update agent stats', async () => {
    const agent: IAgent = {
      id: 'agent-5',
      type: 'worker',
      status: 'idle',
      currentTaskId: null,
      lastHeartbeat: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    await manager.registerAgent(agent);
    await manager.updateStats('agent-5', {
      tasksCompleted: 10,
      totalTokens: 5000,
    });

    const stats = await manager.getStats('agent-5');
    expect(stats.tasksCompleted).toBe(10);
    expect(stats.totalTokens).toBe(5000);
  });

  it('should check heartbeat timeout', async () => {
    const agent: IAgent = {
      id: 'agent-6',
      type: 'worker',
      status: 'busy',
      currentTaskId: 'task-1',
      lastHeartbeat: new Date(Date.now() - 20 * 60 * 1000), // 20 分钟前
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    await manager.registerAgent(agent);

    const timedOut = await manager.checkHeartbeatTimeout();
    expect(timedOut).toContain('agent-6');
  });

  it('should delete agent', async () => {
    const agent: IAgent = {
      id: 'agent-7',
      type: 'worker',
      status: 'idle',
      currentTaskId: null,
      lastHeartbeat: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalTokens: 0,
        avgCompletionTime: 0,
      },
    };

    await manager.registerAgent(agent);
    await manager.deleteAgent('agent-7');

    const retrieved = await manager.getAgent('agent-7');
    expect(retrieved).toBeNull();
  });
});
