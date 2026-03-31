# Multi-Agent Orchestrator

面向 Codex / OpenAI-compatible / Claude 的多 Agent 编排框架。它不只是让模型生成代码，而是把任务拆解、工作区执行、验证闭环、失败沉淀和评估流程整合成一套更可靠的开发 Harness。

## 项目定位

这个项目可以理解成两层能力的组合：

- 多 Agent 编排层：`Orchestrator` 负责拆任务、分配任务、汇总结果，`Worker` 负责执行、上报进度、处理子任务。
- Codex Harness 层：把 AI 开发从“生成一次就算完成”升级为“生成 -> 验证 -> 修订”的可靠闭环。

当前仓库已经支持：

- Codex/OpenAI-compatible 与 Claude 双接入
- SQLite 持久化任务与 Agent 状态
- 本地工作区执行器 `WorkspaceExecutor`
- 命令白名单与权限档位
- `Generator-Verifier-Reviser` 自动闭环
- Trace 事件记录与失败知识沉淀
- Telegram Bot 作为控制面
- Starter 模板、runbook、benchmark 入口，便于未来项目复用

## 已实现功能

### 1. 多 Agent 编排

- `Orchestrator` 支持接收任务、分解任务、优先级调度、结果汇总、失败重分配
- `Worker` 支持任务执行、进度回传、心跳保活、帮助请求、子任务委派
- `TaskManager` 与 `StateManager` 使用 SQLite 持久化任务树、依赖和 Agent 状态
- `MemoryService` 支持读取 `AGENTS.md` / repo 文档 / 配置记忆并缓存

### 2. 工作区执行

- `WorkspaceExecutor` 支持 5 类动作：读文件、找文件、写文件、跑命令、结束任务
- 支持目录扫描、Git 状态注入、进度事件回传
- Shell 命令默认受白名单约束，不允许随意越权执行

### 3. Harness 可靠性能力

- `VerificationEngine` 统一执行 `lint`、`typecheck`、`test`、`build`、`custom checks`
- 任务“完成”必须来自 verifier verdict，不接受模型自报完成
- `TraceRecorder` 和 middleware hooks 会记录 prompt、tool、verify、失败、完成等事件
- `FailureMemoryStore` 会把高价值失败模式写入 `docs/failure-catalog.md`
- `PermissionProfile`、`VerificationPolicy`、`TraceEvent` 等通用结构已经沉淀到 `src/harness/`

### 4. Telegram 控制面

- 已支持 `/task`、`/project`、`/projects`、`/pwd`、`/queue`、`/logs`、`/cancel`、`/status`、`/workers`、`/reset`、`/help`
- 支持项目目录切换、搜索工作区、任务状态查看、日志查看、软取消和长消息分段发送

### 5. 未来项目复用

- `templates/codex-harness/` 提供未来项目 starter
- `scripts/init-codex-harness.mjs` 初始化 `AGENTS.md`、runbooks、failure catalog、benchmark
- `scripts/check-doc-drift.mjs` 检查 Harness 文档是否漂移
- `scripts/run-benchmarks.mjs` 汇总 benchmark 结果

## 快速开始

### 环境要求

- Node.js 20+
- npm

### 安装依赖

```bash
npm install
```

### 配置环境变量

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

至少需要配置：

- `AI_API_KEY`
- `AI_BASE_URL`
- `AI_MODEL`

如果要启用 Telegram 控制面，还需要：

- `TELEGRAM_BOT_TOKEN`
- 可选：`TELEGRAM_CHAT_ID`
- 可选：`WORKSPACE_ROOT`
- 可选：`PROJECT_SEARCH_ROOTS`

示例配置见：[.env.example](./.env.example)

### 先跑一次完整验证

```bash
npm run verify
```

这会依次执行：

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`

## 启动方式

当前仓库还没有统一的 `npm start`，现在有两个正式入口。

### 1. 本地基础运行

```bash
npm run example:basic
```

用途：

- 本地体验编排器工作流
- 验证 `Orchestrator + Worker + Memory + Task/StateManager` 的基础协作

### 2. Telegram 服务模式

```bash
npm run example:telegram
```

用途：

- 作为长期运行的 Bot / 服务入口
- 通过 Telegram 向编排器派发任务、查看状态、切换工作区

启动后会持续运行，直到 `Ctrl+C` 停止。

## 常用命令

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
npm run harness:init
npm run harness:doctor
npm run benchmarks
npm run example:basic
npm run example:telegram
```

## 目录结构

```text
src/
  core/                  运行时核心：Orchestrator、Worker、WorkspaceExecutor
  harness/               verifier、trace、middleware、failure memory、permissions
  integrations/
    llm/                 通用 LLM 抽象
    codex/               Codex/OpenAI-compatible 接入
    claude/              Claude 接入
    telegram/            Telegram Bot 控制面
  database/              SQLite schema
  types/                 类型定义
  index.ts               统一导出入口

docs/                    上手、agent map、failure catalog、运维与发布文档
benchmarks/              benchmark 样例与结果
templates/codex-harness/ 未来项目可复用 starter
scripts/                 harness 初始化、自检、benchmark 工具
tests/                   单元与集成测试
```

## 文档入口

建议从这些文档开始：

- [AGENTS.md](./AGENTS.md)
- [docs/README.md](./docs/README.md)
- [docs/项目功能与上手清单.md](./docs/%E9%A1%B9%E7%9B%AE%E5%8A%9F%E8%83%BD%E4%B8%8E%E4%B8%8A%E6%89%8B%E6%B8%85%E5%8D%95.md)
- [docs/agent-map.md](./docs/agent-map.md)
- [docs/runbooks/verification.md](./docs/runbooks/verification.md)
- [docs/failure-catalog.md](./docs/failure-catalog.md)

## 适合什么场景

- 想让多个 Agent 协作完成开发任务，而不是单 Agent 串行生成
- 想把“写完就算完成”改成“必须通过验证才算完成”
- 想让失败经验沉淀成可复用的 Harness 资产
- 想为未来新项目提供统一的 Agent 模板、runbook、benchmark 与权限边界

## 当前状态

- 版本：`0.2.0`
- 状态：多 Agent 编排 + Codex Harness 基线已接通
- 验证链路：`lint / typecheck / test / build`
- 示例入口：`example:basic`、`example:telegram`

## License

MIT
