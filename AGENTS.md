# AGENTS.md

## 项目地图

- `src/core/`: Orchestrator、Worker、WorkspaceExecutor 等运行时核心
- `src/harness/`: verifier、trace、middleware、failure memory、权限策略
- `src/integrations/`: LLM provider 和 Telegram 集成
- `tests/`: 单元与集成测试
- `docs/`: agent map、runbook、failure catalog、架构与发布文档
- `templates/codex-harness/`: 未来项目可直接复制的 starter 模板
- `benchmarks/`: 评估用例与结果

## 常用命令

- 安装依赖: `npm install`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- 测试: `npm test`
- 构建: `npm run build`
- 总验证: `npm run verify`
- Harness 初始化: `npm run harness:init`
- 文档自检: `npm run harness:doctor`
- Benchmark 汇总: `npm run benchmarks`

## 验证命令

- 当前默认 verifier 入口在 `codex-harness.config.json`
- 改动代码后默认要求跑 `lint`、`typecheck`、`test`、`build`
- `WorkspaceExecutor` 的 `finish` 只代表“请求结束”，最终是否完成由 verifier verdict 决定

## 安全边界

- Shell 命令默认只允许 read-only git、lint、typecheck、test、build、format check
- 禁止通过 shell 安装依赖、发布、部署、删除目录、重置历史
- 高风险区域包括 `.env`、生产凭证、部署脚本、数据库迁移

## 禁改区域

- 未经明确要求，不修改 `dist/`、第三方依赖和生成产物
- 不绕过 verifier 直接把任务状态标为完成

## 文档入口

- `docs/agent-map.md`
- `docs/runbooks/verification.md`
- `docs/failure-catalog.md`
- `codex-harness.config.json`
