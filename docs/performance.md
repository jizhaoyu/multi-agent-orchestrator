# Multi-Agent Orchestrator 性能优化指南

**版本**: 0.2.0
**最后更新**: 2026-01-30

---

## 📊 性能基准

### 目标性能指标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 任务分解时间 | < 5s | Orchestrator 分解任务的时间 |
| 任务分配时间 | < 1s | 分配任务给 Worker 的时间 |
| Worker 响应时间 | < 10s | Worker 开始执行任务的时间 |
| 内存使用 | < 500MB | 系统总内存使用 |
| 并发任务数 | 20+ | 同时执行的任务数 |
| 数据库查询时间 | < 100ms | 单次数据库查询时间 |
| 缓存命中率 | > 90% | Memory Service 缓存命中率 |

---

## 🚀 优化策略

### 1. Claude API 优化

#### 1.1 使用流式响应

```typescript
// 优化前：等待完整响应
const response = await apiClient.sendMessage(messages);

// 优化后：使用流式响应
await apiClient.sendMessageStream(messages, (chunk) => {
  // 实时处理响应块
  console.log(chunk);
});
```

#### 1.2 批量请求

```typescript
// 优化前：串行请求
for (const task of tasks) {
  await apiClient.sendMessage(task.messages);
}

// 优化后：并行请求
await Promise.all(
  tasks.map(task => apiClient.sendMessage(task.messages))
);
```

#### 1.3 请求缓存

```typescript
// 实现请求缓存
class CachedAPIClient extends ClaudeAPIClient {
  private cache = new Map<string, any>();

  async sendMessage(messages, options) {
    const cacheKey = this.getCacheKey(messages);

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const response = await super.sendMessage(messages, options);
    this.cache.set(cacheKey, response);

    return response;
  }
}
```

---

### 2. 数据库优化

#### 2.1 添加索引

```sql
-- 已有的索引
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- 额外的复合索引
CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
  ON tasks(status, priority);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status
  ON tasks(assigned_to, status);

CREATE INDEX IF NOT EXISTS idx_agents_type_status
  ON agents(type, status);
```

#### 2.2 使用事务

```typescript
// 优化前：多次单独操作
await taskManager.addTask(task1);
await taskManager.addTask(task2);
await taskManager.addTask(task3);

// 优化后：使用事务
db.transaction(() => {
  taskManager.addTask(task1);
  taskManager.addTask(task2);
  taskManager.addTask(task3);
})();
```

#### 2.3 批量操作

```typescript
// 优化前：逐个插入
for (const task of tasks) {
  await db.prepare('INSERT INTO tasks ...').run(task);
}

// 优化后：批量插入
const stmt = db.prepare('INSERT INTO tasks ...');
const insertMany = db.transaction((tasks) => {
  for (const task of tasks) stmt.run(task);
});
insertMany(tasks);
```

#### 2.4 定期清理

```typescript
// 定期清理旧数据
setInterval(() => {
  // 删除 30 天前的已完成任务
  db.prepare(`
    DELETE FROM tasks
    WHERE status = 'completed'
    AND completed_at < ?
  `).run(Date.now() - 30 * 24 * 60 * 60 * 1000);
}, 24 * 60 * 60 * 1000); // 每天执行一次
```

---

### 3. 内存优化

#### 3.1 优化缓存大小

```typescript
// 根据实际使用情况调整缓存大小
const memoryService = new MemoryService({
  configRoot: '~/.claude',
  cacheSize: 50, // 减少缓存大小
  cacheTTL: 3 * 60 * 1000, // 减少 TTL
});
```

#### 3.2 及时释放资源

```typescript
// 任务完成后清理
async executeTask(task) {
  try {
    const result = await this.doWork(task);
    return result;
  } finally {
    // 清理临时数据
    this.tempData.clear();

    // 触发垃圾回收（仅在必要时）
    if (global.gc) {
      global.gc();
    }
  }
}
```

#### 3.3 使用流处理大数据

```typescript
// 优化前：一次性加载所有数据
const allTasks = await taskManager.getAllTasks();
for (const task of allTasks) {
  process(task);
}

// 优化后：分批处理
const batchSize = 100;
let offset = 0;

while (true) {
  const tasks = await taskManager.getTasks(offset, batchSize);
  if (tasks.length === 0) break;

  for (const task of tasks) {
    process(task);
  }

  offset += batchSize;
}
```

---

### 4. 并发优化

#### 4.1 Worker 池管理

```typescript
class WorkerPool {
  private workers: Worker[];
  private maxWorkers: number;

  constructor(maxWorkers = 9) {
    this.maxWorkers = maxWorkers;
    this.workers = [];
  }

  async getIdleWorker(): Promise<Worker | null> {
    // 查找空闲 Worker
    const idle = this.workers.find(w => w.status === 'idle');
    if (idle) return idle;

    // 如果没有空闲且未达到上限，创建新 Worker
    if (this.workers.length < this.maxWorkers) {
      const worker = await this.createWorker();
      this.workers.push(worker);
      return worker;
    }

    return null;
  }

  async waitForIdleWorker(): Promise<Worker> {
    while (true) {
      const worker = await this.getIdleWorker();
      if (worker) return worker;

      // 等待 1 秒后重试
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}
```

#### 4.2 任务队列优化

```typescript
// 使用优先级队列
class PriorityTaskQueue {
  private queues: Map<string, ITask[]>;

  constructor() {
    this.queues = new Map([
      ['high', []],
      ['medium', []],
      ['low', []]
    ]);
  }

  enqueue(task: ITask) {
    this.queues.get(task.priority)?.push(task);
  }

  dequeue(): ITask | null {
    // 优先处理高优先级任务
    for (const priority of ['high', 'medium', 'low']) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) {
        return queue.shift() || null;
      }
    }
    return null;
  }
}
```

---

### 5. 网络优化

#### 5.1 连接池

```typescript
// 使用 HTTP Keep-Alive
import https from 'https';

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 60000,
});

// 在 API 客户端中使用
const apiClient = new ClaudeAPIClient({
  apiKey: process.env.ANTHROPIC_API_KEY,
  httpAgent: agent,
});
```

#### 5.2 请求重试优化

```typescript
// 智能重试策略
class SmartRetryStrategy extends RetryStrategy {
  async execute(operation, shouldRetry) {
    let lastError;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // 根据错误类型决定是否重试
        if (!shouldRetry(error)) {
          throw error;
        }

        // 429 错误（限流）使用更长的延迟
        if (error.message.includes('429')) {
          await this.sleep(this.config.maxDelay);
        } else {
          await this.sleep(this.calculateDelay(attempt));
        }
      }
    }

    throw lastError;
  }
}
```

---

### 6. 监控和分析

#### 6.1 性能监控

```typescript
class PerformanceMonitor {
  private metrics: Map<string, number[]>;

  constructor() {
    this.metrics = new Map();
  }

  recordMetric(name: string, value: number) {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)?.push(value);
  }

  getStats(name: string) {
    const values = this.metrics.get(name) || [];
    if (values.length === 0) return null;

    return {
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      p50: this.percentile(values, 50),
      p95: this.percentile(values, 95),
      p99: this.percentile(values, 99),
    };
  }

  private percentile(values: number[], p: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[index] || 0;
  }
}

// 使用示例
const monitor = new PerformanceMonitor();

async function executeTask(task) {
  const start = Date.now();
  try {
    const result = await doWork(task);
    monitor.recordMetric('task_duration', Date.now() - start);
    return result;
  } catch (error) {
    monitor.recordMetric('task_error', 1);
    throw error;
  }
}
```

#### 6.2 内存监控

```typescript
// 定期监控内存使用
setInterval(() => {
  const usage = process.memoryUsage();
  console.log({
    rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
    heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
    heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
    external: `${Math.round(usage.external / 1024 / 1024)}MB`,
  });

  // 如果内存使用超过阈值，触发警告
  if (usage.heapUsed > 400 * 1024 * 1024) {
    console.warn('⚠️  内存使用过高！');
  }
}, 60000); // 每分钟检查一次
```

---

## 🔧 配置优化

### 1. Node.js 配置

```bash
# 增加内存限制
export NODE_OPTIONS="--max-old-space-size=4096"

# 启用垃圾回收日志
export NODE_OPTIONS="--trace-gc"

# 优化垃圾回收
export NODE_OPTIONS="--expose-gc --optimize-for-size"
```

### 2. 环境变量优化

```env
# 调整 Worker 数量
WORKER_COUNT=9

# 调整心跳间隔
HEARTBEAT_INTERVAL=300000  # 5 分钟

# 调整监控间隔
MONITOR_INTERVAL=60000  # 1 分钟

# 调整缓存大小
CACHE_SIZE=100
CACHE_TTL=300000  # 5 分钟

# 调整数据库配置
DB_CACHE_SIZE=2000
DB_PAGE_SIZE=4096
```

---

## 📈 性能测试

### 1. 负载测试

```typescript
// 负载测试脚本
async function loadTest() {
  const orchestrator = new Orchestrator({...});
  const tasks = [];

  // 创建 100 个任务
  for (let i = 0; i < 100; i++) {
    tasks.push(orchestrator.receiveTask(`Task ${i}`));
  }

  const start = Date.now();
  await Promise.all(tasks);
  const duration = Date.now() - start;

  console.log(`完成 100 个任务，耗时: ${duration}ms`);
  console.log(`平均每个任务: ${duration / 100}ms`);
}
```

### 2. 压力测试

```bash
# 使用 Apache Bench 进行压力测试
ab -n 1000 -c 10 http://localhost:3000/api/tasks

# 使用 wrk 进行压力测试
wrk -t12 -c400 -d30s http://localhost:3000/api/tasks
```

---

## 🎯 优化检查清单

### 代码层面
- [ ] 使用流式响应处理大数据
- [ ] 实现请求缓存
- [ ] 使用批量操作
- [ ] 及时释放资源
- [ ] 避免内存泄漏

### 数据库层面
- [ ] 添加必要的索引
- [ ] 使用事务
- [ ] 定期清理旧数据
- [ ] 优化查询语句
- [ ] 使用连接池

### 系统层面
- [ ] 调整 Node.js 内存限制
- [ ] 配置合适的 Worker 数量
- [ ] 优化心跳和监控间隔
- [ ] 使用 PM2 或 systemd 管理进程
- [ ] 配置日志轮转

### 监控层面
- [ ] 实现性能监控
- [ ] 监控内存使用
- [ ] 监控 API 调用次数
- [ ] 监控错误率
- [ ] 设置告警阈值

---

**文档版本**: 1.0
**最后更新**: 2026-01-30
