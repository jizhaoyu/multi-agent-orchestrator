# AGENTS.md

## 项目地图

- `src/`: 产品代码与运行时逻辑
- `tests/`: 单元、集成与回归测试
- `docs/`: Agent 文档入口、runbook、失败目录
- `benchmarks/`: 评估用例与结果
- `skills/`: 复用的 Codex 技能说明

## 常用命令

- 安装依赖: `npm install`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- 测试: `npm test`
- 构建: `npm run build`
- 总验证: `npm run verify`

## 验证命令

- 默认完成判定必须至少覆盖 `lint`、`typecheck`、`test`、`build`
- 任何“任务完成”都必须来自 verifier verdict，不接受模型自报完成
- 修改验证策略时，同步更新 `codex-harness.config.json`

## 安全边界

- 命令默认只允许 read-only git、lint、typecheck、test、build、format check
- 禁止通过 shell 安装依赖、发布、部署、删除目录、重置 git 历史
- 需要额外权限时，优先扩展工具而不是放宽 shell 权限

## 禁改区域

- `.env`、生产密钥、部署脚本、数据库迁移默认视为高风险区域
- 未经明确要求，不修改生成产物和第三方 vendor 文件

## 文档入口

- `docs/agent-map.md`
- `docs/runbooks/verification.md`
- `docs/failure-catalog.md`
- `benchmarks/`
