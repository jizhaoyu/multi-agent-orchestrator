# Docs 索引与汇总

这份索引用于快速说明 `docs/` 目录下每份文档的用途、当前适用性，以及建议的阅读顺序。

## 一、目录现状

当前 `docs/` 目录包含以下文档：

- `README.md`
- `agent-map.md`
- `architecture.md`
- `deployment.md`
- `failure-catalog.md`
- `performance.md`
- `publish-guide.md`
- `runbooks/verification.md`
- `项目功能与上手清单.md`

## 二、按用途分类

### 1. 日常使用优先看

#### `项目功能与上手清单.md`

- 用途：给第一次接手项目的人快速建立整体认识。
- 内容：功能清单、已实现能力、上手步骤、常用命令。
- 当前状态：最新，适合直接拿来 onboarding。

#### `agent-map.md`

- 用途：给 Agent 或开发者快速定位代码区块和稳定上下文。
- 内容：核心模块位置、动态上下文入口、角色分工。
- 当前状态：最新，适合和 `AGENTS.md` 配合使用。

#### `runbooks/verification.md`

- 用途：统一说明 verifier 的工作方式。
- 内容：完成判定、失败后如何修订、什么时候更新 failure catalog。
- 当前状态：最新，适合作为开发与自修复的工作约束。

#### `failure-catalog.md`

- 用途：沉淀高频失败模式和 Harness 改进。
- 内容：失败案例、修复策略、Harness 补强点、模板。
- 当前状态：最新，但内容还比较少，后续应该持续积累。

### 2. 理解系统设计时看

#### `architecture.md`

- 用途：查看项目原始系统设计、分层结构、任务流和测试策略。
- 内容：系统概述、核心组件、数据流、设计决策、安全、性能、部署架构。
- 当前状态：有参考价值，但部分表述偏旧。
- 特别注意：
  - 文档里仍有 `Claude Code`、`~/.claude/` 等旧口径。
  - 当前项目已经扩展到 Codex/OpenAI-compatible、Harness、WorkspaceExecutor 等更新能力，阅读时要结合最新代码理解。

### 3. 运维 / 发布时看

#### `deployment.md`

- 用途：部署、启动、systemd、Docker、日志、备份、故障排查。
- 内容：WSL2 部署、Docker 部署、systemd 管理、日志监控、安全配置、维护流程。
- 当前状态：基本可参考，但依赖和 AI provider 的描述偏旧。
- 特别注意：
  - 文档多处仍以 Claude API 为中心描述。
  - 如果按当前项目部署，应该结合 `.env.example`、`package.json` 和 `codex-harness.config.json` 一起看。

#### `publish-guide.md`

- 用途：npm 包发布和版本管理。
- 内容：版本号更新、构建、打包、本地测试、npm 发布、CHANGELOG、GitHub Release、CI/CD。
- 当前状态：结构完整，适合发布前核对流程。
- 特别注意：
  - 发布前建议优先执行当前真实命令：`npm run verify`。

### 4. 优化与调优时看

#### `performance.md`

- 用途：性能优化思路和调优检查清单。
- 内容：API、数据库、内存、并发、网络、监控、配置优化、性能测试。
- 当前状态：有思路价值，但实现细节明显偏旧。
- 特别注意：
  - 文档仍以 Claude API 为主线。
  - 当前项目已经加入 Harness、Verification、Trace 等能力，这些内容还没有合并进这份文档。

## 三、当前推荐阅读顺序

如果你是第一次接手这个项目，建议按下面顺序看：

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/项目功能与上手清单.md`
4. `docs/agent-map.md`
5. `docs/runbooks/verification.md`
6. `docs/failure-catalog.md`
7. `src/index.ts`
8. `src/core/workspace-executor.ts`
9. `src/harness/verification-engine.ts`
10. `docs/architecture.md`

## 四、文档状态汇总

### 最新、适合直接使用

- `README.md`
- `agent-map.md`
- `failure-catalog.md`
- `runbooks/verification.md`
- `项目功能与上手清单.md`

### 结构有用，但内容需要带着“历史版本”视角看

- `architecture.md`
- `deployment.md`
- `performance.md`
- `publish-guide.md`

## 五、建议的后续整理方向

### 1. 优先补齐的文档

- 把 `architecture.md` 从 Claude 口径更新为 Codex/Harness 口径。
- 把 `deployment.md` 里的 provider 配置更新为当前 `.env.example` 对应的字段。
- 把 `performance.md` 增补 verifier、trace、benchmark、false-complete rate 相关内容。

### 2. 可以继续新增的文档

- `docs/harness-overview.md`
  - 专门解释 Generator-Verifier-Reviser、Trace、Failure Memory、PermissionProfile。
- `docs/telegram-usage.md`
  - 单独整理 Telegram 命令、工作区切换、任务查看、取消流程。
- `docs/benchmark-guide.md`
  - 解释 benchmark case、result、评分方式和回归流程。

## 六、一句话总结

现在的 `docs/` 目录已经分成两类内容：

- 一类是最新的 Harness / 上手文档，适合直接指导当前开发。
- 一类是早期架构与部署文档，仍然有价值，但需要结合当前代码与配置一起阅读，不能完全按旧口径执行。
