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
- Feishu Bot 事件订阅接入（可与 Telegram 共存）
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
- 支持项目目录切换、搜索工作区、任务状态查看、日志查看、实时中断和长消息分段发送

### 5. Feishu 控制面

- 已支持飞书事件订阅回调，接收文本消息并触发编排器执行
- 当前提供 `/task`、`/cancel`、`/status`、`/workers`、`/help` 最小闭环
- 默认走后台静默执行，仅回执与最终结论，保留 Telegram 原有配置和入口不变

### 6. 未来项目复用

- `templates/codex-harness/` 提供未来项目 starter
- `scripts/init-codex-harness.mjs` 初始化 `AGENTS.md`、runbooks、failure catalog、benchmark
- `scripts/check-doc-drift.mjs` 检查 Harness 文档是否漂移
- `scripts/run-benchmarks.mjs` 汇总 benchmark 结果

## 近期更新

### 1. Telegram 交互更适合后台静默执行

- 默认切换为静默执行模式，收到任务后只回执和最终结论，不再连续刷出拆解、分配、单个小弟完整结果。
- `/cancel` 会真实中断当前运行中的 Worker，而不是只改数据库状态。
- 最终输出改为结构化结论块，优先展示 `📌 结论 / 📎 要点 / 💡 建议`，避免长段落和半截截断。

### 1.1 Feishu 接入已补上独立入口

- 新增 `FeishuBotIntegration`，通过事件订阅接收飞书文本消息，不影响 Telegram 现有配置。
- 新增 `examples/feishu-bot.ts` 与 `npm run start:feishu`，可单独启动飞书控制面。
- 飞书当前优先覆盖“发任务 + 静默执行 + 中断 + 状态查询”最小闭环，后续再扩展审批卡片。
- 如果在 Telegram 模式下额外配置 `FEISHU_WEBHOOK_URL`，最终结论和重大异常也会同步推送到飞书。

### 2. 调度与容错逻辑更稳定

- `TaskManager.getNextTask()` 现在会跳过被父任务阻塞的 pending 任务，继续返回真正可执行的任务。
- `Orchestrator.handleError()` 重新分配失败任务时，会真正驱动目标 Worker 执行，而不只是写回任务状态。
- `StateManager` 查询已回填真实 `agent_stats`，空闲 Worker 选择和状态展示不再依赖伪统计值。

### 3. 运行时开销进一步收敛

- 指令上下文拼装已提取为独立缓存组件，减少重复读取 `AGENTS.md`、runbook 和配置文件造成的 I/O 开销。
- 高频 SQLite 查询已复用 prepared statements，并补上批量任务写入与公共 schema loader，减少重复 prepare 和重复 schema 读取。

### 4. 工程治理补齐

- 新增 GitHub Actions CI，默认执行 `npm ci`、`lint`、`typecheck`、`test`、`build`。
- 补充 `npm run audit:high` 作为依赖安全扫描入口，当前以可见告警为主，便于后续替换 Telegram 依赖链中的旧组件。

## 快速开始

### 环境要求

- Node.js 20+
- npm

### 安装依赖

```bash
npm install
```

CI 和可复现环境建议统一使用：

```bash
npm ci
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

如果要启用 Feishu 控制面，还需要：

- `FEISHU_WEBHOOK_URL`，用于把消息推送到飞书自定义机器人
- 可选：`FEISHU_WEBHOOK_SECRET`，如果飞书群机器人开启了签名校验则必须配置
- 如果要从飞书直接发消息控制任务，还需要 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`
- 可选：`FEISHU_VERIFICATION_TOKEN`
- 可选：`FEISHU_EVENT_HOST`
- 可选：`FEISHU_EVENT_PORT`
- 可选：`FEISHU_EVENT_PATH`
- 可选：`FEISHU_CHAT_ID`

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

仓库已补充 GitHub Actions 持续集成，默认会执行：

- `npm ci`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run audit:high`（安全扫描单独展示，当前以可见告警为主，不阻塞主质量门）

## 启动方式

当前仓库已经提供两个统一启动入口，会自动复用 `.env` 中的代理配置。

### 1. 本地基础运行

```bash
npm run start:basic
```

用途：

- 本地体验编排器工作流
- 验证 `Orchestrator + Worker + Memory + Task/StateManager` 的基础协作

### 2. Telegram 服务模式

```bash
npm run start:telegram
```

用途：

- 作为长期运行的 Bot / 服务入口
- 通过 Telegram 向编排器派发任务、查看状态、切换工作区

启动后会持续运行，直到 `Ctrl+C` 停止。

### 3. Feishu 服务模式

```bash
npm run start:feishu
```

用途：

- 通过飞书事件订阅 URL 接收文本消息
- 在飞书群或会话里发起任务、取消任务、查询当前状态
- 如果只配置 `FEISHU_WEBHOOK_URL`，可先用于结果推送；若要从飞书里直接下发任务，需要继续配置事件订阅能力
- 如果你采用“Telegram 发任务，Feishu 群接收总结”的模式，只需要运行 `npm run start:telegram` 并额外配置 `FEISHU_WEBHOOK_URL`
- 与 Telegram 配置共存，按需独立启停

## Telegram 下发 + Feishu 汇总

如果你的使用方式是：

- 在 Telegram 里给 Bot 发任务
- 仍由本地 `Orchestrator` 和 `Worker` 执行
- 只把最终总结和重大异常推送到飞书群

那么只需要：

1. 配置 `TELEGRAM_BOT_TOKEN`
2. 配置 `FEISHU_WEBHOOK_URL`
3. 如果飞书群机器人开启了签名校验，再额外配置 `FEISHU_WEBHOOK_SECRET`
4. 启动 `npm run start:telegram`

这种模式下不需要：

- `npm run start:feishu`
- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- 飞书事件订阅回调地址

参考配置：

```env
AI_PROVIDER=codex
AI_API_KEY=your-api-key
AI_BASE_URL=https://your-provider.example/v1
AI_MODEL=your-model

TELEGRAM_BOT_TOKEN=your-telegram-bot-token
TELEGRAM_CHAT_ID=

FEISHU_WEBHOOK_URL=your-feishu-webhook-url
FEISHU_WEBHOOK_SECRET=

WORKSPACE_ROOT=/path/to/your/workspace
PROJECT_SEARCH_ROOTS=/path/to/projects
ENABLE_WORKSPACE_EXECUTION=true
```

## 常用命令

```bash
npm run lint
npm run typecheck
npm run audit:high
npm test
npm run build
npm run verify
npm run start:basic
npm run start:telegram
npm run start:feishu
npm run harness:init
npm run harness:doctor
npm run benchmarks
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
- 示例入口：`start:basic`、`start:telegram`

## 工程治理说明

- 数据层已统一复用 schema loader，并为高频 SQLite 查询复用 prepared statements，减少重复 prepare 和 N+1 查询。
- `Worker` 已把指令上下文拼装提取为独立缓存组件，避免每个任务重复读取和拼接同一批说明文件。
- GitHub Actions 已接入 lockfile 驱动的 `npm ci` 流程，主质量门覆盖 lint、typecheck、test、build。
- `npm audit` 当前会暴露 `node-telegram-bot-api` 依赖链上的历史漏洞，CI 已单独透出该结果，便于后续替换依赖或升级接入层。

## License

MIT
