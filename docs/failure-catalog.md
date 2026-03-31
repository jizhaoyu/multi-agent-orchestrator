# Failure Catalog

记录高频失败模式、修复策略和应该回灌到 Harness 的改进。

## 2026-03-31T15:20:00.000Z | verification_missing

- 任务类型: code_change
- 触发条件: changed files but finish had no verifier commands
- 错误输出: verifier rejected completion because no required checks were configured
- 修复策略: 回到修订环节，补齐 `lint`、`typecheck`、`test`、`build`
- Harness 改进: 在 starter 中默认生成 `codex-harness.config.json`，并让执行器自动读取
- Repro 检查: `npm run verify`

## 模板

- 任务类型:
- 触发条件:
- 错误输出:
- 根因分类:
- 修复策略:
- Harness 改进:
- Repro 检查:
