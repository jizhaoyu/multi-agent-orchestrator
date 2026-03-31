# Verification Runbook

1. 任何“完成”都先跑 verifier。
2. verifier 失败时，不讨论“感觉上应该没问题”，只消费失败输出继续修订。
3. 新增或修改验证命令时，先更新 `codex-harness.config.json`。
4. 如果同类失败重复出现，把它写进 `docs/failure-catalog.md` 并新增 benchmark。
