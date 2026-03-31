# Agent Map

## Stable Context

- `src/core/`: Orchestrator、Worker、WorkspaceExecutor
- `src/harness/`: verifier、trace、middleware、permission profile、failure memory
- `src/integrations/`: Codex/OpenAI-compatible、Claude、Telegram
- `codex-harness.config.json`: 默认 verifier 和权限配置
- `templates/codex-harness/`: 新项目 starter 资产

## Dynamic Context Targets

- 最近修改过的模块
- 最近失败过的 benchmark
- 相关 runbook 和 failure catalog 条目

## Ownership

- `generator`: 负责规划和实现
- `verifier`: 负责运行确定性检查
- `reviser`: 只消费 verifier 失败输出，生成下一轮修订
