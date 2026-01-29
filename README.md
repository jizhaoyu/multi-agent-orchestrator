# Multi-Agent Orchestrator

让 Claude Code "大哥"指挥多个 Claude Code "小弟"协同完成任务的系统。

## 🎯 项目概述

Multi-Agent Orchestrator 是一个多 Agent 协同系统，实现了：

- **任务分解**：大哥自动将复杂任务分解为可并行的子任务
- **智能分配**：根据 Worker 状态和任务优先级智能分配任务
- **实时监控**：监控所有 Worker 的执行进度和心跳状态
- **错误恢复**：自动检测错误并重新分配任务
- **动态扩展**：根据需要动态创建新的 Worker

## 🏗️ 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                   Orchestrator (大哥)                        │
│  - 任务分解  - 任务分配  - 进度监控  - 质量把控             │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│  Worker #1   │      │  Worker #2   │ ...  │  Worker #9   │
│   (小弟)     │      │   (小弟)     │      │   (小弟)     │
└──────────────┘      └──────────────┘      └──────────────┘
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              共享资源层                                       │
│  - ~/.claude/ 配置  - 中央记忆服务  - SQLite 数据库         │
└─────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 文件，填入你的 API Key
```

### 编译项目

```bash
npm run build
```

### 运行测试

```bash
npm test
```

## 📦 核心模块

### 1. Orchestrator（大哥）

负责任务分解、分配、监控和错误恢复。

```typescript
import { Orchestrator, ClaudeAPIClient, StateManager, TaskManager, MemoryService } from 'multi-agent-orchestrator';

const orchestrator = new Orchestrator({
  id: 'orchestrator-1',
  apiClient: new ClaudeAPIClient({ apiKey: process.env.ANTHROPIC_API_KEY }),
  stateManager,
  taskManager,
  memoryService,
  workers: [],
});

// 接收任务
const task = await orchestrator.receiveTask('开发一个用户登录功能');

// 分解任务
const subtasks = await orchestrator.decomposeTask(task);

// 分配任务
await orchestrator.assignTasks(subtasks);

// 启动监控
await orchestrator.start();
```

### 2. Worker（小弟）

执行具体任务，支持子任务分配。

```typescript
import { Worker } from 'multi-agent-orchestrator';

const worker = new Worker({
  id: 'worker-1',
  apiClient,
  stateManager,
  taskManager,
  memoryService,
});

// 接收任务
await worker.receiveTask(task);

// 执行任务
const result = await worker.executeTask(task);
```

### 3. Task Manager（任务管理器）

管理任务队列、依赖关系和状态。

```typescript
import { TaskManager } from 'multi-agent-orchestrator';

const taskManager = new TaskManager({
  dbPath: './data/tasks.db',
  maxDepth: 3,
});

// 添加任务
await taskManager.addTask(task);

// 获取下一个任务
const nextTask = await taskManager.getNextTask();

// 更新任务状态
await taskManager.updateTaskStatus(task.id, 'completed', result);
```

### 4. State Manager（状态管理器）

追踪所有 Agent 的状态和心跳。

```typescript
import { StateManager } from 'multi-agent-orchestrator';

const stateManager = new StateManager({
  dbPath: './data/state.db',
  heartbeatTimeout: 10 * 60 * 1000, // 10 分钟
});

// 注册 Agent
await stateManager.registerAgent(agent);

// 更新状态
await stateManager.updateStatus(agentId, 'busy', taskId);

// 获取空闲 Worker
const idleWorkers = await stateManager.getIdleWorkers();
```

### 5. Memory Service（记忆服务）

中央化的配置和记忆管理。

```typescript
import { MemoryService } from 'multi-agent-orchestrator';

const memoryService = new MemoryService({
  configRoot: '~/.claude',
  cacheSize: 100,
  enableWatch: true,
});

// 读取记忆
const config = await memoryService.read('CLAUDE.md');

// 写入记忆
await memoryService.write('custom-config.json', { key: 'value' });

// 订阅变更
memoryService.subscribe('CLAUDE.md', (data) => {
  console.log('配置已更新:', data);
});
```

## 🧪 测试

项目包含完整的单元测试和集成测试：

```bash
# 运行所有测试
npm test

# 运行测试并生成覆盖率报告
npm run test:coverage

# 运行特定测试
npm test -- state-manager.test.ts
```

## 📚 文档

- [架构文档](./docs/architecture.md) - 详细的系统架构设计
- [API 文档](./docs/api.md) - API 接口文档（待完成）
- [部署文档](./docs/deployment.md) - 部署指南（待完成）

## 🛠️ 开发

### 项目结构

```
src/
├── types/              # 类型定义
├── integrations/       # 外部集成
│   └── claude/         # Claude API 集成
├── core/               # 核心模块
│   ├── memory-service.ts
│   ├── state-manager.ts
│   ├── task-manager.ts
│   ├── worker.ts
│   └── orchestrator.ts
├── database/           # 数据库 Schema
└── index.ts            # 入口文件
```

### 开发命令

```bash
# 开发模式（监听文件变化）
npm run dev

# 编译
npm run build

# 代码检查
npm run lint

# 代码格式化
npm run format
```

## 🔧 技术栈

- **运行时**: Node.js 20+
- **语言**: TypeScript 5+
- **AI API**: Claude API (Anthropic)
- **数据库**: SQLite (better-sqlite3)
- **测试**: Vitest
- **代码质量**: ESLint + Prettier

## 📝 待完成功能

### P1 - Telegram 集成和可视化

- [ ] Telegram Bot 基础集成
- [ ] 结构化消息格式
- [ ] 实时进度展示
- [ ] Clawdbot Gateway 集成
- [ ] 部署到 WSL2

### P2 - 监控和优化

- [ ] 监控和统计
- [ ] 安全审查
- [ ] 性能优化
- [ ] 文档和示例

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

## 👥 作者

- Claude Code

## 🙏 致谢

- Anthropic Claude API
- 所有开源贡献者

---

**版本**: 0.1.0
**状态**: P0 阶段完成（核心基础设施）
**最后更新**: 2026-01-30
