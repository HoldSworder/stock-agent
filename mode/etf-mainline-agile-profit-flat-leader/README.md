# 敏捷止盈非复利主线龙头

本目录存放一版以收盘口径 `flatReturn` 为首要目标的 ETF 主线模式。原始 `docs/` 文档未修改。

## 推荐模式

推荐配置: `agile-profit-flat|anti_exhaustion_score|above60|4d|min6|sw0|top2|pg15%|dd6%|mainline_persist>=0.15`

- 候选必须站上 MA60。
- 候选必须满足 `mainline_persist >= 0.15`。
- 每 4 个交易日复核一次，只持有最强 1 只 ETF，最大持仓为 1。
- 按 `anti_exhaustion_score` 排序。
- 当前持仓最少持有 6 个交易日；更强候选出现时允许替换。
- 持仓跌出 Top2、跌破 MA120、或浮盈超过 15% 后从峰值回撤 6% 时退出。

## 回测结论

该版本把目标明确切到收盘口径非复利收益，回测 `flatReturn` 高于当前 `高持续主线非复利龙头`。它牺牲了一点次开 10bp 非复利表现，换取更高的系统展示主指标，因此适合作为“flatReturn 优先”的进攻候选，而不是最保守的成交口径候选。

## 文件

- `etf-mainline-agile-profit-flat-leader-research.py`: 回测脚本。
- `backtest-data/summary_agile_profit_flat_leader.md`: 回测摘要、参数复核、分段复核。
- `backtest-data/trades_agile_profit_flat_leader.md`: 推荐候选完整交易记录。

## 风险

- 盈利保护更敏捷，交易数高于上一版。
- 次开 10bp 非复利略低于 `高持续主线非复利龙头`，说明实盘滑点敏感性更高。
- 仍是单腿集中进攻模式，必须接受主线切换期波动。
