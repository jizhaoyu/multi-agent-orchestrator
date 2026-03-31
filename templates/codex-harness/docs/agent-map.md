# Agent Map

## Stable Context

- 这里记录仓库结构、核心模块入口和长期稳定约束
- 保持简短，只写 agent 反复需要的信息

## Dynamic Context Targets

- 最近修改过的模块
- 最近失败过的 benchmark
- 相关 runbook 和 failure catalog 条目

## Ownership

- `generator`: 负责规划和实现
- `verifier`: 负责运行确定性检查
- `reviser`: 只消费 verifier 失败输出，生成下一轮修订
